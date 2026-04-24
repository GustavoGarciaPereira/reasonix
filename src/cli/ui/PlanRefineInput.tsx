/**
 * Inline text input shown after the user picks Approve or Refine in
 * PlanConfirm. Collects free-form feedback before the loop resumes.
 *
 * Why both paths: the plan may contain open questions or risks the
 * model asked the user to weigh in on. If the user just picks Approve
 * with no chance to answer, the model implements against its own
 * guesses. This input lets the user answer questions, pass last-minute
 * constraints, or (on Refine) request concrete changes. Empty input is
 * fine for Approve (skip straight to implement) and triggers a
 * "ask the user clarifying questions" path for Refine.
 *
 * Kept minimal: single-line prompt, Enter to submit, Esc to return to
 * the picker without resuming.
 */

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";

export interface PlanRefineInputProps {
  /**
   * Which path the user is on. Approve = "implement with these last
   * instructions"; refine = "revise the plan with this feedback";
   * checkpoint-revise = mid-execution pause, user is tweaking the
   * remaining plan after seeing a step's result. Drives the header +
   * hint text so users know what kind of message they're writing.
   */
  mode: "approve" | "refine" | "checkpoint-revise";
  /** Called with trimmed feedback. Empty string is allowed. */
  onSubmit: (feedback: string) => void;
  /** Called when the user presses Esc to return to the picker. */
  onCancel: () => void;
}

export function PlanRefineInput({ mode, onSubmit, onCancel }: PlanRefineInputProps) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(value.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    // Filter out non-printable chars; accept ordinary text + CJK.
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  const title =
    mode === "approve"
      ? "▸ approving — any last instructions or answers to open questions?"
      : mode === "checkpoint-revise"
        ? "▸ revising — what should change before the next step?"
        : "▸ refining — what should the model change?";
  const hint =
    mode === "approve"
      ? "Answer questions the plan raised, add constraints, or just press Enter to approve as-is."
      : mode === "checkpoint-revise"
        ? "Scope change, skip steps, alternative approach — the model will adjust the remaining plan based on this."
        : "Describe what's wrong or missing, or answer questions the plan raised.";
  const blankHint =
    mode === "approve"
      ? " (Enter with blank = approve without extra instructions.)"
      : mode === "checkpoint-revise"
        ? " (Enter with blank = continue with the current plan.)"
        : " (Enter with blank = ask the model to list concrete questions.)";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box>
        <Text bold color="yellow">
          {title}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {hint} Enter to send · Esc to return to the picker.
          {value === "" ? blankHint : ""}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color="yellow">› </Text>
          <Text>{value || " "}</Text>
          <Text color="yellow">▍</Text>
        </Text>
      </Box>
    </Box>
  );
}
