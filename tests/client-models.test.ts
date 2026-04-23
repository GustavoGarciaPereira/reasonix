import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";

function makeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("DeepSeekClient.listModels", () => {
  it("parses the OpenAI-style model list", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: makeFetch(200, {
        object: "list",
        data: [
          { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
          { id: "deepseek-reasoner", object: "model", owned_by: "deepseek" },
        ],
      }),
    });
    const list = await client.listModels();
    expect(list).not.toBeNull();
    expect(list!.data.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("returns null on non-2xx (bad key / offline)", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-bad",
      fetch: makeFetch(401, { error: "unauthorized" }),
    });
    expect(await client.listModels()).toBeNull();
  });

  it("returns null on malformed payload", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: makeFetch(200, { whatever: "not a list" }),
    });
    expect(await client.listModels()).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await client.listModels()).toBeNull();
  });

  it("sends the bearer token header", async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new DeepSeekClient({
      apiKey: "sk-xyz",
      fetch: spy as unknown as typeof fetch,
    });
    await client.listModels();
    const [, init] = spy.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("GET");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-xyz");
  });
});
