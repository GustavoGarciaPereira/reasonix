import { Box, Text, useStdout } from "ink";
import React from "react";
import { type TypedPlanState, isPlanStateEmpty } from "../../harvest.js";
import type { BranchProgress, BranchSummary } from "../../loop.js";
import type { TurnStats } from "../../telemetry.js";
import { PlanStateBlock } from "./PlanStateBlock.js";
import { Markdown } from "./markdown.js";
import { useElapsedSeconds, useTick } from "./ticker.js";

export type DisplayRole = "user" | "assistant" | "tool" | "system" | "error" | "info" | "warning";

export interface DisplayEvent {
  id: string;
  role: DisplayRole;
  text: string;
  reasoning?: string;
  planState?: TypedPlanState;
  branch?: BranchSummary;
  branchProgress?: BranchProgress;
  toolName?: string;
  stats?: TurnStats;
  repair?: string;
  streaming?: boolean;
  toolCallBuild?: { name: string; chars: number };
  /**
   * Render a thin horizontal rule above this event. Used to mark
   * "start of a new user turn" so long scrollbacks get visual
   * pacing — without it, five-turn sessions read as one wall of
   * text. Only the *first* user message in a session should leave
   * this off; App.tsx sets it based on whether history is empty.
   */
  leadSeparator?: boolean;
}

/**
 * Reasonix visual language: every event is anchored by a geometric
 * glyph in its role color. Together they form a consistent alphabet
 * (◇ ◆ ▣ ▥ ▲ ✦) the eye learns fast — no text labels needed after
 * the first couple of turns. `◈` is the brand mark, reserved for
 * the app header.
 */
const ROLE_GLYPH = {
  user: "◇",
  assistant: "◆",
  assistantPulse: "◇", // pulse alternate for streaming state
  toolOk: "▣",
  toolErr: "▥",
  warning: "▲",
  error: "✦",
} as const;

function RoleGlyph({
  glyph,
  color,
}: {
  glyph: string;
  color: "cyan" | "green" | "yellow" | "red" | "magenta" | "blue";
}) {
  return (
    <Text color={color} bold>
      {glyph}
    </Text>
  );
}

export const EventRow = React.memo(function EventRow({
  event,
  projectRoot,
}: {
  event: DisplayEvent;
  projectRoot?: string;
}) {
  if (event.role === "user") {
    return (
      <Box marginTop={event.leadSeparator ? 1 : 0}>
        <RoleGlyph glyph={ROLE_GLYPH.user} color="cyan" />
        <Text>{"  "}{event.text}</Text>
      </Box>
    );
  }
  if (event.role === "assistant") {
    if (event.streaming) return <StreamingAssistant event={event} />;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <RoleGlyph glyph={ROLE_GLYPH.assistant} color="green" />
          {event.stats ? (
            <Text dimColor>{`  ${event.stats.model}`}</Text>
          ) : null}
        </Box>
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {event.branch ? <BranchBlock branch={event.branch} /> : null}
          {event.reasoning ? <ReasoningBlock reasoning={event.reasoning} /> : null}
          {!isPlanStateEmpty(event.planState) ? (
            <PlanStateBlock planState={event.planState!} />
          ) : null}
          {event.text ? (
            <Markdown text={event.text} projectRoot={projectRoot} />
          ) : (
            <Text dimColor>(no content)</Text>
          )}
          {event.stats ? <StatsLine stats={event.stats} /> : null}
          {event.repair ? <Text color="magenta">{event.repair}</Text> : null}
        </Box>
      </Box>
    );
  }
  if (event.role === "tool") {
    // `flattenMcpResult` prefixes server-side errors with "ERROR: ".
    // Render the tool glyph in red with a ✗ direction marker so the
    // failure mode is unmissable — it's the signal the model needs
    // most for its next decision.
    const isError = event.text.startsWith("ERROR:");
    const color = isError ? "red" : "yellow";
    const glyph = isError ? ROLE_GLYPH.toolErr : ROLE_GLYPH.toolOk;
    const marker = isError ? "✗" : "→";
    // `edit_file` results get a dedicated diff renderer — colored
    // line-by-line so `-` removals show red, `+` additions show
    // green, unchanged context lines dim. Always full, never
    // truncated: users need to see the whole change to trust
    // /apply. Other tools keep the 400-char clip + /tool N escape.
    const isEditFile =
      (event.toolName === "edit_file" || event.toolName?.endsWith("_edit_file")) && !isError;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <RoleGlyph glyph={glyph} color={color} />
          <Text color={color} bold>{`  ${event.toolName ?? "?"}`}</Text>
          <Text color={color} dimColor>{`  ${marker}`}</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {isEditFile ? (
            <EditFileDiff text={event.text} />
          ) : (
            <Text color={isError ? "red" : undefined} dimColor={!isError}>
              {truncate(event.text, 400)}
            </Text>
          )}
        </Box>
      </Box>
    );
  }
  if (event.role === "error") {
    return (
      <Box marginTop={1}>
        <RoleGlyph glyph={ROLE_GLYPH.error} color="red" />
        <Text color="red">{"  "}{event.text}</Text>
      </Box>
    );
  }
  if (event.role === "info") {
    return (
      <Box>
        <Text dimColor>{event.text}</Text>
      </Box>
    );
  }
  if (event.role === "warning") {
    return (
      <Box>
        <RoleGlyph glyph={ROLE_GLYPH.warning} color="yellow" />
        <Text color="yellow">{"  "}{event.text}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text>{event.text}</Text>
    </Box>
  );
});

/**
 * Thin horizontal rule between turns with a cyan ◆ centered as the
 * Reasonix mark. Past-turn separators live inside `<Static>` (Ink's
 * render-once optimization), so animation here would freeze at
 * tick=0 on every past turn — we keep it static by design. The
 * animated heartbeat lives in PulsingAssistantGlyph (current turn)
 * and the Wordmark (StatsPanel) where rerender is free.
 */
function TurnSeparator() {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const width = Math.max(16, cols - 2);
  const half = Math.floor((width - 3) / 2);
  const left = "─".repeat(half);
  const right = "─".repeat(width - half - 3);
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text dimColor>{left}</Text>
      <Text color="cyan" bold>{" ◆ "}</Text>
      <Text dimColor>{right}</Text>
    </Box>
  );
}

/**
 * Render the payload of an `edit_file` tool result with proper
 * diff coloring: first line is the header ("edited X (A→B chars)"),
 * subsequent lines are prefixed with `-` (removed), `+` (added), or
 * space (unchanged context). Unchanged lines render dim so the
 * changed ones pop visually. No truncation — the whole diff is
 * shown so the user can audit what landed before `/apply` or
 * `git diff` review.
 */
function EditFileDiff({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  // Line 0 is the status header ("edited X (A→B chars)"), Line 1 is
  // the unified-diff hunk header ("@@ -N,M +N,M @@"), the rest is
  // the colored diff body. We style the two headers distinctly so
  // the hunk marker stands out the way git-diff's cyan `@@` does in
  // most terminals.
  const [statusHeader, hunkHeader, ...body] = lines;
  return (
    <Box flexDirection="column">
      <Text dimColor>{` ${statusHeader ?? ""}`}</Text>
      {hunkHeader !== undefined ? (
        <Text color="cyan" bold>
          {hunkHeader}
        </Text>
      ) : null}
      {body.map((line, i) => {
        // Key includes the line content slice so React isn't forced
        // to treat purely-positional identity; lines in the same
        // diff don't reorder but could repeat (e.g. blank lines).
        const key = `${i}-${line.slice(0, 32)}`;
        if (line.startsWith("- ")) {
          return (
            <Text key={key} color="red">
              {line}
            </Text>
          );
        }
        if (line.startsWith("+ ")) {
          return (
            <Text key={key} color="green">
              {line}
            </Text>
          );
        }
        // Context line (starts with "  ") or unknown — dim.
        return (
          <Text key={key} dimColor>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}

function BranchBlock({ branch }: { branch: BranchSummary }) {
  const per = branch.uncertainties
    .map((u, i) => {
      const marker = i === branch.chosenIndex ? "▸" : " ";
      const t = (branch.temperatures[i] ?? 0).toFixed(1);
      return `${marker} #${i} T=${t} u=${u}`;
    })
    .join("  ");
  return (
    <Box>
      <Text color="blue">
        {"⎇ branched "}
        <Text bold>{branch.budget}</Text>
        {` samples → picked #${branch.chosenIndex}   `}
        <Text dimColor>{per}</Text>
      </Text>
    </Box>
  );
}

function ReasoningBlock({ reasoning }: { reasoning: string }) {
  const max = 260;
  const flat = reasoning.replace(/\s+/g, " ").trim();
  // Show the TAIL of the reasoning rather than the head. R1 opens
  // with generic scaffolding ("let me look at the structure...") that
  // repeats across turns and hides the part users actually want to
  // see — the decision right before the model commits to an action.
  // Users can dump the full reasoning with `/think` if needed.
  const preview =
    flat.length <= max ? flat : `… (+${flat.length - max} earlier chars) ${flat.slice(-max)}`;
  // ▏ (LEFT ONE EIGHTH BLOCK) renders as a thin vertical rule at the
  // cell edge — subtler than the role-level ▎ above, giving a
  // visual hierarchy: thick bar = role, thin bar = nested detail
  // under that role (thinking, stats, citations, etc).
  return (
    <Box marginBottom={1}>
      <Text dimColor>▏ </Text>
      <Text dimColor italic>
        thinking  {preview}
      </Text>
    </Box>
  );
}

/**
 * Compact progress view rendered while a turn is still streaming. We keep
 * this to a fixed ~3-line footprint so the dynamic region never scrolls past
 * the terminal viewport and leaves artifacts in scrollback.
 */
function Elapsed() {
  const s = useElapsedSeconds();
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return <Text dimColor>{`${mm}:${ss}`}</Text>;
}

/**
 * Animated role glyph for the actively-streaming assistant. Alternates
 * ◆ ↔ ◇ every ~480ms so the user can see the model is alive even
 * during R1's long pre-first-byte silence. Settles back to a static
 * ◆ once the turn ends (StreamingAssistant is unmounted).
 */
function PulsingAssistantGlyph() {
  const tick = useTick();
  const on = Math.floor(tick / 4) % 2 === 0;
  return (
    <Text color="green" bold>
      {on ? ROLE_GLYPH.assistant : ROLE_GLYPH.assistantPulse}
    </Text>
  );
}

function StreamingAssistant({ event }: { event: DisplayEvent }) {
  if (event.branchProgress) {
    const p = event.branchProgress;
    // completed=0 means we've just started; no sample has finished yet.
    if (p.completed === 0) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <PulsingAssistantGlyph />
            <Text color="blue">
              {"  ⎇ launching "}{p.total}{" parallel samples (R1 thinking in parallel)…  "}
            </Text>
            <Elapsed />
          </Box>
          <Text color="yellow">
            {"  "}spread across T=0.0/0.5/1.0 · reasoner typically takes 30-90s — this is normal
          </Text>
        </Box>
      );
    }
    const pct = Math.round((p.completed / p.total) * 100);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <PulsingAssistantGlyph />
          <Text color="blue">
            {"  ⎇ branching "}{p.completed}/{p.total}{" ("}{pct}{"%)  "}
          </Text>
          <Elapsed />
        </Box>
        <Text dimColor>
          {"  latest #"}
          {p.latestIndex}
          {" T="}
          {p.latestTemperature.toFixed(1)}
          {" u="}
          {p.latestUncertainties}
          {p.completed < p.total ? "  · waiting for other samples…" : "  · selecting winner…"}
        </Text>
      </Box>
    );
  }

  const tail = lastLine(event.text, 140);
  const reasoningTail = event.reasoning ? lastLine(event.reasoning, 120) : "";
  const toolCallBuild = event.toolCallBuild;
  // Four distinct phases a turn can be in — label them plainly so
  // the user doesn't have to decode "streaming · 391 + think 4506
  // chars" to figure out what's happening:
  //   pre-first-byte: request in flight, no bytes back yet
  //   reasoning-only: R1 thinking, no visible content yet
  //   tool-call-only: tool_call arguments streaming, no content/reasoning bytes
  //   writing: content streaming (R1 has already produced its thought)
  //   both: rare — content present AND reasoning still growing
  // We can't cheaply distinguish "reasoning still growing" from
  // "reasoning finished but we already saw it", so when content is
  // present we just say "writing response" and surface both counts.
  const preFirstByte = !event.text && !event.reasoning && !toolCallBuild;
  const reasoningOnly = !event.text && !!event.reasoning && !toolCallBuild;
  const toolCallOnly = !event.text && !event.reasoning && !!toolCallBuild;
  let label: string;
  let labelColor: "yellow" | "cyan" | "green" | "magenta" | undefined;
  if (preFirstByte) {
    label = "request sent · waiting for server";
    labelColor = "yellow";
  } else if (reasoningOnly) {
    label = `R1 reasoning · ${event.reasoning?.length ?? 0} chars of thought`;
    labelColor = "cyan";
  } else if (toolCallOnly) {
    label = `assembling tool call <${toolCallBuild.name}> · ${toolCallBuild.chars} chars of arguments`;
    labelColor = "magenta";
  } else {
    const parts: string[] = [`writing response · ${event.text.length} chars`];
    if (event.reasoning) parts.push(`after ${event.reasoning.length} chars of reasoning`);
    if (toolCallBuild) {
      parts.push(`building tool call <${toolCallBuild.name}> · ${toolCallBuild.chars} chars`);
    }
    label = parts.join(" · ");
    labelColor = "green";
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <PulsingAssistantGlyph />
        <Text>{"  "}</Text>
        <Pulse />
        <Text color={labelColor}>{` ${label} `}</Text>
        <Elapsed />
      </Box>
      {reasoningTail ? (
        <Text dimColor italic>
          ↳ thinking: {reasoningTail}
        </Text>
      ) : null}
      {tail ? (
        <Text dimColor>▸ {tail}</Text>
      ) : preFirstByte ? (
        // Non-dim yellow: first-time users misread the dim version as
        // "app frozen". The reassurance has to be VISIBLE to do its job.
        <Text color="yellow" italic>
          {"  waiting for first byte — this is normal, typically 5-60s depending on model + load"}
        </Text>
      ) : reasoningOnly ? (
        <Text color="yellow" italic>
          {"  R1 is thinking before it speaks — body text arrives when reasoning finishes (typically 20-90s, this is normal)"}
        </Text>
      ) : toolCallOnly ? (
        <Text color="magenta" italic>
          {"  tool-call arguments streaming — the model is about to dispatch a tool"}
        </Text>
      ) : event.reasoning ? (
        <Text color="yellow" italic>
          {"  R1 still reasoning — body text or tool call arrives when thinking finishes"}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Blinking indicator so the user can tell the stream is alive even
 * when the reasoner hasn't produced body text yet. Uses the shared
 * tick (TICK_MS ≈ 120ms) scaled down 4× so the visible blink rate
 * lands around 500ms — feels like a heartbeat, not a progress bar.
 */
function Pulse() {
  const tick = useTick();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return <Text color="cyan">{frames[Math.floor(tick / 4) % frames.length]}</Text>;
}

function lastLine(s: string, maxChars: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= maxChars ? flat : `…${flat.slice(-maxChars)}`;
}

function StatsLine({ stats }: { stats: TurnStats }) {
  const hit = (stats.cacheHitRatio * 100).toFixed(1);
  return (
    <Box>
      <Text dimColor>▏ </Text>
      <Text dimColor>
        {"cache "}
        {hit}
        {"% · tokens "}
        {stats.usage.promptTokens}
        {" → "}
        {stats.usage.completionTokens}
        {" · $"}
        {stats.cost.toFixed(6)}
      </Text>
    </Box>
  );
}

/**
 * Show the *tail* of a long tool result by default — the useful signal
 * (return value, summary, error line) usually lives at the end, not the
 * top-of-file boilerplate. For `ERROR:`-prefixed results, keep the
 * first line intact (that's the actual error message) AND include the
 * tail, so stack-trace endings stay visible too.
 *
 * Rendered like: `(+N earlier chars) …<tail>` so users can tell at a
 * glance that something was elided. `/tool N` still dumps the full
 * content for cases where the middle matters.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (s.startsWith("ERROR:")) {
    const firstNl = s.indexOf("\n");
    const firstLine = firstNl === -1 ? s : s.slice(0, firstNl);
    // If the first line alone is bigger than max, just show it truncated.
    if (firstLine.length >= max) {
      return `${firstLine.slice(0, max)}… (+${s.length - max} chars — /tool N for full)`;
    }
    const budget = max - firstLine.length - 10; // reserve space for separator + ellipsis
    const tail = s.slice(-budget);
    const skipped = s.length - firstLine.length - tail.length;
    return `${firstLine}\n… (+${skipped} chars) …\n${tail}`;
  }
  const skipped = s.length - max;
  return `… (+${skipped} earlier chars — /tool N for full) …\n${s.slice(-max)}`;
}
