import type { Usage } from "./client.js";

/**
 * USD per 1M tokens. Source: DeepSeek's CNY price sheet
 * (https://api-docs.deepseek.com/zh-cn/quick_start/pricing) converted
 * at a fixed 7.2 CNY/USD rate so billing stays stable across daily FX
 * drift; revisit if the rate moves more than ±5%.
 *
 * 2026-04 V4 launch:
 *   - deepseek-v4-flash  ¥0.2 / ¥1  / ¥2   (hit / miss / out per 1M)
 *   - deepseek-v4-pro    ¥1   / ¥12 / ¥24
 *
 * deepseek-chat and deepseek-reasoner are now thin compat aliases for
 * v4-flash's non-thinking and thinking modes respectively — same
 * underlying model, same bill. We keep them in the table so existing
 * sessions (and configs that hard-code these names) keep pricing.
 *
 * Historical note: sessions logged before this file was updated remain
 * as-is in `~/.reasonix/usage.jsonl` — USD is frozen at record time,
 * we never retroactively rewrite billing history.
 */
export const DEEPSEEK_PRICING: Record<
  string,
  { inputCacheHit: number; inputCacheMiss: number; output: number }
> = {
  "deepseek-v4-flash": { inputCacheHit: 0.028, inputCacheMiss: 0.139, output: 0.278 },
  "deepseek-v4-pro": { inputCacheHit: 0.139, inputCacheMiss: 1.667, output: 3.333 },
  // Compat aliases — priced as v4-flash per the deprecation notice.
  "deepseek-chat": { inputCacheHit: 0.028, inputCacheMiss: 0.139, output: 0.278 },
  "deepseek-reasoner": { inputCacheHit: 0.028, inputCacheMiss: 0.139, output: 0.278 },
};

/** Reference Claude Sonnet 4.6 pricing (USD per 1M tokens). */
export const CLAUDE_SONNET_PRICING = { input: 3.0, output: 15.0 };

/**
 * Maximum prompt-side context window per DeepSeek model, in tokens.
 * V4 (flash + pro) jumps to 1,000,000 tokens. The compat aliases
 * (deepseek-chat / deepseek-reasoner) inherit that through the
 * v4-flash route — we bump them so the StatsPanel gauge reflects
 * what the API actually accepts.
 *
 * Completion caps (e.g. 384K for V4) are enforced by the server, not
 * tracked here — they don't affect the prompt-side budget the panel
 * shows. If a future feature surfaces output-cap warnings we'll add
 * a sibling table.
 */
export const DEEPSEEK_CONTEXT_TOKENS: Record<string, number> = {
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-chat": 1_000_000,
  "deepseek-reasoner": 1_000_000,
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
