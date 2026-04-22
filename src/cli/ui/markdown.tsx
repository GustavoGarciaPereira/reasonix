/**
 * Minimal Markdown → Ink renderer for chat output.
 *
 * Handles the subset that actually shows up in LLM answers:
 *   - ATX headers (# ##)
 *   - Unordered / ordered lists
 *   - Fenced code blocks (```lang)
 *   - Inline **bold**, *italic*, `code`
 *   - Paragraphs separated by blank lines
 *   - LaTeX delimiters are stripped (\( \), \[ \], \boxed{X})
 *
 * The goal is not TeX-perfect math — it's "stop showing raw backslashes to
 * the user." When the model insists on LaTeX, we strip the scaffolding and
 * show the expression verbatim; terminals don't do math fonts anyway.
 */

import { Box, Text } from "ink";
import React from "react";

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  n: "ⁿ",
};
const SUBSCRIPT: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
};

function toSuperscript(s: string): string {
  let out = "";
  for (const c of s) out += SUPERSCRIPT[c] ?? c;
  return out;
}
function toSubscript(s: string): string {
  let out = "";
  for (const c of s) out += SUBSCRIPT[c] ?? c;
  return out;
}

export function stripMath(s: string): string {
  return (
    s
      // Delimiters
      .replace(/\\\(\s*/g, "")
      .replace(/\s*\\\)/g, "")
      .replace(/\\\[\s*/g, "\n")
      .replace(/\s*\\\]/g, "\n")
      // Fractions — \frac, \dfrac, \tfrac. Allow whitespace and one nesting
      // level inside braces (e.g. \frac{\sqrt{2}}{3}). Trim captured groups
      // so '\frac{ a }{ b }' renders as '(a)/(b)'.
      .replace(
        /\\[dt]?frac\s*\{((?:[^{}]|\{[^{}]*\})+)\}\s*\{((?:[^{}]|\{[^{}]*\})+)\}/g,
        (_m, num: string, den: string) => `(${num.trim()})/(${den.trim()})`,
      )
      .replace(
        /\\binom\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g,
        (_m, n: string, k: string) => `C(${n.trim()},${k.trim()})`,
      )
      .replace(/\\sqrt\s*\{([^{}]+)\}/g, (_m, g: string) => `√(${g.trim()})`)
      .replace(/\\boxed\s*\{([^{}]+)\}/g, (_m, g: string) => `【${g.trim()}】`)
      .replace(/\\text\s*\{([^{}]+)\}/g, (_m, g: string) => g.trim())
      .replace(/\\overline\s*\{([^{}]+)\}/g, (_m, g: string) => `${g.trim()}̄`)
      .replace(/\\hat\s*\{([^{}]+)\}/g, (_m, g: string) => `${g.trim()}̂`)
      .replace(/\\vec\s*\{([^{}]+)\}/g, (_m, g: string) => `→${g.trim()}`)
      // Operators & symbols
      .replace(/\\cdot/g, "·")
      .replace(/\\times/g, "×")
      .replace(/\\div/g, "÷")
      .replace(/\\pm/g, "±")
      .replace(/\\mp/g, "∓")
      .replace(/\\leq/g, "≤")
      .replace(/\\geq/g, "≥")
      .replace(/\\neq/g, "≠")
      .replace(/\\approx/g, "≈")
      .replace(/\\in\b/g, "∈")
      .replace(/\\notin\b/g, "∉")
      .replace(/\\infty/g, "∞")
      .replace(/\\sum\b/g, "Σ")
      .replace(/\\prod\b/g, "Π")
      .replace(/\\int\b/g, "∫")
      // Greek letters
      .replace(/\\alpha/g, "α")
      .replace(/\\beta/g, "β")
      .replace(/\\gamma/g, "γ")
      .replace(/\\delta/g, "δ")
      .replace(/\\theta/g, "θ")
      .replace(/\\lambda/g, "λ")
      .replace(/\\mu/g, "μ")
      .replace(/\\pi/g, "π")
      .replace(/\\sigma/g, "σ")
      .replace(/\\phi/g, "φ")
      .replace(/\\omega/g, "ω")
      // Arrows / logic
      .replace(/\\implies\b/g, "⇒")
      .replace(/\\iff\b/g, "⇔")
      .replace(/\\to\b/g, "→")
      .replace(/\\rightarrow/g, "→")
      .replace(/\\Rightarrow/g, "⇒")
      .replace(/\\leftarrow/g, "←")
      .replace(/\\Leftarrow/g, "⇐")
      .replace(/\\ldots/g, "…")
      .replace(/\\cdots/g, "⋯")
      // Spacing commands
      .replace(/\\quad/g, "  ")
      .replace(/\\qquad/g, "    ")
      .replace(/\\,/g, " ")
      .replace(/\\;/g, " ")
      .replace(/\\!/g, "")
      .replace(/\\\\/g, "\n")
      // Superscripts / subscripts — single token or {braced group of [\w+-]}
      .replace(/\^\{([\w+-]+)\}/g, (_m, g: string) => toSuperscript(g))
      .replace(/\^([0-9+\-n])/g, (_m, g: string) => toSuperscript(g))
      .replace(/_\{([\w+-]+)\}/g, (_m, g: string) => toSubscript(g))
      .replace(/_([0-9+\-])/g, (_m, g: string) => toSubscript(g))
      // Catch-all fallbacks for any LaTeX command we didn't explicitly handle.
      // Belt-and-braces: even if the model invents a new \weirdcommand{x}{y},
      // we'd rather show '(x)/(y)' or 'x' than a raw backslash.
      .replace(/\\[a-zA-Z]+\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "($1)/($2)")
      .replace(/\\[a-zA-Z]+\s*\{([^{}]+)\}/g, "$1")
      .replace(/\\[a-zA-Z]+/g, "")
      // Collapse multiple whitespace introduced by the stripping above.
      .replace(/[ \t]{2,}/g, " ")
  );
}

/** Split a single line into styled segments for bold / italic / inline code. */
const INLINE_RE = /(\*\*([^*\n]+?)\*\*|`([^`\n]+?)`|(?<![*\w])\*([^*\n]+?)\*(?!\w))/g;

function InlineMd({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let idx = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      parts.push(<Text key={`t${idx++}`}>{text.slice(last, start)}</Text>);
    }
    if (m[2] !== undefined) {
      parts.push(
        <Text key={`b${idx++}`} bold>
          {m[2]}
        </Text>,
      );
    } else if (m[3] !== undefined) {
      parts.push(
        <Text key={`c${idx++}`} color="yellow">
          {m[3]}
        </Text>,
      );
    } else if (m[4] !== undefined) {
      parts.push(
        <Text key={`i${idx++}`} italic>
          {m[4]}
        </Text>,
      );
    }
    last = start + m[0].length;
  }
  if (last < text.length) {
    parts.push(<Text key={`t${idx++}`}>{text.slice(last)}</Text>);
  }
  return <Text>{parts}</Text>;
}

interface ParagraphBlock {
  kind: "paragraph";
  text: string;
}
interface HeadingBlock {
  kind: "heading";
  level: number;
  text: string;
}
interface BulletBlock {
  kind: "bullet";
  items: string[];
  ordered: boolean;
  start: number;
}
interface CodeBlock {
  kind: "code";
  lang: string;
  text: string;
}
interface HrBlock {
  kind: "hr";
}
// First-class Aider-style SEARCH/REPLACE block. We detect these at
// parse time instead of routing them through the paragraph / inline
// markdown path because the inline parser would otherwise eat `**`
// inside JSDoc `/** ... *\/` comments and `para.join(" ")` would
// collapse the block's newlines. Rendered as a diff so the user can
// actually read what's about to change.
interface EditBlockView {
  kind: "edit-block";
  filename: string;
  search: string;
  replace: string;
}

/**
 * GitHub-Flavored-Markdown-ish tables. We don't do alignment flags
 * (:--- / ---:) — column-wise left-alignment is fine for a terminal
 * and the LLM rarely specifies alignment anyway. Columns grow to
 * fit the widest cell, with a hard cap so a pathological 200-char
 * cell doesn't blow past the terminal width.
 */
interface TableBlock {
  kind: "table";
  header: string[];
  rows: string[][];
}

type Block =
  | ParagraphBlock
  | HeadingBlock
  | BulletBlock
  | CodeBlock
  | HrBlock
  | EditBlockView
  | TableBlock;

export function parseBlocks(raw: string): Block[] {
  const lines = raw.split(/\r?\n/);
  const out: Block[] = [];
  let para: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listBuf: BulletBlock | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push({ kind: "paragraph", text: para.join(" ") });
      para = [];
    }
  };
  const flushList = () => {
    if (listBuf) {
      out.push(listBuf);
      listBuf = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine.replace(/\s+$/g, "");

    // Detect Aider-style SEARCH/REPLACE block. Matches the preceding
    // non-blank line as the filename, then `<<<<<<< SEARCH`, content,
    // `=======`, content, `>>>>>>> REPLACE`. We don't do markdown
    // inside — neither the paragraph nor inline parsers should touch
    // this content.
    if (!inCode && /^<{7} SEARCH\s*$/.test(line)) {
      // Filename is the previous non-blank line we just pushed to para.
      // Pull it back out; if there isn't one, treat as literal text.
      const filename = para.pop()?.trim();
      if (filename) {
        flushPara();
        flushList();
        let j = i + 1;
        const searchLines: string[] = [];
        while (j < lines.length && !/^={7}\s*$/.test(lines[j]!)) {
          searchLines.push(lines[j]!);
          j++;
        }
        const replaceLines: string[] = [];
        let k = j + 1;
        while (k < lines.length && !/^>{7} REPLACE\s*$/.test(lines[k]!)) {
          replaceLines.push(lines[k]!);
          k++;
        }
        if (j < lines.length && k < lines.length) {
          out.push({
            kind: "edit-block",
            filename,
            search: searchLines.join("\n"),
            replace: replaceLines.join("\n"),
          });
          i = k;
          continue;
        }
        // Malformed — no separator or no close. Fall through: put
        // the filename back in the paragraph so we don't lose it.
        para.push(filename);
      }
    }

    const fence = line.match(/^```(\w*)/);
    if (fence) {
      if (inCode) {
        out.push({ kind: "code", lang: codeLang, text: codeBuf.join("\n") });
        codeBuf = [];
        codeLang = "";
        inCode = false;
      } else {
        flushPara();
        flushList();
        inCode = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(rawLine);
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push({ kind: "hr" });
      continue;
    }

    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      flushPara();
      flushList();
      out.push({ kind: "heading", level: hm[1]!.length, text: hm[2]!.trim() });
      continue;
    }

    // Table detection: a line with at least one `|` where the NEXT
    // line looks like a GFM separator (`| --- | --- |` or any mix of
    // pipes + dashes + colons + spaces). Both the header row and the
    // separator need to be present — a bare pipe in prose shouldn't
    // trigger the table path.
    if (line.includes("|")) {
      const next = (lines[i + 1] ?? "").trim();
      if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(next)) {
        flushPara();
        flushList();
        const header = splitTableRow(line);
        const rows: string[][] = [];
        let j = i + 2; // skip header + separator
        while (j < lines.length) {
          const r = lines[j]!.replace(/\s+$/g, "");
          if (r.trim() === "" || !r.includes("|")) break;
          rows.push(splitTableRow(r));
          j++;
        }
        out.push({ kind: "table", header, rows });
        i = j - 1;
        continue;
      }
    }

    const bm = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bm) {
      flushPara();
      if (!listBuf || listBuf.ordered) {
        flushList();
        listBuf = { kind: "bullet", items: [], ordered: false, start: 1 };
      }
      listBuf.items.push(bm[1]!);
      continue;
    }

    const om = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (om) {
      flushPara();
      if (!listBuf || !listBuf.ordered) {
        flushList();
        listBuf = { kind: "bullet", items: [], ordered: true, start: Number(om[1]) };
      }
      listBuf.items.push(om[2]!);
      continue;
    }

    flushList();
    para.push(line);
  }

  if (inCode && codeBuf.length) {
    out.push({ kind: "code", lang: codeLang, text: codeBuf.join("\n") });
  }
  flushPara();
  flushList();
  return out;
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading":
      return (
        <Text bold color="cyan">
          <InlineMd text={block.text} />
        </Text>
      );
    case "paragraph":
      return <InlineMd text={block.text} />;
    case "bullet":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={`${i}-${item.slice(0, 24)}`}>
              <Text color="cyan">{block.ordered ? ` ${block.start + i}. ` : "  • "}</Text>
              <InlineMd text={item} />
            </Box>
          ))}
        </Box>
      );
    case "code":
      return (
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="yellow">{block.text}</Text>
        </Box>
      );
    case "edit-block":
      return <EditBlockRow block={block} />;
    case "table":
      return <TableBlockRow block={block} />;
    case "hr":
      return <Text dimColor>{"────────────────────────"}</Text>;
  }
}

/**
 * Split one table row into trimmed cells. Leading/trailing pipes are
 * optional (both `| a | b |` and `a | b` are accepted). Pipes escaped
 * as `\|` stay in the cell content.
 */
function splitTableRow(line: string): string[] {
  // Temporarily replace escaped pipes so split() doesn't fire on them.
  const SENTINEL = "\u0000";
  const masked = line.replace(/\\\|/g, SENTINEL);
  const trimmed = masked.trim().replace(/^\||\|$/g, "");
  return trimmed.split("|").map((c) => c.trim().replace(new RegExp(SENTINEL, "g"), "|"));
}

/**
 * Render a GFM table as an aligned grid. Column widths are the max
 * display length in that column, capped at 40 chars so one huge cell
 * doesn't wreck the layout. Header row is bold + cyan; body rows use
 * the default text color. Separator is a dim row of dashes.
 */
function TableBlockRow({ block }: { block: TableBlock }) {
  const colCount = Math.max(block.header.length, ...block.rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const cellLengths = [displayWidth(block.header[c] ?? "")];
    for (const r of block.rows) cellLengths.push(displayWidth(r[c] ?? ""));
    widths.push(Math.min(40, Math.max(3, ...cellLengths)));
  }
  const pad = (s: string, w: number) => {
    const dw = displayWidth(s);
    if (dw >= w) return s;
    return s + " ".repeat(w - dw);
  };
  const separator = widths.map((w) => "─".repeat(w)).join("─┼─");
  return (
    <Box flexDirection="column">
      <Box>
        {block.header.map((cell, ci) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: table columns never reorder — derived from a static header array
          <Text key={`h-${ci}`} bold color="cyan">
            {pad(cell, widths[ci] ?? 3)}
            {ci < colCount - 1 ? " │ " : ""}
          </Text>
        ))}
      </Box>
      <Text dimColor>{separator}</Text>
      {block.rows.map((row, ri) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: table rows render in source order and don't reorder
        <Box key={`r-${ri}`}>
          {Array.from({ length: colCount }).map((_, ci) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: same — column axis is fixed by the table shape
            <Text key={`c-${ri}-${ci}`}>
              {pad(row[ci] ?? "", widths[ci] ?? 3)}
              {ci < colCount - 1 ? " │ " : ""}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

/**
 * Terminal display width of a string, approximately. CJK characters
 * and full-width punctuation take 2 columns; everything else is 1.
 * Good enough for aligning table cells in a Chinese-or-English mix;
 * real wcwidth is bigger than we need to drag in for this use case.
 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK unified ideographs, full-width forms, hiragana/katakana,
    // Hangul syllables — rough bucket, close enough for the terminal.
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * SEARCH/REPLACE rendered as a minimal diff: filename on top, red
 * `-` lines, a gutter, green `+` lines. No inner markdown / inline
 * parsing — content is shown verbatim so JSDoc `/**` and `*` won't
 * be eaten by bold/italic regex.
 *
 * A truly empty SEARCH means "new file" and we label the filename
 * accordingly instead of rendering an empty red half.
 */
function EditBlockRow({ block }: { block: EditBlockView }) {
  const isNewFile = block.search.length === 0;
  const searchLines = block.search.split("\n");
  const replaceLines = block.replace.split("\n");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text bold color="cyan">
          {block.filename}
        </Text>
        {isNewFile ? (
          <Text color="green" bold>
            {" (new file)"}
          </Text>
        ) : null}
      </Box>
      {isNewFile ? null : (
        <Box flexDirection="column" marginTop={1}>
          {searchLines.map((line, i) => (
            <Text key={`s-${i}-${line.length}`} color="red">
              {`- ${line}`}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={isNewFile ? 1 : 0}>
        {replaceLines.map((line, i) => (
          <Text key={`r-${i}-${line.length}`} color="green">
            {`+ ${line}`}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function Markdown({ text }: { text: string }) {
  const cleaned = stripMath(text);
  const blocks = React.useMemo(() => parseBlocks(cleaned), [cleaned]);
  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((b, i) => (
        <BlockView key={`${i}-${b.kind}`} block={b} />
      ))}
    </Box>
  );
}
