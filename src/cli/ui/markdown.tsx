/**
 * Minimal Markdown → Ink renderer for chat output.
 *
 * Handles the subset that actually shows up in LLM answers:
 *   - ATX headers (# ##)
 *   - Unordered / ordered lists
 *   - Task lists (- [ ] / - [x])
 *   - Blockquotes (> …) — rendered with a left bar; nested / list-in-quote OK
 *   - Fenced code blocks (```lang) — diagram langs get a distinct frame
 *   - Inline **bold**, *italic*, `code`, ~~strikethrough~~
 *   - GFM emoji shortcodes (:smile: :heart: :+1: …) — curated set
 *   - Paragraphs separated by blank lines
 *   - LaTeX delimiters stripped (\( \), \[ \], \boxed{X}); $…$ / $$…$$ too
 *
 * The goal is not TeX-perfect math — it's "stop showing raw backslashes to
 * the user." When the model insists on LaTeX, we strip the scaffolding and
 * show the expression verbatim; terminals don't do math fonts anyway.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
      // Dollar-delimited math (KaTeX / MathJax convention). Block
      // `$$…$$` is unambiguous — strip the delimiters, wrap content
      // in double newlines so parseBlocks surfaces it as its own
      // paragraph instead of folding it into adjacent prose. Must
      // run BEFORE inline `$…$` so the block regex gets first crack.
      .replace(/\$\$([\s\S]+?)\$\$/g, (_m, c: string) => `\n\n${c.trim()}\n\n`)
      // Inline `$…$` is only stripped when a non-space char sits
      // immediately inside EACH dollar. That rules out:
      //   - prices: `$5 per unit` (no closing $)
      //   - `$5 and $10`           (content ends/starts with space)
      //   - `echo $HOME`           (no closing $)
      //   - `$ prompt`             (space after open $)
      // The lookbehind/lookahead on `$` also keeps us from eating
      // half of a `$$…$$` pair that the block regex somehow missed.
      .replace(/(?<!\$)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g, "$1")
      // LaTeX delimiters
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
      // Use `(?![a-zA-Z])` instead of `\b` because LaTeX commands
      // often abut subscript/superscript markers: `\sum_{i=1}^n`,
      // `\int_0^1`, etc. `\b` only fires between a word char and a
      // non-word char, but `_` IS a word char, so `\b` silently
      // refuses to match. The catch-all `\\[a-zA-Z]+` at the bottom
      // would then eat `\sum` to empty — losing the Σ entirely.
      // Lookahead-for-non-letter is the right fence: end of command.
      .replace(/\\in(?![a-zA-Z])/g, "∈")
      .replace(/\\notin(?![a-zA-Z])/g, "∉")
      .replace(/\\infty/g, "∞")
      .replace(/\\sum(?![a-zA-Z])/g, "Σ")
      .replace(/\\prod(?![a-zA-Z])/g, "Π")
      .replace(/\\int(?![a-zA-Z])/g, "∫")
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
      .replace(/\\implies(?![a-zA-Z])/g, "⇒")
      .replace(/\\iff(?![a-zA-Z])/g, "⇔")
      .replace(/\\to(?![a-zA-Z])/g, "→")
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
      // Pandoc-style inline super/subscripts — `x^2^` for superscript,
      // `H~2~O` for subscript. Handled HERE (not in INLINE_RE) because
      // the only useful rendering for a terminal is Unicode
      // super/subscript characters, which live in the same transform
      // pipeline as the LaTeX ^/_ rules below.
      //
      // Policy: only convert when EVERY character inside the markers
      // maps to a Unicode super/subscript glyph. `^2^` → `²` (good),
      // but `^foo^` can't be truly superscripted, so we leave the
      // whole thing literal rather than dropping the markers and
      // losing the model's intent. Guards on `~` use lookaround so
      // the subscript rule never fires inside a `~~strikethrough~~`.
      .replace(/\^([A-Za-z0-9+\-]+)\^/g, (m, g: string) => {
        for (const c of g) if (SUPERSCRIPT[c] === undefined) return m;
        return toSuperscript(g);
      })
      .replace(/(?<!~)~(?!~)([A-Za-z0-9+\-]+)~(?!~)/g, (m, g: string) => {
        for (const c of g) if (SUBSCRIPT[c] === undefined) return m;
        return toSubscript(g);
      })
      // LaTeX super/subscripts — single token or {braced group of [\w+-]}
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

/**
 * GFM emoji shortcode table. Curated ~70 entries covering what LLMs
 * actually emit in chat — faces, hearts, gestures, common signals
 * (✅ ❌ ⚠️), tech / productivity glyphs, a handful of weather and
 * objects. We deliberately skip flags (region codes, rarely used)
 * and the long tail.
 *
 * Unknown shortcodes pass through as literal `:name:` — safer than
 * guessing, and prevents false positives like `file.ts:10:` or a
 * `:classname:` in code from turning into garbage.
 */
const EMOJI_MAP: Record<string, string> = {
  // faces
  smile: "😄",
  smiley: "😃",
  grin: "😁",
  grinning: "😀",
  joy: "😂",
  laughing: "😆",
  heart_eyes: "😍",
  blush: "😊",
  sunglasses: "😎",
  thinking: "🤔",
  neutral_face: "😐",
  confused: "😕",
  cry: "😢",
  sob: "😭",
  rage: "😡",
  angry: "😠",
  scream: "😱",
  wink: "😉",
  kissing_heart: "😘",
  // hearts
  heart: "❤️",
  orange_heart: "🧡",
  yellow_heart: "💛",
  green_heart: "💚",
  blue_heart: "💙",
  purple_heart: "💜",
  black_heart: "🖤",
  white_heart: "🤍",
  broken_heart: "💔",
  sparkling_heart: "💖",
  two_hearts: "💕",
  // gestures
  "+1": "👍",
  "-1": "👎",
  thumbsup: "👍",
  thumbsdown: "👎",
  wave: "👋",
  clap: "👏",
  muscle: "💪",
  ok_hand: "👌",
  pray: "🙏",
  fist: "✊",
  point_up: "☝️",
  raised_hands: "🙌",
  handshake: "🤝",
  // symbols / signals
  rocket: "🚀",
  fire: "🔥",
  star: "⭐",
  star2: "🌟",
  sparkles: "✨",
  boom: "💥",
  zap: "⚡",
  tada: "🎉",
  bulb: "💡",
  warning: "⚠️",
  x: "❌",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  ballot_box_with_check: "☑️",
  no_entry: "⛔",
  question: "❓",
  exclamation: "❗",
  bangbang: "‼️",
  bell: "🔔",
  mute: "🔕",
  hundred: "💯",
  "100": "💯",
  eyes: "👀",
  // tech / productivity
  computer: "💻",
  iphone: "📱",
  hammer: "🔨",
  wrench: "🔧",
  gear: "⚙️",
  package: "📦",
  floppy_disk: "💾",
  key: "🔑",
  lock: "🔒",
  unlock: "🔓",
  mag: "🔍",
  memo: "📝",
  pencil: "✏️",
  bookmark: "🔖",
  // charts / time
  chart_with_upwards_trend: "📈",
  chart_with_downwards_trend: "📉",
  bar_chart: "📊",
  hourglass: "⏳",
  calendar: "📅",
  // misc
  robot: "🤖",
  ghost: "👻",
  bug: "🐛",
  coffee: "☕",
  beer: "🍺",
  sun: "☀️",
  cloud: "☁️",
  rainbow: "🌈",
  speech_balloon: "💬",
  thought_balloon: "💭",
  construction: "🚧",
};

/**
 * GFM autolinks — bare `<url>` / `<email>` shorthand. Rewrite to the
 * full `[url](url)` form so the existing link-rendering path applies
 * (blue + underline for external, URL validated for local). Only
 * unambiguous URL schemes are expanded: http(s) / ftp / mailto.
 * Anything else stays as literal `<foo>` text — some prose has
 * angle-bracketed phrases that aren't URLs.
 */
export function expandAutolinks(s: string): string {
  return s.replace(/<((?:https?|ftp|mailto):[^\s<>]+)>/g, "[$1]($1)");
}

/**
 * Expand `:name:` GFM emoji shortcodes via {@link EMOJI_MAP}. The
 * regex matches broadly (letters / digits / `+` / `_` / `-`) so
 * `:+1:` works, but the ultimate gate is the map lookup — unknown
 * names stay literal. That's what keeps `file.ts:10:` and
 * `:classname:` from being mangled.
 */
export function expandEmoji(s: string): string {
  // Character class covers the whole GFM shortcode alphabet
  // (letters, digits, `_`, `+`, `-`). The leading `-` slot is
  // needed so `:-1:` resolves; putting it at the end of the class
  // keeps it literal. The map lookup is the true gate — unknown
  // names pass through untouched, so false-positive regex matches
  // in prose / code don't corrupt the text.
  return s.replace(/:([a-z0-9_+-]+):/gi, (m, name: string) => {
    return EMOJI_MAP[name.toLowerCase()] ?? m;
  });
}

/**
 * Citation links: `[text](url)` where url either points outside the repo
 * (rendered as a plain external link) or resolves to a file/line in the
 * project (rendered as a validated citation — broken citations turn
 * red so the user can spot model hallucinations at a glance). The point
 * is: the model is encouraged to ground every codebase claim in a
 * link, and Reasonix surfaces broken links instead of silently letting
 * fabrications past.
 */
export type CitationStatus = { ok: true } | { ok: false; reason: string };
export type CitationMap = Map<string, CitationStatus>;

interface CitationParts {
  path: string;
  startLine?: number;
  endLine?: number;
}

export function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith("mailto:") || url.startsWith("//");
}

export function parseCitationUrl(url: string): CitationParts | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // GitHub-style anchor: foo.ts#L42 or foo.ts#L42-L58
  let m = trimmed.match(/^(.+?)#L(\d+)(?:-L?(\d+))?$/);
  if (m) {
    return {
      path: m[1] ?? "",
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : undefined,
    };
  }
  // Colon-style: foo.ts:42 or foo.ts:42-58
  m = trimmed.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (m) {
    return {
      path: m[1] ?? "",
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : undefined,
    };
  }
  return { path: trimmed };
}

export function validateCitation(url: string, projectRoot: string): CitationStatus {
  const parts = parseCitationUrl(url);
  if (!parts || !parts.path) return { ok: false, reason: "empty path" };
  // Strip a leading `/` or `\\`. Models habitually write `/foo.ts`
  // meaning "project-root relative" — Aider / Claude-Code convention —
  // rather than POSIX root-absolute. A literal absolute path is still
  // reachable as `C:\foo` on Windows or once the strip drops the slash
  // and Node's `isAbsolute` correctly rejects what's left. Real unix
  // absolute references like `/etc/hosts` in a code citation are vanishingly
  // rare — if anyone needs one we can revisit.
  const normalized = parts.path.replace(/^[/\\]+/, "");
  const fullPath = isAbsolute(normalized) ? normalized : join(projectRoot, normalized);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(fullPath);
  } catch {
    return { ok: false, reason: "file not found" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not a file" };
  if (parts.startLine === undefined) return { ok: true };
  let lineCount: number;
  try {
    lineCount = readFileSync(fullPath, "utf8").split("\n").length;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (parts.startLine < 1 || parts.startLine > lineCount) {
    return { ok: false, reason: `line ${parts.startLine} > ${lineCount}` };
  }
  if (parts.endLine !== undefined) {
    if (parts.endLine < parts.startLine || parts.endLine > lineCount) {
      return { ok: false, reason: `range end ${parts.endLine} invalid` };
    }
  }
  return { ok: true };
}

/**
 * Heuristic: should this link URL be treated as a repo-file citation
 * (and thus validated / marked red-strikethrough if missing)? The
 * point is to STOP flagging things that obviously aren't paths —
 * otherwise users see a red "broken citations" box for content the
 * model wrote legitimately:
 *   - `#anchor` — in-page anchor jump (not a file ref)
 *   - `url` / `path` — placeholder words in demo text
 *   - `/` — bare root
 * Rule: must contain a path separator, a dot, OR a `#` with a non-
 * bare-anchor prefix. Those are the shapes real file references use.
 */
export function shouldValidateAsCitation(url: string): boolean {
  // Anchor-only: `#foo` / `#` — page-local, not a file
  if (url.startsWith("#")) return false;
  // Bare root placeholders
  if (url === "/" || url === "\\" || url === "") return false;
  // Must look like a path: contains `/`, `\`, or `.` somewhere
  if (!/[/\\.]/.test(url)) return false;
  return true;
}

/**
 * Pre-scan rendered text for every `[text](url)` link, validate the
 * citation-shaped ones, and cache the result. Done once per Markdown
 * mount so InlineMd doesn't re-stat the filesystem on every keystroke
 * during streaming. External links short-circuit (no fs work);
 * non-citation-shaped URLs are skipped entirely (left as default
 * cyan-underline link rendering) so placeholders in demo prose don't
 * clutter the broken-citation summary with false positives.
 */
export function collectCitations(text: string, projectRoot: string): CitationMap {
  const map: CitationMap = new Map();
  const re = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  for (const m of text.matchAll(re)) {
    const url = m[2] ?? "";
    if (!url || isExternalUrl(url)) continue;
    if (!shouldValidateAsCitation(url)) continue;
    if (map.has(url)) continue;
    map.set(url, validateCitation(url, projectRoot));
  }
  return map;
}

/**
 * Split a single line into styled segments for bold / italic / inline
 * code / links.
 *
 * Link group is FIRST so `[text](url)` with markup-looking URL chars
 * doesn't get partially eaten by the bold/code branches.
 *
 * Triple-backtick (```…```) runs are matched BEFORE the single-backtick
 * case so a one-line code span like `​``bash echo hi``​` is captured
 * whole instead of the single-backtick regex greedily eating the
 * middle and leaving two stray backticks on each side (what 0.4.15
 * users saw when the model emitted `​``bash …``​` on the same line as
 * prose). Content may contain single backticks but not newlines —
 * multi-line fenced code is a block-level concern handled in
 * `parseBlocks`.
 */
const INLINE_RE =
  /(\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|```([^\n]+?)```|`([^`\n]+?)`|~~([^~\n]+?)~~|(?<![*\w])\*([^*\n]+?)\*(?!\w)|\\([*_~`[\](){}#+\-.!\\]))/g;

function InlineMd({
  text,
  padTo,
  citations,
}: {
  text: string;
  padTo?: number;
  citations?: CitationMap;
}) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let idx = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    if (start > last) {
      parts.push(<Text key={`t${idx++}`}>{text.slice(last, start)}</Text>);
    }
    // Groups, in the order they appear in INLINE_RE:
    //   m[2] = link text          m[3] = link url
    //   m[4] = bold-italic content (inside *** ***)
    //   m[5] = bold content (inside ** **)
    //   m[6] = triple-backtick content (strip leading lang tag)
    //   m[7] = single-backtick inline code
    //   m[8] = strikethrough content (inside ~~ ~~)
    //   m[9] = italic content (inside * *)
    //   m[10] = backslash-escaped char (emit as literal)
    if (m[2] !== undefined && m[3] !== undefined) {
      const linkText = m[2];
      const url = m[3];
      if (isExternalUrl(url)) {
        parts.push(
          <Text key={`l${idx++}`} color="blue" underline>
            {linkText}
          </Text>,
        );
      } else {
        const status = citations?.get(url);
        if (status && !status.ok) {
          parts.push(
            <Text key={`l${idx++}`} color="red" strikethrough>
              {`${linkText} ✗`}
            </Text>,
          );
        } else {
          parts.push(
            <Text key={`l${idx++}`} color="cyan" underline>
              {linkText}
            </Text>,
          );
        }
      }
    } else if (m[4] !== undefined) {
      parts.push(
        <Text key={`bi${idx++}`} bold italic>
          {m[4]}
        </Text>,
      );
    } else if (m[5] !== undefined) {
      parts.push(
        <Text key={`b${idx++}`} bold>
          {m[5]}
        </Text>,
      );
    } else if (m[6] !== undefined) {
      // One-line fenced span: ```bash echo hi``` → drop the "bash "
      // language tag so the user doesn't see it rendered in code color.
      const stripped = m[6].replace(/^(\w+)\s+/, "");
      parts.push(
        <Text key={`c${idx++}`} color="yellow">
          {stripped}
        </Text>,
      );
    } else if (m[7] !== undefined) {
      parts.push(
        <Text key={`c${idx++}`} color="yellow">
          {m[7]}
        </Text>,
      );
    } else if (m[8] !== undefined) {
      parts.push(
        <Text key={`s${idx++}`} strikethrough dimColor>
          {m[8]}
        </Text>,
      );
    } else if (m[9] !== undefined) {
      parts.push(
        <Text key={`i${idx++}`} italic>
          {m[9]}
        </Text>,
      );
    } else if (m[10] !== undefined) {
      // Backslash escape — emit the escaped char as a plain Text node
      // so the subsequent pass of the regex engine doesn't re-interpret
      // the `*` / `` ` `` / `~` as markup. The `\` is dropped; only the
      // escaped char survives.
      parts.push(<Text key={`esc${idx++}`}>{m[10]}</Text>);
    }
    last = start + m[0].length;
  }
  if (last < text.length) {
    parts.push(<Text key={`t${idx++}`}>{text.slice(last)}</Text>);
  }
  // Trailing pad — used by table cells so column widths line up after
  // the inline markup is rendered (markup chars like `**` and `` ` ``
  // are invisible in output, so naive `pad(rawText, width)` over-pads
  // styled cells and the columns drift out of alignment).
  if (padTo !== undefined) {
    const seen = visibleWidth(text);
    if (seen < padTo) {
      parts.push(<Text key={`pad${idx++}`}>{" ".repeat(padTo - seen)}</Text>);
    }
  }
  return <Text>{parts}</Text>;
}

/**
 * Strip inline markdown markers (**, _, single + triple backtick) so the
 * remaining text reflects what the user actually SEES on screen. Used
 * to compute correct column widths for table cells where the raw cell
 * length includes invisible markup chars.
 */
export function stripInlineMarkup(s: string): string {
  // Single-pass strip using INLINE_RE so alternation precedence exactly
  // matches the runtime renderer. The prior implementation chained
  // sequential .replace() calls, which broke backslash escapes — the
  // inline-code regex would eat `\`code\`` as a `code\`` span before
  // the escape pass got a chance to neutralize each `\``.
  return s.replace(
    INLINE_RE,
    (
      match: string,
      _alt: string,
      linkText: string | undefined,
      _url: string | undefined,
      boldItalic: string | undefined,
      bold: string | undefined,
      code3: string | undefined,
      code1: string | undefined,
      strike: string | undefined,
      italic: string | undefined,
      escapeChar: string | undefined,
    ) => {
      if (linkText !== undefined) return linkText;
      if (boldItalic !== undefined) return boldItalic;
      if (bold !== undefined) return bold;
      if (code3 !== undefined) return code3.replace(/^(\w+)\s+/, "");
      if (code1 !== undefined) return code1;
      if (strike !== undefined) return strike;
      if (italic !== undefined) return italic;
      if (escapeChar !== undefined) return escapeChar;
      return match;
    },
  );
}

/**
 * Display width AFTER stripping inline markup. The visible-on-screen
 * column width — what padding decisions should be based on.
 */
export function visibleWidth(s: string): number {
  return displayWidth(stripInlineMarkup(s));
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
/**
 * One bullet-list item. `task` marks GFM task-list entries:
 *   - `- [ ] do the thing` → `{ text: "do the thing", task: "todo" }`
 *   - `- [x] shipped`      → `{ text: "shipped",      task: "done" }`
 * Regular bullets leave `task` undefined.
 */
export interface BulletItem {
  text: string;
  task?: "done" | "todo";
}
interface BulletBlock {
  kind: "bullet";
  items: BulletItem[];
  ordered: boolean;
  start: number;
}
interface BlockquoteBlock {
  kind: "quote";
  /**
   * Parsed child blocks. After stripping one `>` prefix from each
   * gathered line, the remainder is re-fed through `parseBlocks` so
   * block-level constructs inside the quote (nested `>>` quotes,
   * lists, code fences, tables, …) render with their normal
   * formatting instead of as flattened text. Nesting depth is
   * whatever the markdown source expresses — the recursion closes
   * naturally when no line starts with `>` at its current level.
   */
  children: Block[];
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
  | BlockquoteBlock
  | CodeBlock
  | HrBlock
  | EditBlockView
  | TableBlock;

export function parseBlocks(raw: string): Block[] {
  const lines = raw.split(/\r?\n/);
  const out: Block[] = [];
  // Each entry is one source line inside the current paragraph plus
  // the hard-break flag that applies AFTER it. Hard break = trailing
  // `  ` (two+ spaces before newline) per GFM. The flag decides
  // whether this line's content joins to the next with `\n` (hard,
  // preserves visual newline) or ` ` (soft, default paragraph reflow).
  let para: Array<{ text: string; hardBreak: boolean }> = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listBuf: BulletBlock | null = null;

  // Fence length of the currently-open code block so a block opened
  // with ````` closes only on `````, matching GFM. Empty when we're
  // not in code mode.
  let codeFence = "";

  const flushPara = () => {
    if (para.length === 0) return;
    let joined = "";
    for (let k = 0; k < para.length; k++) {
      joined += para[k]!.text;
      if (k < para.length - 1) {
        joined += para[k]!.hardBreak ? "\n" : " ";
      }
    }
    out.push({ kind: "paragraph", text: joined });
    para = [];
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
      const filename = para.pop()?.text.trim();
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
        para.push({ text: filename, hardBreak: false });
      }
    }

    // Fenced code block (GFM). The fence is 3+ backticks, may have up
    // to 3 leading spaces, and carries an optional language tag. A
    // closing fence must be the SAME backtick run length or longer.
    //
    // Two paths:
    //   a) Fence on its own line → multi-line block, accumulate until
    //      a matching close fence.
    //   b) Fence opens AND closes on the same line (e.g.
    //      `​``bash echo hi``​`) → emit as a one-line code block so
    //      the inline parser doesn't half-eat the backticks.
    if (!inCode) {
      const open = line.match(/^ {0,3}(`{3,})(\w*)\s*(.*)$/);
      if (open) {
        const fence = open[1]!;
        const lang = open[2] ?? "";
        const rest = open[3] ?? "";
        const closeOnSame = rest.match(new RegExp(`^(.*?)${fence}\\s*$`));
        if (closeOnSame) {
          flushPara();
          flushList();
          out.push({ kind: "code", lang, text: (closeOnSame[1] ?? "").trim() });
          continue;
        }
        flushPara();
        flushList();
        inCode = true;
        codeLang = lang;
        codeFence = fence;
        // Anything after the opening fence on the SAME line is
        // still body content (rare but legal).
        if (rest.length > 0) codeBuf.push(rest);
        continue;
      }
    } else {
      // In code mode — check for closing fence. Same indent rules as
      // opening, and the backtick run must be at least as long.
      const close = line.match(/^ {0,3}(`{3,})\s*$/);
      if (close && close[1]!.length >= codeFence.length) {
        out.push({ kind: "code", lang: codeLang, text: codeBuf.join("\n") });
        codeBuf = [];
        codeLang = "";
        codeFence = "";
        inCode = false;
        continue;
      }
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

    // Box-drawing frame detection: top edge `┌────┐`, body lines that
    // each begin and end with `│`, bottom edge `└────┘`. Models love to
    // draw decorative frames around code snippets and flow charts using
    // these characters; without this branch, every body line gets
    // word-wrapped by Ink and the frame turns into garbage. Rendering
    // the inner content as a code block preserves the fixed-width
    // layout the model intended AND gives it a real border via the
    // existing code-block renderer. Only triggers OUTSIDE code mode
    // (where `inCode` is false) so a literal box-drawing character
    // inside a real fenced block isn't grabbed.
    if (/^\s*┌─+┐\s*$/.test(line)) {
      let j = i + 1;
      const bodyLines: string[] = [];
      while (j < lines.length && !/^\s*└─+┘\s*$/.test(lines[j]!)) {
        const inner = lines[j]!;
        // Strip outer `│ ... │` so the content reads naturally.
        const m = inner.match(/^\s*│\s?(.*?)\s?│\s*$/);
        bodyLines.push(m ? (m[1] ?? "") : inner);
        j++;
      }
      if (j < lines.length) {
        flushPara();
        flushList();
        out.push({ kind: "code", lang: "", text: bodyLines.join("\n") });
        i = j;
        continue;
      }
      // No closing edge — fall through and let the line render as
      // paragraph rather than eating to EOF.
    }

    // Table detection: a line with at least one column separator where
    // the NEXT line looks like a separator row. Two flavors accepted:
    //
    //   - Standard GFM: `|` columns + `---` / `:---:` separators.
    //   - Unicode box-drawing: `│` columns (U+2502) + `─` / `┼` (U+2500
    //     / U+253C) separators. Models trained on Chinese text routinely
    //     pick the box-drawing characters even when GFM was an option;
    //     accepting both keeps their output legible without forcing a
    //     re-prompt. `splitTableRow` normalizes `│` → `|` so the rest of
    //     the path stays uniform.
    //
    // Both the header row and the separator must be present — a bare
    // pipe in prose shouldn't trigger the table path.
    if (line.includes("|") || line.includes("│")) {
      const next = (lines[i + 1] ?? "").trim();
      const isGfmSep = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(next);
      const isBoxSep = /^[│─┼┬┴┌┐└┘├┤\s]+$/.test(next) && /─{2,}/.test(next);
      if (isGfmSep || isBoxSep) {
        flushPara();
        flushList();
        const header = splitTableRow(line);
        const colCount = header.length;
        const rows: string[][] = [];
        let j = i + 2; // skip header + separator
        while (j < lines.length) {
          const r = lines[j]!.replace(/\s+$/g, "");
          if (r.trim() === "") break;
          if (!r.includes("|") && !r.includes("│")) {
            // Continuation row: model wrapped a long cell across lines
            // without re-emitting the column separator. Fold this line
            // back into the LAST cell of the previous row so its inline
            // markup (backticks, bold) parses as one piece instead of
            // bleeding into the paragraph stream below the table.
            const prev = rows[rows.length - 1];
            if (prev && prev.length === colCount) {
              const lastIdx = prev.length - 1;
              prev[lastIdx] = `${prev[lastIdx] ?? ""} ${r.trim()}`;
              j++;
              continue;
            }
            break;
          }
          rows.push(splitTableRow(r));
          j++;
        }
        out.push({ kind: "table", header, rows });
        i = j - 1;
        continue;
      }
    }

    // Blockquote: consecutive `>` lines gather into one quote block.
    // We strip exactly one level of `>` prefix, then recursively run
    // the inner text through `parseBlocks`. That gets us:
    //   - Nested `>>` rendering as a quote-in-a-quote (inner `>` is
    //     still present after the outer strip, so the recursion fires).
    //   - Lists, code fences, tables inside a quote — all keep their
    //     normal formatting because parseBlocks handles them again.
    //   - Blank-`>` lines become paragraph breaks inside the quote.
    //
    // We don't implement GFM "lazy continuation" (a line without `>`
    // after a non-empty quote line is still part of the quote) — LLMs
    // reliably re-emit `>` on each line, and enforcing the explicit
    // prefix avoids accidentally swallowing the paragraph that
    // follows a quote.
    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushPara();
      flushList();
      const innerLines: string[] = [quoteMatch[1] ?? ""];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j]!.replace(/\s+$/g, "");
        const m = nxt.match(/^\s*>\s?(.*)$/);
        if (!m) break;
        innerLines.push(m[1] ?? "");
        j++;
      }
      out.push({ kind: "quote", children: parseBlocks(innerLines.join("\n")) });
      i = j - 1;
      continue;
    }

    const bm = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bm) {
      flushPara();
      if (!listBuf || listBuf.ordered) {
        flushList();
        listBuf = { kind: "bullet", items: [], ordered: false, start: 1 };
      }
      listBuf.items.push(parseBulletItem(bm[1]!));
      continue;
    }

    const om = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (om) {
      flushPara();
      if (!listBuf || !listBuf.ordered) {
        flushList();
        listBuf = { kind: "bullet", items: [], ordered: true, start: Number(om[1]) };
      }
      listBuf.items.push(parseBulletItem(om[2]!));
      continue;
    }

    flushList();
    // Hard line break: trailing `  ` (two or more spaces) on the raw
    // line before whitespace was stripped. Per GFM, this forces a
    // visible newline inside a paragraph (where soft-wrapped lines
    // normally join with a space). We stash the flag on THIS line
    // so flushPara knows whether to emit `\n` or ` ` AFTER it.
    const hardBreak = / {2,}\r?$/.test(rawLine);
    para.push({ text: line, hardBreak });
  }

  if (inCode && codeBuf.length) {
    out.push({ kind: "code", lang: codeLang, text: codeBuf.join("\n") });
  }
  flushPara();
  flushList();
  return out;
}

/**
 * GFM task-list prefix sniff: `[ ] …` / `[x] …` / `[X] …` at the start
 * of a bullet item's text becomes a task entry; anything else stays a
 * plain item. The bracket form without a trailing space (e.g. `[x]end`)
 * isn't standard and rarely appears — we require the space to avoid
 * false positives on array-index-style prose like `[1] see ref`.
 */
function parseBulletItem(raw: string): BulletItem {
  const m = raw.match(/^\[([ xX])\]\s+(.*)$/);
  if (!m) return { text: raw };
  const done = m[1]!.toLowerCase() === "x";
  return { text: m[2] ?? "", task: done ? "done" : "todo" };
}

function BlockView({ block, citations }: { block: Block; citations?: CitationMap }) {
  switch (block.kind) {
    case "heading":
      return <HeadingView level={block.level} text={block.text} citations={citations} />;
    case "paragraph":
      return <ParagraphView text={block.text} citations={citations} />;
    case "bullet":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={`${i}-${item.text.slice(0, 24)}`}>
              <Text color={item.task === "done" ? "green" : "cyan"}>
                {bulletPrefix(block, i, item)}
              </Text>
              {item.task === "done" ? (
                <Text strikethrough dimColor>
                  <InlineMd text={item.text} citations={citations} />
                </Text>
              ) : (
                <InlineMd text={item.text} citations={citations} />
              )}
            </Box>
          ))}
        </Box>
      );
    case "quote":
      return <BlockquoteView block={block} citations={citations} />;
    case "code":
      if (DIAGRAM_LANGS.has(block.lang.toLowerCase())) {
        return <DiagramCodeBlock lang={block.lang} text={block.text} />;
      }
      return <CodeBlockView lang={block.lang} text={block.text} />;
    case "edit-block":
      return <EditBlockRow block={block} />;
    case "table":
      return <TableBlockRow block={block} citations={citations} />;
    case "hr":
      return <Text dimColor>{"────────────────────────"}</Text>;
  }
}

/**
 * Paragraph renderer. Plain text goes straight to InlineMd. If the
 * paragraph carries embedded `\n` (inserted by parseBlocks when it
 * sees a GFM hard break — trailing `  ` on a source line), split
 * and render each segment as its own row so the newline is visible
 * in the terminal. Single-line paragraphs still render as one row
 * for tight layout.
 */
function ParagraphView({ text, citations }: { text: string; citations?: CitationMap }) {
  if (!text.includes("\n")) {
    return <InlineMd text={text} citations={citations} />;
  }
  const rows = text.split("\n");
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hard-break rows are source-ordered and never reorder
        <InlineMd key={`ln-${i}`} text={row} citations={citations} />
      ))}
    </Box>
  );
}

/**
 * Pick the gutter glyph for a bullet-list item:
 *   - ordered     → ` N. `
 *   - task done   → ` ☒ `  (green + struck-through in the caller)
 *   - task todo   → ` ☐ `
 *   - plain       → `  • `
 * Width is stable within a list so text after the prefix stays aligned.
 */
function bulletPrefix(block: BulletBlock, i: number, item: BulletItem): string {
  if (block.ordered) return ` ${block.start + i}. `;
  if (item.task === "done") return " ☒ ";
  if (item.task === "todo") return " ☐ ";
  return "  • ";
}

/**
 * Blockquote renderer: left-bar frame (`borderLeft` only, dim) that
 * wraps any child block content. The bar grows with the rendered
 * height automatically — no manual per-line prefix — so a quote
 * containing a list, a code block, or another quote still looks
 * right regardless of how many rows each child consumes.
 *
 * Nested `>>` quotes surface as a BlockquoteView inside another
 * BlockquoteView, producing two adjacent bars (visually nested).
 * Inner blocks keep their normal colors (code yellow, bullet cyan,
 * etc.) — we dim only the bar, not the content, so a code snippet
 * inside a quote still reads as code.
 */
function BlockquoteView({
  block,
  citations,
}: {
  block: BlockquoteBlock;
  citations?: CitationMap;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      borderDimColor
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      flexDirection="column"
      gap={1}
    >
      {block.children.map((child, i) => (
        <BlockView key={`q-${i}-${child.kind}`} block={child} citations={citations} />
      ))}
    </Box>
  );
}

/**
 * Split one table row into trimmed cells. Leading/trailing column
 * markers are optional (both `| a | b |` and `a | b` are accepted).
 * Pipes escaped as `\|` stay in the cell content. Unicode `│`
 * (U+2502 BOX DRAWINGS LIGHT VERTICAL) is normalized to `|` first so
 * box-drawing tables and GFM tables share one code path.
 */
function splitTableRow(line: string): string[] {
  // Temporarily replace escaped pipes so split() doesn't fire on them.
  const SENTINEL = "\u0000";
  const masked = line.replace(/\\\|/g, SENTINEL).replace(/│/g, "|");
  const trimmed = masked.trim().replace(/^\||\|$/g, "");
  return trimmed.split("|").map((c) => c.trim().replace(new RegExp(SENTINEL, "g"), "|"));
}

/**
 * Render a GFM table as an aligned grid. Column widths are the max
 * display length in that column, capped at 40 chars so one huge cell
 * doesn't wreck the layout. Header row is bold + cyan; body rows use
 * the default text color. Separator is a dim row of dashes.
 */
function TableBlockRow({ block, citations }: { block: TableBlock; citations?: CitationMap }) {
  const colCount = Math.max(block.header.length, ...block.rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    // Use VISIBLE width (post-markup-strip) for column sizing —
    // otherwise a cell like `**定义** \`dispatch\` 方法` would be
    // measured with the ** and ` chars included, over-padding once
    // the markers vanish at render time and shoving subsequent
    // columns rightward.
    const cellLengths = [visibleWidth(block.header[c] ?? "")];
    for (const r of block.rows) cellLengths.push(visibleWidth(r[c] ?? ""));
    widths.push(Math.min(40, Math.max(3, ...cellLengths)));
  }
  const separator = widths.map((w) => "─".repeat(w)).join("─┼─");
  return (
    <Box flexDirection="column">
      <Box>
        {block.header.map((cell, ci) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: table columns never reorder — derived from a static header array
          <Text key={`h-${ci}`} bold color="cyan">
            <InlineMd text={cell} padTo={widths[ci] ?? 3} citations={citations} />
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
              <InlineMd text={row[ci] ?? ""} padTo={widths[ci] ?? 3} citations={citations} />
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

/**
 * Code-block languages that render as graphs/diagrams in real
 * browsers but can't be drawn in a terminal. For these we show the
 * SOURCE with a distinct frame + a header and a "paste into viewer"
 * hint, so the user knows they're looking at a diagram-source block
 * rather than executable code.
 */
const DIAGRAM_LANGS = new Set([
  "mermaid",
  "dot",
  "graphviz",
  "plantuml",
  "puml",
  "flowchart",
  "sequencediagram",
  "gantt",
  "erdiagram",
]);

/**
 * Viewer URL hint keyed by language — shown dim at the bottom of a
 * diagram-source block so users know where to paste it to see the
 * actual graph. Fallback is a generic "use the matching viewer" for
 * less common langs.
 */
const DIAGRAM_VIEWER_HINT: Record<string, string> = {
  mermaid: "→ paste at https://mermaid.live to view",
  plantuml: "→ paste at https://www.plantuml.com/plantuml to view",
  puml: "→ paste at https://www.plantuml.com/plantuml to view",
  dot: "→ paste at https://dreampuf.github.io/GraphvizOnline to view",
  graphviz: "→ paste at https://dreampuf.github.io/GraphvizOnline to view",
};

/**
 * Render a diagram-source code block with a magenta double-line
 * frame + a `◇ lang diagram (source)` header + a viewer hint
 * underneath. Distinct from the plain code-block rendering so the
 * user can tell at a glance that the terminal couldn't draw the
 * actual graph — they're looking at source to copy out.
 */
/**
 * Heading renderer. H1/H2 get solid-bg pills (high contrast, like
 * page-section headers in editor outlines); H3+ stays bold + accent
 * color so deeply nested headings don't visually overpower the
 * content below them. Inline markdown still expands inside the
 * heading so `code` and *italic* render correctly.
 */
function HeadingView({
  level,
  text,
  citations,
}: {
  level: number;
  text: string;
  citations?: CitationMap;
}) {
  if (level === 1) {
    return (
      <Box marginY={1}>
        <Text backgroundColor="#67e8f9" color="black" bold>
          {` # ${text} `}
        </Text>
      </Box>
    );
  }
  if (level === 2) {
    return (
      <Box marginTop={1}>
        <Text backgroundColor="#c4b5fd" color="black" bold>
          {` ## ${text} `}
        </Text>
      </Box>
    );
  }
  if (level === 3) {
    return (
      <Box marginTop={1}>
        <Text bold color="#f0abfc">
          {"### "}
        </Text>
        <Text bold>
          <InlineMd text={text} citations={citations} />
        </Text>
      </Box>
    );
  }
  return (
    <Text bold color="cyan">
      <InlineMd text={text} citations={citations} />
    </Text>
  );
}

/**
 * Fenced code block. Round-cornered frame, language pill in the
 * top-left, body in syntax-flavored colors. Lives inside event rows
 * which Ink renders into `<Static>` (scrollback) — the eraseLines
 * miscount that bans bordered Boxes from the *live* region doesn't
 * apply here, since Static items render once and never repaint.
 */
function CodeBlockView({ lang, text }: { lang: string; text: string }) {
  const langLabel = lang.trim();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#7dd3fc" paddingX={1}>
      {langLabel ? (
        <Box>
          <Text backgroundColor="#7dd3fc" color="black" bold>
            {` ${langLabel} `}
          </Text>
        </Box>
      ) : null}
      <Text color="#fde68a">{text}</Text>
    </Box>
  );
}

function DiagramCodeBlock({ lang, text }: { lang: string; text: string }) {
  const hint =
    DIAGRAM_VIEWER_HINT[lang.toLowerCase()] ?? "→ render with the matching viewer to view";
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        {`◇ ${lang} diagram (source — terminal can't draw the graph)`}
      </Text>
      <Box marginTop={1}>
        <Text color="yellow">{text}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}

export function Markdown({ text, projectRoot }: { text: string; projectRoot?: string }) {
  const cleaned = expandAutolinks(expandEmoji(stripMath(text)));
  const root = projectRoot ?? process.cwd();
  const citations = React.useMemo(() => collectCitations(cleaned, root), [cleaned, root]);
  const blocks = React.useMemo(() => parseBlocks(cleaned), [cleaned]);
  // Collect broken citations into an ordered list so the user sees
  // exactly which paths/lines failed and why. A bare count ("⚠ 1
  // broken citation") tells the user something's wrong but leaves them
  // to scan the wall of text for the red strikethrough — listing each
  // one with its reason makes the failure actionable: the user can
  // immediately push back on the specific claim, or decide it doesn't
  // matter and move on.
  const broken: Array<{ url: string; reason: string }> = [];
  for (const [url, status] of citations) {
    if (!status.ok) broken.push({ url, reason: status.reason });
  }
  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((b, i) => (
        <BlockView key={`${i}-${b.kind}`} block={b} citations={citations} />
      ))}
      {broken.length > 0 ? <BrokenCitationsBlock items={broken} /> : null}
    </Box>
  );
}

function BrokenCitationsBlock({ items }: { items: Array<{ url: string; reason: string }> }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text color="red" bold>
        {`⚠ ${items.length} broken citation${items.length > 1 ? "s" : ""} — the model referenced paths or lines that don't exist`}
      </Text>
      {items.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list is derived from a Map iteration order, stable per render
        <Text key={`bc-${i}`} color="red">
          {`  ✗ ${b.url} → ${b.reason}`}
        </Text>
      ))}
    </Box>
  );
}
