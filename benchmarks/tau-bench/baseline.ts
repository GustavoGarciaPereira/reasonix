/**
 * Naive baseline runner — deliberately does NOT use CacheFirstLoop.
 *
 * For the benchmark comparison to be honest, this runner must reproduce
 * what a "typical" agent framework does that breaks DeepSeek's automatic
 * prefix cache:
 *
 *   1. Inject a fresh timestamp into the system prompt every turn.
 *   2. Re-serialize the tool list each turn with a shuffled key order.
 *   3. Rebuild the full message array each turn rather than appending.
 *
 * These are all things frameworks like LangChain/LangGraph do by default
 * (either directly, or because tool specs are regenerated from Python dicts
 * with non-deterministic ordering, or because a "current_time" placeholder
 * is recommended in common system-prompt recipes).
 *
 * Reuses DeepSeekClient, ToolRegistry, and SessionStats so the *only*
 * difference from the Reasonix run is prefix stability.
 */

import {
  type ChatMessage,
  type DeepSeekClient,
  SessionStats,
  type ToolCall,
  type ToolDefinition,
  ToolRegistry,
  type ToolSpec,
} from "../../src/index.js";
import type { Turn } from "./types.js";

export interface BaselineRunnerOptions {
  client: DeepSeekClient;
  systemPrompt: string;
  tools: ToolDefinition[];
  model?: string;
  maxToolIters?: number;
}

export interface BaselineTurnResult {
  assistantMessage: string;
  toolCallsExecuted: { name: string; args: string; result: string }[];
  /** Turn number (1-based) assigned by the agent. Lets callers filter this.stats.turns for per-turn usage. */
  turnNo: number;
}

export class BaselineAgent {
  readonly client: DeepSeekClient;
  readonly stats = new SessionStats();
  private readonly systemPrompt: string;
  private readonly registry: ToolRegistry;
  private readonly model: string;
  private readonly maxToolIters: number;
  /**
   * Previous-turn messages. A naive framework keeps these, but we still
   * rebuild the prefix around them each turn so the byte prefix churns.
   */
  private history: ChatMessage[] = [];
  private turnNo = 0;

  constructor(opts: BaselineRunnerOptions) {
    this.client = opts.client;
    this.systemPrompt = opts.systemPrompt;
    this.model = opts.model ?? "deepseek-chat";
    this.maxToolIters = opts.maxToolIters ?? 6;
    this.registry = new ToolRegistry({ autoFlatten: false });
    for (const t of opts.tools) this.registry.register(t);
  }

  /**
   * Run one user-turn: sends the user message, lets the model do tool
   * calls until it stops, returns the final assistant text.
   *
   * Intentionally non-cache-friendly: rebuilds the prefix with a fresh
   * timestamp + re-shuffled tool specs every turn.
   */
  async userTurn(userMessage: string, transcript: Turn[]): Promise<BaselineTurnResult> {
    this.turnNo++;

    // Naive pattern #1: current-time placeholder in the system prompt.
    const churnedSystem = `${this.systemPrompt}\nCurrent time: ${new Date().toISOString()}`;

    // Naive pattern #2: shuffle tool spec order each turn (simulates
    // frameworks that materialize tools from Python dicts / maps).
    const shuffledTools = shuffle(this.registry.specs(), this.turnNo);

    this.history.push({ role: "user", content: userMessage });

    const toolExecutions: { name: string; args: string; result: string }[] = [];

    for (let iter = 0; iter < this.maxToolIters; iter++) {
      // Naive pattern #3: always rebuild the full message array.
      const messages: ChatMessage[] = [{ role: "system", content: churnedSystem }, ...this.history];

      const resp = await this.client.chat({
        model: this.model,
        messages,
        tools: shuffledTools,
      });
      this.stats.record(this.turnNo, this.model, resp.usage);

      const assistantMessage: ChatMessage = { role: "assistant", content: resp.content };
      if (resp.toolCalls.length > 0) assistantMessage.tool_calls = resp.toolCalls;
      this.history.push(assistantMessage);

      if (resp.toolCalls.length === 0) {
        return {
          assistantMessage: resp.content,
          toolCallsExecuted: toolExecutions,
          turnNo: this.turnNo,
        };
      }

      for (const tc of resp.toolCalls) {
        const name = tc.function?.name ?? "";
        const args = tc.function?.arguments ?? "{}";
        const result = await this.registry.dispatch(name, args);
        toolExecutions.push({ name, args, result });
        this.history.push({
          role: "tool",
          tool_call_id: tc.id ?? "",
          name,
          content: result,
        });
      }
    }

    const lastAssistant = [...this.history].reverse().find((m) => m.role === "assistant");
    return {
      assistantMessage: lastAssistant?.content ?? "[max_tool_iters reached]",
      toolCallsExecuted: toolExecutions,
      turnNo: this.turnNo,
    };
  }
}

/**
 * Deterministic Fisher–Yates shuffle seeded by an integer. Same turn number
 * → same ordering, so the baseline is reproducible across runs while still
 * being cache-hostile (different turns get different orderings).
 */
function shuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed * 9301 + 49297;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Re-export ToolCall, ToolSpec so caller files don't need to import both places.
export type { ToolCall, ToolSpec };
