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
 * The plan BODY is NOT rendered inside this modal — App.tsx pushes it
 * into the Static scrollback as a `role: "plan"` display event the
 * moment submit_plan fires. That's a one-time markdown render into
 * permanent history, so the user reads the full proposal above and
 * the modal below stays a tight picker. The previous design (body
 * rendered inside the modal with an aggressive line clamp) left users
 * staring at "(25 more lines truncated)" and unable to approve safely.
 */

import { Box, Text } from "ink";
import React from "react";
import type { PlanStep } from "../../tools/plan.js";
import { ModalCard } from "./ModalCard.js";
import { PlanStepList } from "./PlanStepList.js";
import { SingleSelect } from "./Select.js";

export type PlanConfirmChoice = "approve" | "refine" | "cancel";

export interface PlanConfirmProps {
  plan: string;
  steps?: PlanStep[];
  /** Optional human-friendly title from the model — surfaced in the header. */
  summary?: string;
  onChoose: (choice: PlanConfirmChoice) => void;
  projectRoot?: string;
}

function PlanConfirmInner({ plan, steps, summary, onChoose }: PlanConfirmProps) {
  // Crude signal for "the model left questions or risks for me" — the
  // typical section headings. Triggers an extra hint toward the Refine
  // option so users know where to answer them.
  const hasOpenQuestions =
    /^#{1,6}\s*(open[-\s]?questions?|risks?|unknowns?|assumptions?|unclear)/im.test(plan) ||
    /^#{1,6}\s*(待确认|开放问题|风险|未知|假设|不确定)/im.test(plan);

  return (
    <ModalCard
      accent="#67e8f9"
      icon="📋"
      title="plan proposed"
      subtitle={summary ?? "approve / refine / cancel"}
    >
      {hasOpenQuestions ? (
        <Box marginBottom={1}>
          <Text color="#fbbf24">
            ▲ the plan flags open questions or risks — pick{" "}
            <Text bold>Refine / answer questions</Text> to write concrete answers before the model
            moves on.
          </Text>
        </Box>
      ) : null}
      {steps && steps.length > 0 ? (
        <Box marginBottom={1} flexDirection="column">
          <PlanStepList steps={steps} />
        </Box>
      ) : null}
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
        onCancel={() => onChoose("cancel")}
        footer="[↑↓] navigate  ·  [Enter] select  ·  [Esc] cancel"
      />
    </ModalCard>
  );
}

// React.memo: parent App re-renders every 120ms while the global ticker
// is running (even with the live status rows hidden — context changes
// propagate). Unless props change, skip re-rendering the heavy Markdown
// subtree. Default shallow prop compare is fine — `plan` + `onChoose`
// identity + `projectRoot` are the only fields that change.
export const PlanConfirm = React.memo(PlanConfirmInner);
