import { describe, expect, it } from "vitest";
import { diffTranscripts, renderMarkdown, renderSummaryTable, similarity } from "../src/diff.js";
import type { ReadTranscriptResult, TranscriptRecord } from "../src/transcript.js";

function mkParsed(records: TranscriptRecord[], task = "t01"): ReadTranscriptResult {
  return {
    meta: {
      version: 1,
      source: "test",
      model: "deepseek-chat",
      task,
      mode: "test",
      startedAt: "2026-04-21T00:00:00Z",
    },
    records,
  };
}

const mkUserA = (turn: number, content: string): TranscriptRecord => ({
  ts: "t",
  turn,
  role: "user",
  content,
});
const mkAssistant = (
  turn: number,
  content: string,
  opts: { hit?: number; miss?: number; cost?: number; prefixHash?: string } = {},
): TranscriptRecord => ({
  ts: "t",
  turn,
  role: "assistant_final",
  content,
  model: "deepseek-chat",
  prefixHash: opts.prefixHash ?? "stable",
  usage: {
    prompt_tokens: (opts.hit ?? 900) + (opts.miss ?? 100),
    completion_tokens: 50,
    total_tokens: (opts.hit ?? 900) + (opts.miss ?? 100) + 50,
    prompt_cache_hit_tokens: opts.hit ?? 900,
    prompt_cache_miss_tokens: opts.miss ?? 100,
  },
  cost: opts.cost ?? 0.0001,
});
const mkTool = (turn: number, name: string, args = "{}"): TranscriptRecord => ({
  ts: "t",
  turn,
  role: "tool",
  content: "{}",
  tool: name,
  args,
});

describe("similarity", () => {
  it("returns 1 for identical strings", () => {
    expect(similarity("hello world", "hello world")).toBe(1);
  });
  it("returns 0 for disjoint short strings", () => {
    expect(similarity("abc", "xyz")).toBeCloseTo(0, 1);
  });
  it("is high for small edits", () => {
    expect(similarity("the quick brown fox", "the quick brown dog")).toBeGreaterThan(0.8);
  });
});

describe("diffTranscripts", () => {
  it("marks an all-same pair as match with no divergence", () => {
    const shared: TranscriptRecord[] = [
      mkUserA(1, "hi"),
      mkTool(1, "lookup"),
      mkAssistant(1, "hello there friend"),
    ];
    const report = diffTranscripts(
      { label: "A", parsed: mkParsed(shared) },
      { label: "B", parsed: mkParsed([...shared]) },
    );
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]!.kind).toBe("match");
    expect(report.firstDivergenceTurn).toBeNull();
  });

  it("flags tool-name disagreement as divergence on the correct turn", () => {
    const a: TranscriptRecord[] = [
      mkUserA(1, "hi"),
      mkTool(1, "lookup_order"),
      mkAssistant(1, "ok"),
      mkUserA(2, "change it"),
      mkTool(2, "update_address"),
      mkAssistant(2, "done"),
    ];
    const b: TranscriptRecord[] = [
      mkUserA(1, "hi"),
      mkTool(1, "lookup_order"),
      mkAssistant(1, "ok"),
      mkUserA(2, "change it"),
      mkTool(2, "cancel_order"), // <-- different tool on turn 2
      mkAssistant(2, "done"),
    ];
    const report = diffTranscripts(
      { label: "A", parsed: mkParsed(a) },
      { label: "B", parsed: mkParsed(b) },
    );
    expect(report.firstDivergenceTurn).toBe(2);
    const p2 = report.pairs.find((p) => p.turn === 2)!;
    expect(p2.kind).toBe("diverge");
    expect(p2.divergenceNote).toMatch(/tool calls differ/);
  });

  it("flags same-tool-different-args as args-divergence", () => {
    const a: TranscriptRecord[] = [
      mkTool(1, "update_address", '{"orderId":"o_1","address":"A"}'),
      mkAssistant(1, "ok"),
    ];
    const b: TranscriptRecord[] = [
      mkTool(1, "update_address", '{"orderId":"o_1","address":"DIFFERENT"}'),
      mkAssistant(1, "ok"),
    ];
    const report = diffTranscripts(
      { label: "A", parsed: mkParsed(a) },
      { label: "B", parsed: mkParsed(b) },
    );
    const p1 = report.pairs[0]!;
    expect(p1.kind).toBe("diverge");
    expect(p1.divergenceNote).toMatch(/args differ/);
  });

  it("computes correct aggregate deltas (cache / cost / turns)", () => {
    const baseline = [
      mkAssistant(1, "one", { hit: 100, miss: 900, cost: 0.0003, prefixHash: "h1" }),
      mkAssistant(2, "two", { hit: 100, miss: 900, cost: 0.0003, prefixHash: "h2" }),
    ];
    const reasonix = [
      mkAssistant(1, "one", { hit: 900, miss: 100, cost: 0.0001, prefixHash: "stable" }),
      mkAssistant(2, "two", { hit: 900, miss: 100, cost: 0.0001, prefixHash: "stable" }),
    ];
    const report = diffTranscripts(
      { label: "baseline", parsed: mkParsed(baseline) },
      { label: "reasonix", parsed: mkParsed(reasonix) },
    );
    expect(report.a.stats.cacheHitRatio).toBeCloseTo(0.1, 2);
    expect(report.b.stats.cacheHitRatio).toBeCloseTo(0.9, 2);
    expect(report.a.stats.prefixHashes.length).toBe(2);
    expect(report.b.stats.prefixHashes.length).toBe(1);
    expect(report.b.stats.totalCostUsd).toBeLessThan(report.a.stats.totalCostUsd);
  });

  it("labels only_in_b when transcript B has extra turns", () => {
    const a = [mkAssistant(1, "one")];
    const b = [mkAssistant(1, "one"), mkAssistant(2, "two")];
    const report = diffTranscripts(
      { label: "A", parsed: mkParsed(a) },
      { label: "B", parsed: mkParsed(b) },
    );
    expect(report.pairs).toHaveLength(2);
    expect(report.pairs[1]!.kind).toBe("only_in_b");
  });
});

describe("renderers", () => {
  it("renderSummaryTable includes cache delta + prefix stability story when warranted", () => {
    const baseline = [
      mkAssistant(1, "one", { hit: 100, miss: 900, prefixHash: "h1" }),
      mkAssistant(2, "two", { hit: 100, miss: 900, prefixHash: "h2" }),
    ];
    const reasonix = [
      mkAssistant(1, "one", { hit: 900, miss: 100, prefixHash: "stable" }),
      mkAssistant(2, "two", { hit: 900, miss: 100, prefixHash: "stable" }),
    ];
    const report = diffTranscripts(
      { label: "baseline", parsed: mkParsed(baseline) },
      { label: "reasonix", parsed: mkParsed(reasonix) },
    );
    const table = renderSummaryTable(report);
    expect(table).toContain("cache hit");
    expect(table).toContain("prefix stability");
    expect(table).toMatch(/byte-stable/);
  });

  it("renderMarkdown includes the per-turn table and summary", () => {
    const a = [mkAssistant(1, "A answer")];
    const b = [mkAssistant(1, "B answer text")];
    const report = diffTranscripts(
      { label: "A", parsed: mkParsed(a) },
      { label: "B", parsed: mkParsed(b) },
    );
    const md = renderMarkdown(report);
    expect(md).toMatch(/## Summary/);
    expect(md).toMatch(/## Turn-by-turn/);
    expect(md).toMatch(/cache hit/);
  });
});
