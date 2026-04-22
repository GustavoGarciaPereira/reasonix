import { Box, Text, useInput } from "ink";
import React from "react";
import { type MultilineKey, processMultilineKey } from "./multiline-keys.js";
import { useTick } from "./ticker.js";

export interface PromptInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Input box with multi-line composition support. Behaves like the
 * old single-line prompt by default, but:
 *   - Ctrl+J inserts a newline (universal across terminals).
 *   - Shift+Enter inserts a newline (only on terminals that report
 *     the modifier via CSI-u — many don't).
 *   - `\<Enter>` at end of line acts as bash-style continuation —
 *     always works, even on terminals without modifier reporting.
 *   - Pasted multi-line text lands as-is instead of submitting on
 *     the first '\r'.
 *
 * No mid-string insertion cursor — edits happen at the end, like
 * a readline prompt in raw mode. Simple, predictable, enough for
 * 95% of prompts and any code paste.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: PromptInputProps) {
  // Blink from the shared ticker (TICK_MS ≈ 120ms) scaled by 4 so the
  // visible on/off toggles land around 500ms — standard cursor blink.
  // When disabled the cursor is hidden entirely.
  const tick = useTick();
  const showCursor = disabled ? false : Math.floor(tick / 4) % 2 === 0;

  useInput(
    (input, key) => {
      const keyEvent: MultilineKey = {
        input,
        return: key.return,
        shift: key.shift,
        ctrl: key.ctrl,
        meta: key.meta,
        backspace: key.backspace,
        delete: key.delete,
        tab: key.tab,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        leftArrow: key.leftArrow,
        rightArrow: key.rightArrow,
        escape: key.escape,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
      };
      const action = processMultilineKey(value, keyEvent);
      if (action.next !== null) onChange(action.next);
      if (action.submit) onSubmit(action.submitValue ?? value);
    },
    { isActive: !disabled },
  );

  const effectivePlaceholder = disabled
    ? (placeholder ?? "…waiting for response…")
    : (placeholder ?? "type a message, or /command · Ctrl+J for newline");

  const lines = value.length > 0 ? value.split("\n") : [""];
  const borderColor = disabled ? "gray" : "cyan";

  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      {lines.map((line, i) => {
        const isLast = i === lines.length - 1;
        const isFirst = i === 0;
        const showPlaceholder = isFirst && value.length === 0;
        // Line content never survives a re-keying here: the value buffer
        // fully re-renders on every keystroke, so the array index IS the
        // stable identity. Biome's rule targets list reordering, which
        // doesn't apply to an append-only splits-by-newline view.
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable by construction — lines are derived from `value.split("\n")` and never reordered
          <Box key={i}>
            {isFirst ? (
              <Text bold color={borderColor}>
                you ›{" "}
              </Text>
            ) : (
              <Text dimColor>{"     "}</Text>
            )}
            {/* When showing the placeholder, the cursor is at position 0 —
                put it BEFORE the dimmed hint text so it visually matches
                "you're about to type here," not "you typed the placeholder."
                When showing real content, the cursor follows the last char
                of the last line (append-only edit model). */}
            {showPlaceholder && isLast && !disabled ? (
              <Text color={borderColor}>{showCursor ? "▌" : " "}</Text>
            ) : null}
            {showPlaceholder ? <Text dimColor>{effectivePlaceholder}</Text> : <Text>{line}</Text>}
            {!showPlaceholder && isLast && !disabled ? (
              <Text color={borderColor}>{showCursor ? "▌" : " "}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
