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

describe("parseBlocks — GFM tables", () => {
  it("recognizes a simple table with header + separator + rows", () => {
    const md = [
      "Intro paragraph.",
      "",
      "| 声望点 | 加成效果 |",
      "|--------|----------|",
      "| 每2点 | +1 点击力 |",
      "| 每3点 | +10% CPS 乘数 |",
      "",
      "Trailing text.",
    ].join("\n");
    const blocks = parseBlocks(md);
    const table = blocks.find((b) => b.kind === "table");
    expect(table).toBeDefined();
    if (table && table.kind === "table") {
      expect(table.header).toEqual(["声望点", "加成效果"]);
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0]).toEqual(["每2点", "+1 点击力"]);
      expect(table.rows[1]).toEqual(["每3点", "+10% CPS 乘数"]);
    }
    // Surrounding paragraphs still parsed as separate blocks.
    expect(
      blocks.find((b) => b.kind === "paragraph" && b.text === "Intro paragraph."),
    ).toBeDefined();
    expect(blocks.find((b) => b.kind === "paragraph" && b.text === "Trailing text.")).toBeDefined();
  });

  it("accepts alignment colons in the separator without breaking", () => {
    const md = ["| col1 | col2 |", "|:-----|-----:|", "| a    | b    |"].join("\n");
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.header).toEqual(["col1", "col2"]);
      expect(t.rows[0]).toEqual(["a", "b"]);
    }
  });

  it("accepts tables without leading/trailing pipes", () => {
    const md = ["col1 | col2", "-----|-----", "a    | b"].join("\n");
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.header).toEqual(["col1", "col2"]);
      expect(t.rows[0]).toEqual(["a", "b"]);
    }
  });

  it("does NOT trigger on a bare '|' in prose when next line is not a separator", () => {
    const md = ["Use the pipe | operator to chain.", "Second paragraph."].join("\n");
    const blocks = parseBlocks(md);
    expect(blocks.find((b) => b.kind === "table")).toBeUndefined();
  });

  it("preserves escaped pipes inside cell content", () => {
    const md = ["| a | b |", "|---|---|", "| x \\| y | z |"].join("\n");
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.rows[0]).toEqual(["x | y", "z"]);
    }
  });
});
