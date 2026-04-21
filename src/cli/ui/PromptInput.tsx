import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import React from "react";

export interface PromptInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Keep `<TextInput>` mounted at all times and use its `focus` prop to gate
 * input. Conditionally rendering it (mount / unmount between turns) loses
 * the stdin raw-mode claim on some terminals, which silently drops
 * keystrokes after the first turn finishes.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: PromptInputProps) {
  const effectivePlaceholder = disabled
    ? (placeholder ?? "…waiting for response…")
    : (placeholder ?? 'type a message, or "/exit"');
  return (
    <Box borderStyle="round" borderColor={disabled ? "gray" : "cyan"} paddingX={1}>
      <Text bold color={disabled ? "gray" : "cyan"}>
        you ›{" "}
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus={!disabled}
        placeholder={effectivePlaceholder}
      />
    </Box>
  );
}
