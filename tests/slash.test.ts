import { describe, expect, it, vi } from "vitest";
import { handleSlash, parseSlash } from "../src/cli/ui/slash.js";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory.js";

function makeLoop() {
  const client = new DeepSeekClient({
    apiKey: "sk-test",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  return new CacheFirstLoop({
    client,
    prefix: new ImmutablePrefix({ system: "s" }),
  });
}

describe("parseSlash", () => {
  it("returns null on non-slash input", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("")).toBeNull();
    expect(parseSlash("/")).toBeNull();
  });
  it("lowercases the command and splits args", () => {
    expect(parseSlash("/Harvest on")).toEqual({ cmd: "harvest", args: ["on"] });
    expect(parseSlash("/branch 3")).toEqual({ cmd: "branch", args: ["3"] });
    expect(parseSlash("/help")).toEqual({ cmd: "help", args: [] });
  });
});

describe("handleSlash", () => {
  it("/exit requests exit", () => {
    const loop = makeLoop();
    expect(handleSlash("exit", [], loop).exit).toBe(true);
    expect(handleSlash("quit", [], loop).exit).toBe(true);
  });

  it("/clear requests history clear", () => {
    expect(handleSlash("clear", [], makeLoop()).clear).toBe(true);
  });

  it("/help returns a multi-line message", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/status/);
    expect(r.info).toMatch(/\/harvest/);
    expect(r.info).toMatch(/\/branch/);
  });

  it("/status reflects current loop config", () => {
    const loop = makeLoop();
    const r = handleSlash("status", [], loop);
    expect(r.info).toMatch(/model=/);
    expect(r.info).toMatch(/harvest=off/);
    expect(r.info).toMatch(/branch=off/);
  });

  it("/model switches the model", () => {
    const loop = makeLoop();
    handleSlash("model", ["deepseek-reasoner"], loop);
    expect(loop.model).toBe("deepseek-reasoner");
  });

  it("/harvest on/off toggles", () => {
    const loop = makeLoop();
    handleSlash("harvest", ["on"], loop);
    expect(loop.harvestEnabled).toBe(true);
    handleSlash("harvest", ["off"], loop);
    expect(loop.harvestEnabled).toBe(false);
  });

  it("/harvest with no arg toggles the current state", () => {
    const loop = makeLoop();
    expect(loop.harvestEnabled).toBe(false);
    handleSlash("harvest", [], loop);
    expect(loop.harvestEnabled).toBe(true);
    handleSlash("harvest", [], loop);
    expect(loop.harvestEnabled).toBe(false);
  });

  it("/branch N enables branching and force-enables harvest + disables stream", () => {
    const loop = makeLoop();
    expect(loop.stream).toBe(true);
    expect(loop.harvestEnabled).toBe(false);
    handleSlash("branch", ["3"], loop);
    expect(loop.branchOptions.budget).toBe(3);
    expect(loop.branchEnabled).toBe(true);
    expect(loop.harvestEnabled).toBe(true);
    expect(loop.stream).toBe(false);
  });

  it("/branch off disables branching and restores stream preference", () => {
    const loop = makeLoop();
    handleSlash("branch", ["3"], loop);
    handleSlash("branch", ["off"], loop);
    expect(loop.branchEnabled).toBe(false);
    expect(loop.stream).toBe(true);
  });

  it("/branch rejects invalid N", () => {
    const loop = makeLoop();
    const r = handleSlash("branch", ["abc"], loop);
    expect(r.info).toMatch(/usage/);
    expect(loop.branchEnabled).toBe(false);
  });

  it("/branch caps at 8", () => {
    const loop = makeLoop();
    const r = handleSlash("branch", ["99"], loop);
    expect(r.info).toMatch(/capped/);
    expect(loop.branchEnabled).toBe(false);
  });

  it("unknown commands return an unknown flag with hint", () => {
    const r = handleSlash("nope", [], makeLoop());
    expect(r.unknown).toBe(true);
    expect(r.info).toMatch(/unknown command/);
  });

  it("/mcp with no servers attached points at reasonix setup", () => {
    const r = handleSlash("mcp", [], makeLoop());
    expect(r.info).toMatch(/no MCP servers/);
    expect(r.info).toMatch(/reasonix setup/);
  });

  it("/mcp shows the spec strings from SlashContext", () => {
    const r = handleSlash("mcp", [], makeLoop(), {
      mcpSpecs: [
        "filesystem=npx -y @modelcontextprotocol/server-filesystem /tmp",
        "kb=https://kb.example.com/sse",
      ],
    });
    expect(r.info).toMatch(/MCP servers \(2\)/);
    expect(r.info).toMatch(/server-filesystem/);
    expect(r.info).toMatch(/kb.example.com/);
  });

  it("/setup prints instructions to exit and run reasonix setup", () => {
    const r = handleSlash("setup", [], makeLoop());
    expect(r.info).toMatch(/reasonix setup/);
    expect(r.exit).toBeUndefined(); // /setup doesn't auto-exit — user presses /exit
  });

  it("/compact says 'nothing to compact' when no tool messages exceed the cap", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "hi" });
    loop.log.append({ role: "tool", tool_call_id: "t1", content: "short result" });
    const r = handleSlash("compact", [], loop);
    expect(r.info).toMatch(/nothing to compact/);
  });

  it("/compact shrinks oversized tool results and reports chars saved", () => {
    const loop = makeLoop();
    loop.log.append({ role: "user", content: "read a big file" });
    loop.log.append({ role: "tool", tool_call_id: "t1", content: "Z".repeat(20_000) });
    const r = handleSlash("compact", [], loop);
    expect(r.info).toMatch(/compacted 1 tool result/);
    expect(r.info).toMatch(/saved/);
    // After compaction the tool message length should be below the default 4k cap + envelope.
    const toolEntry = loop.log.entries.find((m) => m.role === "tool");
    expect(typeof toolEntry?.content).toBe("string");
    expect((toolEntry?.content as string).length).toBeLessThan(5_000);
  });

  it("/compact honors a custom cap argument", () => {
    const loop = makeLoop();
    loop.log.append({ role: "tool", tool_call_id: "t1", content: "A".repeat(10_000) });
    // 2000-char cap should shrink the 10k message
    const r = handleSlash("compact", ["2000"], loop);
    expect(r.info).toMatch(/compacted 1/);
    const toolEntry = loop.log.entries.find((m) => m.role === "tool");
    expect((toolEntry?.content as string).length).toBeLessThan(2_500);
  });

  it("/help mentions /compact", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/compact/);
  });

  it("/preset fast = deepseek-chat, no harvest, no branch", () => {
    const loop = makeLoop();
    handleSlash("model", ["deepseek-reasoner"], loop);
    handleSlash("harvest", ["on"], loop);
    handleSlash("branch", ["3"], loop);
    handleSlash("preset", ["fast"], loop);
    expect(loop.model).toBe("deepseek-chat");
    expect(loop.harvestEnabled).toBe(false);
    expect(loop.branchEnabled).toBe(false);
  });

  it("/preset smart = reasoner + harvest, no branch", () => {
    const loop = makeLoop();
    handleSlash("preset", ["smart"], loop);
    expect(loop.model).toBe("deepseek-reasoner");
    expect(loop.harvestEnabled).toBe(true);
    expect(loop.branchEnabled).toBe(false);
  });

  it("/preset max = reasoner + harvest + branch3", () => {
    const loop = makeLoop();
    handleSlash("preset", ["max"], loop);
    expect(loop.model).toBe("deepseek-reasoner");
    expect(loop.harvestEnabled).toBe(true);
    expect(loop.branchOptions.budget).toBe(3);
  });

  it("/preset with bad name returns usage", () => {
    const r = handleSlash("preset", ["nonsense"], makeLoop());
    expect(r.info).toMatch(/usage/);
  });

  it("/help mentions presets", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/Presets:/);
    expect(r.info).toMatch(/fast/);
    expect(r.info).toMatch(/smart/);
    expect(r.info).toMatch(/max/);
  });

  it("/help mentions sessions", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/sessions/);
    expect(r.info).toMatch(/\/forget/);
  });

  it("/help mentions /mcp and /setup", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/mcp/);
    expect(r.info).toMatch(/\/setup/);
  });

  it("/undo outside code mode says it's not available", () => {
    const r = handleSlash("undo", [], makeLoop());
    expect(r.info).toMatch(/only available inside .reasonix code/);
  });

  it("/undo in code mode invokes the callback", () => {
    const r = handleSlash("undo", [], makeLoop(), {
      codeUndo: () => "▸ restored 2 file(s)",
    });
    expect(r.info).toMatch(/restored 2 file/);
  });

  it("/help mentions /undo and /commit", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/undo/);
    expect(r.info).toMatch(/\/commit/);
  });

  it("/commit outside code mode says it's not available", () => {
    const r = handleSlash("commit", ["foo"], makeLoop());
    expect(r.info).toMatch(/only available inside .reasonix code/);
  });

  it("/commit with no message prints usage", () => {
    const r = handleSlash("commit", [], makeLoop(), { codeRoot: "/tmp" });
    expect(r.info).toMatch(/usage: \/commit/);
  });

  it("/apply outside code mode says it's not available", () => {
    const r = handleSlash("apply", [], makeLoop());
    expect(r.info).toMatch(/only available inside .reasonix code/);
  });

  it("/apply in code mode invokes the callback", () => {
    const r = handleSlash("apply", [], makeLoop(), {
      codeApply: () => "▸ 2/2 edits applied",
    });
    expect(r.info).toMatch(/2\/2 edits applied/);
  });

  it("/discard outside code mode says it's not available", () => {
    const r = handleSlash("discard", [], makeLoop());
    expect(r.info).toMatch(/only available inside .reasonix code/);
  });

  it("/discard in code mode invokes the callback", () => {
    const r = handleSlash("discard", [], makeLoop(), {
      codeDiscard: () => "▸ discarded 3 pending",
    });
    expect(r.info).toMatch(/discarded 3 pending/);
  });

  it("/help mentions /apply and /discard", () => {
    const r = handleSlash("help", [], makeLoop());
    expect(r.info).toMatch(/\/apply/);
    expect(r.info).toMatch(/\/discard/);
  });

  it("/commit strips surrounding double quotes from the message", () => {
    // We can't exercise git without a real repo; instead, rely on the
    // fact that /commit fails (no git repo at /nonexistent) but the
    // failure output should reveal the stripped message in the
    // arguments we passed. We mirror this by just confirming usage
    // ISN'T printed — meaning the parser accepted a non-empty message.
    const r = handleSlash("commit", ['"fix: tests"'], makeLoop(), { codeRoot: "/nonexistent" });
    expect(r.info).not.toMatch(/usage: \/commit/);
    // It WILL say git failed since /nonexistent isn't a git repo, but
    // we don't assert the exact message — it varies by platform.
    expect(r.info).toMatch(/git (add|commit) failed/);
  });

  it("/sessions returns a hint when none exist", () => {
    const r = handleSlash("sessions", [], makeLoop());
    expect(r.info).toMatch(/no saved sessions yet|Saved sessions/);
  });

  it("/forget on a session-less loop says nothing to forget", () => {
    const loop = makeLoop();
    expect(loop.sessionName).toBeNull();
    const r = handleSlash("forget", [], loop);
    expect(r.info).toMatch(/nothing to forget/);
  });
});
