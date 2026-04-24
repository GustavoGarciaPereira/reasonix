/**
 * Tool-call "ready" progress signal during streaming.
 *
 * Matches the 0.5.19 UX fix: as each tool_call's arguments stream into
 * valid JSON we emit `tool_call_delta` with an incrementing
 * `toolCallReadyCount`, so the UI can render "N ready · building call
 * M" instead of a context-free spinner. Dispatch still happens after
 * the stream ends — this is purely a visibility improvement.
 */

import { describe, expect, it } from "vitest";
import { looksLikeCompleteJson } from "../src/loop.js";

describe("looksLikeCompleteJson", () => {
  it("empty / whitespace → false", () => {
    expect(looksLikeCompleteJson("")).toBe(false);
    expect(looksLikeCompleteJson("   ")).toBe(false);
  });

  it("partial JSON → false (the common streaming case)", () => {
    expect(looksLikeCompleteJson("{")).toBe(false);
    expect(looksLikeCompleteJson('{"path"')).toBe(false);
    expect(looksLikeCompleteJson('{"path": "foo.md", "content": "hel')).toBe(false);
  });

  it("complete JSON object → true", () => {
    expect(looksLikeCompleteJson("{}")).toBe(true);
    expect(looksLikeCompleteJson('{"path": "foo.md", "content": "hello"}')).toBe(true);
  });

  it("complete JSON array → true", () => {
    expect(looksLikeCompleteJson("[]")).toBe(true);
    expect(looksLikeCompleteJson('[{"a": 1}]')).toBe(true);
  });

  it("primitive JSON values → true", () => {
    expect(looksLikeCompleteJson("true")).toBe(true);
    expect(looksLikeCompleteJson("42")).toBe(true);
    expect(looksLikeCompleteJson('"text"')).toBe(true);
  });

  it("valid JSON with trailing whitespace → true", () => {
    expect(looksLikeCompleteJson('{"a":1}\n')).toBe(true);
  });
});
