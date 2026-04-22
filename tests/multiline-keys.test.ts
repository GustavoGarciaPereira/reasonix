import { describe, expect, it } from "vitest";
import { type MultilineKey, processMultilineKey } from "../src/cli/ui/multiline-keys.js";

function key(overrides: Partial<MultilineKey> = {}): MultilineKey {
  return { input: "", ...overrides };
}

describe("processMultilineKey", () => {
  it("appends printable input at the end", () => {
    const r = processMultilineKey("hel", key({ input: "l" }));
    expect(r).toEqual({ next: "hell", submit: false });
  });

  it("appends a multi-char paste burst as-is", () => {
    const r = processMultilineKey("", key({ input: "line1\nline2" }));
    expect(r.next).toBe("line1\nline2");
    expect(r.submit).toBe(false);
  });

  it("Enter on a plain buffer submits", () => {
    const r = processMultilineKey("hi", key({ return: true }));
    expect(r.submit).toBe(true);
    expect(r.submitValue).toBe("hi");
    expect(r.next).toBeNull();
  });

  it("Enter with trailing backslash converts to newline (bash-style continuation)", () => {
    const r = processMultilineKey("line1\\", key({ return: true }));
    expect(r.submit).toBe(false);
    expect(r.next).toBe("line1\n");
  });

  it("Shift+Enter inserts a newline without submitting", () => {
    const r = processMultilineKey("abc", key({ return: true, shift: true }));
    expect(r.submit).toBe(false);
    expect(r.next).toBe("abc\n");
  });

  it("Ctrl+J (ASCII LF) inserts a newline", () => {
    const r = processMultilineKey("abc", key({ input: "\n" }));
    expect(r.next).toBe("abc\n");
    expect(r.submit).toBe(false);
  });

  it("Ctrl+J reported as ctrl+'j' (normalized form) also inserts a newline", () => {
    const r = processMultilineKey("abc", key({ input: "j", ctrl: true }));
    expect(r.next).toBe("abc\n");
    expect(r.submit).toBe(false);
  });

  it("Backspace drops one char from the end", () => {
    const r = processMultilineKey("abcd", key({ backspace: true }));
    expect(r.next).toBe("abc");
  });

  it("Backspace on empty buffer is a no-op", () => {
    const r = processMultilineKey("", key({ backspace: true }));
    expect(r.next).toBeNull();
    expect(r.submit).toBe(false);
  });

  it("Backspace can delete across newlines", () => {
    const r = processMultilineKey("a\nb", key({ backspace: true }));
    expect(r.next).toBe("a\n");
    const r2 = processMultilineKey(r.next!, key({ backspace: true }));
    expect(r2.next).toBe("a");
  });

  it("Delete behaves like Backspace (cursor-at-end model)", () => {
    const r = processMultilineKey("xyz", key({ delete: true }));
    expect(r.next).toBe("xy");
  });

  it("Tab is ignored (parent handles slash auto-complete)", () => {
    const r = processMultilineKey("/he", key({ tab: true, input: "" }));
    expect(r.next).toBeNull();
    expect(r.submit).toBe(false);
  });

  it("Tab with '\\t' in input is still ignored", () => {
    const r = processMultilineKey("x", key({ tab: true, input: "\t" }));
    expect(r.next).toBeNull();
  });

  it("Arrow keys are ignored (parent handles slash-nav + history)", () => {
    expect(processMultilineKey("x", key({ upArrow: true })).next).toBeNull();
    expect(processMultilineKey("x", key({ downArrow: true })).next).toBeNull();
    expect(processMultilineKey("x", key({ leftArrow: true })).next).toBeNull();
    expect(processMultilineKey("x", key({ rightArrow: true })).next).toBeNull();
  });

  it("Escape is ignored (parent handles abort)", () => {
    const r = processMultilineKey("x", key({ escape: true }));
    expect(r.next).toBeNull();
  });

  it("Ctrl+<letter> that isn't j is dropped (no accidental text insert)", () => {
    const r = processMultilineKey("x", key({ input: "c", ctrl: true }));
    expect(r.next).toBeNull();
  });

  it("Meta (Alt) key events are dropped", () => {
    const r = processMultilineKey("x", key({ input: "a", meta: true }));
    expect(r.next).toBeNull();
  });

  it("Plain return on an empty buffer still submits (empty message case handled upstream)", () => {
    const r = processMultilineKey("", key({ return: true }));
    expect(r.submit).toBe(true);
    expect(r.submitValue).toBe("");
  });
});
