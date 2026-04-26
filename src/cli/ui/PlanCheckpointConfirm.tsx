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

import { Box } from "ink";
import React from "react";
import type { PlanStep } from "../../tools/plan.js";
import { ModalCard } from "./ModalCard.js";
import { PlanStepList, type StepStatus } from "./PlanStepList.js";
import { SingleSelect } from "./Select.js";

export type CheckpointChoice = "continue" | "revise" | "stop";

export interface PlanCheckpointConfirmProps {
  stepId: string;
  title?: string;
  completed: number;
  total: number;
  /** Full step list from the approved plan, when available. */
  steps?: PlanStep[];
  /** Set of stepIds the model has marked complete so far. */
  completedStepIds?: Set<string>;
  onChoose: (choice: CheckpointChoice) => void;
}

function PlanCheckpointConfirmInner({
  stepId,
  title,
  completed,
  total,
  steps,
  completedStepIds,
  onChoose,
}: PlanCheckpointConfirmProps) {
  const label = title ? `${stepId} · ${title}` : stepId;
  const counter = total > 0 ? `${completed}/${total}` : "";
  const isLast = total > 0 && completed >= total;
  const statuses = buildStatusMap(steps, completedStepIds, stepId, isLast);
  const subtitle = counter ? `${counter}  ·  ${label}` : label;
  return (
    <ModalCard accent="#86efac" icon="✓" title="checkpoint — step done" subtitle={subtitle}>
      {steps && steps.length > 0 ? (
        <Box marginBottom={1} flexDirection="column">
          <PlanStepList steps={steps} statuses={statuses} focusStepId={stepId} />
        </Box>
      ) : null}
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
    </ModalCard>
  );
}

export const PlanCheckpointConfirm = React.memo(PlanCheckpointConfirmInner);

/**
 * Derive a status map from the plan + completion set + current step.
 * The currently-just-finished step always renders as "done" even if
 * completedStepIds hasn't been flushed yet (it gets added in the
 * same render cycle, order not guaranteed). Steps ahead of the
 * cursor are "pending"; the next step after the current one isn't
 * marked "running" because nothing is actually running while the
 * picker is up — that belongs to the post-continue state.
 */
function buildStatusMap(
  steps: PlanStep[] | undefined,
  completedStepIds: Set<string> | undefined,
  currentStepId: string,
  isLast: boolean,
): Map<string, StepStatus> {
  const map = new Map<string, StepStatus>();
  if (!steps) return map;
  for (const step of steps) {
    if (completedStepIds?.has(step.id) || step.id === currentStepId) {
      map.set(step.id, "done");
    } else {
      map.set(step.id, "pending");
    }
  }
  if (isLast) {
    // Every step is done; leave as "done" — no "running" overlay.
  }
  return map;
}
