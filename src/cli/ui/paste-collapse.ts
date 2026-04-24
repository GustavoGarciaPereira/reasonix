/**
 * Collapse long user-typed input for display purposes.
 *
 * Problem: pasting a stack trace, log dump, or sample file into the
 * prompt box floods the Historical scrollback with a huge block — the
 * user can't see their previous turns, the assistant's replies, or
 * where the cursor is. Terminal UIs have shipped this shape for
 * years (iTerm's "pasted text" notation, Claude Code's preview).
 *
 * Split of concerns: the MODEL still gets the full text. This helper
 * only rewrites what we render in the Historical row. `@` expansions
 * and `!` bang outputs have their own display paths (unaffected).
 */

/** Defaults tuned to typical prose vs. typical code-paste shapes. */
export const DEFAULT_PASTE_LINE_THRESHOLD = 40;
export const DEFAULT_PASTE_CHAR_THRESHOLD = 2000;
/** Lines kept visible at the head of a collapsed paste. */
export const DEFAULT_PASTE_HEAD_LINES = 10;

export interface PasteCollapseOptions {
  lineThreshold?: number;
  charThreshold?: number;
  headLines?: number;
}

export interface PasteCollapseResult {
  /** Text to render in the Historical row (possibly collapsed). */
  displayText: string;
  /** True when collapsing happened. False = input passed through verbatim. */
  collapsed: boolean;
  /** Original char length — exposed so callers can log/annotate. */
  originalChars: number;
  /** Original line count. */
  originalLines: number;
}

/**
 * Collapse `input` when it exceeds either the line OR char threshold.
 * Display shape:
 *
 *     ▸ pasted 2.3 KB (84 lines) — first 10 shown, full text sent to model
 *     line 1
 *     line 2
 *     …
 *     line 10
 *     … (74 more lines)
 *
 * Short input passes through unchanged — collapsed = false.
 */
export function formatLongPaste(
  input: string,
  opts: PasteCollapseOptions = {},
): PasteCollapseResult {
  const lineCap = opts.lineThreshold ?? DEFAULT_PASTE_LINE_THRESHOLD;
  const charCap = opts.charThreshold ?? DEFAULT_PASTE_CHAR_THRESHOLD;
  const headN = Math.max(1, opts.headLines ?? DEFAULT_PASTE_HEAD_LINES);

  const originalChars = input.length;
  const lines = input.split("\n");
  const originalLines = lines.length;

  if (originalChars <= charCap && originalLines <= lineCap) {
    return { displayText: input, collapsed: false, originalChars, originalLines };
  }

  const header = `▸ pasted ${formatBytes(originalChars)} (${originalLines} lines) — first ${Math.min(headN, originalLines)} shown, full text sent to model`;
  const head = lines.slice(0, headN).join("\n");
  const remaining = originalLines - headN;
  const footer = remaining > 0 ? `… (${remaining} more line${remaining === 1 ? "" : "s"})` : "";
  const displayText = footer ? `${header}\n${head}\n${footer}` : `${header}\n${head}`;
  return { displayText, collapsed: true, originalChars, originalLines };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
