/**
 * Tests for `codeSystemPrompt` — the .gitignore injection helper.
 * Pure I/O at the edge, so filesystem-backed tests using a temp dir.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_SYSTEM_PROMPT, codeSystemPrompt } from "../src/code/prompt.js";

describe("codeSystemPrompt", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-prompt-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the base prompt unchanged when no .gitignore exists", () => {
    expect(codeSystemPrompt(root)).toBe(CODE_SYSTEM_PROMPT);
  });

  it("appends the .gitignore content as a fenced block", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n.env\n", "utf8");
    const out = codeSystemPrompt(root);
    expect(out.length).toBeGreaterThan(CODE_SYSTEM_PROMPT.length);
    expect(out).toMatch(/# Project \.gitignore/);
    expect(out).toContain("node_modules/");
    expect(out).toContain(".env");
  });

  it("truncates a .gitignore larger than 2000 chars", () => {
    const huge = `${"# comment ".repeat(500)}\n`; // ~5000 chars
    writeFileSync(join(root, ".gitignore"), huge, "utf8");
    const out = codeSystemPrompt(root);
    expect(out).toMatch(/truncated \d+ chars/);
    // The prompt (base + truncated + fences) is bounded, not 5000+.
    expect(out.length).toBeLessThan(CODE_SYSTEM_PROMPT.length + 2300);
  });

  it("still reminds the model about built-in ignores even without a .gitignore", () => {
    // Base prompt mentions node_modules / dist / .git as "avoid listing"
    // so new-repo users without .gitignore still get the hint.
    expect(CODE_SYSTEM_PROMPT).toMatch(/node_modules/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/dist/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/\.git/);
  });
});
