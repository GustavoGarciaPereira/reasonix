/**
 * Subagent runtime — isolated child loops for offloading exploration or
 * self-contained subtasks.
 *
 * Two surfaces sit on top of the same `spawnSubagent` core:
 *
 *   1. `registerSubagentTool` — exposes a low-level `spawn_subagent`
 *      function-call tool. Library API. NOT registered into the model
 *      tool list by `reasonix code` since 0.4.26 — Skills (with
 *      `runAs: subagent` frontmatter) became the user-facing surface.
 *      Kept exported because library callers and tests still want
 *      direct access to the primitive.
 *
 *   2. `run_skill` (in src/tools/skills.ts) — when the resolved skill
 *      has `runAs: subagent`, it calls `spawnSubagent` with the skill
 *      body as the system prompt and the user's `arguments` as the
 *      task. Subagent skills are listed in the pinned Skills index
 *      with a 🧬 marker, which gives the model a clear pattern-match
 *      trigger without forcing it to reason about "is this task big
 *      enough to delegate."
 *
 * Why R1 specifically benefits:
 *   - R1 reasoning tokens are expensive AND inflate the parent context.
 *     A subagent runs its own private loop, then surfaces only the
 *     distilled final answer back to the parent — the main session
 *     never sees the reasoning trail.
 *
 * Invariants common to both surfaces:
 *   - Serial only — no parallel spawn (MVP).
 *   - Inherits parent's tool registry MINUS `spawn_subagent` itself
 *     (no recursion via the tool API) and MINUS `submit_plan`
 *     (subagents don't propose plans to the user).
 *   - No hooks, no session — runs are ephemeral.
 *   - Lower default `maxToolIters` than the parent (16 vs 64).
 *   - Independent prefix cache (subagent's prefix has its own
 *     fingerprint).
 *   - Parent registry's plan-mode state propagates: subagents can't
 *     escape `/plan`.
 *   - Non-streaming child loop — the parent isn't watching deltas, so
 *     streaming would only add an SSE parser to the critical path.
 *     Cancellation still works via the AbortSignal.
 */

import { type DeepSeekClient, Usage } from "../client.js";
import { CacheFirstLoop } from "../loop.js";
import { ImmutablePrefix } from "../memory.js";
import { applyProjectMemory } from "../project-memory.js";
import {
  ESCALATION_CONTRACT,
  NEGATIVE_CLAIM_RULE,
  TUI_FORMATTING_RULES,
} from "../prompt-fragments.js";
import { ToolRegistry } from "../tools.js";

/**
 * Live event emitted by a running subagent. Surfaced via the optional
 * `sink` ref the TUI attaches its handler to. Side-channel only — these
 * events do NOT pass through the parent loop's `LoopEvent` stream
 * because subagents run inside a tool-dispatch frame, after the parent's
 * `step()` has already yielded `tool_start` and is awaiting the result.
 */
export interface SubagentEvent {
  kind: "start" | "progress" | "end";
  /** First ~30 chars of the task prompt — used for the TUI status row. */
  task: string;
  /** Skill that spawned this subagent, when applicable. Stamped on every event so the TUI/logger can attribute without extra plumbing. */
  skillName?: string;
  /** Model id the child loop ran on. Stamped alongside skillName. */
  model?: string;
  /** Iteration count inside the child loop (number of tool results so far). */
  iter?: number;
  /** Wall-clock ms since the subagent started. */
  elapsedMs?: number;
  /** First ~120 chars of the final assistant message. Set on `end`. */
  summary?: string;
  /** Error message if the subagent failed. Set on `end`. */
  error?: string;
  /** Total turns the subagent took. Set on `end`. */
  turns?: number;
  /** Total USD spent inside the child loop. Set on `end`. */
  costUsd?: number;
  /** Aggregated child-loop Usage (sum across turns). Set on `end`. */
  usage?: Usage;
}

/**
 * Mutable ref the registration writes through. The TUI sets `.current`
 * to its own handler on mount; nothing receives events before that
 * happens (and headless callers leave `.current = null`, which is the
 * library-mode default — they read the final result from the helper's
 * return value instead).
 */
export interface SubagentSink {
  current: ((ev: SubagentEvent) => void) | null;
}

/**
 * Per-spawn options for {@link spawnSubagent}. All but `parentRegistry`
 * + `client` + `system` + `task` are tunables with sensible defaults.
 */
export interface SpawnSubagentOptions {
  /** Shared DeepSeek client. The subagent reuses it (same auth, same retries). */
  client: DeepSeekClient;
  /**
   * Parent registry — the subagent inherits a copy of its tools (minus
   * the never-inherited set: `spawn_subagent`, `submit_plan`).
   */
  parentRegistry: ToolRegistry;
  /**
   * System prompt for the child loop. Skills' subagent path passes
   * the skill body here; the spawn_subagent tool passes its default
   * (or the model's `system` argument override).
   */
  system: string;
  /** The task / question / instruction the subagent must address. */
  task: string;
  /** Model id for the child loop. Defaults to `deepseek-v4-pro`. */
  model?: string;
  /** Iteration ceiling for the child loop. Defaults to 16. */
  maxToolIters?: number;
  /**
   * Maximum chars of the final assistant message returned. Long answers
   * are truncated with a notice — the parent's prompt budget shouldn't
   * be blown out by an over-eager subagent.
   */
  maxResultChars?: number;
  /** Optional sink for TUI live updates. */
  sink?: SubagentSink;
  /**
   * Parent's per-tool-dispatch AbortSignal. When the parent aborts (Esc),
   * we forward the cancel into the child loop. Omit for headless callers
   * that don't care about cancellation.
   */
  parentSignal?: AbortSignal;
  /**
   * Skill name when this spawn is driven by a `runAs: subagent` skill.
   * Used purely for downstream attribution (TUI summary line, usage log).
   * Omit for raw `spawn_subagent` tool calls.
   */
  skillName?: string;
}

/**
 * Structured result of a subagent run. The two convenience JSON wrappers
 * (`spawn_subagent` tool, `run_skill` subagent path) serialize this for
 * the model; library callers can read the typed object directly.
 */
export interface SubagentResult {
  success: boolean;
  /** Final assistant message (possibly truncated). Empty on error. */
  output: string;
  /** Set when the run failed (network, child-loop error, etc.). */
  error?: string;
  /** Turns the child loop took. */
  turns: number;
  /** Tool calls dispatched inside the child loop. */
  toolIters: number;
  /** Wall-clock ms. */
  elapsedMs: number;
  /** USD spent in the child loop, summed across its turns. */
  costUsd: number;
  /** Model id the child loop ran on. */
  model: string;
  /** Skill name if the spawn was driven by a `runAs: subagent` skill. */
  skillName?: string;
  /** Aggregated Usage across the child loop's turns. Zero-filled when no API calls landed. */
  usage: Usage;
}

export interface SubagentToolOptions {
  /** Shared DeepSeek client. */
  client: DeepSeekClient;
  /**
   * Default system prompt used when the model doesn't pass one. Project
   * memory (REASONIX.md) is appended automatically when `projectRoot` is
   * set.
   */
  defaultSystem?: string;
  /** Project root for `applyProjectMemory` lookup. Omit in chat mode. */
  projectRoot?: string;
  /** Default model. `deepseek-v4-flash` by default (see DEFAULT_SUBAGENT_MODEL). */
  defaultModel?: string;
  /** Iteration ceiling. Lower than the parent (16 by default). */
  maxToolIters?: number;
  /** Maximum chars returned in the tool result. */
  maxResultChars?: number;
  /** Optional sink the TUI attaches its handler to for live updates. */
  sink?: SubagentSink;
}

const DEFAULT_SUBAGENT_SYSTEM = `You are a Reasonix subagent. The parent agent spawned you to handle one focused subtask, then return.

Rules:
- Stay on the task you were given. Do not expand scope.
- Use tools as needed. You share the parent's sandbox + safety rules.
- When you're done, your final assistant message is the only thing the parent will see — make it complete and self-contained. No follow-up offers, no questions, no "let me know if you need more."
- Prefer one clear, distilled answer over a long log of what you tried.

${NEGATIVE_CLAIM_RULE}

${ESCALATION_CONTRACT}

${TUI_FORMATTING_RULES}`;

const DEFAULT_MAX_RESULT_CHARS = 8000;
const DEFAULT_MAX_ITERS = 16;
// Subagents default to flash — their work is read-and-synthesize
// (explore, research), which doesn't need the 12× pro tier. Skill
// frontmatter `model: deepseek-v4-pro` is the opt-in override for
// skills that empirically benefit from the stronger model.
const DEFAULT_SUBAGENT_MODEL = "deepseek-v4-flash";
// Subagents default to effort=high — less thinking budget than a
// main turn (which defaults to `max` in the preset). The parent's
// task arg is already a distilled prompt; explore/research rarely
// need deep chains of thought, and `high` saves output tokens.
const DEFAULT_SUBAGENT_EFFORT: "high" | "max" = "high";

const SUBAGENT_TOOL_NAME = "spawn_subagent";
/**
 * Tools the subagent never inherits from the parent registry:
 *   - spawn_subagent itself: would allow unbounded recursion via the
 *     tool API. Depth=1 hard cap by construction.
 *   - submit_plan: only the parent talks to the user about plan
 *     approval; a subagent submitting a plan would surface a picker
 *     midway through the parent's turn, which the user did not ask for.
 */
const NEVER_INHERITED_TOOLS = new Set<string>([SUBAGENT_TOOL_NAME, "submit_plan"]);

/**
 * Run one subagent to completion. The unified primitive both
 * `spawn_subagent` (function-call tool) and `run_skill` (subagent
 * skills) call into.
 *
 * Headless: returns a `SubagentResult` regardless of success/failure.
 * Errors are captured in the structured shape, never thrown — the
 * caller decides how to surface them (tool result JSON, log line, etc.).
 */
export async function spawnSubagent(opts: SpawnSubagentOptions): Promise<SubagentResult> {
  const model = opts.model ?? DEFAULT_SUBAGENT_MODEL;
  const maxToolIters = opts.maxToolIters ?? DEFAULT_MAX_ITERS;
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const sink = opts.sink;
  const skillName = opts.skillName;

  const startedAt = Date.now();
  const taskPreview = opts.task.length > 30 ? `${opts.task.slice(0, 30)}…` : opts.task;
  sink?.current?.({
    kind: "start",
    task: taskPreview,
    skillName,
    model,
    iter: 0,
    elapsedMs: 0,
  });

  const childTools = forkRegistryExcluding(opts.parentRegistry, NEVER_INHERITED_TOOLS);
  const childPrefix = new ImmutablePrefix({
    system: opts.system,
    toolSpecs: childTools.specs(),
  });
  const childLoop = new CacheFirstLoop({
    client: opts.client,
    prefix: childPrefix,
    tools: childTools,
    model,
    // Subagents run on a constrained thinking budget by default — the
    // task is already narrow by construction, and `high` cuts output
    // tokens substantially vs `max`.
    reasoningEffort: DEFAULT_SUBAGENT_EFFORT,
    maxToolIters,
    hooks: [],
    stream: false,
  });

  // Wire parent-abort → child-abort. Two pitfalls we have to handle:
  //
  //   1. `addEventListener("abort", ...)` does NOT fire for a signal
  //      that's already aborted (the abort event has already been
  //      dispatched once and `once: true` is moot). If the parent
  //      aborted between dispatch entry and our listener attach,
  //      the listener stays silent forever and the child runs free.
  //      → Check `.aborted` synchronously and forward immediately.
  //
  //   2. childLoop.step() reassigns its internal _turnAbort at the
  //      top of step(). loop.ts forwards prior aborted state into
  //      the fresh controller, so abort() called BEFORE step() runs
  //      still kills the new step at iter 0.
  const onParentAbort = () => childLoop.abort();
  if (opts.parentSignal?.aborted) {
    childLoop.abort();
  } else {
    opts.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  let final = "";
  let errorMessage: string | undefined;
  let toolIter = 0;
  try {
    for await (const ev of childLoop.step(opts.task)) {
      if (ev.role === "tool") {
        toolIter++;
        sink?.current?.({
          kind: "progress",
          task: taskPreview,
          skillName,
          model,
          iter: toolIter,
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (ev.role === "assistant_final") {
        // `forcedSummary: true` is the loop's signal that this isn't
        // a real model answer — it's an abort placeholder, a budget-
        // exhaustion summary, or a context-guard fallback. Treating
        // them as success means parent agents would happily render
        // "[aborted by user (Esc) — no summary produced.]" as the
        // subagent's actual answer. Surface it as an error instead so
        // `success: false` reaches the caller and `/skill` doesn't
        // pretend the run completed normally.
        if (ev.forcedSummary) {
          errorMessage = ev.content?.trim() || "subagent ended without producing an answer";
        } else {
          final = ev.content ?? "";
        }
      }
      if (ev.role === "error") {
        errorMessage = ev.error ?? "subagent error";
      }
    }
  } catch (err) {
    errorMessage = (err as Error).message;
  } finally {
    opts.parentSignal?.removeEventListener("abort", onParentAbort);
  }
  // The loop yields `done` without an `error` event when its API call
  // is aborted mid-flight (intentional UX — see the matching catch in
  // CacheFirstLoop.step). From a SUBAGENT consumer's perspective that
  // still counts as a failure: no answer came back, the parent has
  // nothing to render. Synthesize an error so `success: false` and the
  // UI surfaces the abort instead of returning empty output.
  if (!errorMessage && !final) {
    errorMessage = opts.parentSignal?.aborted
      ? "subagent aborted before producing an answer"
      : "subagent ended without producing an answer";
  }

  const elapsedMs = Date.now() - startedAt;
  const turns = childLoop.stats.turns.length;
  const costUsd = childLoop.stats.totalCost;
  const usage = aggregateChildUsage(childLoop);

  const truncated =
    final.length > maxResultChars
      ? `${final.slice(0, maxResultChars)}\n\n[…truncated ${final.length - maxResultChars} chars; ask the subagent for a tighter summary if you need more.]`
      : final;

  sink?.current?.({
    kind: "end",
    task: taskPreview,
    skillName,
    model,
    iter: toolIter,
    elapsedMs,
    summary: errorMessage ? undefined : truncated.slice(0, 120),
    error: errorMessage,
    turns,
    costUsd,
    usage,
  });

  return {
    success: !errorMessage,
    output: errorMessage ? "" : truncated,
    error: errorMessage,
    turns,
    toolIters: toolIter,
    elapsedMs,
    costUsd,
    model,
    skillName,
    usage,
  };
}

/**
 * Sum the child loop's per-turn `Usage` into one aggregate record.
 * Zero-filled when the loop made no API calls (e.g. failed before the
 * first request) so downstream consumers always see a valid shape.
 */
function aggregateChildUsage(loop: CacheFirstLoop): Usage {
  const agg = new Usage();
  for (const t of loop.stats.turns) {
    agg.promptTokens += t.usage.promptTokens;
    agg.completionTokens += t.usage.completionTokens;
    agg.totalTokens += t.usage.totalTokens;
    agg.promptCacheHitTokens += t.usage.promptCacheHitTokens;
    agg.promptCacheMissTokens += t.usage.promptCacheMissTokens;
  }
  return agg;
}

/**
 * Serialize a {@link SubagentResult} into the JSON tool-result shape
 * the model consumes. Both the spawn_subagent tool and the run_skill
 * subagent path return this string verbatim, so the schema stays
 * stable across both surfaces.
 */
export function formatSubagentResult(r: SubagentResult): string {
  if (!r.success) {
    return JSON.stringify({
      success: false,
      error: r.error ?? "unknown subagent error",
      turns: r.turns,
      tool_iters: r.toolIters,
      elapsed_ms: r.elapsedMs,
    });
  }
  return JSON.stringify({
    success: true,
    output: r.output,
    turns: r.turns,
    tool_iters: r.toolIters,
    elapsed_ms: r.elapsedMs,
    cost_usd: r.costUsd,
  });
}

/**
 * Register the spawn_subagent tool into the parent registry. Library
 * surface — `reasonix code` does NOT call this since 0.4.26 (Skills
 * with `runAs: subagent` are the user-facing surface), but library
 * consumers who want the low-level tool can opt in.
 */
export function registerSubagentTool(
  parentRegistry: ToolRegistry,
  opts: SubagentToolOptions,
): ToolRegistry {
  const baseSystem = opts.defaultSystem ?? DEFAULT_SUBAGENT_SYSTEM;
  // Bake project memory into the default once — re-reading on every
  // spawn would (a) make the child prefix unstable when REASONIX.md
  // changes mid-session, defeating cache reuse across multiple
  // subagent calls, and (b) cost a stat() per call. The parent itself
  // also reads memory once at startup; matching that semantics keeps
  // subagent and parent on the same page.
  const defaultSystem = opts.projectRoot
    ? applyProjectMemory(baseSystem, opts.projectRoot)
    : baseSystem;
  const defaultModel = opts.defaultModel ?? DEFAULT_SUBAGENT_MODEL;
  const maxToolIters = opts.maxToolIters ?? DEFAULT_MAX_ITERS;
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const sink = opts.sink;

  parentRegistry.register({
    name: SUBAGENT_TOOL_NAME,
    description:
      "Spawn an isolated subagent to handle a self-contained subtask in a fresh context, returning only its final answer. Use for: deep codebase exploration that would flood the main context, multi-step research where you only need the conclusion, or any focused subtask whose intermediate reasoning the user does not need to see. The subagent inherits all your tools (filesystem, shell, web, MCP, etc.) but runs in its own isolated message log — its tool calls and reasoning never enter your context. Only the final assistant message comes back as this tool's result. Keep tasks focused; the subagent has a stricter iter budget than you do.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The subtask the subagent should perform. Be specific and self-contained — the subagent has none of your conversation context, only what you write here.",
        },
        system: {
          type: "string",
          description:
            "Optional override for the subagent's system prompt. The default tells it to stay focused and return a concise answer; override only when the subtask needs a specialized persona.",
        },
        model: {
          type: "string",
          enum: ["deepseek-v4-flash", "deepseek-v4-pro"],
          description:
            "Which DeepSeek model the subagent runs on. Default is 'deepseek-v4-flash' — cheap and fast, fine for explore/research-style subtasks. Override to 'deepseek-v4-pro' (~12× more expensive) when the subtask genuinely needs the stronger model: cross-file architecture, subtle bug hunts, anything where flash has empirically underperformed.",
        },
      },
      required: ["task"],
    },
    fn: async (args: { task?: unknown; system?: unknown; model?: unknown }, ctx) => {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) {
        return JSON.stringify({
          error: "spawn_subagent requires a non-empty 'task' argument.",
        });
      }
      const system =
        typeof args.system === "string" && args.system.trim().length > 0
          ? args.system.trim()
          : defaultSystem;
      const model =
        typeof args.model === "string" && args.model.startsWith("deepseek-")
          ? args.model
          : defaultModel;
      const result = await spawnSubagent({
        client: opts.client,
        parentRegistry,
        system,
        task,
        model,
        maxToolIters,
        maxResultChars,
        sink,
        parentSignal: ctx?.signal,
      });
      return formatSubagentResult(result);
    },
  });

  return parentRegistry;
}

/**
 * Build a child ToolRegistry that copies every tool from `parent` except
 * those whose names are in `exclude`. Plan-mode state propagates so a
 * subagent spawned while the parent is under `/plan` cannot escape it.
 *
 * Exported for tests + library callers who want the same fork behavior
 * for their own nested-loop patterns.
 */
export function forkRegistryExcluding(
  parent: ToolRegistry,
  exclude: ReadonlySet<string>,
): ToolRegistry {
  const child = new ToolRegistry();
  for (const spec of parent.specs()) {
    const name = spec.function.name;
    if (exclude.has(name)) continue;
    const def = parent.get(name);
    if (!def) continue;
    // Re-register copies the public ToolDefinition fields. The child
    // re-runs auto-flatten analysis on its own, which produces an
    // identical flatSchema for the same input — no surprise.
    child.register(def);
  }
  if (parent.planMode) child.setPlanMode(true);
  return child;
}
