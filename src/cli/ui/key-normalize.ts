/**
 * CSI sequence recovery for Ink's `useInput`.
 *
 * Why this exists. Ink delivers keyboard events through `parse-keypress`,
 * which reads stdin and recognises ANSI control-sequence-introducer
 * (CSI) sequences with a state machine plus a short timeout. On most
 * terminals this works: the byte stream `\x1b [ A` arrives in one
 * read, parse-keypress emits `{key.upArrow:true, input:""}`, life is
 * good.
 *
 * On Windows PowerShell + ConPTY (and a handful of embedded shells)
 * the bytes don't always arrive together. parse-keypress's timeout
 * expires between chunks, so it dispatches the lone `\x1b` as
 * `key.escape:true` and then dispatches the trailing `[A` as a
 * regular character event — `input:"[A", key.upArrow:undefined`. The
 * useInput consumer sees `[A` as plain text, inserts it into the
 * buffer, and the cursor never moves. Same shape on `[C` (right
 * arrow), `[Z` (Shift+Tab), `[5~` (PgUp), `[201~` (bracketed-paste
 * end), etc.
 *
 * Every Reasonix UI component that calls `useInput` is exposed to
 * this. Patching each one to re-recognise the bare CSI tail was
 * fragile — every release a new symptom appeared (cursor stuck,
 * paste markers leaking, Shift+Tab not toggling). So this module is
 * the single source of truth for CSI recovery: every input handler
 * runs the raw event through `recoverCsiTail` before reading
 * structured key flags.
 *
 * Recovery is conservative. We only rewrite when:
 *   1. None of the structured key flags Ink already populated for
 *      this event is set (so a real upArrow press isn't second-
 *      guessed).
 *   2. `input` exactly matches a recognised tail in either form —
 *      the full `\x1b[X` sequence (in case the timeout merged it)
 *      or the bare `[X` ConPTY-stripped variant.
 *
 * Anything else passes through unchanged.
 */

/**
 * Subset of Ink's `Key` interface that contains the structured flags
 * we know how to recover. Optional everywhere because callers from
 * different Ink versions may not populate every field.
 */
export interface CsiKeyFlags {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  delete?: boolean;
  shift?: boolean;
  tab?: boolean;
}

/**
 * CSI tails we recognise. Each maps the printable bytes of a CSI
 * tail (the part after the `\x1b`) to the structured key flags they
 * should set. Bracketed-paste markers `[200~` / `[201~` are
 * intentionally absent — they're handled by PromptInput's paste
 * accumulator, which has different semantics (collect content
 * between markers rather than emit one keystroke).
 */
const CSI_TAIL_TO_FLAGS: ReadonlyArray<{ tail: string; flags: CsiKeyFlags }> = [
  // Arrow keys — the most common ConPTY victim.
  { tail: "[A", flags: { upArrow: true } },
  { tail: "[B", flags: { downArrow: true } },
  { tail: "[C", flags: { rightArrow: true } },
  { tail: "[D", flags: { leftArrow: true } },
  // Page navigation.
  { tail: "[5~", flags: { pageUp: true } },
  { tail: "[6~", flags: { pageDown: true } },
  // Forward-delete (the key labelled Delete on most keyboards).
  { tail: "[3~", flags: { delete: true } },
  // Shift+Tab — terminal sends `\x1b[Z` rather than tab-with-shift.
  { tail: "[Z", flags: { shift: true, tab: true } },
];

/**
 * Did Ink already give us a structured key for this event? When
 * `true`, recovery is unnecessary and would risk overriding a real
 * keypress that happens to share `input` with a CSI tail.
 */
function alreadyStructured(flags: CsiKeyFlags): boolean {
  return Boolean(
    flags.upArrow ||
      flags.downArrow ||
      flags.leftArrow ||
      flags.rightArrow ||
      flags.pageUp ||
      flags.pageDown ||
      flags.delete ||
      (flags.tab && flags.shift),
  );
}

/**
 * If `input` is a recognisable CSI tail (with or without the leading
 * `\x1b`), return the structured flags it should produce. Otherwise
 * `null`. Bracketed-paste markers always return `null` here — those
 * are handled by their own accumulator.
 *
 * Pure function. Pass already-structured events through (they
 * short-circuit) so a real arrow press doesn't get rewritten.
 */
export function recoverCsiTail(input: string, existing: CsiKeyFlags = {}): CsiKeyFlags | null {
  if (alreadyStructured(existing)) return null;
  for (const entry of CSI_TAIL_TO_FLAGS) {
    if (input === entry.tail || input === `\x1b${entry.tail}`) {
      return entry.flags;
    }
  }
  return null;
}

/**
 * Tail forms (with and without the leading `\x1b`) that should never
 * end up as literal text in a user's prompt buffer. Used as a final
 * defensive pass before treating input as printable — if a CSI
 * fragment slipped past structured-key recovery (e.g. arrived
 * embedded inside a paste burst), at least drop the raw bytes
 * rather than insert them as garbage text.
 *
 * Includes the bracketed-paste markers `[200~` / `[201~` because a
 * paste whose start/end markers got chunked across reads can leave
 * those bytes in the printable input.
 */
export const STRIPPABLE_CSI_FRAGMENTS: readonly string[] = [
  "\u001b[200~",
  "\u001b[201~",
  "[200~",
  "[201~",
  ...CSI_TAIL_TO_FLAGS.flatMap((e) => [`\u001b${e.tail}`, e.tail]),
];

/** Remove every recognised CSI fragment from a string. */
export function stripCsiFragments(input: string): string {
  let out = input;
  for (const frag of STRIPPABLE_CSI_FRAGMENTS) {
    if (out.includes(frag)) out = out.replaceAll(frag, "");
  }
  return out;
}
