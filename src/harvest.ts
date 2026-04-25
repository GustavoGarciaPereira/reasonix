/**
 * Pillar 2 — R1 Thought Harvesting.
 *
 * Takes the `reasoning_content` emitted by a thinking model (deepseek-reasoner
 * / R1) and extracts a structured plan state by making a cheap secondary call
 * to V3 in JSON mode. The typed state is intended for the orchestrator to
 * branch on — e.g. trigger self-consistency sampling when `uncertainties.length
 * > 2`, or surface the subgoals to the user.
 *
 * Opt-in: loops disable harvesting by default. Failures (bad JSON, API error,
 * empty reasoning) return an empty TypedPlanState — the main turn is never
 * aborted because of a harvest hiccup.
 */

import type { DeepSeekClient } from "./client.js";

export interface TypedPlanState {
  subgoals: string[];
  hypotheses: string[];
  uncertainties: string[];
  rejectedPaths: string[];
}

export interface HarvestOptions {
  /** Model used for the extraction call. Defaults to the cheap chat model. */
  model?: string;
  /** Cap on how many items land in each array. Default 5. */
  maxItems?: number;
  /** Per-item character cap. Default 80. */
  maxItemLen?: number;
  /** Abort the extraction if R1 reasoning is shorter than this. Default 40. */
  minReasoningLen?: number;
}

export function emptyPlanState(): TypedPlanState {
  return { subgoals: [], hypotheses: [], uncertainties: [], rejectedPaths: [] };
}

export function isPlanStateEmpty(s: TypedPlanState | null | undefined): boolean {
  if (!s) return true;
  return (
    s.subgoals.length === 0 &&
    s.hypotheses.length === 0 &&
    s.uncertainties.length === 0 &&
    s.rejectedPaths.length === 0
  );
}

const SYSTEM_PROMPT = `You extract a typed plan state from a reasoning trace produced by another LLM.
Output ONLY a JSON object. No markdown, no prose, no backticks.

Schema:
{
  "subgoals":       string[],   // concrete intermediate objectives the trace identifies
  "hypotheses":     string[],   // candidate approaches or assumptions being weighed
  "uncertainties":  string[],   // facts the trace flags as unclear / to verify
  "rejectedPaths":  string[]    // approaches the trace considered and then abandoned
}

Constraints:
- Every field must be present. Use [] if not applicable.
- Each array has at most {maxItems} items.
- Each item is plain text, at most {maxItemLen} characters, no markdown.
- Write in the same language as the trace (Chinese in → Chinese out, etc.).
- Do not quote back the trace; write short, specific phrases.`;

export async function harvest(
  reasoningContent: string | null | undefined,
  client?: DeepSeekClient,
  options: HarvestOptions = {},
  signal?: AbortSignal,
): Promise<TypedPlanState> {
  if (!client || !reasoningContent) return emptyPlanState();
  // Fast-path the already-aborted case so we don't burn a network
  // round-trip for a result the caller no longer wants.
  if (signal?.aborted) return emptyPlanState();
  const minLen = options.minReasoningLen ?? 40;
  const trimmed = reasoningContent.trim();
  if (trimmed.length < minLen) return emptyPlanState();

  // Harvest is schema-constrained JSON extraction, not agent reasoning.
  // Default to v4-flash with `thinking: "disabled"` below — a few
  // hundred output tokens fit easily in the non-thinking budget, the
  // reply comes back ~10× faster than thinking mode, and the per-turn
  // cost stays an asterisk next to the main loop's spend rather than a
  // visible slice of it. (`deepseek-chat` was the compat alias for this
  // same route; we now name the real model.)
  const model = options.model ?? "deepseek-v4-flash";
  const maxItems = options.maxItems ?? 5;
  const maxItemLen = options.maxItemLen ?? 80;
  const system = SYSTEM_PROMPT.replace("{maxItems}", String(maxItems)).replace(
    "{maxItemLen}",
    String(maxItemLen),
  );

  try {
    const resp = await client.chat({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: trimmed },
      ],
      responseFormat: { type: "json_object" },
      temperature: 0,
      maxTokens: 600,
      // Pin mode + effort so a future default-model swap (e.g. someone
      // sets `options.model = "deepseek-v4-pro"`) can't accidentally
      // turn this micro-extraction into a multi-thousand-reasoning-
      // token call. DeepSeek ignores these on non-thinking models, so
      // the request stays valid regardless of the chosen model.
      thinking: "disabled",
      reasoningEffort: "high",
      signal,
    });
    return parsePlanState(resp.content, maxItems, maxItemLen);
  } catch {
    return emptyPlanState();
  }
}

function parsePlanState(raw: string, maxItems: number, maxItemLen: number): TypedPlanState {
  const text = (raw ?? "").trim();
  if (!text) return emptyPlanState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Occasionally a model wraps JSON in fences despite instructions.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return emptyPlanState();
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return emptyPlanState();
    }
  }
  if (!parsed || typeof parsed !== "object") return emptyPlanState();
  const obj = parsed as Record<string, unknown>;
  return {
    subgoals: sanitizeArray(obj.subgoals, maxItems, maxItemLen),
    hypotheses: sanitizeArray(obj.hypotheses, maxItems, maxItemLen),
    uncertainties: sanitizeArray(obj.uncertainties, maxItems, maxItemLen),
    rejectedPaths: sanitizeArray(obj.rejectedPaths ?? obj.rejected_paths, maxItems, maxItemLen),
  };
}

function sanitizeArray(raw: unknown, maxItems: number, maxItemLen: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= maxItems) break;
    if (typeof item !== "string") continue;
    const cleaned = item.trim().replace(/\s+/g, " ");
    if (!cleaned) continue;
    out.push(cleaned.length <= maxItemLen ? cleaned : `${cleaned.slice(0, maxItemLen - 1)}…`);
  }
  return out;
}
