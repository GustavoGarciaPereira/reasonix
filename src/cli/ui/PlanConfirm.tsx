/**
 * Modal-style approval for a `submit_plan` proposal.
 *
 * Three choices:
 *   1. Approve + implement — exits plan mode, pushes a synthetic user
 *      message telling the model to implement the plan now.
 *   2. Refine — stays in plan mode; tells the model to explore more
 *      and submit an improved plan.
 *   3. Cancel — exits plan mode, drops the plan, tells the model the
 *      user didn't want any of it.
 *
 * Mirrors ShellConfirm in structure (border, SingleSelect, three
 * options, no y/n hotkey — mid-typing triggers would be painful).
 * The plan body is rendered verbatim above the picker so the user can
 * actually read what they're approving.
 */

import { Box, Text } from "ink";
import React from "react";
import { SingleSelect } from "./Select.js";
import { Markdown } from "./markdown.js";

export type PlanConfirmChoice = "approve" | "refine" | "cancel";

export interface PlanConfirmProps {
  plan: string;
  onChoose: (choice: PlanConfirmChoice) => void;
  /**
   * Cap on rendered plan length. A pathological 20-KB plan would push
   * the picker off the bottom of the terminal; we show the head +
   * "(…N chars truncated — /tool for full output)" instead. The picker
   * itself gets the full plan (it's already been committed to the
   * transcript via the tool result).
   */
  maxRenderedChars?: number;
  projectRoot?: string;
}

const DEFAULT_MAX_RENDERED = 2400;

export function PlanConfirm({ plan, onChoose, maxRenderedChars, projectRoot }: PlanConfirmProps) {
  const cap = maxRenderedChars ?? DEFAULT_MAX_RENDERED;
  const tooLong = plan.length > cap;
  const visible = tooLong
    ? `${plan.slice(0, cap)}\n\n… (${plan.length - cap} chars truncated — use /tool to view the full proposal)`
    : plan;
  // Crude signal for "the model left questions or risks for me" — the
  // typical section headings. Triggers an extra hint toward the Refine
  // option so users know where to answer them.
  const hasOpenQuestions =
    /^#{1,6}\s*(open[-\s]?questions?|risks?|unknowns?|assumptions?|unclear)/im.test(plan) ||
    /^#{1,6}\s*(待确认|开放问题|风险|未知|假设|不确定)/im.test(plan);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Box>
        <Text bold color="cyan">
          ▸ plan submitted — awaiting your review
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Markdown text={visible} projectRoot={projectRoot} />
      </Box>
      {hasOpenQuestions ? (
        <Box marginTop={1}>
          <Text color="yellow">
            ▲ the plan has open questions or flagged risks — pick{" "}
            <Text bold>Refine / answer questions</Text> to write concrete answers before the model
            moves on.
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <SingleSelect
          initialValue={hasOpenQuestions ? "refine" : "approve"}
          items={[
            {
              value: "approve",
              label: "Approve and implement",
              hint: "Exit plan mode. The model starts executing. You'll get a text input to add any last instructions (or just press Enter to skip).",
            },
            {
              value: "refine",
              label: "Refine / answer questions",
              hint: "Stay in plan mode. Write answers, modifications, or critiques; the model revises and re-submits.",
            },
            {
              value: "cancel",
              label: "Cancel",
              hint: "Exit plan mode. Drop the plan; the model won't implement it.",
            },
          ]}
          onSubmit={(v) => onChoose(v as PlanConfirmChoice)}
        />
      </Box>
    </Box>
  );
}
