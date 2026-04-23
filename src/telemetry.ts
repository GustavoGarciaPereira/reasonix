import type { Usage } from "./client.js";

/**
 * USD per 1M tokens. Source of truth is DeepSeek's CNY price sheet at
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing (as of
 * 2026-04-23): chat and reasoner are unified at ¥0.2 / ¥2 / ¥3 per 1M
 * tokens (cache-hit input / cache-miss input / output). Converted at
 * a fixed 7.2 CNY/USD rate so stats stay stable across the daily FX
 * drift; revisit if the rate moves more than ±5%.
 *
 * Historical note: the pre-unification prices were chat $0.07/$0.27/$1.10
 * and reasoner $0.14/$0.55/$2.19. Sessions logged under those values
 * in `~/.reasonix/usage.jsonl` remain as-is (USD frozen at record time)
 * — we never retroactively rewrite billing history.
 */
export const DEEPSEEK_PRICING: Record<
  string,
  { inputCacheHit: number; inputCacheMiss: number; output: number }
> = {
  "deepseek-chat": { inputCacheHit: 0.028, inputCacheMiss: 0.28, output: 0.42 },
  "deepseek-reasoner": { inputCacheHit: 0.028, inputCacheMiss: 0.28, output: 0.42 },
};

/** Reference Claude Sonnet 4.6 pricing (USD per 1M tokens). */
export const CLAUDE_SONNET_PRICING = { input: 3.0, output: 15.0 };

/**
 * Maximum prompt-side context window per DeepSeek model, in tokens.
 * Both V3 (`deepseek-chat`) and R1 (`deepseek-reasoner`) currently expose
 * a 131,072-token prompt limit per the OpenAPI spec; completion caps
 * differ but don't affect the prompt budget the StatsPanel shows.
 */
export const DEEPSEEK_CONTEXT_TOKENS: Record<string, number> = {
  "deepseek-chat": 131_072,
  "deepseek-reasoner": 131_072,
};

/** Fallback when the caller's model id isn't in the table — safe lower bound. */
export const DEFAULT_CONTEXT_TOKENS = 131_072;

export function costUsd(model: string, usage: Usage): number {
  const p = DEEPSEEK_PRICING[model];
  if (!p) return 0;
  return (
    (usage.promptCacheHitTokens * p.inputCacheHit +
      usage.promptCacheMissTokens * p.inputCacheMiss +
      usage.completionTokens * p.output) /
    1_000_000
  );
}

/** Input-side cost only (prompt, cache hit + miss). Used for the panel breakdown. */
export function inputCostUsd(model: string, usage: Usage): number {
  const p = DEEPSEEK_PRICING[model];
  if (!p) return 0;
  return (
    (usage.promptCacheHitTokens * p.inputCacheHit +
      usage.promptCacheMissTokens * p.inputCacheMiss) /
    1_000_000
  );
}

/** Output-side cost only (completion tokens). Used for the panel breakdown. */
export function outputCostUsd(model: string, usage: Usage): number {
  const p = DEEPSEEK_PRICING[model];
  if (!p) return 0;
  return (usage.completionTokens * p.output) / 1_000_000;
}

export function claudeEquivalentCost(usage: Usage): number {
  return (
    (usage.promptTokens * CLAUDE_SONNET_PRICING.input +
      usage.completionTokens * CLAUDE_SONNET_PRICING.output) /
    1_000_000
  );
}

export interface TurnStats {
  turn: number;
  model: string;
  usage: Usage;
  cost: number;
  cacheHitRatio: number;
}

export interface SessionSummary {
  turns: number;
  totalCostUsd: number;
  /**
   * Input-side (prompt) cost aggregated across the session. Split
   * from totalCostUsd so the panel can render "cost $X (in $Y · out
   * $Z)" — users asked for visibility into where the spend lands.
   */
  totalInputCostUsd: number;
  /** Output-side (completion) cost aggregated across the session. */
  totalOutputCostUsd: number;
  /** @deprecated Claude reference; kept for benchmarks + replay compat, no longer surfaced in the TUI. */
  claudeEquivalentUsd: number;
  /** @deprecated. Same as claudeEquivalentUsd — synthetic ratio, not a real measurement. */
  savingsVsClaudePct: number;
  cacheHitRatio: number;
  /**
   * Most recent turn's prompt-token count. Used by the TUI's context
   * gauge: we can't know the next call's cost without making it, but
   * the last turn's prompt tokens is the floor (next call is last
   * prompt + user delta + any new tool outputs).
   */
  lastPromptTokens: number;
}

export class SessionStats {
  readonly turns: TurnStats[] = [];

  record(turn: number, model: string, usage: Usage): TurnStats {
    const cost = costUsd(model, usage);
    const stats: TurnStats = {
      turn,
      model,
      usage,
      cost,
      cacheHitRatio: usage.cacheHitRatio,
    };
    this.turns.push(stats);
    return stats;
  }

  get totalCost(): number {
    return this.turns.reduce((sum, t) => sum + t.cost, 0);
  }

  get totalClaudeEquivalent(): number {
    return this.turns.reduce((sum, t) => sum + claudeEquivalentCost(t.usage), 0);
  }

  get savingsVsClaude(): number {
    const c = this.totalClaudeEquivalent;
    return c > 0 ? 1 - this.totalCost / c : 0;
  }

  get totalInputCost(): number {
    return this.turns.reduce((sum, t) => sum + inputCostUsd(t.model, t.usage), 0);
  }

  get totalOutputCost(): number {
    return this.turns.reduce((sum, t) => sum + outputCostUsd(t.model, t.usage), 0);
  }

  get aggregateCacheHitRatio(): number {
    let hit = 0;
    let miss = 0;
    for (const t of this.turns) {
      hit += t.usage.promptCacheHitTokens;
      miss += t.usage.promptCacheMissTokens;
    }
    const denom = hit + miss;
    return denom > 0 ? hit / denom : 0;
  }

  summary(): SessionSummary {
    const last = this.turns[this.turns.length - 1];
    return {
      turns: this.turns.length,
      totalCostUsd: round(this.totalCost, 6),
      totalInputCostUsd: round(this.totalInputCost, 6),
      totalOutputCostUsd: round(this.totalOutputCost, 6),
      claudeEquivalentUsd: round(this.totalClaudeEquivalent, 6),
      savingsVsClaudePct: round(this.savingsVsClaude * 100, 2),
      cacheHitRatio: round(this.aggregateCacheHitRatio, 4),
      lastPromptTokens: last?.usage.promptTokens ?? 0,
    };
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
