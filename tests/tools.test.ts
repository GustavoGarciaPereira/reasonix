import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";

describe("ToolRegistry", () => {
  it("registers and dispatches a tool with JSON args", async () => {
    const reg = new ToolRegistry();
    reg.register<{ a: number; b: number }, number>({
      name: "add",
      description: "add two ints",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      fn: ({ a, b }) => a + b,
    });
    expect(reg.has("add")).toBe(true);
    const result = await reg.dispatch("add", '{"a":2,"b":3}');
    expect(result).toBe("5");
  });

  it("returns structured error for unknown tool", async () => {
    const reg = new ToolRegistry();
    const out = await reg.dispatch("nope", "{}");
    expect(JSON.parse(out)).toEqual({ error: "unknown tool: nope" });
  });

  it("handles invalid JSON arguments gracefully", async () => {
    const reg = new ToolRegistry();
    reg.register({ name: "noop", fn: () => "ok" });
    const out = await reg.dispatch("noop", "{bad json");
    expect(JSON.parse(out).error).toMatch(/invalid tool arguments JSON/);
  });

  it("emits OpenAI-shaped specs", () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "echo",
      description: "echo input",
      parameters: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      fn: ({ msg }: { msg: string }) => msg,
    });
    const spec = reg.specs()[0]!;
    expect(spec.type).toBe("function");
    expect(spec.function.name).toBe("echo");
    expect(spec.function.parameters.required).toEqual(["msg"]);
  });

  it("does NOT flatten shallow schemas", () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "shallow",
      parameters: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a"],
      },
      fn: () => "ok",
    });
    expect(reg.wasFlattened("shallow")).toBe(false);
    expect(reg.specs()[0]!.function.parameters.properties).toHaveProperty("a");
  });

  it("auto-flattens deep schemas and re-nests args on dispatch", async () => {
    const reg = new ToolRegistry();
    let received: any = null;
    reg.register({
      name: "deep",
      parameters: {
        type: "object",
        required: ["user"],
        properties: {
          user: {
            type: "object",
            required: ["profile"],
            properties: {
              profile: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  age: { type: "integer" },
                },
              },
            },
          },
        },
      },
      fn: (args: any) => {
        received = args;
        return "ok";
      },
    });

    expect(reg.wasFlattened("deep")).toBe(true);
    const spec = reg.specs()[0]!;
    expect(spec.function.parameters.properties).toHaveProperty("user.profile.name");
    expect(spec.function.parameters.properties).toHaveProperty("user.profile.age");

    // Model emits flat dot-notation args (as it would after seeing the flat spec).
    await reg.dispatch("deep", '{"user.profile.name":"alice","user.profile.age":30}');
    expect(received).toEqual({ user: { profile: { name: "alice", age: 30 } } });
  });

  it("auto-flattens wide schemas (>10 leaf params)", () => {
    const reg = new ToolRegistry();
    const props: Record<string, { type: string }> = {};
    for (let i = 0; i < 15; i++) props[`p${i}`] = { type: "string" };
    reg.register({
      name: "wide",
      parameters: { type: "object", properties: props },
      fn: () => "ok",
    });
    expect(reg.wasFlattened("wide")).toBe(true);
  });

  it("dispatch passes through nested args even when tool was flattened (defensive)", async () => {
    const reg = new ToolRegistry();
    let received: any = null;
    reg.register({
      name: "deep",
      parameters: {
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: { type: "object", properties: { c: { type: "string" } } },
            },
          },
        },
      },
      fn: (args: any) => {
        received = args;
        return "ok";
      },
    });
    expect(reg.wasFlattened("deep")).toBe(true);
    // Some models may ignore the flat spec and emit nested args anyway.
    await reg.dispatch("deep", '{"a":{"b":{"c":"hi"}}}');
    expect(received).toEqual({ a: { b: { c: "hi" } } });
  });

  it("truncates oversized results when maxResultChars is set", async () => {
    const reg = new ToolRegistry();
    const big = "x".repeat(50_000);
    reg.register({
      name: "bloat",
      parameters: { type: "object", properties: {} },
      fn: () => big,
    });
    const out = await reg.dispatch("bloat", "{}", { maxResultChars: 1000 });
    expect(out.length).toBeLessThan(2000);
    expect(out).toMatch(/truncated/);
  });

  it("passes results through unchanged when maxResultChars is absent", async () => {
    const reg = new ToolRegistry();
    const big = "x".repeat(50_000);
    reg.register({
      name: "bloat",
      parameters: { type: "object", properties: {} },
      fn: () => big,
    });
    const out = await reg.dispatch("bloat", "{}");
    expect(out.length).toBe(50_000);
  });

  it("autoFlatten:false opts out", () => {
    const reg = new ToolRegistry({ autoFlatten: false });
    reg.register({
      name: "deep",
      parameters: {
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: { b: { type: "object", properties: { c: { type: "string" } } } },
          },
        },
      },
      fn: () => "ok",
    });
    expect(reg.wasFlattened("deep")).toBe(false);
    expect(reg.specs()[0]!.function.parameters.properties).toHaveProperty("a");
  });
});
