import type { WriteStream } from "node:fs";
import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ApplyResult,
  type EditBlock,
  type EditSnapshot,
  applyEditBlocks,
  parseEditBlocks,
  restoreSnapshots,
  snapshotBeforeEdits,
} from "../../code/edit-blocks.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import type { LoopEvent } from "../../loop.js";
import type { SessionSummary } from "../../telemetry.js";
import type { ToolRegistry } from "../../tools.js";
import { openTranscriptFile, recordFromLoopEvent, writeRecord } from "../../transcript.js";
import { type DisplayEvent, EventRow } from "./EventLog.js";
import { PromptInput } from "./PromptInput.js";
import { StatsPanel } from "./StatsPanel.js";
import { handleSlash, parseSlash } from "./slash.js";

export interface AppProps {
  model: string;
  system: string;
  transcript?: string;
  harvest?: boolean;
  branch?: number;
  session?: string;
  /**
   * Pre-populated tool registry (e.g. from bridgeMcpTools()). When present,
   * its specs are folded into the ImmutablePrefix so the model sees them,
   * and its dispatch is used for tool calls — MCP tools become first-class.
   */
  tools?: ToolRegistry;
  /** Raw `--mcp` / config-derived spec strings, for `/mcp` slash display. */
  mcpSpecs?: string[];
  /**
   * When set, parse SEARCH/REPLACE blocks from assistant responses and
   * apply them to disk under `rootDir`. Set by `reasonix code`.
   */
  codeMode?: { rootDir: string };
}

/**
 * Throttle interval in ms. We flush streaming deltas at most this often to
 * avoid re-rendering the whole UI on every single token from DeepSeek.
 * 60ms ≈ 16Hz, fast enough to feel live, slow enough to not thrash Ink.
 */
const FLUSH_INTERVAL_MS = 60;

interface StreamingState {
  id: string;
  text: string;
  reasoning: string;
}

export function App({
  model,
  system,
  transcript,
  harvest,
  branch,
  session,
  tools,
  mcpSpecs,
  codeMode,
}: AppProps) {
  const { exit } = useApp();
  const [historical, setHistorical] = useState<DisplayEvent[]>([]);
  const [streaming, setStreaming] = useState<DisplayEvent | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Tracks whether the current turn has been aborted via Esc, so the
  // Esc handler only fires once per turn (repeated presses would yield
  // stacked warning events).
  const abortedThisTurn = useRef(false);
  // Name + truncated args of the tool currently dispatching. Populated
  // on `tool_start`, cleared on `tool` (or error). Drives the
  // "▸ tool<X> running…" pulse-spinner row so long tool calls don't
  // look like the app hung.
  const [ongoingTool, setOngoingTool] = useState<{ name: string; args?: string } | null>(null);
  // Snapshots of every file the *last* edit batch touched, keyed by
  // nothing more than "most recent". `/undo` restores from this ref
  // and nulls it out — one level of undo, Aider-style. Multi-step
  // undo would need a proper history stack and a clear policy for
  // when the stack clears; v1 keeps it simple.
  const lastEditSnapshots = useRef<EditSnapshot[] | null>(null);
  // Pending edit blocks awaiting `/apply` or `/discard`. We do NOT
  // auto-apply — v0.4.1 showed that "model proposed, so apply" turns
  // analysis into unintended edits. The user explicitly confirms now.
  const pendingEdits = useRef<EditBlock[]>([]);
  const [summary, setSummary] = useState<SessionSummary>({
    turns: 0,
    totalCostUsd: 0,
    claudeEquivalentUsd: 0,
    savingsVsClaudePct: 0,
    cacheHitRatio: 0,
    lastPromptTokens: 0,
  });

  const transcriptRef = useRef<WriteStream | null>(null);
  if (transcript && !transcriptRef.current) {
    transcriptRef.current = openTranscriptFile(transcript, {
      version: 1,
      source: "reasonix chat",
      model,
      startedAt: new Date().toISOString(),
    });
  }
  useEffect(() => {
    return () => {
      transcriptRef.current?.end();
    };
  }, []);

  const loopRef = useRef<CacheFirstLoop | null>(null);
  const loop = useMemo(() => {
    if (loopRef.current) return loopRef.current;
    const client = new DeepSeekClient();
    const prefix = new ImmutablePrefix({
      system,
      toolSpecs: tools?.specs(),
    });
    const l = new CacheFirstLoop({ client, prefix, tools, model, harvest, branch, session });
    loopRef.current = l;
    return l;
  }, [model, system, harvest, branch, session, tools]);

  // Surface a one-time banner about session state on first mount.
  const sessionBannerShown = useRef(false);
  useEffect(() => {
    if (sessionBannerShown.current) return;
    sessionBannerShown.current = true;
    if (!session) {
      setHistorical((prev) => [
        ...prev,
        {
          id: `sys-session-${Date.now()}`,
          role: "info",
          text: "▸ ephemeral chat (no session persistence) — drop --no-session to enable",
        },
      ]);
    } else if (loop.resumedMessageCount > 0) {
      setHistorical((prev) => [
        ...prev,
        {
          id: `sys-resume-${Date.now()}`,
          role: "info",
          text: `▸ resumed session "${session}" with ${loop.resumedMessageCount} prior messages · /forget to start over · /sessions to list`,
        },
      ]);
    } else {
      setHistorical((prev) => [
        ...prev,
        {
          id: `sys-newsession-${Date.now()}`,
          role: "info",
          text: `▸ session "${session}" (new) — auto-saved as you chat · /forget to delete · /sessions to list`,
        },
      ]);
    }
  }, [session, loop]);

  // Esc during busy → forward to the loop as an abort signal. The loop
  // finishes the tool call in flight (we can't kill subprocess stdio
  // mid-write), then diverts to its no-tools summary path so the user
  // gets an answer instead of a hard stop. Only listens while busy so
  // we don't accidentally hijack Esc in other contexts.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (!busy) return;
    if (abortedThisTurn.current) return;
    abortedThisTurn.current = true;
    loop.abort();
  });

  /**
   * Callback wired into the `/undo` slash command. Restores the files
   * last edit batch to their pre-edit state and reports per-file
   * results. Only available when running in code mode — the slash
   * handler gates on this callback's presence.
   */
  const codeUndo = useCallback((): string => {
    if (!codeMode) return "not in code mode";
    const snaps = lastEditSnapshots.current;
    if (!snaps || snaps.length === 0) {
      return "nothing to undo — no recent edit batch to restore";
    }
    const results = restoreSnapshots(snaps, codeMode.rootDir);
    lastEditSnapshots.current = null;
    return formatUndoResults(results);
  }, [codeMode]);

  /**
   * /apply callback — write pending edit blocks to disk, snapshot
   * beforehand so /undo still works, report per-file results.
   */
  const codeApply = useCallback((): string => {
    if (!codeMode) return "not in code mode";
    const blocks = pendingEdits.current;
    if (blocks.length === 0) {
      return "nothing pending — the assistant hasn't proposed edits since the last /apply or /discard.";
    }
    const snaps = snapshotBeforeEdits(blocks, codeMode.rootDir);
    const results = applyEditBlocks(blocks, codeMode.rootDir);
    const anyApplied = results.some((r) => r.status === "applied" || r.status === "created");
    if (anyApplied) lastEditSnapshots.current = snaps;
    pendingEdits.current = [];
    return formatEditResults(results);
  }, [codeMode]);

  /**
   * /discard callback — forget the pending edits without touching
   * disk. Keeps the conversation going without the user having to
   * argue the model out of its proposal.
   */
  const codeDiscard = useCallback((): string => {
    const count = pendingEdits.current.length;
    if (count === 0) return "nothing pending to discard.";
    pendingEdits.current = [];
    return `▸ discarded ${count} pending edit block(s). Nothing was written to disk.`;
  }, []);

  const prefixHash = loop.prefix.fingerprint;

  const writeTranscript = useCallback(
    (ev: LoopEvent) => {
      const stream = transcriptRef.current;
      if (!stream) return;
      writeRecord(stream, recordFromLoopEvent(ev, { model, prefixHash }));
    },
    [model, prefixHash],
  );

  const handleSubmit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      setInput("");
      const slash = parseSlash(text);
      if (slash) {
        const result = handleSlash(slash.cmd, slash.args, loop, {
          mcpSpecs,
          codeUndo: codeMode ? codeUndo : undefined,
          codeApply: codeMode ? codeApply : undefined,
          codeDiscard: codeMode ? codeDiscard : undefined,
          codeRoot: codeMode?.rootDir,
        });
        if (result.exit) {
          transcriptRef.current?.end();
          exit();
          return;
        }
        if (result.clear) {
          setHistorical([]);
          return;
        }
        if (result.info) {
          setHistorical((prev) => [
            ...prev,
            {
              id: `sys-${Date.now()}`,
              role: "info",
              text: result.info!,
            },
          ]);
        }
        return;
      }

      // User message is immutable — push to Static immediately.
      setHistorical((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);

      const assistantId = `a-${Date.now()}`;
      // Refs are the source of truth for accumulated streaming text; the React
      // state copy below is only for rendering and gets updated on flush.
      const streamRef: StreamingState = { id: assistantId, text: "", reasoning: "" };
      const contentBuf = { current: "" };
      const reasoningBuf = { current: "" };

      setStreaming({ id: assistantId, role: "assistant", text: "", streaming: true });
      setBusy(true);
      abortedThisTurn.current = false;

      const flush = () => {
        if (!contentBuf.current && !reasoningBuf.current) return;
        streamRef.text += contentBuf.current;
        streamRef.reasoning += reasoningBuf.current;
        contentBuf.current = "";
        reasoningBuf.current = "";
        setStreaming({
          id: assistantId,
          role: "assistant",
          text: streamRef.text,
          reasoning: streamRef.reasoning || undefined,
          streaming: true,
        });
      };
      const timer = setInterval(flush, FLUSH_INTERVAL_MS);

      try {
        for await (const ev of loop.step(text)) {
          writeTranscript(ev);
          if (ev.role === "assistant_delta") {
            if (ev.content) contentBuf.current += ev.content;
            if (ev.reasoningDelta) reasoningBuf.current += ev.reasoningDelta;
          } else if (ev.role === "branch_start") {
            setStreaming({
              id: assistantId,
              role: "assistant",
              text: "",
              streaming: true,
              branchProgress: ev.branchProgress,
            });
          } else if (ev.role === "branch_progress") {
            // Live-update the streaming slot with per-sample completion info.
            setStreaming({
              id: assistantId,
              role: "assistant",
              text: "",
              streaming: true,
              branchProgress: ev.branchProgress,
            });
          } else if (ev.role === "branch_done") {
            // Intermediate: branching finished but assistant_final not yet emitted.
            // Keep streaming state alive; actual render happens on assistant_final.
          } else if (ev.role === "assistant_final") {
            flush();
            const repairNote = ev.repair ? describeRepair(ev.repair) : "";
            setStreaming(null);
            const finalText = ev.content || streamRef.text;
            setHistorical((prev) => [
              ...prev,
              {
                id: assistantId,
                role: "assistant",
                text: finalText,
                reasoning: streamRef.reasoning || undefined,
                planState: ev.planState,
                branch: ev.branch,
                stats: ev.stats,
                repair: repairNote || undefined,
                streaming: false,
              },
            ]);
            if (codeMode && finalText && !ev.forcedSummary) {
              // Parse SEARCH/REPLACE blocks but DO NOT write them to
              // disk. Store as pending — the user has to say /apply
              // explicitly. This prevents "analyze the project" from
              // silently drifting into "edit the project".
              //
              // `ev.forcedSummary` gates us out entirely: if the loop
              // had to force a summary (budget / aborted / context-
              // guard), its text is a wrap-up, not a plan to execute.
              // Blocks dropped in a forced summary are display-only.
              const blocks = parseEditBlocks(finalText);
              if (blocks.length > 0) {
                pendingEdits.current = blocks;
                setHistorical((prev) => [
                  ...prev,
                  {
                    id: `pending-${Date.now()}`,
                    role: "info",
                    text: formatPendingPreview(blocks),
                  },
                ]);
              }
            }
          } else if (ev.role === "tool_start") {
            // Kick off the visual indicator. Cleared when `tool`
            // (result) or `error` arrives, or on the finally below.
            setOngoingTool({ name: ev.toolName ?? "?", args: ev.toolArgs });
          } else if (ev.role === "tool") {
            flush();
            setOngoingTool(null);
            setHistorical((prev) => [
              ...prev,
              {
                id: `t-${Date.now()}-${Math.random()}`,
                role: "tool",
                text: ev.content,
                toolName: ev.toolName,
              },
            ]);
          } else if (ev.role === "error") {
            setHistorical((prev) => [
              ...prev,
              { id: `e-${Date.now()}`, role: "error", text: ev.error ?? ev.content },
            ]);
          } else if (ev.role === "warning") {
            setHistorical((prev) => [
              ...prev,
              { id: `w-${Date.now()}-${Math.random()}`, role: "warning", text: ev.content },
            ]);
          }
        }
        flush();
      } finally {
        clearInterval(timer);
        setStreaming(null);
        setOngoingTool(null);
        setSummary(loop.stats.summary());
        setBusy(false);
      }
    },
    [busy, codeApply, codeDiscard, codeMode, codeUndo, exit, loop, mcpSpecs, writeTranscript],
  );

  return (
    <Box flexDirection="column">
      <StatsPanel
        summary={summary}
        model={loop.model}
        prefixHash={prefixHash}
        harvestOn={loop.harvestEnabled}
        branchBudget={loop.branchOptions.budget}
      />
      <Static items={historical}>{(item) => <EventRow key={item.id} event={item} />}</Static>
      {streaming ? (
        <Box marginY={1}>
          <EventRow event={streaming} />
        </Box>
      ) : null}
      {ongoingTool ? <OngoingToolRow tool={ongoingTool} /> : null}
      <PromptInput value={input} onChange={setInput} onSubmit={handleSubmit} disabled={busy} />
      <CommandStrip codeMode={!!codeMode} />
    </Box>
  );
}

/**
 * Live spinner row while a tool call is in flight. Without this the
 * window between the model's `tool_calls` decision and the tool's
 * result (often seconds for a multi-KB `filesystem_edit_file`) looks
 * like the app has frozen — the streaming assistant display is
 * already cleared and the input is disabled, so there's nothing to
 * look at.
 */
function OngoingToolRow({ tool }: { tool: { name: string; args?: string } }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, []);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const argsPreview =
    tool.args && tool.args.length > 0 && tool.args !== "{}"
      ? `  ${tool.args.length > 60 ? `${tool.args.slice(0, 60)}…` : tool.args}`
      : "";
  return (
    <Box marginY={1}>
      <Text color="cyan">{frames[tick % frames.length]}</Text>
      <Text color="yellow">{` tool<${tool.name}> running…`}</Text>
      {argsPreview ? <Text dimColor>{argsPreview}</Text> : null}
    </Box>
  );
}

function CommandStrip({ codeMode }: { codeMode: boolean }) {
  return (
    <Box paddingX={2} flexDirection="column">
      <Text dimColor>
        /help · /preset {"<fast|smart|max>"} · /mcp · /compact · /sessions · /setup · /clear · /exit
      </Text>
      {codeMode ? (
        <Text dimColor>
          code mode: /apply · /discard · /undo · /commit "msg" — edits NEVER write without /apply
        </Text>
      ) : null}
      <Text dimColor>Esc (while thinking) — abort & summarize what was found so far</Text>
    </Box>
  );
}

/**
 * Render a batch of SEARCH/REPLACE application results as one
 * human-scannable info line per edit. Prefixes denote status so the
 * line reads well even without color (e.g. when piped to a log file
 * or stripped for screenshots):
 *   ✓ applied  src/foo.ts
 *   ✓ created  src/new.ts
 *   ✗ not-found  src/bar.ts (SEARCH text does not match…)
 */
function formatEditResults(results: ApplyResult[]): string {
  const lines = results.map((r) => {
    const mark = r.status === "applied" || r.status === "created" ? "✓" : "✗";
    const detail = r.message ? ` (${r.message})` : "";
    return `  ${mark} ${r.status.padEnd(11)} ${r.path}${detail}`;
  });
  const ok = results.filter((r) => r.status === "applied" || r.status === "created").length;
  const total = results.length;
  const header = `▸ edit blocks: ${ok}/${total} applied — /undo to roll back, or \`git diff\` to review`;
  return [header, ...lines].join("\n");
}

/**
 * Pending-edits preview shown after each assistant turn that proposed
 * changes. We keep it deliberately thin — path + approximate
 * ±line-count — because a full diff would crowd the TUI and the user
 * can always run `git diff` after /apply.
 */
function formatPendingPreview(blocks: EditBlock[]): string {
  const lines = blocks.map((b) => {
    const removed = b.search === "" ? 0 : countLines(b.search);
    const added = countLines(b.replace);
    const tag = b.search === "" ? "NEW " : "    ";
    return `  ${tag}${b.path}  (-${removed} +${added} lines)`;
  });
  const header = `▸ ${blocks.length} pending edit block(s) — /apply to commit to disk, /discard to drop`;
  return [header, ...lines].join("\n");
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  return (s.match(/\n/g)?.length ?? 0) + 1;
}

function formatUndoResults(results: ApplyResult[]): string {
  const lines = results.map((r) => {
    const mark = r.status === "applied" ? "✓" : "✗";
    const detail = r.message ? ` (${r.message})` : "";
    return `  ${mark} ${r.path}${detail}`;
  });
  return [`▸ undo: restored ${results.length} file(s) to pre-edit state`, ...lines].join("\n");
}

function describeRepair(repair: {
  scavenged: number;
  truncationsFixed: number;
  stormsBroken: number;
}): string {
  const parts: string[] = [];
  if (repair.scavenged) parts.push(`scavenged ${repair.scavenged}`);
  if (repair.truncationsFixed) parts.push(`repaired ${repair.truncationsFixed} truncation`);
  if (repair.stormsBroken) parts.push(`broke ${repair.stormsBroken} storm`);
  return parts.length ? `[repair] ${parts.join(", ")}` : "";
}
