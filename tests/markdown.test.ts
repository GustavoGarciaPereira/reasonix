import { describe, expect, it } from "vitest";
import { parseBlocks, stripMath } from "../src/cli/ui/markdown.js";

describe("stripMath", () => {
  it("converts \\frac, \\dfrac, \\tfrac uniformly", () => {
    expect(stripMath("\\frac{a}{b}")).toBe("(a)/(b)");
    expect(stripMath("\\dfrac{a}{b}")).toBe("(a)/(b)");
    expect(stripMath("\\tfrac{a}{b}")).toBe("(a)/(b)");
  });

  it("converts a \\frac with Chinese content (the original user-reported case)", () => {
    const out = stripMath("v = \\frac{总路程}{总时间}");
    expect(out).toContain("(总路程)/(总时间)");
    expect(out).not.toContain("\\frac");
    expect(out).not.toContain("\\");
  });

  it("handles \\frac with a nested \\sqrt", () => {
    const out = stripMath("\\frac{\\sqrt{2}}{3}");
    expect(out).not.toContain("\\frac");
    expect(out).not.toContain("\\sqrt");
  });

  it("tolerates whitespace inside frac braces", () => {
    expect(stripMath("\\frac{ a }{ b }")).toContain("(a)/(b)");
  });

  it("strips \\implies, \\to arrows", () => {
    expect(stripMath("a \\implies b")).toContain("a ⇒ b");
    expect(stripMath("x \\to y")).toContain("x → y");
  });

  it("\\quad becomes spaces", () => {
    expect(stripMath("a\\quad b")).not.toContain("\\");
  });

  it("converts single-digit subscripts and superscripts to Unicode", () => {
    expect(stripMath("t_1 + t_2")).toBe("t₁ + t₂");
    expect(stripMath("x^2 + y^3")).toBe("x² + y³");
  });

  it("strips LaTeX math delimiters", () => {
    const out = stripMath("equation: \\(x^2 + 1\\)");
    expect(out).toBe("equation: x² + 1");
  });

  it("unknown commands are stripped too (catch-all fallback)", () => {
    const out = stripMath("\\weirdmacro{x}{y} + \\unknown{z} + \\alone");
    expect(out).not.toContain("\\");
  });

  it("\\boxed wraps in 【…】", () => {
    expect(stripMath("\\boxed{x = 5}")).toBe("【x = 5】");
  });

  it("\\sqrt becomes √(...)", () => {
    expect(stripMath("\\sqrt{49}")).toBe("√(49)");
  });

  it("the full user-reported line no longer leaks raw LaTeX", () => {
    const input =
      "总路程：2d km 总时间：t_1 + t_2 = \\dfrac{d}{30} + \\dfrac{d}{60} = \\dfrac{2d}{60} + \\dfrac{d}{60} = \\dfrac{3d}{60} = \\dfrac{d}{20} 小时 平均速度：v_{avg} = \\frac{总路程}{总时间} = 40 km/h";
    const out = stripMath(input);
    expect(out).not.toContain("\\");
    expect(out).toContain("(总路程)/(总时间)");
    expect(out).toContain("t₁");
    expect(out).toContain("(d)/(30)");
  });
});

describe("parseBlocks — SEARCH/REPLACE detection", () => {
  it("extracts a single SEARCH/REPLACE block into a first-class edit-block", () => {
    const text = [
      "Here is the fix:",
      "",
      "src/foo.ts",
      "<<<<<<< SEARCH",
      "const x = 1;",
      "=======",
      "const x = 2;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const blocks = parseBlocks(text);
    const edit = blocks.find((b) => b.kind === "edit-block");
    expect(edit).toBeDefined();
    if (edit?.kind !== "edit-block") throw new Error("unreachable");
    expect(edit.filename).toBe("src/foo.ts");
    expect(edit.search).toBe("const x = 1;");
    expect(edit.replace).toBe("const x = 2;");
  });

  it("preserves multi-line SEARCH and REPLACE verbatim (no markdown mangling)", () => {
    // The original user-reported shape: JSDoc comments inside SEARCH.
    // Before this fix, `/** ... */` got eaten by bold/italic regex and
    // `para.join(" ")` collapsed newlines.
    const text = [
      "src/code/edit-blocks.ts",
      "<<<<<<< SEARCH",
      "/** Edit landed on disk. */",
      "| 'applied'",
      "=======",
      "/** Edit landed on disk. */",
      "| 'applied-new'",
      ">>>>>>> REPLACE",
    ].join("\n");
    const [edit] = parseBlocks(text).filter((b) => b.kind === "edit-block");
    if (edit?.kind !== "edit-block") throw new Error("expected edit-block");
    // The `/** ... */` and `|` chars survive intact — no `*`-eating,
    // no newline-flattening.
    expect(edit.search).toContain("/** Edit landed on disk. */");
    expect(edit.search).toContain("\n");
    expect(edit.replace).toContain("'applied-new'");
  });

  it("recognizes new-file (empty SEARCH) blocks", () => {
    const text = [
      "src/new.ts",
      "<<<<<<< SEARCH",
      "=======",
      "export const x = 1;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const [edit] = parseBlocks(text).filter((b) => b.kind === "edit-block");
    if (edit?.kind !== "edit-block") throw new Error("expected edit-block");
    expect(edit.search).toBe("");
    expect(edit.replace).toBe("export const x = 1;");
  });

  it("ignores a stray <<<<<<< SEARCH without a filename or close marker", () => {
    const text = "just some prose with <<<<<<< SEARCH left over in the middle";
    const blocks = parseBlocks(text);
    expect(blocks.find((b) => b.kind === "edit-block")).toBeUndefined();
  });

  it("extracts multiple edit-blocks in one response, keeping the prose between them", () => {
    const text = [
      "First change:",
      "src/a.ts",
      "<<<<<<< SEARCH",
      "old_a",
      "=======",
      "new_a",
      ">>>>>>> REPLACE",
      "",
      "And second:",
      "src/b.ts",
      "<<<<<<< SEARCH",
      "old_b",
      "=======",
      "new_b",
      ">>>>>>> REPLACE",
    ].join("\n");
    const blocks = parseBlocks(text);
    const edits = blocks.filter((b) => b.kind === "edit-block");
    expect(edits).toHaveLength(2);
    const paragraphs = blocks.filter((b) => b.kind === "paragraph");
    expect(paragraphs.map((p) => (p.kind === "paragraph" ? p.text : ""))).toEqual(
      expect.arrayContaining(["First change:", "And second:"]),
    );
  });
});
