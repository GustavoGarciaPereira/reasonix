import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { type MultilineKey, processMultilineKey } from "./multiline-keys.js";

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
  const [showCursor, setShowCursor] = useState(true);

  // Blink the end-of-input cursor so it's visibly alive even when
  // the user hasn't typed for a while. 500 ms matches a typical
  // terminal cursor blink.
  useEffect(() => {
    if (disabled) {
      setShowCursor(false);
      return;
    }
    setShowCursor(true);
    const id = setInterval(() => setShowCursor((s) => !s), 500);
    return () => clearInterval(id);
  }, [disabled]);

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
            {showPlaceholder ? <Text dimColor>{effectivePlaceholder}</Text> : <Text>{line}</Text>}
            {isLast && !disabled && !showPlaceholder ? (
              <Text color={borderColor}>{showCursor ? "▌" : " "}</Text>
            ) : null}
            {isLast && !disabled && showPlaceholder ? (
              <Text color={borderColor}>{showCursor ? "▌" : " "}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
