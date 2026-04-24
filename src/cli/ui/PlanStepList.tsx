/**
 * Shared compact renderer for a plan's structured step list. Used by
 * PlanConfirm (on approval) and PlanCheckpointConfirm (mid-execution)
 * so the user always sees the same visual representation of the plan.
 *
 * Layout per step:
 *
 *    ● ✓ step-1 · Extract tokens into a module
 *    ●●▶ step-2 · Migrate session cookies
 *    ●●●  step-3 · Update tests
 *
 * The risk gutter (1–3 dots, green/yellow/red) is the signal the user
 * learns to scan: high-risk steps are what deserves review before
 * approve; low-risk is noise.
 */

import { Box, Text } from "ink";
import React from "react";
import type { PlanStep, PlanStepRisk } from "../../tools/plan.js";

export type StepStatus = "pending" | "running" | "done" | "skipped";

export interface PlanStepListProps {
  steps: PlanStep[];
  /**
   * Map of stepId → status. Missing ids default to "pending" so a
   * plan just submitted (no completions yet) renders cleanly.
   */
  statuses?: Map<string, StepStatus> | Record<string, StepStatus>;
  /**
   * Optional current step — rendered with a `›` gutter mark so the
   * user sees which one just completed / is about to run.
   */
  focusStepId?: string;
}

function riskDots(risk: PlanStep["risk"]): {
  dots: string;
  color: "green" | "yellow" | "red" | "gray";
} {
  switch (risk) {
    case "high":
      return { dots: "●●●", color: "red" };
    case "med":
      return { dots: "●● ", color: "yellow" };
    case "low":
      return { dots: "●  ", color: "green" };
    default:
      return { dots: "   ", color: "gray" };
  }
}

function statusGlyph(status: StepStatus): {
  glyph: string;
  color: "green" | "cyan" | "gray" | "yellow";
} {
  switch (status) {
    case "done":
      return { glyph: "✓", color: "green" };
    case "running":
      return { glyph: "▶", color: "cyan" };
    case "skipped":
      return { glyph: "—", color: "gray" };
    default:
      return { glyph: " ", color: "yellow" };
  }
}

function getStatus(stepId: string, statuses: PlanStepListProps["statuses"]): StepStatus {
  if (!statuses) return "pending";
  if (statuses instanceof Map) {
    return statuses.get(stepId) ?? "pending";
  }
  return statuses[stepId] ?? "pending";
}

function PlanStepListInner({ steps, statuses, focusStepId }: PlanStepListProps) {
  if (steps.length === 0) return null;
  const hasAnyRisk = steps.some((s) => s.risk !== undefined);
  const doneCount = Array.from({ length: steps.length }, (_, i) =>
    getStatus(steps[i]!.id, statuses),
  ).filter((s) => s === "done").length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          {`${steps.length} step${steps.length === 1 ? "" : "s"}`}
          {doneCount > 0 ? ` · ${doneCount} done` : ""}
          {hasAnyRisk ? " · risk: " : ""}
        </Text>
        {hasAnyRisk ? <RiskLegend /> : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {steps.map((step) => {
          const status = getStatus(step.id, statuses);
          const focus = focusStepId === step.id;
          const risk = riskDots(step.risk);
          const glyph = statusGlyph(status);
          const titleDim = status === "done" || status === "skipped";
          return (
            <Box key={step.id}>
              <Text color={focus ? "cyan" : "gray"} bold={focus}>
                {focus ? "› " : "  "}
              </Text>
              <Text color={risk.color} bold>
                {risk.dots}
              </Text>
              <Text color={glyph.color} bold>
                {` ${glyph.glyph} `}
              </Text>
              <Text dimColor={titleDim}>{`${step.id} · ${step.title}`}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function RiskLegend() {
  return (
    <Box>
      <Text color="green">●</Text>
      <Text dimColor> low </Text>
      <Text color="yellow">●●</Text>
      <Text dimColor> med </Text>
      <Text color="red">●●●</Text>
      <Text dimColor> high</Text>
    </Box>
  );
}

export const PlanStepList = React.memo(PlanStepListInner);

export function riskOf(step: PlanStep): PlanStepRisk | undefined {
  return step.risk;
}
