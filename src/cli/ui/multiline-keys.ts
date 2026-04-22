/**
 * Pure keystroke → action reducer for MultilineInput.
 *
 * Kept separate from the React component so the keyboard
 * semantics are easy to unit-test. MultilineInput is otherwise
 * a thin Ink wrapper that threads its `useInput` callback
 * through this function and applies the result.
 *
 * Terminal reality check: on most terminals, pressing Shift+Enter
 * sends the exact same byte as plain Enter — the modifier is lost.
 * That's why the reliable newline insertion path is Ctrl+J (which
 * really is LF, distinct from CR), with Shift+Enter only working
 * on terminals that opt into CSI-u modifier encoding. The `\<Enter>`
 * bash-style continuation is the portable fallback.
 */

export interface MultilineKey {
  /** Printable character(s) delivered by the key event, may be empty. */
  input: string;
  /** Modifier + named-key flags as Ink reports them. */
  return?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
  /** Navigation/editing keys owned by the parent App (slash-nav, history). */
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  escape?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

export interface MultilineAction {
  /** New value to set on the text buffer. `null` = unchanged. */
  next: string | null;
  /** When `true`, the caller should fire `onSubmit(next ?? value)`. */
  submit: boolean;
  /** When submitting, which value to submit (after any final trims). */
  submitValue?: string;
}

const BACKSLASH_SUFFIX = /\\$/;

/**
 * Decide what to do with a single keystroke against the current buffer.
 *
 * Decisions:
 *   Ctrl+J              → insert '\n' (terminal-universal newline)
 *   Shift+Return        → insert '\n' (works where CSI-u is on)
 *   Enter with "\" end  → replace trailing '\' with '\n' (bash continuation)
 *   Enter               → submit the current buffer
 *   Backspace/Delete    → drop one char from the end (cursor-at-end model)
 *   Printable char(s)   → append at the end
 *
 * We don't model an insertion cursor inside the string: always-at-end
 * keeps the reducer tiny and matches how readline-in-raw-mode feels. The
 * user can still edit by backspacing — for deep edits, exit and compose
 * in $EDITOR.
 */
export function processMultilineKey(value: string, key: MultilineKey): MultilineAction {
  // Parent App owns these keys: Tab for slash auto-complete, arrows
  // for slash-nav/history, Esc for abort. Bowing out here keeps the
  // text buffer from eating a stray "\t" or arrow escape sequence
  // when both the parent and child useInput fire on the same event.
  if (
    key.tab ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.escape ||
    key.pageUp ||
    key.pageDown
  ) {
    return { next: null, submit: false };
  }

  // Reliable newline: Ctrl+J arrives as literal '\n' in key.input on
  // every terminal we've checked. We also accept key.ctrl && input=='j'
  // as a belt-and-braces match against terminals that normalize the
  // control-char into its ASCII letter form.
  if (key.input === "\n" || (key.ctrl && key.input === "j")) {
    return { next: `${value}\n`, submit: false };
  }

  if (key.return) {
    // Shift+Return → newline (when terminal reports the modifier).
    if (key.shift) {
      return { next: `${value}\n`, submit: false };
    }
    // Bash-style line continuation: trailing '\' + Enter.
    if (BACKSLASH_SUFFIX.test(value)) {
      return { next: `${value.slice(0, -1)}\n`, submit: false };
    }
    // Plain Enter → submit.
    return { next: null, submit: true, submitValue: value };
  }

  if (key.backspace || key.delete) {
    if (value.length === 0) return { next: null, submit: false };
    return { next: value.slice(0, -1), submit: false };
  }

  // Ignore bare modifier keys (ctrl/meta without accompanying printable).
  if ((key.ctrl || key.meta) && key.input.length === 0) {
    return { next: null, submit: false };
  }

  // Printable input (may be a multi-char paste burst — accept as-is;
  // pasted newlines become part of the buffer rather than triggering
  // submit on the first line).
  if (key.input.length > 0 && !key.ctrl && !key.meta) {
    return { next: value + key.input, submit: false };
  }

  return { next: null, submit: false };
}
