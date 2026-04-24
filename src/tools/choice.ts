/**
 * ask_choice — the primitive for "user needs to pick between alternatives".
 *
 * Why it exists: `submit_plan` is for ONE concrete plan the user approves.
 * Models routinely misused it to present A/B/C option menus, leaving the
 * user stuck with an approve/refine/cancel picker that had no way to
 * select a route. `ask_choice` gives branching its own tool so plan
 * mode stays about one actionable thing at a time.
 *
 * Shape mirrors `submit_plan`:
 *   1. Model calls `ask_choice` with a question and 2–4 options.
 *   2. The tool throws `ChoiceRequestedError`; the registry serializes
 *      the payload via `toToolResult`.
 *   3. TUI parses the tagged error, mounts `ChoiceConfirm`, user picks
 *      one option (or types a custom answer via the escape hatch, or
 *      cancels).
 *   4. A synthetic user message feeds the choice back — "user picked
 *      <id>" or "user answered: <text>" — and the loop resumes.
 *
 * Auto-flatten note: the `options` array of objects is exactly the
 * schema shape that DeepSeek V3/R1 is known to drop. `ToolRegistry`
 * auto-flattens and re-nests on dispatch (Pillar 3), so we don't need
 * to hand-flatten here. We still `sanitizeOptions` at runtime because
 * even with flatten-repair, models occasionally emit empty strings or
 * miss fields entirely.
 */

import type { ToolRegistry } from "../tools.js";

/**
 * One option in a branching question. `id` is what gets fed back to
 * the model when the user picks; keep it short and stable (A, B, C,
 * or option-1 / option-2 / ...). `summary` is optional extra context
 * the UI shows as a dimmed sub-line under the title.
 */
export interface ChoiceOption {
  id: string;
  title: string;
  summary?: string;
}

/**
 * Thrown by `ask_choice`. Carries the branching question plus the
 * options list out to the TUI via the `toToolResult` protocol. The
 * error message tells the model to STOP so it doesn't race past the
 * picker with more tool calls — same pattern as `PlanProposedError`.
 */
export class ChoiceRequestedError extends Error {
  readonly question: string;
  readonly options: ChoiceOption[];
  readonly allowCustom: boolean;
  constructor(question: string, options: ChoiceOption[], allowCustom: boolean) {
    super(
      "ChoiceRequestedError: choice submitted. STOP calling tools now — the TUI has shown the options to the user. Wait for their next message; it will either be 'user picked <id>' (carry on with that branch), 'user answered: <text>' (custom free-form reply; read and proceed), or 'user cancelled the choice' (drop the question and ask what they want instead). Don't call any tools in the meantime.",
    );
    this.name = "ChoiceRequestedError";
    this.question = question;
    this.options = options;
    this.allowCustom = allowCustom;
  }

  toToolResult(): {
    error: string;
    question: string;
    options: ChoiceOption[];
    allowCustom: boolean;
  } {
    return {
      error: `${this.name}: ${this.message}`,
      question: this.question,
      options: this.options,
      allowCustom: this.allowCustom,
    };
  }
}

export interface ChoiceToolOptions {
  /**
   * Side-channel preview fired when the model asks. The tool-result
   * event also carries the payload; this is the earlier hook for
   * test harnesses or alternative UIs that don't want to parse JSON.
   */
  onChoiceRequested?: (question: string, options: ChoiceOption[]) => void;
}

function sanitizeOptions(raw: unknown): ChoiceOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ChoiceOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const title = typeof e.title === "string" ? e.title.trim() : "";
    if (!id || !title) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const summary = typeof e.summary === "string" ? e.summary.trim() || undefined : undefined;
    const opt: ChoiceOption = { id, title };
    if (summary) opt.summary = summary;
    out.push(opt);
  }
  return out;
}

export function registerChoiceTool(
  registry: ToolRegistry,
  opts: ChoiceToolOptions = {},
): ToolRegistry {
  registry.register({
    name: "ask_choice",
    description:
      "Ask the user to pick between 2–4 pre-defined alternatives. Use when the decision is genuinely the user's to make — strategic direction, stylistic preference, which of two equally-valid approaches, a library pick you can't weigh without them. Do NOT use for: (a) clarifying questions that just need a text answer — write those as plain assistant text with a question; (b) presenting A/B/C 'routes' inside submit_plan — that strands the user at an approve/refine/cancel picker with no branch selector, use ask_choice instead; (c) when there's an obvious best option — just do it or submit_plan it. Keep option ids short and stable (A, B, C, or option-1 / option-2). Each option needs a title; summary is optional context. Set allowCustom=true when the user might reasonably want a reply that isn't in your list.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The question to put in front of the user. One sentence. Don't repeat the options in the question text — the picker renders them separately.",
        },
        options: {
          type: "array",
          description:
            "2–4 alternatives. Each needs a stable id and a short title; summary is optional.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short stable id (A, B, C, or option-1)." },
              title: { type: "string", description: "One-line title shown as the option label." },
              summary: {
                type: "string",
                description:
                  "Optional. A second dimmed line with more detail. Keep under ~80 chars.",
              },
            },
            required: ["id", "title"],
          },
        },
        allowCustom: {
          type: "boolean",
          description:
            "If true, the picker shows a 'Let me type my own answer' escape hatch. Default false. Turn on when the user's real answer might not fit any of your pre-defined options.",
        },
      },
      required: ["question", "options"],
    },
    fn: async (args: { question: string; options: unknown; allowCustom?: boolean }) => {
      const question = (args?.question ?? "").trim();
      if (!question) {
        throw new Error(
          "ask_choice: question is required — write one sentence explaining the decision.",
        );
      }
      const options = sanitizeOptions(args?.options);
      if (options.length < 2) {
        throw new Error(
          "ask_choice: need at least 2 well-formed options (each with a non-empty id and title). If you just need a text answer, ask the user in plain assistant text instead.",
        );
      }
      if (options.length > 6) {
        throw new Error(
          "ask_choice: too many options (max 6). If you really have this many branches, split into two sequential ask_choice calls or narrow down first.",
        );
      }
      const allowCustom = args?.allowCustom === true;
      opts.onChoiceRequested?.(question, options);
      throw new ChoiceRequestedError(question, options, allowCustom);
    },
  });
  return registry;
}
