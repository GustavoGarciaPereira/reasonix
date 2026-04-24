/**
 * Plan Mode — read-only exploration phase for `reasonix code`.
 *
 * Shape (mirrors claude-code's plan/act split, adapted for Reasonix):
 *
 *   1. User types `/plan` → registry switches to plan-mode enforcement
 *      (write tools refused at dispatch; reads + allowlisted shell
 *      still work).
 *   2. Model explores, then calls `submit_plan` with a markdown plan
 *      (and, optionally, a structured `steps` array).
 *   3. `submit_plan` throws `PlanProposedError`, which the TUI renders
 *      as a picker: Approve / Refine / Cancel.
 *   4. Approve → registry leaves plan mode, a synthetic user message
 *      "The plan has been approved. Implement it now." is pushed into
 *      the loop so the next turn executes.
 *   5. During execution the model may call `mark_step_complete` after
 *      each step; the TUI shows a progress row per completion.
 *
 * The read-only enforcement lives in `ToolRegistry.dispatch` via
 * `readOnly` / `readOnlyCheck`; this file ships the `submit_plan`
 * escape hatch, the `mark_step_complete` progress signal, and the
 * error type that carries the plan out of the registry without
 * stuffing it into the message.
 *
 * We do not change `ImmutablePrefix.toolSpecs` when plan mode toggles —
 * that would break Pillar 1's prefix cache. Instead the same full spec
 * list stays pinned, and the registry enforces mode at dispatch time.
 * The refusal string teaches the model the rule; cache hits stay
 * intact.
 */

import type { ToolRegistry } from "../tools.js";

/**
 * Structured step in a submitted plan. Optional — plans can still be
 * pure markdown. When provided, each step is addressable by `id` so
 * the model can later mark it complete via `mark_step_complete`.
 */
export interface PlanStep {
  id: string;
  title: string;
  action: string;
}

/**
 * Thrown by `submit_plan` when plan mode is active, carrying the plan
 * text (and optional structured steps) the TUI will render for the
 * user's approval.
 *
 * Implements the `toToolResult` protocol so `ToolRegistry.dispatch`
 * serializes the full plan into the tool-result JSON (not just the
 * error message). The TUI parses `{ error, plan, steps? }` from the
 * tool event and mounts the `PlanConfirm` picker.
 */
export class PlanProposedError extends Error {
  readonly plan: string;
  readonly steps?: PlanStep[];
  constructor(plan: string, steps?: PlanStep[]) {
    super(
      "PlanProposedError: plan submitted. STOP calling tools now — the TUI has shown the plan to the user. Wait for their next message; it will either approve (you'll then implement the plan), request a refinement (you should explore more and submit an updated plan), or cancel (drop the plan and ask what they want instead). Don't call any tools in the meantime.",
    );
    this.name = "PlanProposedError";
    this.plan = plan;
    this.steps = steps;
  }

  /**
   * Structured tool-result shape. Consumed by the TUI to extract the
   * plan without regex-scraping the error message. `steps` is only
   * included when the model supplied a structured list.
   */
  toToolResult(): { error: string; plan: string; steps?: PlanStep[] } {
    const payload: { error: string; plan: string; steps?: PlanStep[] } = {
      error: `${this.name}: ${this.message}`,
      plan: this.plan,
    };
    if (this.steps && this.steps.length > 0) payload.steps = this.steps;
    return payload;
  }
}

export interface PlanToolOptions {
  /**
   * Optional side-channel callback fired when the model submits a plan.
   * The TUI uses this to preview the plan in real time (the tool-result
   * event is also emitted; this is just earlier and friendlier to
   * test harnesses that don't want to parse JSON).
   */
  onPlanSubmitted?: (plan: string, steps?: PlanStep[]) => void;
  /**
   * Optional callback fired when the model marks a step complete via
   * `mark_step_complete`. Analogous to `onPlanSubmitted` — the tool
   * event carries the same payload, but this firing point is earlier
   * and avoids JSON parsing for consumers that don't need it.
   */
  onStepCompleted?: (update: StepCompletion) => void;
}

/**
 * Payload surfaced by `mark_step_complete` via `PlanCheckpointError`.
 * The TUI parses the tool result JSON, pushes a `✓ step` progress row,
 * and mounts the checkpoint picker. `kind` is kept on the payload so
 * consumers that peek at the JSON can dispatch on a stable tag.
 */
export interface StepCompletion {
  kind: "step_completed";
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
}

/**
 * Thrown by `mark_step_complete`. Mirrors `PlanProposedError`: the
 * registry serializes the structured payload via `toToolResult`, the
 * TUI catches the error tag and pauses the loop until the user
 * decides continue / revise / stop. The error message tells the model
 * to stop calling tools so it doesn't race past the picker.
 */
export class PlanCheckpointError extends Error {
  readonly stepId: string;
  readonly title?: string;
  readonly result: string;
  readonly notes?: string;
  constructor(update: { stepId: string; title?: string; result: string; notes?: string }) {
    super(
      "PlanCheckpointError: step complete — STOP calling tools. The TUI has paused the plan for user review. Wait for the next user message; it will either say continue (proceed to the next step), request a revision (adjust the remaining plan), or stop (summarize and end).",
    );
    this.name = "PlanCheckpointError";
    this.stepId = update.stepId;
    this.title = update.title;
    this.result = update.result;
    this.notes = update.notes;
  }

  toToolResult(): { error: string } & StepCompletion {
    const payload: { error: string } & StepCompletion = {
      error: `${this.name}: ${this.message}`,
      kind: "step_completed",
      stepId: this.stepId,
      result: this.result,
    };
    if (this.title) payload.title = this.title;
    if (this.notes) payload.notes = this.notes;
    return payload;
  }
}

function sanitizeSteps(raw: unknown): PlanStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const title = typeof e.title === "string" ? e.title.trim() : "";
    const action = typeof e.action === "string" ? e.action.trim() : "";
    if (!id || !title || !action) continue;
    steps.push({ id, title, action });
  }
  return steps.length > 0 ? steps : undefined;
}

export function registerPlanTool(registry: ToolRegistry, opts: PlanToolOptions = {}): ToolRegistry {
  registry.register({
    name: "submit_plan",
    description:
      "Submit ONE concrete plan you've already decided on. Use this for tasks that warrant a review gate — multi-file refactors, architecture changes, anything that would be expensive or confusing to undo. Skip it for small fixes (one-line typo, obvious bug with a clear fix) — just make the change. The user will either approve (you then implement it), ask for refinement, or cancel. If the user has already enabled /plan mode, writes are blocked at dispatch and you MUST use this. CRITICAL: do NOT use submit_plan to present alternative routes (A/B/C, option 1/2/3) for the user to pick from — the picker only exposes approve/refine/cancel, so a menu plan strands the user with no way to choose. For branching decisions, call `ask_choice` instead; only call submit_plan once the user has picked a direction and you have a single actionable plan. Write the plan as markdown with a one-line summary, a bulleted list of files to touch and what will change, and any risks or open questions. Optionally pass `steps` — an array of {id, title, action} — so the UI can track per-step progress; call `mark_step_complete` after finishing each one.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description:
            "Markdown-formatted plan. Lead with a one-sentence summary. Then a file-by-file breakdown of what you'll change and why. Flag any risks or open questions at the end so the user can weigh in before you start.",
        },
        steps: {
          type: "array",
          description:
            "Optional structured step list. When provided, the UI shows a progress counter and each `mark_step_complete` call ticks one off. Use stable ids (step-1, step-2, ...). Skip for small plans where the markdown body is enough.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable id, e.g. step-1." },
              title: { type: "string", description: "Short imperative title." },
              action: {
                type: "string",
                description: "One-sentence description of the concrete action.",
              },
            },
            required: ["id", "title", "action"],
          },
        },
      },
      required: ["plan"],
    },
    fn: async (args: { plan: string; steps?: unknown }) => {
      const plan = (args?.plan ?? "").trim();
      if (!plan) {
        throw new Error("submit_plan: empty plan — write a markdown plan and try again.");
      }
      const steps = sanitizeSteps(args?.steps);
      // Always fire the picker, not just inside plan mode. Plan mode's
      // role is the *stronger* constraint — it forces you into read-only
      // until you submit. Outside plan mode, submit_plan is your own
      // call: use it when the task is large enough to deserve a review
      // gate (multi-file refactors, architecture changes, anything
      // that would be expensive to undo), skip it for small fixes.
      opts.onPlanSubmitted?.(plan, steps);
      throw new PlanProposedError(plan, steps);
    },
  });
  registry.register({
    name: "mark_step_complete",
    description:
      "Mark one step of the approved plan as done AND pause for the user to review. Call this after finishing each step. The TUI shows a ✓ progress row and mounts a Continue / Revise / Stop picker — you MUST stop calling tools after this fires and wait for the next user message. Pass the `stepId` from the plan's steps array, a short `result` (what you did), and optional `notes` for anything surprising (errors, scope changes, follow-ups). This tool doesn't change any files. Don't call it if the plan didn't include structured steps, and don't invent ids that weren't in the original plan.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        stepId: {
          type: "string",
          description:
            "The id of the step being marked complete. Must match one from submit_plan's steps array.",
        },
        title: {
          type: "string",
          description:
            "Optional. The step's title, echoed back for the UI. If omitted, the UI falls back to the id.",
        },
        result: {
          type: "string",
          description: "One-sentence summary of what was done for this step.",
        },
        notes: {
          type: "string",
          description:
            "Optional. Anything surprising — blockers hit, assumptions revised, follow-ups for later steps.",
        },
      },
      required: ["stepId", "result"],
    },
    fn: async (args: { stepId: string; title?: string; result: string; notes?: string }) => {
      const stepId = (args?.stepId ?? "").trim();
      const result = (args?.result ?? "").trim();
      if (!stepId) {
        throw new Error("mark_step_complete: stepId is required.");
      }
      if (!result) {
        throw new Error(
          "mark_step_complete: result is required — say in one sentence what you did.",
        );
      }
      const title = typeof args?.title === "string" ? args.title.trim() || undefined : undefined;
      const notes = typeof args?.notes === "string" ? args.notes.trim() || undefined : undefined;
      const update: StepCompletion = { kind: "step_completed", stepId, result };
      if (title) update.title = title;
      if (notes) update.notes = notes;
      opts.onStepCompleted?.(update);
      throw new PlanCheckpointError({ stepId, title, result, notes });
    },
  });
  return registry;
}
