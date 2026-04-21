import { describe, expect, it } from "vitest";
import { computeReplayStats } from "../src/replay.js";
import type { TranscriptRecord } from "../src/transcript.js";

const mkAssistant = (
  turn: number,
  hit: number,
  miss: number,
  completion: number,
  cost: number,
  prefixHash = "stable123",
): TranscriptRecord => ({
  ts: "2026-04-21T00:00:00Z",
  turn,
  role: "assistant_final",
  content: `reply ${turn}`,
  model: "deepseek-chat",
  prefixHash,
  usage: {
    prompt_tokens: hit + miss,
    completion_tokens: completion,
    total_tokens: hit + miss + completion,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
  },
  cost,
});

describe("computeReplayStats", () => {
  it("aggregates cache-hit and cost across assistant_final records", () => {
    const recs: TranscriptRecord[] = [
      { ts: "t", turn: 1, role: "user", content: "q1" },
      mkAssistant(1, 900, 100, 50, 0.0001),
      { ts: "t", turn: 1, role: "tool", content: "{}", tool: "foo", args: "{}" },
      { ts: "t", turn: 2, role: "user", content: "q2" },
      mkAssistant(2, 950, 50, 30, 0.00008),
    ];
    const stats = computeReplayStats(recs);
    expect(stats.turns).toBe(2);
    expect(stats.userTurns).toBe(2);
    expect(stats.toolCalls).toBe(1);
    // cache: hit 1850 / (1850+150) = 92.5%
    expect(stats.cacheHitRatio).toBeCloseTo(0.925, 4);
    expect(stats.totalCostUsd).toBeCloseTo(0.00018, 6);
    expect(stats.prefixHashes).toEqual(["stable123"]);
    expect(stats.models).toEqual(["deepseek-chat"]);
  });

  it("detects prefix churn when multiple hashes appear (baseline-style transcript)", () => {
    const recs: TranscriptRecord[] = [
      mkAssistant(1, 100, 900, 50, 0.0003, "hashA"),
      mkAssistant(2, 100, 900, 50, 0.0003, "hashB"),
      mkAssistant(3, 100, 900, 50, 0.0003, "hashC"),
    ];
    const stats = computeReplayStats(recs);
    expect(stats.prefixHashes).toHaveLength(3);
    expect(stats.cacheHitRatio).toBeCloseTo(0.1, 2);
  });

  it("tolerates old transcripts without usage — produces zero-cost stats gracefully", () => {
    const recs: TranscriptRecord[] = [
      { ts: "t", turn: 1, role: "user", content: "q" },
      { ts: "t", turn: 1, role: "assistant_final", content: "a" },
    ];
    const stats = computeReplayStats(recs);
    expect(stats.turns).toBe(0); // no usage → no perTurn entries → turns count is 0
    expect(stats.userTurns).toBe(1);
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.cacheHitRatio).toBe(0);
  });
});
