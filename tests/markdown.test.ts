import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectCitations,
  expandAutolinks,
  expandEmoji,
  isExternalUrl,
  parseBlocks,
  parseCitationUrl,
  shouldValidateAsCitation,
  stripInlineMarkup,
  stripMath,
  validateCitation,
  visibleWidth,
} from "../src/cli/ui/markdown.js";

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

  it("preserves Windows-style backslash paths in plain prose", () => {
    // Regression: the catch-all `\\[a-zA-Z]+` LaTeX fallback wiped
    // five characters from "F:\TEST1" — `\TEST` matched as an
    // unknown LaTeX command and was deleted, leaving "F:1". The
    // early-exit guard skips the math pipeline entirely when no
    // math indicator is present.
    expect(stripMath("F:\\TEST1")).toBe("F:\\TEST1");
    expect(stripMath("F:\\TEST1\\report_output")).toBe("F:\\TEST1\\report_output");
    expect(stripMath("see C:\\Users\\name\\Documents\\foo.py")).toBe(
      "see C:\\Users\\name\\Documents\\foo.py",
    );
    // Literal backslash-letter in prose (not a path) also survives.
    expect(stripMath("the regex \\d+ matches digits")).toBe("the regex \\d+ matches digits");
  });

  it("still processes math when both a path and an equation appear together", () => {
    // Mixed input: the math indicator (`\frac`) IS present, so the
    // pipeline runs. The guard is "all-or-nothing" by design — once
    // we know there's math we transform the whole string. Path
    // chars in this case may collide with the catch-all, which is
    // acceptable (no real chat output mixes Windows paths with
    // LaTeX math, and even if it did, surfacing the math correctly
    // matters more than preserving the path verbatim).
    const out = stripMath("save to F:\\out then compute \\frac{a}{b}");
    expect(out).toContain("(a)/(b)");
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

  it("recognizes Unicode box-drawing tables (│ ─ ┼) as tables too", () => {
    // R1/V3 frequently emit this shape when asked for tabular data in
    // Chinese — the GFM-only path treated them as plain paragraphs and
    // Ink word-wrapped them into a tangle.
    const md = [
      "步骤             │ 说明",
      "─────────────────┼─────────────────────────────────────────",
      "**工具查找**     │ 按 `name` 查找已注册的工具",
      "**参数解析**     │ 支持 string (JSON) 或 object 格式",
      "",
      "Trailing prose.",
    ].join("\n");
    const blocks = parseBlocks(md);
    const table = blocks.find((b) => b.kind === "table");
    expect(table).toBeDefined();
    if (table && table.kind === "table") {
      expect(table.header).toEqual(["步骤", "说明"]);
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0]).toEqual(["**工具查找**", "按 `name` 查找已注册的工具"]);
      expect(table.rows[1]).toEqual(["**参数解析**", "支持 string (JSON) 或 object 格式"]);
    }
    expect(
      blocks.find((b) => b.kind === "paragraph" && b.text === "Trailing prose."),
    ).toBeDefined();
  });

  it("does NOT trigger on a bare '│' in prose without a separator below", () => {
    const md = ["The character │ is a vertical bar.", "Nothing tabular here."].join("\n");
    expect(parseBlocks(md).find((b) => b.kind === "table")).toBeUndefined();
  });

  it("folds a continuation row (no column separator) into the last cell of the previous row", () => {
    // Real-world LLM output: cell content too long, model wraps onto a
    // second line without re-emitting the separator. Used to leak as
    // a paragraph after the table; now stitched back into the cell so
    // inline backticks / bold parse correctly.
    const md = [
      "文件         │ 角色",
      "─────────────┼─────────────────────────────────────────",
      "`src/tools.ts` │ `dispatch()` 方法定义（约第 106 行起）。签名：",
      "                async dispatch(name: string, ...)。处理 plan-mode 拦截。",
    ].join("\n");
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0]?.[1]).toContain("dispatch()");
      expect(t.rows[0]?.[1]).toContain("async dispatch(name");
    }
  });
});

describe("parseBlocks — box-drawing frames as code blocks", () => {
  it("recognizes a single-line ┌─┐ │ └─┘ frame", () => {
    // Models routinely wrap one line of code in a Unicode frame for
    // emphasis. The renderer treats the frame as a code block so the
    // inner content stays readable instead of being word-wrapped.
    const md = [
      "Here is the call site:",
      "",
      "┌──────────────────────────────────────────┐",
      "│ result = await this.tools.dispatch(...); │",
      "└──────────────────────────────────────────┘",
      "",
      "Trailing.",
    ].join("\n");
    const blocks = parseBlocks(md);
    const code = blocks.find((b) => b.kind === "code");
    expect(code).toBeDefined();
    if (code && code.kind === "code") {
      expect(code.text).toBe("result = await this.tools.dispatch(...);");
    }
    expect(blocks.find((b) => b.kind === "paragraph" && b.text === "Trailing.")).toBeDefined();
  });

  it("recognizes a multi-line ┌─┐ │…│ └─┘ frame (flow charts and diagrams)", () => {
    const md = [
      "┌──────────────┐",
      "│ step 1       │",
      "│  ↓           │",
      "│ step 2       │",
      "└──────────────┘",
    ].join("\n");
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code" });
    if (blocks[0]?.kind === "code") {
      expect(blocks[0].text).toContain("step 1");
      expect(blocks[0].text).toContain("step 2");
      expect(blocks[0].text).toContain("↓");
      // Outer │ characters got stripped — content reads cleanly.
      expect(blocks[0].text).not.toContain("│");
    }
  });

  it("falls back to paragraph when the closing └─┘ is missing", () => {
    const md = ["┌────┐", "│ a  │", "no closing edge here"].join("\n");
    const blocks = parseBlocks(md);
    // No code block emitted — the open-edge line stays as paragraph.
    expect(blocks.find((b) => b.kind === "code")).toBeUndefined();
  });
});

describe("stripInlineMarkup + visibleWidth", () => {
  it("strips bold markers", () => {
    expect(stripInlineMarkup("**hello**")).toBe("hello");
  });
  it("strips inline code backticks", () => {
    expect(stripInlineMarkup("call `dispatch()` now")).toBe("call dispatch() now");
  });
  it("strips italic markers but leaves single * inside words", () => {
    expect(stripInlineMarkup("*emphasis*")).toBe("emphasis");
    expect(stripInlineMarkup("a*b*c")).toBe("a*b*c");
  });
  it("strips triple-backtick spans + their language tag", () => {
    expect(stripInlineMarkup("```bash echo hi```")).toBe("echo hi");
  });
  it("visibleWidth excludes markup chars", () => {
    // raw is 19 chars, visible is "定义 dispatch" = 4 (CJK ×2) + 1 (space) + 8 = 13
    expect(visibleWidth("**定义** `dispatch`")).toBe(13);
  });
  it("table cells with inline markup get sized by visible width, not raw", () => {
    // Header is plain, rows have inline code. The column sized by raw
    // length would be too wide; visibleWidth keeps things aligned to
    // what the user actually sees.
    const md = ["| 位置 | 角色 |", "|------|------|", "| `src/tools.ts` | 定义 dispatch |"].join(
      "\n",
    );
    const [t] = parseBlocks(md).filter((b) => b.kind === "table");
    expect(t).toBeDefined();
    if (t && t.kind === "table") {
      expect(t.rows[0]).toEqual(["`src/tools.ts`", "定义 dispatch"]);
    }
  });
});

describe("parseBlocks — fenced code blocks", () => {
  it("recognizes a plain multi-line fence", () => {
    const blocks = parseBlocks("```bash\necho hi\necho bye\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "code", lang: "bash", text: "echo hi\necho bye" });
  });

  it("allows up to 3 leading spaces on the fence line (GFM)", () => {
    const blocks = parseBlocks("   ```bash\n   echo indented\n   ```");
    const code = blocks.find((b) => b.kind === "code");
    expect(code).toBeDefined();
    expect(code && code.kind === "code" && code.lang).toBe("bash");
  });

  it("handles a one-line fenced code block (model puts everything on one line)", () => {
    const blocks = parseBlocks("```bash svn commit -m hi```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "code", lang: "bash", text: "svn commit -m hi" });
  });

  it("handles a one-line fenced block surrounded by prose paragraphs", () => {
    const blocks = parseBlocks("Run this:\n\n```bash svn status```\n\nOr:\n\n```bash svn log```");
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
    expect(blocks[1]).toMatchObject({ kind: "code", text: "svn status" });
    expect(blocks[2]).toMatchObject({ kind: "paragraph" });
    expect(blocks[3]).toMatchObject({ kind: "code", text: "svn log" });
  });

  it("closing fence must be at least as long as the opening fence", () => {
    // Opened with 4 backticks so body can contain 3 without closing.
    const blocks = parseBlocks("````\nsome ``` code\n````");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "code", lang: "", text: "some ``` code" });
  });

  it("an unclosed fence still emits a code block at EOF", () => {
    const blocks = parseBlocks("```python\nprint('hi')");
    const code = blocks.find((b) => b.kind === "code");
    expect(code && code.kind === "code" && code.text).toBe("print('hi')");
  });
});

describe("citation links — parseCitationUrl", () => {
  it("parses bare path", () => {
    expect(parseCitationUrl("src/foo.ts")).toEqual({ path: "src/foo.ts" });
  });

  it("parses path:line", () => {
    expect(parseCitationUrl("src/foo.ts:42")).toEqual({ path: "src/foo.ts", startLine: 42 });
  });

  it("parses path:start-end range", () => {
    expect(parseCitationUrl("src/foo.ts:42-58")).toEqual({
      path: "src/foo.ts",
      startLine: 42,
      endLine: 58,
    });
  });

  it("parses GitHub-style #L42 anchor", () => {
    expect(parseCitationUrl("src/foo.ts#L42")).toEqual({ path: "src/foo.ts", startLine: 42 });
  });

  it("parses GitHub-style #L42-L58 range", () => {
    expect(parseCitationUrl("src/foo.ts#L42-L58")).toEqual({
      path: "src/foo.ts",
      startLine: 42,
      endLine: 58,
    });
  });

  it("returns null on empty input", () => {
    expect(parseCitationUrl("")).toBeNull();
    expect(parseCitationUrl("   ")).toBeNull();
  });
});

describe("citation links — isExternalUrl", () => {
  it("recognizes http/https/ftp", () => {
    expect(isExternalUrl("https://example.com")).toBe(true);
    expect(isExternalUrl("http://example.com")).toBe(true);
    expect(isExternalUrl("ftp://example.com")).toBe(true);
  });

  it("recognizes mailto and protocol-relative", () => {
    expect(isExternalUrl("mailto:a@b.c")).toBe(true);
    expect(isExternalUrl("//cdn.example.com/x")).toBe(true);
  });

  it("rejects local paths and bare names", () => {
    expect(isExternalUrl("src/foo.ts")).toBe(false);
    expect(isExternalUrl("src/foo.ts:42")).toBe(false);
    expect(isExternalUrl("README.md")).toBe(false);
    expect(isExternalUrl("./foo")).toBe(false);
  });
});

describe("citation links — validateCitation + collectCitations", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-citation-"));
    writeFileSync(join(tmp, "real.ts"), "line1\nline2\nline3\nline4\nline5\n");
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("file exists, no line → ok", () => {
    expect(validateCitation("real.ts", tmp)).toEqual({ ok: true });
  });

  it("file exists, line in range → ok", () => {
    expect(validateCitation("real.ts:3", tmp)).toEqual({ ok: true });
  });

  it("file exists, line out of range → broken with reason", () => {
    const result = validateCitation("real.ts:99", tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("99");
  });

  it("range end out of file → broken", () => {
    const result = validateCitation("real.ts:1-99", tmp);
    expect(result.ok).toBe(false);
  });

  it("missing file → broken with 'file not found'", () => {
    const result = validateCitation("ghost.ts:1", tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("file not found");
  });

  it("leading `/` is treated as project-rooted, not filesystem-absolute", () => {
    // Models habitually write `/foo.ts` meaning "project root" (Aider /
    // Claude-Code style). Without the strip this would be resolved
    // against POSIX `/` or the Windows drive root and always fail —
    // that was the symptom in 0.5.16: a real file at the project root
    // rendered as "file not found" because the leading slash sent the
    // validator to the wrong place.
    expect(validateCitation("/real.ts", tmp)).toEqual({ ok: true });
    expect(validateCitation("/real.ts:2", tmp)).toEqual({ ok: true });
  });

  it("leading `\\` is treated the same way (Windows-style)", () => {
    expect(validateCitation("\\real.ts", tmp)).toEqual({ ok: true });
  });

  it("collectCitations validates every unique citation, skips externals", () => {
    const text = [
      "See [foo](real.ts:2) for details.",
      "Compare with [bar](https://example.com).",
      "Bogus claim [baz](ghost.ts:1).",
      "Another [foo again](real.ts:2).",
    ].join("\n");
    const map = collectCitations(text, tmp);
    expect(map.size).toBe(2);
    expect(map.get("real.ts:2")).toEqual({ ok: true });
    expect(map.get("ghost.ts:1")?.ok).toBe(false);
    expect(map.has("https://example.com")).toBe(false);
  });
});

describe("citation links — parseBlocks regression", () => {
  it("plain markdown link inside paragraph still parses as paragraph", () => {
    const blocks = parseBlocks("See [the docs](src/foo.ts:42) for context.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("paragraph");
    if (blocks[0]?.kind === "paragraph") {
      expect(blocks[0].text).toContain("[the docs](src/foo.ts:42)");
    }
  });

  it("stripInlineMarkup extracts link text only", () => {
    expect(stripInlineMarkup("see [foo](path.ts:10) here")).toBe("see foo here");
  });

  it("visibleWidth ignores link URL", () => {
    // "see " + "foo" + " here" = 12 visible chars
    expect(visibleWidth("see [foo](path.ts:10) here")).toBe(12);
  });
});

describe("parseBlocks — blockquote", () => {
  it("single `> line` parses to a quote with one paragraph child", () => {
    const blocks = parseBlocks("> a quoted line");
    expect(blocks).toHaveLength(1);
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    expect(blocks[0].children).toHaveLength(1);
    expect(blocks[0].children[0]?.kind).toBe("paragraph");
    if (blocks[0].children[0]?.kind === "paragraph") {
      expect(blocks[0].children[0].text).toBe("a quoted line");
    }
  });

  it("consecutive `>` lines fold into one paragraph inside the quote", () => {
    const blocks = parseBlocks(["> first", "> second", "> third"].join("\n"));
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    // Three adjacent `>` lines with no blank separator → one paragraph
    // (paragraph parser joins with spaces, same as outside a quote).
    expect(blocks[0].children).toHaveLength(1);
    if (blocks[0].children[0]?.kind === "paragraph") {
      expect(blocks[0].children[0].text).toBe("first second third");
    }
  });

  it("blank `>` line splits the quote into two paragraph children", () => {
    const blocks = parseBlocks(["> para 1", ">", "> para 2"].join("\n"));
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    expect(blocks[0].children).toHaveLength(2);
    expect(blocks[0].children.map((c) => c.kind)).toEqual(["paragraph", "paragraph"]);
  });

  it("non-`>` line after a quote closes it — following prose becomes its own paragraph", () => {
    const blocks = parseBlocks(["> quoted", "", "not quoted"].join("\n"));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.kind).toBe("quote");
    expect(blocks[1]?.kind).toBe("paragraph");
    if (blocks[1]?.kind === "paragraph") expect(blocks[1].text).toBe("not quoted");
  });

  it("quote content carries inline markdown (bold, code) through intact", () => {
    const blocks = parseBlocks("> **important**: call `foo()` first");
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    const child = blocks[0].children[0];
    if (child?.kind !== "paragraph") throw new Error("unreachable");
    expect(child.text).toBe("**important**: call `foo()` first");
  });

  it("`>` with no space before content still parses (GFM-tolerant)", () => {
    const blocks = parseBlocks(">no space");
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    if (blocks[0].children[0]?.kind === "paragraph") {
      expect(blocks[0].children[0].text).toBe("no space");
    }
  });

  it("nested `> >` becomes a blockquote inside a blockquote", () => {
    const blocks = parseBlocks(["> outer", ">", "> > inner"].join("\n"));
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    expect(blocks[0].children.map((c) => c.kind)).toEqual(["paragraph", "quote"]);
    const inner = blocks[0].children[1];
    if (inner?.kind !== "quote") throw new Error("unreachable");
    const innerPara = inner.children[0];
    if (innerPara?.kind !== "paragraph") throw new Error("unreachable");
    expect(innerPara.text).toBe("inner");
  });

  it("triple-nested `> > >` produces three levels of quote", () => {
    const blocks = parseBlocks("> > > deep");
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    const lvl2 = blocks[0].children[0];
    if (lvl2?.kind !== "quote") throw new Error("unreachable");
    const lvl3 = lvl2.children[0];
    if (lvl3?.kind !== "quote") throw new Error("unreachable");
    const leaf = lvl3.children[0];
    if (leaf?.kind !== "paragraph") throw new Error("unreachable");
    expect(leaf.text).toBe("deep");
  });

  it("list inside a quote parses as a real bullet block, not flattened text", () => {
    const blocks = parseBlocks(["> - item a", "> - item b"].join("\n"));
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    expect(blocks[0].children).toHaveLength(1);
    const inner = blocks[0].children[0];
    if (inner?.kind !== "bullet") throw new Error("unreachable");
    expect(inner.items.map((x) => x.text)).toEqual(["item a", "item b"]);
  });

  it("fenced code block inside a quote parses as a real code block", () => {
    const blocks = parseBlocks(["> ```js", "> const x = 1;", "> ```"].join("\n"));
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    const inner = blocks[0].children[0];
    if (inner?.kind !== "code") throw new Error("unreachable");
    expect(inner.lang).toBe("js");
    expect(inner.text).toBe("const x = 1;");
  });

  it("mixed content inside a quote: paragraph + list keeps both structured", () => {
    const src = ["> 引用可以包含其他元素：", ">", "> - 列表项一", "> - 列表项二"].join("\n");
    const blocks = parseBlocks(src);
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    expect(blocks[0].children.map((c) => c.kind)).toEqual(["paragraph", "bullet"]);
  });

  it("horizontal rule inside a quote stays as literal `---` (no HR promotion)", () => {
    // Inside the quote, `> ---` strips to `---` — THAT does match the
    // HR regex in the recursive parse, so nested HR IS a real thing.
    // Just checking it's a quote with an hr child (not eaten at the
    // outer level).
    const blocks = parseBlocks("> ---");
    expect(blocks).toHaveLength(1);
    if (blocks[0]?.kind !== "quote") throw new Error("unreachable");
    expect(blocks[0].children[0]?.kind).toBe("hr");
  });
});

describe("parseBlocks — task lists", () => {
  it("`- [ ] …` produces a todo item", () => {
    const blocks = parseBlocks("- [ ] do the thing");
    if (blocks[0]?.kind !== "bullet") throw new Error("unreachable");
    expect(blocks[0].items).toHaveLength(1);
    expect(blocks[0].items[0]).toEqual({ text: "do the thing", task: "todo" });
  });

  it("`- [x] …` produces a done item", () => {
    const blocks = parseBlocks("- [x] shipped");
    if (blocks[0]?.kind !== "bullet") throw new Error("unreachable");
    expect(blocks[0].items[0]).toEqual({ text: "shipped", task: "done" });
  });

  it("uppercase `[X]` is also treated as done (case-insensitive)", () => {
    const blocks = parseBlocks("- [X] uppercase");
    if (blocks[0]?.kind !== "bullet") throw new Error("unreachable");
    expect(blocks[0].items[0]?.task).toBe("done");
  });

  it("mixed tasks and plain bullets coexist in one list", () => {
    const text = ["- plain item", "- [ ] todo", "- [x] done"].join("\n");
    const blocks = parseBlocks(text);
    if (blocks[0]?.kind !== "bullet") throw new Error("unreachable");
    expect(blocks[0].items).toEqual([
      { text: "plain item" },
      { text: "todo", task: "todo" },
      { text: "done", task: "done" },
    ]);
  });

  it("array-index-style prose `[1] ref` does NOT become a task", () => {
    // Regression: task regex requires a space after the bracket, so
    // `- [1] ref` is a plain bullet whose item text is "[1] ref".
    const blocks = parseBlocks("- [1] reference");
    if (blocks[0]?.kind !== "bullet") throw new Error("unreachable");
    expect(blocks[0].items[0]).toEqual({ text: "[1] reference" });
  });
});

describe("stripMath — $ / $$ delimiters", () => {
  it("strips inline `$E = mc^2$` to `E = mc²` (delimiter gone, superscript converted)", () => {
    expect(stripMath("$E = mc^2$")).toBe("E = mc²");
  });

  it("strips surrounding `$$…$$` on block math and isolates it as its own paragraph", () => {
    const out = stripMath("prose $$x + y = z$$ more prose");
    // Block math gets \n\n on each side so parseBlocks later treats
    // it as its own paragraph instead of folding into prose.
    expect(out).not.toContain("$$");
    expect(out).toContain("x + y = z");
  });

  it("handles `$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$` end-to-end", () => {
    const out = stripMath("$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$");
    expect(out).not.toContain("$");
    expect(out).not.toContain("\\");
    expect(out).toContain("Σ"); // \sum → Σ
    expect(out).toContain("(n(n+1))/(2)"); // \frac → ( )/( )
    expect(out).toContain("ⁿ"); // ^{n} → ⁿ
  });

  it("does NOT eat a price like `$5 per unit` (no closing $ adjacent to non-space)", () => {
    expect(stripMath("$5 per unit")).toBe("$5 per unit");
  });

  it("does NOT eat `$5 and $10` prose (content starts/ends with space at boundaries)", () => {
    expect(stripMath("$5 and $10 extra")).toBe("$5 and $10 extra");
  });

  it("does NOT eat a shell var `echo $HOME`", () => {
    expect(stripMath("echo $HOME")).toBe("echo $HOME");
  });

  it("leaves `$ prompt:` alone (space immediately after opening $)", () => {
    expect(stripMath("$ prompt:")).toBe("$ prompt:");
  });

  it("strips a single-character inline expression `$x$`", () => {
    // With non-greedy + 1-or-more content, $x$ matches as content `x`.
    expect(stripMath("$x$")).toBe("x");
  });
});

describe("expandEmoji — GFM shortcodes", () => {
  it(":smile: → 😄", () => {
    expect(expandEmoji(":smile:")).toBe("😄");
  });

  it(":+1: and :-1: resolve to thumb emojis", () => {
    expect(expandEmoji(":+1:")).toBe("👍");
    expect(expandEmoji(":-1:")).toBe("👎");
  });

  it("inline prose: `great :fire: job` → `great 🔥 job`", () => {
    expect(expandEmoji("great :fire: job")).toBe("great 🔥 job");
  });

  it("unknown shortcode stays literal (no mangling of `:unknown_thing:`)", () => {
    expect(expandEmoji(":unknown_thing:")).toBe(":unknown_thing:");
  });

  it("numeric `:10:` stays literal (not in map; protects timestamps / file:line:col)", () => {
    expect(expandEmoji("file.ts:10: error")).toBe("file.ts:10: error");
  });

  it("case-insensitive match (`:SMILE:` also resolves)", () => {
    expect(expandEmoji(":SMILE:")).toBe("😄");
  });

  it(":100: resolves via the numeric alias", () => {
    expect(expandEmoji(":100:")).toBe("💯");
  });

  it("multiple emoji on one line all expand", () => {
    expect(expandEmoji(":rocket: :fire: :tada:")).toBe("🚀 🔥 🎉");
  });
});

describe("inline — bold-italic `***text***`", () => {
  it("stripInlineMarkup unwraps the whole three-star envelope (no leftover asterisks)", () => {
    expect(stripInlineMarkup("***both***")).toBe("both");
  });

  it("visibleWidth counts only the inner text", () => {
    // "both" = 4 visible chars, `***` markers contribute 0.
    expect(visibleWidth("***both***")).toBe(4);
  });

  it("bold-italic coexists with surrounding plain text", () => {
    expect(stripInlineMarkup("hi ***emphasis*** there")).toBe("hi emphasis there");
  });

  it("does NOT greedily consume a following `**bold**` on the same line", () => {
    // Concrete regression: the bold-italic regex is non-greedy and
    // content excludes `*`, so `***a*** **b**` stays as two distinct
    // spans with 4 chars visible.
    expect(stripInlineMarkup("***a*** **b**")).toBe("a b");
  });
});

describe("stripMath — Pandoc super/subscript (^text^ / ~text~)", () => {
  it("`x^2^` → `x²` (all chars convertible)", () => {
    expect(stripMath("x^2^")).toBe("x²");
  });

  it("`H~2~O` → `H₂O` (subscript)", () => {
    expect(stripMath("H~2~O")).toBe("H₂O");
  });

  it("`a^123^` → `a¹²³` (multi-digit superscript)", () => {
    expect(stripMath("a^123^")).toBe("a¹²³");
  });

  it("leaves `^foo^` literal when content has non-convertible chars", () => {
    // `f`, `o` aren't in SUPERSCRIPT map, so dropping the markers
    // would lose the model's intent — better to leave literal.
    expect(stripMath("x^foo^")).toBe("x^foo^");
  });

  it("subscript rule does NOT fire inside `~~strikethrough~~`", () => {
    // Both `~` are guarded by (?<!~)(?!~) so `~~text~~` passes through
    // to the inline parser intact. `text` contains letters → would
    // fail the conversion guard anyway, but also the outer lookarounds
    // skip the strikethrough bounds — double protection.
    expect(stripMath("~~gone~~")).toBe("~~gone~~");
  });

  it("LaTeX form `H^{2}` still works (handled by the existing {braced} rule)", () => {
    expect(stripMath("H^{2}O")).toBe("H²O");
  });
});

describe("parseBlocks — hard line break (GFM trailing two spaces)", () => {
  it("a single `  ` hard break injects a `\\n` inside the paragraph text", () => {
    const src = "line one  \nline two";
    const blocks = parseBlocks(src);
    expect(blocks).toHaveLength(1);
    if (blocks[0]?.kind !== "paragraph") throw new Error("unreachable");
    expect(blocks[0].text).toBe("line one\nline two");
  });

  it("without trailing `  ` a soft break still collapses to a space", () => {
    const src = "line one\nline two";
    const blocks = parseBlocks(src);
    if (blocks[0]?.kind !== "paragraph") throw new Error("unreachable");
    expect(blocks[0].text).toBe("line one line two");
  });

  it("mixed hard + soft breaks preserve the distinction", () => {
    // line 1 → hard → line 2 → soft → line 3
    const src = "line one  \nline two\nline three";
    const blocks = parseBlocks(src);
    if (blocks[0]?.kind !== "paragraph") throw new Error("unreachable");
    expect(blocks[0].text).toBe("line one\nline two line three");
  });

  it("three trailing spaces also trigger hard break (GFM: two-or-more)", () => {
    const src = "one   \ntwo";
    const blocks = parseBlocks(src);
    if (blocks[0]?.kind !== "paragraph") throw new Error("unreachable");
    expect(blocks[0].text).toBe("one\ntwo");
  });

  it("one trailing space is NOT a hard break (two required)", () => {
    const src = "one \ntwo";
    const blocks = parseBlocks(src);
    if (blocks[0]?.kind !== "paragraph") throw new Error("unreachable");
    expect(blocks[0].text).toBe("one two");
  });
});

describe("inline — backslash escapes", () => {
  it("stripInlineMarkup drops `\\` before punctuation (CommonMark escape)", () => {
    expect(stripInlineMarkup("\\*not italic\\*")).toBe("*not italic*");
  });

  it("stripInlineMarkup keeps ``\\``` before backtick", () => {
    expect(stripInlineMarkup("\\`code\\`")).toBe("`code`");
  });

  it("escape survives a would-be strikethrough at the edges", () => {
    // `\~...\~` has only single ~ each side after escape — not strike.
    expect(stripInlineMarkup("\\~foo\\~")).toBe("~foo~");
  });

  it("`\\\\` becomes a single literal backslash", () => {
    expect(stripInlineMarkup("a\\\\b")).toBe("a\\b");
  });

  it("escape only triggers on markup punctuation — `\\a` stays `\\a`", () => {
    // `a` isn't in the escape class, so the backslash is preserved.
    expect(stripInlineMarkup("hi\\a")).toBe("hi\\a");
  });

  it("visibleWidth skips the `\\` when escape fires", () => {
    // "\\*not\\*" renders as 5 visible chars: "*not*"
    expect(visibleWidth("\\*not\\*")).toBe(5);
  });
});

describe("expandAutolinks — `<url>` shorthand", () => {
  it("rewrites `<https://example.com>` to a full `[url](url)`", () => {
    expect(expandAutolinks("see <https://example.com> now")).toBe(
      "see [https://example.com](https://example.com) now",
    );
  });

  it("rewrites `<mailto:foo@bar.com>`", () => {
    expect(expandAutolinks("<mailto:test@example.com>")).toBe(
      "[mailto:test@example.com](mailto:test@example.com)",
    );
  });

  it("leaves `<non-url text>` alone (no recognized scheme)", () => {
    expect(expandAutolinks("<angle-bracketed prose>")).toBe("<angle-bracketed prose>");
  });

  it("leaves `<kbd>`, `<span>`, and other HTML tags alone", () => {
    expect(expandAutolinks("<kbd>Ctrl</kbd>")).toBe("<kbd>Ctrl</kbd>");
  });
});

describe("shouldValidateAsCitation — citation guard", () => {
  it("skips anchor-only `#foo` (in-page jump, not a file)", () => {
    expect(shouldValidateAsCitation("#foo")).toBe(false);
    expect(shouldValidateAsCitation("#")).toBe(false);
    expect(shouldValidateAsCitation("#section-1")).toBe(false);
  });

  it("skips bare `/` and empty", () => {
    expect(shouldValidateAsCitation("/")).toBe(false);
    expect(shouldValidateAsCitation("")).toBe(false);
  });

  it("skips placeholder words without path separators or extensions", () => {
    expect(shouldValidateAsCitation("url")).toBe(false);
    expect(shouldValidateAsCitation("placeholder")).toBe(false);
  });

  it("accepts a real path with slash", () => {
    expect(shouldValidateAsCitation("src/foo.ts")).toBe(true);
  });

  it("accepts a file with extension but no slash", () => {
    expect(shouldValidateAsCitation("README.md")).toBe(true);
  });
});

describe("collectCitations — no false positives from anchors / placeholders", () => {
  it("does NOT add `#anchor` URLs to the citation map (no broken-citation red)", () => {
    const map = collectCitations("jump to [top](#1-header) here", "/tmp");
    expect(map.size).toBe(0);
  });

  it("does NOT add placeholder words like `url` to the map", () => {
    const map = collectCitations("demo link: [see this](url)", "/tmp");
    expect(map.size).toBe(0);
  });
});

describe("parseBlocks — diagram code blocks (mermaid / dot / plantuml / …)", () => {
  it("parses a ```mermaid block as a CodeBlock with lang='mermaid'", () => {
    const src = ["```mermaid", "graph TD", "  A --> B", "```"].join("\n");
    const blocks = parseBlocks(src);
    expect(blocks).toHaveLength(1);
    if (blocks[0]?.kind !== "code") throw new Error("unreachable");
    expect(blocks[0].lang).toBe("mermaid");
    expect(blocks[0].text).toBe("graph TD\n  A --> B");
  });

  it("parses a ```dot block as a CodeBlock (rendering branches on lang at display time)", () => {
    const src = ["```dot", "digraph G { A -> B }", "```"].join("\n");
    const blocks = parseBlocks(src);
    if (blocks[0]?.kind !== "code") throw new Error("unreachable");
    expect(blocks[0].lang).toBe("dot");
  });
});

describe("inline — strikethrough", () => {
  it("stripInlineMarkup unwraps `~~text~~`", () => {
    expect(stripInlineMarkup("before ~~gone~~ after")).toBe("before gone after");
  });

  it("visibleWidth ignores `~~` markers", () => {
    // "abc" + " " + "xy" = 6 visible chars; `~~` on each side = 0 visible.
    expect(visibleWidth("abc ~~xy~~")).toBe(6);
  });

  it("bold, code, and strikethrough can coexist on one line", () => {
    const input = "**bold** then `code` then ~~gone~~";
    expect(stripInlineMarkup(input)).toBe("bold then code then gone");
  });

  it("two strikethroughs on one line are both captured", () => {
    expect(stripInlineMarkup("~~one~~ and ~~two~~")).toBe("one and two");
  });
});
