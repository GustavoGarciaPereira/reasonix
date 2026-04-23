import { describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import {
  DEEPSEEK_PRICING,
  SessionStats,
  costUsd,
  inputCostUsd,
  outputCostUsd,
} from "../src/telemetry.js";

// Derive expected figures from the pricing table so the tests don't
// re-bake stale constants every time DeepSeek updates the price sheet.
// The `costUsd` formula under test is:
//   (hitT * hit + missT * miss + outT * out) / 1e6
const CHAT = DEEPSEEK_PRICING["deepseek-chat"]!;

describe("Usage.cacheHitRatio", () => {
  it("computes hit ratio", () => {
    const u = new Usage(0, 0, 0, 80, 20);
    expect(u.cacheHitRatio).toBe(0.8);
  });
  it("is zero on empty", () => {
    expect(new Usage().cacheHitRatio).toBe(0);
  });
});

describe("costUsd", () => {
  it("applies DeepSeek pricing tiers", () => {
    const u = new Usage(1000, 100, 0, 800, 200);
    const c = costUsd("deepseek-chat", u);
    expect(c).toBeCloseTo(
      (800 * CHAT.inputCacheHit + 200 * CHAT.inputCacheMiss + 100 * CHAT.output) / 1_000_000,
      10,
    );
  });

  it("returns 0 for unknown model", () => {
    expect(costUsd("unknown-model", new Usage(1000, 100))).toBe(0);
  });
});

describe("SessionStats", () => {
  it("aggregates savings vs Claude", () => {
    const stats = new SessionStats();
    stats.record(1, "deepseek-chat", new Usage(1000, 100, 1100, 800, 200));
    const s = stats.summary();
    expect(s.turns).toBe(1);
    expect(s.cacheHitRatio).toBe(0.8);
    expect(s.savingsVsClaudePct).toBeGreaterThan(90);
  });

  it("accumulates across turns", () => {
    const stats = new SessionStats();
    stats.record(1, "deepseek-chat", new Usage(100, 10, 110, 80, 20));
    stats.record(2, "deepseek-chat", new Usage(200, 20, 220, 160, 40));
    expect(stats.turns.length).toBe(2);
    expect(stats.aggregateCacheHitRatio).toBeCloseTo(240 / 300);
  });

  it("summary.lastPromptTokens tracks the most recent turn only", () => {
    const stats = new SessionStats();
    expect(stats.summary().lastPromptTokens).toBe(0);
    stats.record(1, "deepseek-chat", new Usage(5_000, 100, 5_100, 4_000, 1_000));
    expect(stats.summary().lastPromptTokens).toBe(5_000);
    stats.record(2, "deepseek-chat", new Usage(42_000, 200, 42_200, 40_000, 2_000));
    expect(stats.summary().lastPromptTokens).toBe(42_000);
  });

  it("summary splits input + output costs — the new panel breakdown", () => {
    const stats = new SessionStats();
    stats.record(1, "deepseek-chat", new Usage(1000, 100, 1100, 800, 200));
    const s = stats.summary();
    // `summary()` rounds USD figures to 6 decimals, so we match at 6 —
    // the raw formula at higher precision is exercised by the
    // `inputCostUsd` / `outputCostUsd` tests below.
    expect(s.totalInputCostUsd).toBeCloseTo(
      (800 * CHAT.inputCacheHit + 200 * CHAT.inputCacheMiss) / 1_000_000,
      6,
    );
    expect(s.totalOutputCostUsd).toBeCloseTo((100 * CHAT.output) / 1_000_000, 6);
    // Sum of input+output equals total (within rounding).
    expect(s.totalInputCostUsd + s.totalOutputCostUsd).toBeCloseTo(s.totalCostUsd, 6);
  });
});

describe("inputCostUsd / outputCostUsd", () => {
  it("input cost covers cache-hit + cache-miss but NOT completion", () => {
    const u = new Usage(1000, 100, 1100, 800, 200);
    const i = inputCostUsd("deepseek-chat", u);
    expect(i).toBeCloseTo(
      (800 * CHAT.inputCacheHit + 200 * CHAT.inputCacheMiss) / 1_000_000,
      10,
    );
  });

  it("output cost covers completion only", () => {
    const u = new Usage(1000, 100, 1100, 800, 200);
    const o = outputCostUsd("deepseek-chat", u);
    expect(o).toBeCloseTo((100 * CHAT.output) / 1_000_000, 10);
  });

  it("chat and reasoner are unified at the same price", () => {
    // Post-unification (2026-04): DeepSeek charges identically for both
    // models. If this test starts failing, either DeepSeek reintroduced
    // tiered pricing (update the constants) or someone accidentally
    // edited only one entry — catch that before shipping.
    const chat = DEEPSEEK_PRICING["deepseek-chat"]!;
    const reasoner = DEEPSEEK_PRICING["deepseek-reasoner"]!;
    expect(reasoner).toEqual(chat);
  });

  it("both return 0 for an unknown model", () => {
    const u = new Usage(1000, 100, 1100, 800, 200);
    expect(inputCostUsd("unknown", u)).toBe(0);
    expect(outputCostUsd("unknown", u)).toBe(0);
  });
});
