import type { WriteStream } from "node:fs";
import { Box, Static, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { expandAtMentions } from "../../at-mentions.js";
import {
  type ApplyResult,
  type EditBlock,
  applyEditBlocks,
  parseEditBlocks,
  snapshotBeforeEdits,
  toWholeFileEditBlock,
} from "../../code/edit-blocks.js";
import { clearPendingEdits, loadPendingEdits, savePendingEdits } from "../../code/pending-edits.js";
import {
  type EditMode,
  type ReasoningEffort,
  addProjectShellAllowed,
  editModeHintShown,
  loadEditMode,
  loadReasoningEffort,
  markEditModeHintShown,
  saveEditMode,
  saveReasoningEffort,
} from "../../config.js";
import { type ResolvedHook, formatHookOutcomeMessage, loadHooks, runHooks } from "../../hooks.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";
import type { LoopEvent } from "../../loop.js";
import type { SessionSummary } from "../../telemetry.js";
import type { ToolRegistry } from "../../tools.js";
import { formatCommandResult, runCommand } from "../../tools/shell.js";
import { registerSkillTools } from "../../tools/skills.js";
import { formatSubagentResult, spawnSubagent } from "../../tools/subagent.js";
import { openTranscriptFile, recordFromLoopEvent, writeRecord } from "../../transcript.js";
import { appendUsage } from "../../usage.js";
import { AtMentionSuggestions } from "./AtMentionSuggestions.js";
import { EditConfirm, type EditReviewChoice } from "./EditConfirm.js";
import { type DisplayEvent, EventRow } from "./EventLog.js";
import { ModeStatusBar, OngoingToolRow, StatusRow, SubagentRow, UndoBanner } from "./LiveRows.js";
import { PlanConfirm, type PlanConfirmChoice } from "./PlanConfirm.js";
import { PlanRefineInput } from "./PlanRefineInput.js";
import { PromptInput } from "./PromptInput.js";
import { ShellConfirm, type ShellConfirmChoice, derivePrefix } from "./ShellConfirm.js";
import { SlashArgPicker } from "./SlashArgPicker.js";
import { SlashSuggestions } from "./SlashSuggestions.js";
import { StatsPanel } from "./StatsPanel.js";
import { detectBangCommand, formatBangUserMessage } from "./bang.js";
import { describeRepair, formatEditResults, formatPendingPreview } from "./edit-history.js";
import { handleMcpBrowseSlash } from "./mcp-browse.js";
import { formatLongPaste } from "./paste-collapse.js";
import { type McpServerSummary, handleSlash, parseSlash, suggestSlashCommands } from "./slash.js";
import { TickerProvider } from "./ticker.js";
import { useCompletionPickers } from "./useCompletionPickers.js";
import { useEditHistory } from "./useEditHistory.js";
import { useSessionInfo } from "./useSessionInfo.js";
import { useSubagent } from "./useSubagent.js";

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
   * Pre-captured inspection reports for each connected MCP server,
   * collected once at chat startup. Drives the rich `/mcp` slash view
   * (tools + resources + prompts per server).
   */
  mcpServers?: McpServerSummary[];
  /**
   * Shared ref the MCP bridge's onProgress callback writes through.
   * We attach our updater to `progressSink.current` on mount so any
   * `notifications/progress` frame from any bridged tool flows into
   * the UI. `null` allowed — chat mode without MCP leaves it unset.
   */
  progressSink?: {
    current:
      | ((info: { toolName: string; progress: number; total?: number; message?: string }) => void)
      | null;
  };
  /**
   * When set, parse SEARCH/REPLACE blocks from assistant responses and
   * apply them to disk under `rootDir`. Set by `reasonix code`. The
   * optional `jobs` registry enables /jobs + /kill slashes in the TUI
   * and the status-bar "N jobs running" indicator.
   */
  codeMode?: { rootDir: string; jobs?: import("../../tools/jobs.js").JobRegistry };
}

/**
 * Throttle interval in ms. We flush streaming deltas at most this often to
 * avoid re-rendering the whole UI on every single token from DeepSeek.
 * 100ms ≈ 10Hz, still feels live, gives fragile terminals (winpty/MINTTY)
 * enough room to finish a repaint before the next one arrives.
 */
const FLUSH_INTERVAL_MS = 100;

/**
 * True when the user has opted out of live spinner/streaming rows.
 * `REASONIX_UI=plain` suppresses every transient row in the render
 * tree so only the `<Static>` committed history + the input prompt
 * are drawn. Trades liveness for stability on terminals where Ink's
 * cursor-up repaint leaves ghost artifacts.
 */
const PLAIN_UI = process.env.REASONIX_UI === "plain";

interface StreamingState {
  id: string;
  text: string;
  reasoning: string;
  toolCallBuild?: { name: string; chars: number };
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
  mcpServers,
  progressSink,
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
  // Latest progress frame for the currently-running tool (MCP
  // `notifications/progress`). `null` when no progress has been
  // reported for this tool call — OngoingToolRow still spins, just
  // without a progress number.
  const [toolProgress, setToolProgress] = useState<{
    progress: number;
    total?: number;
    message?: string;
  } | null>(null);
  // Subagent UI wiring: live activity row + sink ref the loop closure
  // captures. Must be declared BEFORE loop construction so the
  // subagentRunner closure can read the ref.
  const { activity: subagentActivity, sinkRef: subagentSinkRef } = useSubagent({
    session,
    setHistorical,
  });
  // Transient "what's happening" text set by the loop during silent
  // phases (harvest round-trip, between-iteration R1 thinking, forced
  // summary). Rendered as a dim spinner row; auto-cleared on the next
  // primary event.
  const [statusLine, setStatusLine] = useState<string | null>(null);
  // Loaded user hooks (project + global settings.json). Stays mutable
  // so `/hooks reload` can rescan disk without reconstructing the
  // loop. The loop holds a parallel reference for its tool-event
  // dispatch; we keep them in sync via the effect below.
  const [hookList, setHookList] = useState<ResolvedHook[]>(() =>
    loadHooks({ projectRoot: codeMode?.rootDir }),
  );
  // Working directory reported in every hook's stdin payload. Hook
  // scripts that `cd $REASONIX_CWD` (or read `cwd` from the JSON
  // envelope) land in the project root, not the user's shell home.
  const hookCwd = codeMode?.rootDir ?? process.cwd();
  // Session-scoped edit history + undo banner + /undo, /history, /show
  // handlers. Kept in a custom hook so App.tsx only sees the small API
  // it needs — append an edit, arm the banner, answer the slash
  // callbacks, seal the turn entry, check whether anything's undoable.
  const {
    undoBanner,
    recordEdit,
    armUndoBanner,
    codeUndo,
    codeHistory,
    codeShowEdit,
    sealCurrentEntry,
    hasUndoable,
  } = useEditHistory(codeMode);
  // Pending edit blocks awaiting `/apply` or `/discard`. We do NOT
  // auto-apply — v0.4.1 showed that "model proposed, so apply" turns
  // analysis into unintended edits. The user explicitly confirms now.
  const pendingEdits = useRef<EditBlock[]>([]);
  // Reactive mirror of `pendingEdits.current.length`. Refs don't trigger
  // re-renders, but the bottom mode-status bar needs to show the queue
  // size live — this keeps the number in sync whenever the queue grows
  // (interceptor / text-SEARCH parse / checkpoint restore) or clears
  // (/apply / /discard / /new).
  const [pendingCount, setPendingCount] = useState(0);
  const syncPendingCount = useCallback(() => {
    setPendingCount(pendingEdits.current.length);
  }, []);
  // Edit-gate mode. `review` (default) queues edits into pendingEdits;
  // `auto` applies them immediately and exposes an undo banner. Shift+
  // Tab cycles, `/mode <review|auto>` sets explicitly. Persisted so
  // toggling once survives a relaunch.
  const [editMode, setEditMode] = useState<EditMode>(() => (codeMode ? loadEditMode() : "review"));
  // Interceptor closure reads the live mode through this ref — so we
  // install the registry hook once (in useEffect below) and avoid tearing
  // down + reattaching it every time the user cycles modes.
  const editModeRef = useRef<EditMode>(editMode);
  useEffect(() => {
    editModeRef.current = editMode;
    if (codeMode) saveEditMode(editMode);
  }, [editMode, codeMode]);
  // Current per-edit confirmation prompt (review mode, tool-call path).
  // Non-null → EditConfirm modal renders, interceptor is suspended on
  // `editReviewResolveRef.current`, other live rows hide. User picks a
  // choice → handleEditReviewChoose resolves the promise, interceptor
  // resumes and returns the tool result the model will see.
  const [pendingEditReview, setPendingEditReview] = useState<EditBlock | null>(null);
  const editReviewResolveRef = useRef<((c: EditReviewChoice) => void) | null>(null);
  // Per-turn override: set by "apply-rest-of-turn" so subsequent edits
  // in the SAME turn skip the modal and land like AUTO. Resets to "ask"
  // at handleSubmit entry so the next user turn starts fresh.
  const turnEditPolicyRef = useRef<"ask" | "apply-all">("ask");
  // Visual highlight on the bottom mode bar for ~1.2s after Shift+Tab /
  // /mode flips the mode — a soft "yes, it changed" signal so the user
  // doesn't have to scan the header to confirm the toggle landed.
  const [modeFlash, setModeFlash] = useState(false);
  const modeFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevEditModeRef = useRef<EditMode>(editMode);
  useEffect(() => {
    if (prevEditModeRef.current === editMode) return;
    prevEditModeRef.current = editMode;
    setModeFlash(true);
    if (modeFlashTimeoutRef.current) clearTimeout(modeFlashTimeoutRef.current);
    modeFlashTimeoutRef.current = setTimeout(() => {
      setModeFlash(false);
      modeFlashTimeoutRef.current = null;
    }, 1200);
  }, [editMode]);
  // Shell command the model asked to run that wasn't on the auto-run
  // allowlist. Non-null renders the ShellConfirm modal and disables
  // the prompt input; the user picks Run once / Always allow in this
  // project / Deny and we feed the result back as a synthetic user
  // message so the model sees what happened.
  const [pendingShell, setPendingShell] = useState<{
    command: string;
    /**
     * Which tool surfaced the NeedsConfirmationError. Drives post-
     * approval dispatch: `run_command` uses the synchronous runCommand
     * (waits for exit); `run_background` spawns via JobRegistry and
     * returns after a ready-signal / waitSec window.
     */
    kind: "run_command" | "run_background";
  } | null>(null);
  // Plan text the model submitted via `submit_plan` while plan mode
  // was active. Non-null renders PlanConfirm; user picks Approve /
  // Refine / Cancel and we drive the loop from there. Separate from
  // `planMode` because a pending plan is a one-shot decision even if
  // plan mode stays on (Refine keeps mode on; Approve/Cancel flip off).
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  // Stashed plan + intent while the user types free-form feedback
  // (refinement or last instructions on approve). When the picker
  // returns "refine" or "approve", we defer the loop-resume and show
  // PlanRefineInput. User types + Enter → we ship it; Esc → restore
  // pendingPlan and re-show the picker. Letting Approve also take
  // input closes the "model left open questions, user had no place
  // to answer them" hole.
  const [stagedInput, setStagedInput] = useState<{
    plan: string;
    mode: "refine" | "approve";
  } | null>(null);
  // Plan-mode indicator — displayed in the StatsPanel, mirrored onto
  // the ToolRegistry so dispatch enforces read-only. Toggled via the
  // `/plan` slash and PlanConfirm picker. Ephemeral — not persisted
  // across launches (you explicitly opt in per session).
  const [planMode, setPlanMode] = useState<boolean>(false);
  // /pro armed — next turn will run on v4-pro. Mirrored here (rather
  // than reading loop.proArmed directly) so state transitions trigger
  // a StatsPanel re-render that picks up the new badge.
  const [proArmed, setProArmed] = useState(false);
  // True while the CURRENT running turn is on v4-pro because of either
  // /pro arming or auto-escalation. Set on turn-start if armed consumed
  // OR any "⇧ pro" warning fires, cleared at turn-end.
  const [turnOnPro, setTurnOnPro] = useState(false);
  // Text waiting to be submitted AFTER the current turn finishes.
  // Set by ShellConfirm's onChoose when the user approves faster than
  // the model's "awaiting confirmation" response. We can't call
  // handleSubmit directly because it early-returns on `busy === true`,
  // so we abort the in-flight turn and let the effect below fire the
  // submit once busy clears.
  const [queuedSubmit, setQueuedSubmit] = useState<string | null>(null);
  // Shell-style history of user prompts. ↑/↓ while idle walks it;
  // submit pushes to the end. Cursor -1 = "live input", 0+ = "N turns
  // back from newest". We don't persist history to disk — sessions
  // already keep the message log, and cross-session bash-style recall
  // would need per-project scoping we haven't designed.
  const promptHistory = useRef<string[]>([]);
  const historyCursor = useRef<number>(-1);
  // Disambiguates <Static> keys when a single turn yields multiple assistant_final events.
  const assistantIterCounter = useRef<number>(0);
  // Full untruncated tool results, in arrival order. The EventLog
  // renderer clips tool output at 400 chars for display; `/tool N`
  // reads from this ref to show the real thing. Not persisted — a
  // resumed session replays the log (which has the same content in
  // `tool` messages) but we don't repopulate this ref on resume
  // because the user wouldn't expect `/tool` to reach back across
  // process boundaries.
  const toolHistoryRef = useRef<Array<{ toolName: string; text: string }>>([]);
  const [summary, setSummary] = useState<SessionSummary>({
    turns: 0,
    totalCostUsd: 0,
    totalInputCostUsd: 0,
    totalOutputCostUsd: 0,
    claudeEquivalentUsd: 0,
    savingsVsClaudePct: 0,
    cacheHitRatio: 0,
    lastPromptTokens: 0,
    lastTurnCostUsd: 0,
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
  // hookList + hookCwd intentionally NOT in deps — they seed the loop
  // on first construction (loopRef guards a single instantiation), and
  // later edits flow in through the mutable `loop.hooks = hookList`
  // effect below. Putting them in deps would tear down the loop on
  // every reload, wiping the append-only log mid-session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hookList — see comment above
  // biome-ignore lint/correctness/useExhaustiveDependencies: hookCwd — see comment above
  const loop = useMemo(() => {
    if (loopRef.current) return loopRef.current;
    const client = new DeepSeekClient();
    // Register run_skill HERE (not in code.tsx / chat.tsx) because
    // subagent-runAs skills need the client + parent registry to
    // spawn child loops. Wiring lives in App.tsx so the same code
    // path covers both code mode and chat mode.
    //
    // The closure captures `tools` (parent registry), `client`, and
    // the subagent sink ref by lexical scope — `spawnSubagent` reads
    // them per invocation, so a sink handler attached after this
    // registration still receives events.
    if (tools && !tools.has("run_skill")) {
      registerSkillTools(tools, {
        projectRoot: codeMode?.rootDir,
        subagentRunner: async (skill, task) => {
          const result = await spawnSubagent({
            client,
            parentRegistry: tools,
            // Skill body is the subagent's persona/playbook; the user-
            // supplied task is what to actually do inside it.
            system: skill.body,
            task,
            // Per-skill model override (frontmatter `model: ...`),
            // else falls through to spawnSubagent's default.
            model: skill.model,
            sink: subagentSinkRef.current,
            // Stamped onto every event so the TUI sink + usage log can
            // attribute the run to a skill without extra bookkeeping.
            skillName: skill.name,
          });
          return formatSubagentResult(result);
        },
      });
    }
    const prefix = new ImmutablePrefix({
      system,
      toolSpecs: tools?.specs(),
    });
    const l = new CacheFirstLoop({
      client,
      prefix,
      tools,
      model,
      harvest,
      branch,
      session,
      hooks: hookList,
      hookCwd,
      // Restore the user's last-chosen effort cap. Without this a
      // `/effort high` silently reverted to `max` on relaunch — the
      // loop's constructor default wins over persisted state.
      reasoningEffort: loadReasoningEffort(),
    });
    loopRef.current = l;
    return l;
  }, [model, system, harvest, branch, session, tools, codeMode]);

  // Keep the loop's hook list in sync after a `/hooks reload`. The
  // loop's field is intentionally mutable for exactly this case —
  // construction happens once, hook edits are picked up live.
  useEffect(() => {
    loop.hooks = hookList;
  }, [loop, hookList]);

  // Ambient session info (balance, model catalog, latest published
  // version) — three independent mount-time fetches behind one hook
  // so the refresh callbacks can be wired into handleSubmit's finally
  // (balance) and the slash context (/models, /update).
  const {
    balance,
    models,
    latestVersion,
    updateAvailable,
    refreshBalance,
    refreshModels,
    refreshLatestVersion,
  } = useSessionInfo(loop);

  // Three mutually-exclusive input-prefix pickers (slash name, @ file
  // mention, slash argument) — state + memos + commit callbacks live
  // in a dedicated hook so App.tsx only sees the small surface it
  // actually consumes in useInput / handleSubmit / render. Declared
  // after useSessionInfo because the slash-arg picker reads the model
  // catalog for `/model <partial>` completion.
  const {
    slashMatches,
    slashSelected,
    setSlashSelected,
    atPicker,
    atMatches,
    atSelected,
    setAtSelected,
    pickAtMention,
    recordRecentFile,
    slashArgContext,
    slashArgMatches,
    slashArgSelected,
    setSlashArgSelected,
    pickSlashArg,
  } = useCompletionPickers({ input, setInput, codeMode, models, mcpServers });

  // Wire the shared progressSink so the bridge's onProgress → us.
  // Only updates progress when the frame belongs to the currently-
  // running tool: late frames from a previous call shouldn't overwrite
  // the spinner of whatever's running next.
  useEffect(() => {
    if (!progressSink) return;
    progressSink.current = (info) => {
      setToolProgress({
        progress: info.progress,
        total: info.total,
        message: info.message,
      });
    };
    return () => {
      if (progressSink.current) progressSink.current = null;
    };
  }, [progressSink]);

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
    // Restore any pending edit queue from a prior run that was
    // interrupted before /apply or /discard. The checkpoint file sits
    // next to the session log; if present, we re-populate pendingEdits
    // and post an info row so the user knows what's waiting.
    if (session && codeMode) {
      const restored = loadPendingEdits(session);
      if (restored && restored.length > 0) {
        pendingEdits.current = restored;
        syncPendingCount();
        setHistorical((prev) => [
          ...prev,
          {
            id: `sys-pending-${Date.now()}`,
            role: "info",
            text: `▸ restored ${restored.length} pending edit block(s) from an interrupted prior run — /apply to commit or /discard to drop.`,
          },
        ]);
      }
    }
    // One-time onboarding tip for the edit-gate keybindings. New users
    // wouldn't otherwise discover Shift+Tab (it's in /keys and the
    // bottom status bar, but both require looking). Shown exactly once
    // per install; the config flag suppresses re-display on every
    // relaunch. Skips chat mode — those shortcuts don't apply there.
    if (codeMode && !editModeHintShown()) {
      setHistorical((prev) => [
        ...prev,
        {
          id: `sys-edittip-${Date.now()}`,
          role: "info",
          text:
            "▸ TIP: edit-gate keybindings\n" +
            "    y / n       accept or drop pending edits\n" +
            "    Shift+Tab   switch review ↔ AUTO (persisted; AUTO applies instantly)\n" +
            "    u           undo the last auto-applied batch (within the 5s banner)\n" +
            "  Current mode is shown in the bottom status bar. Run /keys anytime for the full list.\n" +
            "  (This tip shows once — suppressed after.)",
        },
      ]);
      markEditModeHintShown();
    }
  }, [session, loop, codeMode, syncPendingCount]);

  // Esc during busy → forward to the loop as an abort signal. The loop
  // finishes the tool call in flight (we can't kill subprocess stdio
  // mid-write), then diverts to its no-tools summary path so the user
  // gets an answer instead of a hard stop. Only listens while busy so
  // we don't accidentally hijack Esc in other contexts.
  //
  // Also handles ↑/↓ shell-style history while idle. We don't use
  // ink-text-input's (absent) history support; parent-level useInput
  // is simpler and lets us own the cursor semantics.
  useInput((chKey, key) => {
    if (key.escape && busy) {
      if (abortedThisTurn.current) return;
      abortedThisTurn.current = true;
      // If an edit-review modal is up, resolve its promise first so the
      // interceptor unblocks — otherwise the tool call hangs past the
      // loop's abort and the next turn can't start. Esc during modal =
      // "reject this edit" (safe default — nothing lands on disk).
      const resolve = editReviewResolveRef.current;
      if (resolve) {
        editReviewResolveRef.current = null;
        setPendingEditReview(null);
        resolve("reject");
      }
      loop.abort();
      return;
    }
    // Edit-mode cycle: Shift+Tab flips review ↔ auto. Available any
    // time a modal isn't up — including mid-turn — so the user can
    // switch gears without abandoning the in-flight request. Prefer
    // this to typing `/mode <x>`; one keystroke, no command parsing.
    if (
      codeMode &&
      key.shift &&
      key.tab &&
      !pendingShell &&
      !pendingPlan &&
      !stagedInput &&
      !pendingEditReview
    ) {
      setEditMode((m) => {
        const next: EditMode = m === "auto" ? "review" : "auto";
        setHistorical((prev) => [
          ...prev,
          {
            id: `mode-${Date.now()}`,
            role: "info",
            text:
              next === "auto"
                ? "▸ edit mode: AUTO — edits apply immediately; press u within 5s to undo"
                : "▸ edit mode: review — edits queue for /apply (or y) / /discard (or n)",
          },
        ]);
        return next;
      });
      return;
    }
    // Undo banner keybind: `u` rolls back the last auto-apply. Gated
    // on an empty prompt buffer so typing "user" into the input doesn't
    // steal from the first keystroke. 5-second window; after that the
    // banner self-dismisses and /undo remains the only path.
    if (
      codeMode &&
      input.length === 0 &&
      (chKey === "u" || chKey === "U") &&
      !pendingShell &&
      !pendingPlan &&
      !stagedInput &&
      !pendingEditReview &&
      // Fire when EITHER the banner is up OR there's any non-undone
      // history entry — the keybind is useful long after the 5-second
      // banner expires, which users rightly want.
      (undoBanner || hasUndoable())
    ) {
      const out = codeUndo([]);
      setHistorical((prev) => [...prev, { id: `undo-${Date.now()}`, role: "info", text: out }]);
      return;
    }
    if (busy) return;
    // ShellConfirm owns the full keyboard while it's showing. If we
    // kept handling ↑/↓ / Tab here they'd race with its SingleSelect
    // — the picker would move AND history recall would fire into the
    // (hidden) prompt buffer. Bail early.
    if (pendingShell) return;

    // @-mention picker takes the same priority tier as slash. When
    // the user is typing `@…` in code mode and there are file matches,
    // ↑/↓ walk the list and Tab substitutes the selected path. Enter
    // is caught in handleSubmit. Must come BEFORE slash so the two
    // pickers don't fight over arrow keys (mutually exclusive by
    // construction — atPicker is null when slashMatches is set).
    if (atMatches && atMatches.length > 0) {
      if (key.upArrow) {
        setAtSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setAtSelected((i) => Math.min(atMatches.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const sel = atMatches[atSelected] ?? atMatches[0];
        if (sel) pickAtMention(sel);
        return;
      }
    }

    // Slash-argument picker. Fires inside `/<cmd> <partial>` — either
    // a file picker (for /edit), enum picker (for /preset, /model,
    // /plan, /branch, /harvest), or hint-only row. Navigation + Tab
    // substitute the highlighted value at the arg's offset.
    if (slashArgMatches && slashArgMatches.length > 0) {
      if (key.upArrow) {
        setSlashArgSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSlashArgSelected((i) => Math.min(slashArgMatches.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const sel = slashArgMatches[slashArgSelected] ?? slashArgMatches[0];
        if (sel) pickSlashArg(sel);
        return;
      }
    }

    // Slash-suggestion mode takes priority over history recall.
    // When the user is typing a `/…` prefix and there are matches,
    // ↑/↓ walk the suggestion list and Tab snaps the input to the
    // highlighted command. Enter is handled in `handleSubmit` so
    // TextInput's onSubmit still fires cleanly.
    if (slashMatches && slashMatches.length > 0) {
      if (key.upArrow) {
        setSlashSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSelected((i) => Math.min(slashMatches.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const sel = slashMatches[slashSelected] ?? slashMatches[0];
        if (sel) setInput(`/${sel.cmd}`);
        return;
      }
    }

    // Outside slash mode: ↑/↓ recall prior prompts — but ONLY when the
    // buffer is empty. A non-empty buffer hands those keys to
    // PromptInput for cursor movement (multi-line navigation, or a
    // no-op on single-line) so the user doesn't accidentally clobber
    // typed text with a recalled prompt.
    if (input.length === 0) {
      const hist = promptHistory.current;
      if (key.upArrow) {
        if (hist.length === 0) return;
        const nextCursor = Math.min(historyCursor.current + 1, hist.length - 1);
        historyCursor.current = nextCursor;
        setInput(hist[hist.length - 1 - nextCursor] ?? "");
        return;
      }
      if (key.downArrow) {
        if (historyCursor.current < 0) return;
        const nextCursor = historyCursor.current - 1;
        historyCursor.current = nextCursor;
        setInput(nextCursor < 0 ? "" : (hist[hist.length - 1 - nextCursor] ?? ""));
        return;
      }
    }
  });

  // Edit-gate interceptor. Reroutes `edit_file` / `write_file` tool
  // calls through the review queue (in `review` mode) or the auto-apply
  // snapshot/banner path (in `auto` mode) so the model's tool usage
  // respects the same gate as its text-form SEARCH/REPLACE output.
  // Without this, edit_file bypasses `/apply` entirely — which was the
  // bug that made the preview flow feel absent pre-0.5.24.
  //
  // `editModeRef` is read inside the closure so mode cycles don't need
  // to reinstall the hook. Cleanup clears the slot on unmount so a
  // follow-up App instance (tests, HMR) starts with a fresh registry.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: session / setEditMode / syncPendingCount are intentional closure captures — their updaters are stable and we don't want to tear down and rebuild the interceptor on unrelated state churn
  useEffect(() => {
    if (!tools || !codeMode) return;
    tools.setToolInterceptor(async (name, args) => {
      if (name !== "edit_file" && name !== "write_file") return null;
      const rawPath = typeof args.path === "string" ? args.path : "";
      if (!rawPath) return null;
      // Mirror filesystem.ts safePath's leading-slash tolerance so
      // `/src/foo.ts` doesn't get misrouted through applyEditBlock's
      // rootDir-escape check.
      let relPath = rawPath;
      while (relPath.startsWith("/") || relPath.startsWith("\\")) {
        relPath = relPath.slice(1);
      }
      if (!relPath) return null;

      let block: EditBlock;
      if (name === "edit_file") {
        const search = typeof args.search === "string" ? args.search : "";
        const replace = typeof args.replace === "string" ? args.replace : "";
        if (!search) return null; // let the tool fn surface the "empty search" error
        block = { path: relPath, search, replace, offset: 0 };
      } else {
        // write_file: capture the current content (if any) as SEARCH so
        // the queued block is a literal whole-file overwrite. For new
        // files SEARCH stays empty — applyEditBlock's create-new sentinel.
        const content = typeof args.content === "string" ? args.content : "";
        block = toWholeFileEditBlock(relPath, content, codeMode.rootDir);
      }

      // Helper: apply the current block + record into history + arm
      // undo + echo a row. Used by auto mode AND by the various
      // "apply" branches of the review modal so we don't duplicate
      // the snapshot/apply/banner logic.
      const applyNow = (): string => {
        const snaps = snapshotBeforeEdits([block], codeMode.rootDir);
        const results = applyEditBlocks([block], codeMode.rootDir);
        const good = results.some((r) => r.status === "applied" || r.status === "created");
        if (good) {
          recordEdit("auto", [block], results, snaps);
          armUndoBanner(results);
        }
        setHistorical((prev) => [
          ...prev,
          {
            id: `ae-${Date.now()}-${Math.random()}`,
            role: "info",
            text: formatEditResults(results),
          },
        ]);
        return formatEditResults(results);
      };

      if (editModeRef.current === "auto") return applyNow();

      // review mode, tool-call path: suspend the interceptor on the
      // per-edit modal unless the user has already hit "apply-rest-of-
      // turn" earlier in the same turn. Text-form SEARCH/REPLACE blocks
      // in assistant_final still queue for end-of-turn preview — they
      // land all at once with no mid-stream opportunity to prompt.
      if (turnEditPolicyRef.current === "apply-all") return applyNow();

      const choice = await new Promise<EditReviewChoice>((resolveChoice) => {
        editReviewResolveRef.current = resolveChoice;
        setPendingEditReview(block);
      });
      // Clear the pending-review slot synchronously so a rapid-fire next
      // tool call doesn't race the React state settling.
      editReviewResolveRef.current = null;
      setPendingEditReview(null);

      if (choice === "reject") {
        setHistorical((prev) => [
          ...prev,
          {
            id: `er-${Date.now()}-${Math.random()}`,
            role: "info",
            text: `▸ rejected edit to ${block.path}`,
          },
        ]);
        return `User rejected this edit to ${block.path}. Don't retry the same SEARCH/REPLACE — either try a different approach or ask the user what they want instead.`;
      }
      if (choice === "apply-rest-of-turn") {
        turnEditPolicyRef.current = "apply-all";
        setHistorical((prev) => [
          ...prev,
          {
            id: `er-${Date.now()}-${Math.random()}`,
            role: "info",
            text: "▸ auto-approving remaining edits for this turn",
          },
        ]);
        return applyNow();
      }
      if (choice === "flip-to-auto") {
        setEditMode("auto");
        setHistorical((prev) => [
          ...prev,
          {
            id: `er-${Date.now()}-${Math.random()}`,
            role: "info",
            text: "▸ flipped to AUTO mode for the rest of the session (persisted)",
          },
        ]);
        return applyNow();
      }
      // "apply"
      return applyNow();
    });
    return () => {
      tools.setToolInterceptor(null);
    };
  }, [tools, codeMode, session, recordEdit, armUndoBanner, syncPendingCount, setEditMode]);

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
    if (anyApplied) recordEdit("review-apply", blocks, results, snaps);
    pendingEdits.current = [];
    clearPendingEdits(session ?? null);
    syncPendingCount();
    return formatEditResults(results);
  }, [codeMode, session, syncPendingCount, recordEdit]);

  /**
   * /discard callback — forget the pending edits without touching
   * disk. Keeps the conversation going without the user having to
   * argue the model out of its proposal.
   */
  const codeDiscard = useCallback((): string => {
    const count = pendingEdits.current.length;
    if (count === 0) return "nothing pending to discard.";
    pendingEdits.current = [];
    clearPendingEdits(session ?? null);
    syncPendingCount();
    return `▸ discarded ${count} pending edit block(s). Nothing was written to disk.`;
  }, [session, syncPendingCount]);

  const prefixHash = loop.prefix.fingerprint;

  const writeTranscript = useCallback(
    (ev: LoopEvent) => {
      const stream = transcriptRef.current;
      if (!stream) return;
      writeRecord(stream, recordFromLoopEvent(ev, { model, prefixHash }));
    },
    [model, prefixHash],
  );

  /**
   * Toggle plan mode on the local state AND on the ToolRegistry. The
   * registry's copy is what actually gates dispatch; the local state
   * drives the StatsPanel indicator and slash ergonomics. Kept in sync
   * by funneling every toggle through this setter.
   */
  const togglePlanMode = useCallback(
    (on: boolean) => {
      setPlanMode(on);
      tools?.setPlanMode(on);
    },
    [tools],
  );

  /** Clear the pending-plan picker state; safe to call unconditionally. */
  const clearPendingPlan = useCallback(() => {
    setPendingPlan(null);
  }, []);

  const handleSubmit = useCallback(
    async (raw: string) => {
      let text = raw.trim();
      if (!text || busy) return;

      // @-mention picker intercept. When the picker is open (trailing
      // `@…` with file matches), Enter substitutes the highlighted
      // path INTO the buffer and does NOT submit — the user almost
      // always types more after a mention ("look at @file.ts and…").
      // Substituting adds a trailing space which dismisses the picker,
      // so the next Enter submits normally.
      if (atMatches && atMatches.length > 0 && atPicker) {
        const sel = atMatches[atSelected] ?? atMatches[0];
        if (sel) {
          pickAtMention(sel);
          return;
        }
      }

      // Slash-argument picker intercept — same shape as @-picker. For
      // file pickers (/edit) we splice + trailing space so the user
      // keeps typing the instruction. For enum pickers (/preset,
      // /model, /plan, …) we splice without trailing space; those
      // commands take no further args, so the user presses Enter a
      // second time to run.
      if (slashArgMatches && slashArgMatches.length > 0 && slashArgContext) {
        const sel = slashArgMatches[slashArgSelected] ?? slashArgMatches[0];
        if (sel) {
          pickSlashArg(sel);
          return;
        }
      }

      // Slash auto-complete on Enter. When the user typed a prefix
      // (e.g. "/he") and the suggestion list is visible, substitute
      // the highlighted match so Enter runs it — same effect as Tab
      // + Enter, one keystroke less. Skip substitution if the user
      // already typed a full, exact command name (respect verbatim
      // input when they know what they want).
      if (text.startsWith("/") && !text.includes(" ")) {
        const typed = text.slice(1).toLowerCase();
        const matches = suggestSlashCommands(typed, !!codeMode);
        const exact = matches.find((m) => m.cmd === typed);
        if (!exact && matches.length > 0) {
          const chosen = matches[slashSelected] ?? matches[0];
          if (chosen) text = `/${chosen.cmd}`;
        }
      }

      setInput("");
      historyCursor.current = -1;

      // Y/N fast-path when edits are pending. One keystroke is all it
      // takes to commit or drop — matches the muscle memory of `git
      // add -p` / most prompts. Deliberately scoped: only when there
      // ARE pending edits, so "y" as a normal message still works
      // when nothing's waiting.
      if (codeMode && pendingEdits.current.length > 0 && (text === "y" || text === "n")) {
        const out = text === "y" ? codeApply() : codeDiscard();
        setHistorical((prev) => [...prev, { id: `sys-${Date.now()}`, role: "info", text: out }]);
        promptHistory.current.push(text);
        return;
      }

      // Bash mode — `!cmd` runs a shell command in the sandbox root
      // immediately (no allowlist gate: user-typed = explicit consent),
      // surfaces the formatted output in the Historical log, and
      // persists a user-role message so the next model turn sees what
      // happened AND the bang exchange survives session resume.
      const bangCmd = detectBangCommand(text);
      if (bangCmd !== null) {
        const bangRoot = codeMode?.rootDir ?? process.cwd();
        promptHistory.current.push(text);
        setHistorical((prev) => [
          ...prev,
          {
            id: `bang-u-${Date.now()}`,
            role: "user",
            text,
            leadSeparator: prev.length > 0,
          },
        ]);
        setBusy(true);
        try {
          const result = await runCommand(bangCmd, {
            cwd: bangRoot,
            timeoutSec: 60,
            maxOutputChars: 32_000,
          });
          const formatted = formatCommandResult(bangCmd, result);
          setHistorical((prev) => [
            ...prev,
            { id: `bang-o-${Date.now()}`, role: "info", text: formatted },
          ]);
          loop.appendAndPersist({
            role: "user",
            content: formatBangUserMessage(bangCmd, formatted),
          });
        } catch (err) {
          setHistorical((prev) => [
            ...prev,
            {
              id: `bang-e-${Date.now()}`,
              role: "warning",
              text: `! command failed: ${(err as Error).message}`,
            },
          ]);
        } finally {
          setBusy(false);
        }
        return;
      }

      // MCP resource / prompt browsers — async calls that don't fit the
      // synchronous handleSlash shape, so we intercept the exact command
      // forms here. The slash-command registry still lists them (for
      // /help + argument-level picker completion), but this branch is
      // what actually runs the read/fetch.
      const mcpBrowseMatch = /^\/(resource|prompt)(?:\s+([\s\S]*))?$/.exec(text);
      if (mcpBrowseMatch) {
        const kind = mcpBrowseMatch[1] as "resource" | "prompt";
        const arg = mcpBrowseMatch[2]?.trim() ?? "";
        promptHistory.current.push(text);
        setHistorical((prev) => [
          ...prev,
          { id: `mcp-u-${Date.now()}`, role: "user", text, leadSeparator: prev.length > 0 },
        ]);
        await handleMcpBrowseSlash(kind, arg, mcpServers ?? [], setHistorical);
        return;
      }

      const slash = parseSlash(text);
      if (slash) {
        const result = handleSlash(slash.cmd, slash.args, loop, {
          mcpSpecs,
          mcpServers,
          codeUndo: codeMode ? codeUndo : undefined,
          codeApply: codeMode ? codeApply : undefined,
          codeDiscard: codeMode ? codeDiscard : undefined,
          codeHistory: codeMode ? codeHistory : undefined,
          codeShowEdit: codeMode ? codeShowEdit : undefined,
          codeRoot: codeMode?.rootDir,
          pendingEditCount: codeMode ? pendingEdits.current.length : undefined,
          toolHistory: () => toolHistoryRef.current,
          memoryRoot: codeMode?.rootDir ?? process.cwd(),
          planMode,
          setPlanMode: codeMode ? togglePlanMode : undefined,
          clearPendingPlan: codeMode ? clearPendingPlan : undefined,
          editMode: codeMode ? editMode : undefined,
          setEditMode: codeMode ? setEditMode : undefined,
          armPro: () => {
            loop.armProForNextTurn();
            setProArmed(true);
          },
          disarmPro: () => {
            loop.disarmPro();
            setProArmed(false);
          },
          jobs: codeMode?.jobs,
          postInfo: (text: string) =>
            setHistorical((prev) => [
              ...prev,
              { id: `sys-late-${Date.now()}-${Math.random()}`, role: "info", text },
            ]),
          reloadHooks: () => {
            const fresh = loadHooks({ projectRoot: codeMode?.rootDir });
            setHookList(fresh);
            return fresh.length;
          },
          latestVersion,
          refreshLatestVersion,
          models,
          refreshModels,
        });
        if (result.exit) {
          transcriptRef.current?.end();
          exit();
          return;
        }
        if (result.clear && result.info) {
          // Clear + message: wipe scrollback, then seed the new view
          // with the explanatory info line so the user sees *what
          // happened*. Previously clear alone left them staring at
          // an empty screen with no confirmation.
          setHistorical([
            {
              id: `sys-${Date.now()}`,
              role: "info",
              text: result.info,
            },
          ]);
          // /new wipes conversation; any pending edits from the prior
          // assistant turn are stale (the user no longer sees the
          // preview). Drop them so a later /apply doesn't surprise.
          if (codeMode) {
            pendingEdits.current = [];
            clearPendingEdits(session ?? null);
            syncPendingCount();
          }
          return;
        }
        if (result.clear) {
          setHistorical([]);
          if (codeMode) {
            pendingEdits.current = [];
            clearPendingEdits(session ?? null);
            syncPendingCount();
          }
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
        // `/retry` (and anything else that requests a resubmit) falls
        // through to the normal user-message flow with the provided
        // text instead of returning.
        if (result.resubmit) {
          text = result.resubmit;
        } else {
          promptHistory.current.push(text);
          return;
        }
      }

      // UserPromptSubmit hooks. Exit code 2 from any matching hook
      // drops the message entirely (the user's text never reaches
      // the model). Other non-zero exits surface as warning rows but
      // the prompt still goes through. We render every non-pass
      // outcome's stderr inline so a "blocked" choice has a visible
      // explanation.
      if (hookList.some((h) => h.event === "UserPromptSubmit")) {
        const promptReport = await runHooks({
          hooks: hookList,
          payload: { event: "UserPromptSubmit", cwd: hookCwd, prompt: text },
        });
        if (promptReport.outcomes.length > 0) {
          setHistorical((prev) => [
            ...prev,
            ...promptReport.outcomes
              .filter((o) => o.decision !== "pass")
              .map((o) => ({
                id: `hp-${Date.now()}-${Math.random()}`,
                role: "warning" as const,
                text: formatHookOutcomeMessage(o),
              })),
          ]);
        }
        if (promptReport.blocked) return;
      }

      // User message is immutable — push to Static immediately.
      // Large pastes (stack traces, log dumps, file contents) get a
      // collapsed preview in Historical so scrollback stays navigable;
      // the MODEL still receives the full text below via modelInput.
      promptHistory.current.push(text);
      const pasteDisplay = formatLongPaste(text);
      setHistorical((prev) => [
        ...prev,
        // `leadSeparator`: thin rule above this user turn when history
        // isn't empty — visual pacing for multi-turn sessions. First
        // user message leaves it off so the UI doesn't open with a
        // dangling divider.
        {
          id: `u-${Date.now()}`,
          role: "user",
          text: pasteDisplay.displayText,
          leadSeparator: prev.length > 0,
        },
      ]);

      const assistantId = `a-${Date.now()}`;
      // Refs are the source of truth for accumulated streaming text; the React
      // state copy below is only for rendering and gets updated on flush.
      const streamRef: StreamingState = { id: assistantId, text: "", reasoning: "" };
      const contentBuf = { current: "" };
      const reasoningBuf = { current: "" };
      // Coalesces tool_call_delta events into one re-render per flush tick.
      const toolCallBuildBuf: {
        current: {
          name: string;
          chars: number;
          index?: number;
          readyCount?: number;
        } | null;
      } = {
        current: null,
      };

      setStreaming({ id: assistantId, role: "assistant", text: "", streaming: true });
      setBusy(true);
      abortedThisTurn.current = false;
      // Seal the in-progress history entry so this turn's edits open
      // a new one — prior turns are preserved intact for /history and
      // `/undo` to walk back through independently.
      if (codeMode) sealCurrentEntry();
      // Reset per-turn edit policy so "apply-rest-of-turn" from the
      // previous turn doesn't carry over silently. User expects each
      // new prompt to start with the normal review gate re-armed.
      turnEditPolicyRef.current = "ask";
      // Pro badge state: if /pro was armed, this turn consumes it; the
      // loop emits a "⇧ /pro armed" warning we'll catch below. Clear
      // the armed mirror so the badge flips to "escalated" (via the
      // warning handler) rather than staying at "armed" during the
      // actual run.
      if (proArmed) {
        setProArmed(false);
        setTurnOnPro(true);
      } else {
        setTurnOnPro(false);
      }

      const flush = () => {
        if (!contentBuf.current && !reasoningBuf.current && !toolCallBuildBuf.current) return;
        streamRef.text += contentBuf.current;
        streamRef.reasoning += reasoningBuf.current;
        if (toolCallBuildBuf.current) {
          streamRef.toolCallBuild = toolCallBuildBuf.current;
        }
        contentBuf.current = "";
        reasoningBuf.current = "";
        toolCallBuildBuf.current = null;
        setStreaming({
          id: assistantId,
          role: "assistant",
          text: streamRef.text,
          reasoning: streamRef.reasoning || undefined,
          toolCallBuild: streamRef.toolCallBuild,
          streaming: true,
        });
      };
      // In PLAIN mode the streaming row is suppressed, so flushing into
      // streamRef does no visible work — skip the interval entirely.
      const timer = PLAIN_UI ? null : setInterval(flush, FLUSH_INTERVAL_MS);

      // Expand `@path/to/file.ts` mentions in code mode: the model
      // gets the inlined content appended under a "Referenced files"
      // block; the Historical row above keeps the user's verbatim text
      // so the display doesn't balloon.
      let modelInput = text;
      if (codeMode?.rootDir) {
        const expanded = expandAtMentions(text, codeMode.rootDir);
        if (expanded.expansions.length > 0) {
          modelInput = expanded.text;
          const inlined = expanded.expansions
            .filter((ex) => ex.ok)
            .map((ex) => `${ex.path} (${(ex.bytes ?? 0).toLocaleString()} bytes)`);
          const skipped = expanded.expansions
            .filter((ex) => !ex.ok)
            .map((ex) => `${ex.path} (${ex.skip})`);
          const parts: string[] = [];
          if (inlined.length > 0) parts.push(`inlined ${inlined.join(", ")}`);
          if (skipped.length > 0) parts.push(`skipped ${skipped.join(", ")}`);
          if (parts.length > 0) {
            setHistorical((prev) => [
              ...prev,
              { id: `at-${Date.now()}`, role: "info", text: `▸ @mentions: ${parts.join("; ")}` },
            ]);
          }
        }
      }

      try {
        for await (const ev of loop.step(modelInput)) {
          writeTranscript(ev);
          // Status lines are transient — any primary event (streaming
          // starts, a tool fires, etc.) means whatever we were waiting
          // FOR has now arrived, so drop the hint. We do this uniformly
          // at the top of the loop body for every role except "status"
          // itself (which SETS the line).
          if (ev.role !== "status") {
            setStatusLine((cur) => (cur ? null : cur));
          }
          if (ev.role === "status") {
            setStatusLine(ev.content);
          } else if (ev.role === "assistant_delta") {
            if (ev.content) contentBuf.current += ev.content;
            if (ev.reasoningDelta) reasoningBuf.current += ev.reasoningDelta;
          } else if (ev.role === "tool_call_delta") {
            if (ev.toolName) {
              toolCallBuildBuf.current = {
                name: ev.toolName,
                chars: ev.toolCallArgsChars ?? 0,
                index: ev.toolCallIndex,
                readyCount: ev.toolCallReadyCount,
              };
            }
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
            // Update the live stats panel every assistant_final — this is
            // where the loop already recorded per-iter usage. Without
            // this, cost/ctx/cache/hit stay at the PRIOR turn's numbers
            // until the whole step resolves, which is especially
            // confusing in multi-iter tool-call chains.
            setSummary(loop.stats.summary());
            // Persist a compact per-turn record to ~/.reasonix/usage.jsonl
            // so `reasonix stats` (no arg) can aggregate across every
            // session the user has ever run. Best-effort: a disk error
            // inside appendUsage is swallowed and won't break the turn.
            if (ev.stats?.usage) {
              appendUsage({
                session: session ?? null,
                model: ev.stats.model,
                usage: ev.stats.usage,
              });
            }
            const finalText = ev.content || streamRef.text;
            const iterReasoning = streamRef.reasoning || undefined;
            const iterId = `${assistantId}-i${assistantIterCounter.current++}`;
            setHistorical((prev) => [
              ...prev,
              {
                id: iterId,
                role: "assistant",
                text: finalText,
                reasoning: iterReasoning,
                planState: ev.planState,
                branch: ev.branch,
                stats: ev.stats,
                repair: repairNote || undefined,
                streaming: false,
              },
            ]);
            // streamRef is scoped to the whole handleSubmit call but each
            // iteration's deltas must not bleed into the next.
            streamRef.text = "";
            streamRef.reasoning = "";
            streamRef.toolCallBuild = undefined;
            contentBuf.current = "";
            reasoningBuf.current = "";
            toolCallBuildBuf.current = null;
            if (codeMode && finalText && !ev.forcedSummary) {
              // Parse SEARCH/REPLACE blocks from assistant text. What
              // happens next depends on the edit mode: `review` queues
              // them for user confirmation; `auto` snapshots + applies
              // immediately, arming the undo banner.
              //
              // `ev.forcedSummary` gates us out entirely: if the loop
              // had to force a summary (budget / aborted / context-
              // guard), its text is a wrap-up, not a plan to execute.
              // Blocks dropped in a forced summary are display-only.
              const blocks = parseEditBlocks(finalText);
              if (blocks.length > 0) {
                if (editModeRef.current === "auto") {
                  const snaps = snapshotBeforeEdits(blocks, codeMode.rootDir);
                  const results = applyEditBlocks(blocks, codeMode.rootDir);
                  const good = results.some(
                    (r) => r.status === "applied" || r.status === "created",
                  );
                  if (good) {
                    recordEdit("auto-text", blocks, results, snaps);
                    armUndoBanner(results);
                  }
                  setHistorical((prev) => [
                    ...prev,
                    {
                      id: `applied-${Date.now()}`,
                      role: "info",
                      text: formatEditResults(results),
                    },
                  ]);
                } else {
                  // Append rather than replace — tool-call edits from
                  // earlier in the same turn may already be queued via
                  // the registry interceptor.
                  pendingEdits.current = [...pendingEdits.current, ...blocks];
                  // Checkpoint the queue so a crash / Ctrl+C between
                  // "blocks parsed" and "user /apply" doesn't lose the
                  // edits. On next launch App.tsx's restore effect reads
                  // this file. /apply + /discard clear it explicitly.
                  savePendingEdits(session ?? null, pendingEdits.current);
                  syncPendingCount();
                  setHistorical((prev) => [
                    ...prev,
                    {
                      id: `pending-${Date.now()}`,
                      role: "info",
                      text: formatPendingPreview(pendingEdits.current),
                    },
                  ]);
                }
              }
            }
          } else if (ev.role === "tool_start") {
            // Kick off the visual indicator. Cleared when `tool`
            // (result) or `error` arrives, or on the finally below.
            // Also reset any lingering progress from a prior call so
            // the new spinner starts clean.
            setOngoingTool({ name: ev.toolName ?? "?", args: ev.toolArgs });
            setToolProgress(null);
            // Feed the `@` picker's recency LRU from tool args — any
            // path-shaped field (`path`, `file_path`, `file`) under a
            // filesystem tool call means the user/model is actively
            // working on that file. Picker surfaces it next time `@`
            // is typed, even if the file's mtime is stale.
            if (codeMode && ev.toolArgs) {
              try {
                const parsed = JSON.parse(ev.toolArgs) as {
                  path?: unknown;
                  file_path?: unknown;
                  file?: unknown;
                };
                for (const k of ["path", "file_path", "file"] as const) {
                  const v = parsed[k];
                  if (typeof v === "string" && v.trim()) {
                    recordRecentFile(v.trim());
                    break;
                  }
                }
              } catch {
                /* malformed args — skip recency tracking */
              }
            }
          } else if (ev.role === "tool") {
            flush();
            setOngoingTool(null);
            setToolProgress(null);
            toolHistoryRef.current.push({
              toolName: ev.toolName ?? "?",
              text: ev.content,
            });
            setHistorical((prev) => [
              ...prev,
              {
                id: `t-${Date.now()}-${Math.random()}`,
                role: "tool",
                text: ev.content,
                toolName: ev.toolName,
              },
            ]);
            // run_command rejected because the command isn't on the
            // auto-allow list. Stash it so the y/n fast-path can run
            // it after user confirmation. Only the latest such request
            // is tracked — a second rejection overwrites the first.
            if (
              codeMode &&
              (ev.toolName === "run_command" || ev.toolName === "run_background") &&
              ev.content.includes('"NeedsConfirmationError:') &&
              ev.toolArgs
            ) {
              try {
                const parsed = JSON.parse(ev.toolArgs) as { command?: unknown };
                if (typeof parsed.command === "string" && parsed.command.trim()) {
                  setPendingShell({
                    command: parsed.command.trim(),
                    kind: ev.toolName as "run_command" | "run_background",
                  });
                }
              } catch {
                /* malformed args — skip the prompt */
              }
            }
            // submit_plan fired while plan mode was on — the registry
            // serialized `{ error, plan }` via PlanProposedError's
            // toToolResult(). Extract the plan and mount PlanConfirm.
            // Only the latest submission is tracked; a second overrides.
            if (
              codeMode &&
              ev.toolName === "submit_plan" &&
              ev.content.includes('"PlanProposedError:')
            ) {
              try {
                const parsed = JSON.parse(ev.content) as { plan?: unknown };
                if (typeof parsed.plan === "string" && parsed.plan.trim()) {
                  const planText = parsed.plan.trim();
                  setPendingPlan(planText);
                  // Push the plan into the Static scrollback so the
                  // user can read it in full (and scroll back through
                  // the terminal's own buffer), rather than being
                  // constrained by the PlanConfirm modal's height cap.
                  // The modal below then stays a small picker.
                  setHistorical((prev) => [
                    ...prev,
                    {
                      id: `plan-${Date.now()}-${Math.random()}`,
                      role: "plan",
                      text: planText,
                    },
                  ]);
                }
              } catch {
                /* malformed payload — skip the picker */
              }
            }
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
            // The loop emits warnings starting with "⇧" whenever this
            // turn is (or just became) running on pro — either the
            // /pro armed state was consumed at turn start, or the
            // failure threshold tripped mid-turn. Flip the badge so
            // the user sees the escalation in the header.
            if (ev.content?.startsWith("⇧ ")) setTurnOnPro(true);
          }
        }
        flush();

        // Stop hooks — turn has ended (or aborted). Block decisions are
        // meaningless past this point so we treat every non-pass as a
        // warning. Natural place for "after every turn, run the
        // formatter / lint / tests" automation.
        if (hookList.some((h) => h.event === "Stop")) {
          const stopReport = await runHooks({
            hooks: hookList,
            payload: {
              event: "Stop",
              cwd: hookCwd,
              lastAssistantText: streamRef.text,
              turn: loop.stats.summary().turns,
            },
          });
          for (const o of stopReport.outcomes) {
            if (o.decision === "pass") continue;
            setHistorical((prev) => [
              ...prev,
              {
                id: `hs-${Date.now()}-${Math.random()}`,
                role: "warning",
                text: formatHookOutcomeMessage(o),
              },
            ]);
          }
        }
      } finally {
        if (timer) clearInterval(timer);
        setStreaming(null);
        setOngoingTool(null);
        setToolProgress(null);
        setStatusLine(null);
        setSummary(loop.stats.summary());
        setBusy(false);
        // Clear pro-on-turn badge; armed-for-next-turn already cleared
        // at turn start when it was consumed.
        setTurnOnPro(false);
        // Refresh balance lazily — don't block the return.
        refreshBalance();
      }
    },
    [
      busy,
      clearPendingPlan,
      codeApply,
      codeDiscard,
      codeHistory,
      codeMode,
      codeShowEdit,
      codeUndo,
      exit,
      hookCwd,
      hookList,
      loop,
      latestVersion,
      mcpSpecs,
      mcpServers,
      models,
      planMode,
      session,
      slashSelected,
      atMatches,
      atPicker,
      atSelected,
      pickAtMention,
      recordRecentFile,
      slashArgMatches,
      slashArgContext,
      slashArgSelected,
      pickSlashArg,
      togglePlanMode,
      writeTranscript,
      recordEdit,
      armUndoBanner,
      sealCurrentEntry,
      editMode,
      syncPendingCount,
      refreshBalance,
      refreshLatestVersion,
      refreshModels,
      proArmed,
    ],
  );

  /**
   * ShellConfirm callback. Three outcomes, all of them ending with a
   * synthetic user message fed back into the loop so the model sees
   * what happened next turn:
   *   - deny → "I denied running X." and we move on.
   *   - run_once / always_allow → run the command inside the sandbox
   *     root, attach the formatted output as the user turn. In the
   *     always_allow case we also persist the derived prefix to
   *     config so next invocation auto-runs.
   */
  const handleShellConfirm = useCallback(
    async (choice: ShellConfirmChoice) => {
      const pending = pendingShell;
      if (!pending || !codeMode) return;
      const { command: cmd, kind } = pending;
      setPendingShell(null);

      let synthetic: string;
      if (choice === "deny") {
        setHistorical((prev) => [
          ...prev,
          { id: `sh-deny-${Date.now()}`, role: "info", text: `▸ denied: ${cmd}` },
        ]);
        synthetic = `I denied running \`${cmd}\`. Please continue without running it.`;
      } else {
        if (choice === "always_allow") {
          const prefix = derivePrefix(cmd);
          addProjectShellAllowed(codeMode.rootDir, prefix);
          setHistorical((prev) => [
            ...prev,
            {
              id: `sh-allow-${Date.now()}`,
              role: "info",
              text: `▸ always allowed "${prefix}" for ${codeMode.rootDir}`,
            },
          ]);
        }
        setHistorical((prev) => [
          ...prev,
          {
            id: `sh-run-${Date.now()}`,
            role: "info",
            text:
              kind === "run_background" ? `▸ starting (background): ${cmd}` : `▸ running: ${cmd}`,
          },
        ]);
        if (kind === "run_background" && codeMode.jobs) {
          // Spawn through the JobRegistry so the process keeps running
          // after this handler resolves; the synthetic message tells the
          // model the job id so it can call job_output / stop_job next.
          let startedOk = false;
          let jobId: number | null = null;
          let preview = "";
          try {
            const res = await codeMode.jobs.start(cmd, { cwd: codeMode.rootDir });
            startedOk = true;
            jobId = res.jobId;
            preview = res.preview;
            const header = res.stillRunning
              ? `[job ${res.jobId} started · pid ${res.pid ?? "?"} · ${res.readyMatched ? "READY signal matched" : "running"}]`
              : res.exitCode !== null
                ? `[job ${res.jobId} exited during startup · exit ${res.exitCode}]`
                : `[job ${res.jobId} failed to start]`;
            const body = preview ? `${header}\n${preview}` : header;
            setHistorical((prev) => [
              ...prev,
              { id: `sh-out-${Date.now()}`, role: "info", text: body },
            ]);
            synthetic = `I approved the background spawn. ${header}\n\nStartup preview:\n\n${preview || "(no output yet)"}\n\nThe process is still running — use job_output to read newer logs, stop_job to halt it.`;
          } catch (err) {
            const msg = `$ ${cmd}\n[failed to start] ${(err as Error).message}`;
            setHistorical((prev) => [
              ...prev,
              { id: `sh-out-${Date.now()}`, role: "info", text: msg },
            ]);
            synthetic = `I approved the background spawn but it failed to start:\n\n${msg}`;
          }
          void startedOk; // appease "assigned but never used" — retained for future hook
          void jobId;
        } else {
          // Foreground (run_command) — synchronous; waits for exit.
          let body: string;
          try {
            const res = await runCommand(cmd, { cwd: codeMode.rootDir });
            body = formatCommandResult(cmd, res);
          } catch (err) {
            body = `$ ${cmd}\n[failed to spawn] ${(err as Error).message}`;
          }
          setHistorical((prev) => [
            ...prev,
            { id: `sh-out-${Date.now()}`, role: "info", text: body },
          ]);
          synthetic = `I ran the command you requested. Output:\n\n${body}`;
        }
      }

      // If the prior turn is still streaming ("please confirm" chatter),
      // handleSubmit would early-return on busy=true. Abort the in-flight
      // turn and queue the synthetic for the effect below, which fires
      // once busy clears. Otherwise submit directly.
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [pendingShell, codeMode, handleSubmit, busy, loop],
  );

  // Drain the shell-confirm queue after the in-flight turn tears down.
  // React closure staleness means handleShellConfirm can't just await
  // the abort itself — this effect is the reliable edge detector.
  useEffect(() => {
    if (!busy && queuedSubmit !== null) {
      const text = queuedSubmit;
      setQueuedSubmit(null);
      void handleSubmit(text);
    }
  }, [busy, queuedSubmit, handleSubmit]);

  /**
   * PlanConfirm callback. Three outcomes, all ending with a synthetic
   * user message so the model sees the verdict on its next turn:
   *   - approve → exit plan mode, tell the model to implement now.
   *   - refine  → stay in plan mode, tell the model to revise.
   *   - cancel  → exit plan mode, tell the model to drop the plan.
   * Mirrors handleShellConfirm's busy-queue dance — if the turn is
   * still streaming "plan submitted, waiting" chatter when the user
   * picks, we abort it and queue the synthetic for the effect above.
   *
   * `approve` is also callable with no pending plan (via the
   * `/apply-plan` slash fallback, used when the model wrote a plan in
   * assistant text instead of calling submit_plan). In that case we
   * just flip plan mode off and push the implement-now message.
   */
  const handlePlanConfirm = useCallback(
    async (choice: PlanConfirmChoice) => {
      const hadPendingPlan = pendingPlan !== null;
      if (!hadPendingPlan && choice !== "approve") {
        // Refine / Cancel without a pending plan is a no-op; only the
        // /apply-plan fallback makes sense without one.
        return;
      }

      if (choice === "refine" || choice === "approve") {
        // Two-step: stash the plan + the intent, show the input, wait
        // for user feedback before pushing anything. Approve collects
        // "last instructions / answers to open questions" (blank is
        // fine, user can just hit Enter). Refine collects required
        // feedback so the model has concrete guidance to revise.
        if (pendingPlan) {
          setStagedInput({ plan: pendingPlan, mode: choice });
          setPendingPlan(null);
        } else if (choice === "approve") {
          // /apply-plan fallback path — no pending plan, just approve.
          setStagedInput({ plan: "", mode: "approve" });
        }
        return;
      }

      // Cancel — no input needed, fire immediately.
      setPendingPlan(null);
      togglePlanMode(false);
      const marker = "▸ plan cancelled";
      const synthetic =
        "The plan was cancelled. Drop it entirely. Ask me what I actually want before proposing another plan or making any changes.";
      setHistorical((prev) => [
        ...prev,
        { id: `plan-${choice}-${Date.now()}`, role: "info", text: marker },
      ]);
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [pendingPlan, togglePlanMode, busy, loop, handleSubmit],
  );

  // Ref-wrapped stable alias. `handlePlanConfirm` has deps that churn
  // every turn (busy toggles while the model is still streaming its
  // wrap-up) — passing it directly to `React.memo(PlanConfirm)` breaks
  // the memo's shallow prop compare, so even without the ticker the
  // picker re-rendered on every parent state change. The ref keeps the
  // identity stable across the whole picker lifetime; the callback
  // itself always reads the latest closure via `.current`.
  const handlePlanConfirmRef = useRef(handlePlanConfirm);
  useEffect(() => {
    handlePlanConfirmRef.current = handlePlanConfirm;
  }, [handlePlanConfirm]);
  const stableHandlePlanConfirm = useCallback(
    async (choice: PlanConfirmChoice) => handlePlanConfirmRef.current(choice),
    [],
  );

  /**
   * Fired when the user submits feedback from the inline input. The
   * staged `mode` decides whether this is a refine or approve: refine
   * stays in plan mode and asks the model to revise; approve exits
   * plan mode and pushes the implement synthetic, with any user
   * guidance (answers to open questions, last-minute preferences)
   * included verbatim.
   */
  const handleStagedInputSubmit = useCallback(
    async (feedback: string) => {
      const staged = stagedInput;
      setStagedInput(null);
      if (!staged) return;
      const trimmed = feedback.trim();

      let synthetic: string;
      let marker: string;
      if (staged.mode === "approve") {
        togglePlanMode(false);
        if (trimmed) {
          synthetic = `The plan above has been approved. Implement it now. You are out of plan mode — use edit_file / write_file / run_command as needed.\n\nUser's additional instructions / answers to your open questions:\n\n${trimmed}\n\nFactor these in before the first edit. Stick to the plan unless you discover a concrete reason to deviate; if you do, tell me and wait for a response.`;
          marker = `▸ plan approved + instructions — ${trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed}`;
        } else {
          synthetic =
            "The plan above has been approved. Implement it now. You are out of plan mode — use edit_file / write_file / run_command as needed. If the plan listed open questions and I didn't answer them, default to the safest interpretation and call them out in your first reply. Don't fabricate preferences — if a question is truly unanswerable without me, stop and ask.";
          marker = "▸ plan approved — implementing";
        }
      } else {
        // refine
        if (trimmed) {
          synthetic = `The plan needs refinement. User feedback / answers:\n\n${trimmed}\n\nStay in plan mode — address the feedback (explore more if needed), then submit an improved submit_plan call. Don't propose a near-identical plan unless you explain why the feedback doesn't apply.`;
          marker = `▸ refining — ${trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed}`;
        } else {
          synthetic =
            "The plan needs refinement, but the user didn't give specifics. Ask them one or two concrete questions — scope, approach, file boundaries, or the risks you flagged — then wait for their answer before submitting an updated plan.";
          marker = "▸ refining — asking the model to clarify";
        }
      }

      setHistorical((prev) => [
        ...prev,
        { id: `plan-${staged.mode}-${Date.now()}`, role: "info", text: marker },
      ]);
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
      } else {
        await handleSubmit(synthetic);
      }
    },
    [stagedInput, togglePlanMode, busy, loop, handleSubmit],
  );

  /** Esc on the inline input — restore the picker without resuming. */
  const handleStagedInputCancel = useCallback(() => {
    if (stagedInput?.plan) setPendingPlan(stagedInput.plan);
    setStagedInput(null);
  }, [stagedInput]);

  return (
    <TickerProvider disabled={PLAIN_UI || !!pendingPlan || !!pendingShell || !!pendingEditReview}>
      <Box flexDirection="column">
        <StatsPanel
          summary={summary}
          model={loop.model}
          prefixHash={prefixHash}
          harvestOn={loop.harvestEnabled}
          branchBudget={loop.branchOptions.budget}
          reasoningEffort={loop.reasoningEffort}
          planMode={planMode}
          editMode={codeMode ? editMode : undefined}
          balance={balance}
          busy={busy}
          updateAvailable={updateAvailable}
          proArmed={proArmed}
          escalated={turnOnPro}
        />
        <Static items={historical}>
          {(item) => <EventRow key={item.id} event={item} projectRoot={hookCwd} />}
        </Static>
        {/*
          Live rows are hidden while the ShellConfirm modal is up — the
          model's concurrent "please confirm" stream is noise the user
          doesn't need, and the picker shouldn't fight it for visual
          attention. They come back naturally once the user chooses and
          the next turn begins.
        */}
        {!PLAIN_UI &&
        !pendingShell &&
        !pendingPlan &&
        !stagedInput &&
        !pendingEditReview &&
        streaming ? (
          <Box marginY={1}>
            <EventRow event={streaming} projectRoot={hookCwd} />
          </Box>
        ) : null}
        {!PLAIN_UI &&
        !pendingShell &&
        !pendingPlan &&
        !stagedInput &&
        !pendingEditReview &&
        ongoingTool ? (
          <OngoingToolRow tool={ongoingTool} progress={toolProgress} />
        ) : null}
        {!PLAIN_UI &&
        !pendingShell &&
        !pendingPlan &&
        !stagedInput &&
        !pendingEditReview &&
        subagentActivity ? (
          <SubagentRow activity={subagentActivity} />
        ) : null}
        {!PLAIN_UI &&
        !pendingShell &&
        !pendingPlan &&
        !stagedInput &&
        !pendingEditReview &&
        !ongoingTool &&
        statusLine ? (
          <StatusRow text={statusLine} />
        ) : null}
        {!PLAIN_UI &&
        undoBanner &&
        !pendingShell &&
        !pendingPlan &&
        !stagedInput &&
        !pendingEditReview ? (
          <UndoBanner banner={undoBanner} />
        ) : null}
        {/*
          Belt-and-suspenders fallback: if we're busy but NONE of the
          specific indicators (streaming, ongoingTool, statusLine) is
          visible, something is still happening — show a generic
          "processing…" so the user never stares at a silent ticker
          without a label. Catches micro-gaps between events that the
          targeted status lines don't cover.
        */}
        {!PLAIN_UI &&
        !pendingShell &&
        !pendingPlan &&
        !stagedInput &&
        !pendingEditReview &&
        busy &&
        !streaming &&
        !ongoingTool &&
        !statusLine ? (
          <StatusRow text="processing…" />
        ) : null}
        {stagedInput ? (
          <PlanRefineInput
            mode={stagedInput.mode}
            onSubmit={handleStagedInputSubmit}
            onCancel={handleStagedInputCancel}
          />
        ) : pendingPlan ? (
          <PlanConfirm
            plan={pendingPlan}
            onChoose={stableHandlePlanConfirm}
            projectRoot={hookCwd}
          />
        ) : pendingShell ? (
          <ShellConfirm
            command={pendingShell.command}
            allowPrefix={derivePrefix(pendingShell.command)}
            kind={pendingShell.kind}
            onChoose={handleShellConfirm}
          />
        ) : pendingEditReview ? (
          <EditConfirm
            block={pendingEditReview}
            onChoose={(choice) => {
              const resolve = editReviewResolveRef.current;
              if (resolve) {
                editReviewResolveRef.current = null;
                resolve(choice);
              }
            }}
          />
        ) : (
          <>
            {codeMode ? (
              <ModeStatusBar
                editMode={editMode}
                pendingCount={pendingCount}
                flash={modeFlash}
                planMode={planMode}
                undoArmed={!!undoBanner || hasUndoable()}
                jobs={codeMode.jobs}
              />
            ) : null}
            <PromptInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              disabled={busy}
            />
            <SlashSuggestions matches={slashMatches} selectedIndex={slashSelected} />
            <AtMentionSuggestions
              matches={atMatches}
              selectedIndex={atSelected}
              query={atPicker?.query ?? ""}
            />
            {slashArgContext ? (
              <SlashArgPicker
                matches={slashArgMatches}
                selectedIndex={slashArgSelected}
                spec={slashArgContext.spec}
                kind={slashArgContext.kind}
                partial={slashArgContext.partial}
              />
            ) : null}
          </>
        )}
      </Box>
    </TickerProvider>
  );
}
