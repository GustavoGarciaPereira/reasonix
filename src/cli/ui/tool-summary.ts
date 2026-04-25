/**
 * One-line tool-result summarizer for the compact scrollback row.
 *
 * Old rendering: glyph + arrow + blank line + 400-char body block.
 * Cost ~6–8 vertical lines per tool call. Long sessions drown in
 * noise; the actually-interesting tool result (an edit diff, a
 * checkpoint signal) gets buried.
 *
 * New rendering: glyph + tool name + arrow + a SINGLE-LINE summary
 * tailored to the tool family. Full content stays in the tool history
 * and can be expanded via `/tool N`. edit_file keeps its multi-line
 * diff renderer (the diff IS the value).
 *
 * Pure function — lives outside EventLog.tsx so it's testable without
 * Ink and can be reused if other surfaces (replay, transcript export)
 * want the same one-liner.
 */

const MAX_SUMMARY_CHARS = 80;
const TRAILING_ELLIPSIS = "…";

export interface ToolSummary {
  /** Single-line summary text. Empty string if the result was empty. */
  summary: string;
  /** True when the tool result represents a failure the renderer should color red. */
  isError: boolean;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - TRAILING_ELLIPSIS.length)) + TRAILING_ELLIPSIS;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Render a duration in milliseconds as a tight human label for the
 * compact tool row. Picks a representation that fits in ~5 chars so
 * the surrounding row stays readable on narrow terminals.
 *
 *   <  100ms → "47ms"
 *   < 1000ms → "0.4s"
 *   <   60s  → "12s"  (or "1.2s" for sub-10-second times)
 *   >=  60s  → "1m30s"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 100) return `${Math.round(ms)}ms`;
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

function formatBytes(n: number): string {
  if (n < 1000) return `${n}B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}KB`;
  return `${(n / 1_000_000).toFixed(1)}MB`;
}

function formatLineCount(text: string): string {
  // Cheap line count — the +1 covers files without a trailing newline.
  const lines = text.split(/\r?\n/).length;
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

/**
 * Try to recognize a structured error envelope. Reasonix tools emit
 * `{ "error": "..." }` JSON for failures and structured payloads
 * (PlanProposedError carries `{error, plan, ...}`) for special
 * signals. We surface the error name as the summary so the user
 * sees what kind of failure happened at a glance.
 */
function summarizeStructured(content: string): ToolSummary | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    // Plan / choice signals come through as errors carrying structured
    // payloads — the App-level handlers extract the structured part.
    // For the tool row here we just want the tag.
    if (typeof obj.error === "string") {
      const tag = obj.error.split(":", 1)[0]?.trim() ?? "error";
      const detail = obj.error.slice(tag.length + 1).trim();
      // The tag-only case (no colon body) — show the bare tag.
      const summary = detail ? `${tag} — ${detail}` : tag;
      // Plan / Choice errors are control-flow signals, not real errors.
      const isControlSignal =
        tag === "PlanProposedError" ||
        tag === "PlanCheckpointError" ||
        tag === "PlanRevisionProposedError" ||
        tag === "ChoiceRequestedError" ||
        tag === "NeedsConfirmationError";
      return { summary: clip(summary, MAX_SUMMARY_CHARS), isError: !isControlSignal };
    }
    // step_completed payload (when used outside the error path, kept
    // for forward-compat with non-throwing variants).
    if (obj.kind === "step_completed" && typeof obj.stepId === "string") {
      const result = typeof obj.result === "string" ? obj.result : "";
      return {
        summary: clip(`✓ ${obj.stepId}: ${result}`, MAX_SUMMARY_CHARS),
        isError: false,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Per-tool-name overrides for cases where a smarter summary is cheap
 * to compute. Returning null means "fall through to the generic
 * summary path."
 *
 * Suffix-match is on purpose: MCP-bridged tools come in prefixed
 * (`filesystem_read_file`, `git_search_files`) and we want them to
 * pick up the same specialized summary as the bare local name.
 */
function summarizeKnownTool(toolName: string, content: string): ToolSummary | null {
  const hasSuffix = (s: string) => toolName === s || toolName.endsWith(`_${s}`);
  if (hasSuffix("read_file")) {
    const lines = formatLineCount(content);
    const bytes = formatBytes(content.length);
    const head = clip(
      firstNonEmptyLine(content),
      MAX_SUMMARY_CHARS - lines.length - bytes.length - 8,
    );
    return {
      summary: head ? `${head} · ${lines} · ${bytes}` : `${lines} · ${bytes}`,
      isError: false,
    };
  }
  if (hasSuffix("list_directory") || hasSuffix("directory_tree")) {
    const entries = content.split(/\r?\n/).filter((l) => l.trim()).length;
    return { summary: `${entries} entr${entries === 1 ? "y" : "ies"}`, isError: false };
  }
  if (hasSuffix("search_files") || hasSuffix("search_content")) {
    const matches = content.split(/\r?\n/).filter((l) => l.trim()).length;
    if (matches === 0) return { summary: "no matches", isError: false };
    const first = firstNonEmptyLine(content);
    return {
      summary: clip(`${matches} match${matches === 1 ? "" : "es"} · ${first}`, MAX_SUMMARY_CHARS),
      isError: false,
    };
  }
  if (hasSuffix("write_file")) {
    const lines = formatLineCount(content);
    const bytes = formatBytes(content.length);
    return { summary: `wrote ${lines} · ${bytes}`, isError: false };
  }
  if (hasSuffix("run_command") || hasSuffix("run_background")) {
    // Native shell tools prepend "exit 0:" / "exit N:" or the result
    // already mentions exit code. Try to surface it.
    const exitMatch = content.match(/exit (?:code )?(-?\d+)/i);
    const first = firstNonEmptyLine(content);
    if (exitMatch) {
      const code = exitMatch[1];
      const isError = code !== "0";
      return {
        summary: clip(`exit ${code} · ${first}`, MAX_SUMMARY_CHARS),
        isError,
      };
    }
    return { summary: clip(first || "(no output)", MAX_SUMMARY_CHARS), isError: false };
  }
  return null;
}

export function summarizeToolResult(toolName: string, content: string): ToolSummary {
  const isExplicitError = content.startsWith("ERROR:");
  if (isExplicitError) {
    const stripped = content.slice("ERROR:".length).trim();
    return { summary: clip(stripped || "(unknown error)", MAX_SUMMARY_CHARS), isError: true };
  }
  const structured = summarizeStructured(content);
  if (structured) return structured;
  const known = summarizeKnownTool(toolName, content);
  if (known) return known;
  // Generic: first line + size hint.
  const first = firstNonEmptyLine(content);
  if (!content.trim()) return { summary: "(empty)", isError: false };
  if (content.length <= MAX_SUMMARY_CHARS) {
    return { summary: clip(first, MAX_SUMMARY_CHARS), isError: false };
  }
  const sizeHint = formatBytes(content.length);
  const head = clip(first, MAX_SUMMARY_CHARS - sizeHint.length - 3);
  return { summary: `${head} · ${sizeHint}`, isError: false };
}
