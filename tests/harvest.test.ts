import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { emptyPlanState, harvest, isPlanStateEmpty } from "../src/harvest.js";

function stubClient(jsonPayload: string): DeepSeekClient {
  const fakeFetch = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: jsonPayload } }],
        usage: { prompt_tokens: 50, completion_tokens: 30 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
}

function erroringClient(): DeepSeekClient {
  const fakeFetch = vi.fn(async () => new Response("boom", { status: 500 }));
  return new DeepSeekClient({
    apiKey: "sk-test",
    fetch: fakeFetch as unknown as typeof fetch,
    retry: { maxAttempts: 1, initialBackoffMs: 1 },
  });
}

describe("emptyPlanState / isPlanStateEmpty", () => {
  it("empty state reports empty", () => {
    expect(isPlanStateEmpty(emptyPlanState())).toBe(true);
    expect(isPlanStateEmpty(null)).toBe(true);
    expect(isPlanStateEmpty(undefined)).toBe(true);
  });
  it("non-empty state reports non-empty", () => {
    const s = emptyPlanState();
    s.subgoals.push("x");
    expect(isPlanStateEmpty(s)).toBe(false);
  });
});

describe("harvest", () => {
  it("returns empty when no client is provided", async () => {
    const r = await harvest("some reasoning here that is long enough to qualify", undefined);
    expect(isPlanStateEmpty(r)).toBe(true);
  });

  it("returns empty when reasoning is absent", async () => {
    const client = stubClient("{}");
    expect(isPlanStateEmpty(await harvest(null, client))).toBe(true);
    expect(isPlanStateEmpty(await harvest("", client))).toBe(true);
  });

  it("returns empty when reasoning is too short", async () => {
    const client = stubClient(
      '{"subgoals":["x"],"hypotheses":[],"uncertainties":[],"rejectedPaths":[]}',
    );
    const r = await harvest("short", client);
    expect(isPlanStateEmpty(r)).toBe(true);
  });

  it("parses a well-formed JSON response", async () => {
    const json = JSON.stringify({
      subgoals: ["解二次方程", "验证根"],
      hypotheses: ["可因式分解"],
      uncertainties: [],
      rejectedPaths: ["配方法"],
    });
    const client = stubClient(json);
    const r = await harvest(
      "一段足够长的推理文本，描述了如何解一个二次方程的全部过程，包括因式分解、求根公式对比以及验证步骤。",
      client,
    );
    expect(r.subgoals).toEqual(["解二次方程", "验证根"]);
    expect(r.hypotheses).toEqual(["可因式分解"]);
    expect(r.rejectedPaths).toEqual(["配方法"]);
    expect(r.uncertainties).toEqual([]);
  });

  it("accepts snake_case rejected_paths as fallback", async () => {
    const json = JSON.stringify({
      subgoals: [],
      hypotheses: [],
      uncertainties: [],
      rejected_paths: ["bad-approach"],
    });
    const r = await harvest(
      "a long enough reasoning trace that exceeds the minimum length threshold.",
      stubClient(json),
    );
    expect(r.rejectedPaths).toEqual(["bad-approach"]);
  });

  it("extracts JSON even when wrapped in prose", async () => {
    const body = JSON.stringify({
      subgoals: ["a"],
      hypotheses: [],
      uncertainties: [],
      rejectedPaths: [],
    });
    const wrapped = `Here is the JSON:\n\`\`\`json\n${body}\n\`\`\`\n`;
    const r = await harvest(
      "a long enough reasoning trace that exceeds the minimum length threshold.",
      stubClient(wrapped),
    );
    expect(r.subgoals).toEqual(["a"]);
  });

  it("returns empty on malformed JSON response", async () => {
    const r = await harvest(
      "a long enough reasoning trace that exceeds the minimum length threshold.",
      stubClient("not json at all, just text"),
    );
    expect(isPlanStateEmpty(r)).toBe(true);
  });

  it("gracefully swallows API errors and returns empty", async () => {
    const r = await harvest(
      "a long enough reasoning trace that exceeds the minimum length threshold.",
      erroringClient(),
    );
    expect(isPlanStateEmpty(r)).toBe(true);
  });

  it("caps array length and trims long items", async () => {
    const longs = Array.from({ length: 10 }, (_, i) => `${"x".repeat(200)}${i}`);
    const json = JSON.stringify({
      subgoals: longs,
      hypotheses: [],
      uncertainties: [],
      rejectedPaths: [],
    });
    const r = await harvest(
      "a long enough reasoning trace that exceeds the minimum length threshold.",
      stubClient(json),
      { maxItems: 3, maxItemLen: 20 },
    );
    expect(r.subgoals.length).toBe(3);
    for (const s of r.subgoals) {
      expect(s.length).toBeLessThanOrEqual(20);
    }
  });

  it("filters non-string items", async () => {
    const json = JSON.stringify({
      subgoals: ["ok", 42, null, { nested: true }, "also-ok"],
      hypotheses: [],
      uncertainties: [],
      rejectedPaths: [],
    });
    const r = await harvest(
      "a long enough reasoning trace that exceeds the minimum length threshold.",
      stubClient(json),
    );
    expect(r.subgoals).toEqual(["ok", "also-ok"]);
  });
});
