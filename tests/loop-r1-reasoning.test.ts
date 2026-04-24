/**
 * R1 thinking-mode contract: when a reasoner turn returns both
 * `reasoning_content` and `tool_calls`, the assistant message we
 * persist + send on the NEXT request (the tool-loop continuation)
 * must carry `reasoning_content` back. Otherwise DeepSeek 400s with
 * "The reasoning_content in the thinking mode must be passed back to
 * the API." Reproduces the bug that surfaced in 0.5.14 live usage.
 */

import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop, isThinkingModeModel, thinkingModeForModel } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";

describe("isThinkingModeModel", () => {
  it("deepseek-reasoner → true (legacy R1 alias)", () => {
    expect(isThinkingModeModel("deepseek-reasoner")).toBe(true);
  });
  it("deepseek-v4-flash → true (default thinking)", () => {
    expect(isThinkingModeModel("deepseek-v4-flash")).toBe(true);
  });
  it("deepseek-v4-pro → true (default thinking)", () => {
    expect(isThinkingModeModel("deepseek-v4-pro")).toBe(true);
  });
  it("deepseek-chat → false (non-thinking compat alias)", () => {
    expect(isThinkingModeModel("deepseek-chat")).toBe(false);
  });
  it("unknown models → false (safe default)", () => {
    expect(isThinkingModeModel("gpt-4")).toBe(false);
    expect(isThinkingModeModel("")).toBe(false);
  });
});

describe("thinkingModeForModel", () => {
  it("chat → disabled, reasoner → enabled (compat aliases pin the mode)", () => {
    expect(thinkingModeForModel("deepseek-chat")).toBe("disabled");
    expect(thinkingModeForModel("deepseek-reasoner")).toBe("enabled");
  });
  it("v4 models → enabled (docs default)", () => {
    expect(thinkingModeForModel("deepseek-v4-flash")).toBe("enabled");
    expect(thinkingModeForModel("deepseek-v4-pro")).toBe("enabled");
  });
  it("unknown models → undefined (let server decide)", () => {
    expect(thinkingModeForModel("gpt-4")).toBeUndefined();
    expect(thinkingModeForModel("anthropic-claude")).toBeUndefined();
  });
});

interface FakeResponseShape {
  content?: string;
  reasoning_content?: string;
  tool_calls?: any[];
  usage?: Record<string, number>;
}

function capturingFetch(responses: FakeResponseShape[]): {
  fetch: typeof fetch;
  bodies: Array<{
    messages: ChatMessage[];
    extra_body?: { thinking?: { type?: string } };
    reasoning_effort?: string;
  }>;
} {
  const bodies: Array<{
    messages: ChatMessage[];
    extra_body?: { thinking?: { type?: string } };
    reasoning_effort?: string;
  }> = [];
  let i = 0;
  const fn = vi.fn(async (_url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    bodies.push({
      messages: body.messages,
      extra_body: body.extra_body,
      reasoning_effort: body.reasoning_effort,
    });
    const resp = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: resp.content ?? "",
              reasoning_content: resp.reasoning_content ?? null,
              tool_calls: resp.tool_calls ?? undefined,
            },
            finish_reason: resp.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: resp.usage ?? {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 100,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fn, bodies };
}

describe("R1 reasoning_content round-trip", () => {
  it("preserves reasoning_content on the assistant message when the turn has tool_calls", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "noop",
      readOnly: true,
      fn: () => "ok",
    });

    const { fetch: fakeFetch, bodies } = capturingFetch([
      {
        // Turn 1: model emits reasoning + tool call.
        content: "",
        reasoning_content: "I should call noop to check something.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "noop", arguments: "{}" },
          },
        ],
      },
      {
        // Turn 2: plain text wrap-up after the tool result comes back.
        content: "done",
      },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
      tools,
      model: "deepseek-reasoner",
      stream: false,
    });

    for await (const _ev of loop.step("please noop")) {
      /* drain */
    }

    expect(bodies.length).toBe(2);
    // Turn 2's request messages include the turn-1 assistant message;
    // find it and verify reasoning_content landed.
    const turn2Messages = bodies[1]!.messages;
    const assistantWithCalls = turn2Messages.find(
      (m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0,
    );
    expect(assistantWithCalls).toBeDefined();
    expect(assistantWithCalls?.reasoning_content).toBe("I should call noop to check something.");
  });

  it("also preserves reasoning_content on plain-text reasoner turns", async () => {
    // 0.5.18 regression: R1 requires reasoning_content on ANY
    // assistant message the model produced in thinking mode, not just
    // ones with tool_calls. 0.5.15 scoped the fix too narrowly and a
    // plan-approval flow (submit_plan → "plan submitted" plain-text
    // turn → approval) kept 400ing on the follow-up request.
    const { fetch: fakeFetch, bodies } = capturingFetch([
      {
        content: "a plain answer",
        reasoning_content: "reasoning attached to a plain-text turn",
      },
      { content: "follow-up" },
    ]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-reasoner",
      stream: false,
    });

    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    for await (const _ev of loop.step("next")) {
      /* drain */
    }

    const turn2Messages = bodies[1]!.messages;
    const assistant = turn2Messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.reasoning_content).toBe("reasoning attached to a plain-text turn");
  });

  it("pins thinking=enabled + reasoning_effort=max for v4-pro (agent-class default)", async () => {
    const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-v4-pro",
      stream: false,
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    expect(bodies[0]!.extra_body?.thinking?.type).toBe("enabled");
    expect(bodies[0]!.reasoning_effort).toBe("max");
  });

  it("pins thinking=disabled for deepseek-chat (non-thinking compat alias)", async () => {
    const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "deepseek-chat",
      stream: false,
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    expect(bodies[0]!.extra_body?.thinking?.type).toBe("disabled");
    expect(bodies[0]!.reasoning_effort).toBe("max");
  });

  it("omits thinking entirely for unknown models (let the server decide)", async () => {
    const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
    const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model: "some-third-party-model",
      stream: false,
    });
    for await (const _ev of loop.step("hello")) {
      /* drain */
    }
    expect(bodies[0]!.extra_body).toBeUndefined();
    // reasoning_effort is always set — it's a benign field for models
    // that don't know it (OpenAI just ignores unknown top-level fields).
    expect(bodies[0]!.reasoning_effort).toBe("max");
  });
});
