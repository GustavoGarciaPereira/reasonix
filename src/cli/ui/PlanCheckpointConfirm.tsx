/**
 * Modal-style picker shown when `mark_step_complete` pauses the loop
 * via `PlanCheckpointError`. Three choices:
 *
 *   1. Continue — push "Step X done, proceed." so the model starts
 *      the next step on the next turn.
 *   2. Revise   — open a feedback input; whatever the user types
 *      becomes a synthetic "user feedback for remaining steps" message.
 *      The model can then adjust its approach without starting the
 *      whole plan over.
 *   3. Stop     — push "User stopped the plan. Summarize what was
 *      done." so the run ends cleanly rather than being abandoned.
 *
 * The ✓ step-progress scrollback row is pushed separately (by App.tsx
 * at checkpoint detection time), so this modal stays a tight picker —
 * no need to re-render the step body here.
 */

import { Box, Text } from "ink";
import React from "react";
import { SingleSelect } from "./Select.js";

export type CheckpointChoice = "continue" | "revise" | "stop";

export interface PlanCheckpointConfirmProps {
  stepId: string;
  title?: string;
  completed: number;
  total: number;
  onChoose: (choice: CheckpointChoice) => void;
}

function PlanCheckpointConfirmInner({
  stepId,
  title,
  completed,
  total,
  onChoose,
}: PlanCheckpointConfirmProps) {
  const label = title ? `${stepId} · ${title}` : stepId;
  const counter = total > 0 ? ` (${completed}/${total})` : "";
  const isLast = total > 0 && completed >= total;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} marginY={1}>
      <Box>
        <Text bold color="green">
          ▸ checkpoint — step done
        </Text>
        <Text dimColor>{`  ${label}${counter}`}</Text>
      </Box>
      <Box marginTop={1}>
        <SingleSelect
          initialValue={isLast ? "stop" : "continue"}
          items={[
            {
              value: "continue",
              label: "Continue — run the next step",
              hint: "Model resumes with the next step. Use this when the result looks right and you don't need to tweak the remaining plan.",
            },
            {
              value: "revise",
              label: "Revise — give feedback before the next step",
              hint: "Stay paused, type guidance (scope changes, skip steps, alternative approach). The model adjusts the remaining plan based on your message.",
            },
            {
              value: "stop",
              label: "Stop — end the plan here",
              hint: "Model summarizes what was done and ends. Remaining steps are skipped.",
            },
          ]}
          onSubmit={(v) => onChoose(v as CheckpointChoice)}
          onCancel={() => onChoose("stop")}
          footer="[↑↓] navigate  ·  [Enter] select  ·  [Esc] stop"
        />
      </Box>
    </Box>
  );
}

export const PlanCheckpointConfirm = React.memo(PlanCheckpointConfirmInner);
