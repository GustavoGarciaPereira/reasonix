/**
 * Code chunker — walks a directory and splits source files into
 * embedding-sized windows with `{path, startLine, endLine, text}`
 * metadata so semantic-search results carry a precise file:line
 * citation back into the conversation.
 *
 * Why line-window (not AST) for MVP:
 *   - Language-agnostic: works on TS, Py, Rust, Go, Markdown,
 *     config files — no per-language parser to ship and maintain.
 *   - Predictable cost: a 500-line file produces ~10 chunks at
 *     `windowLines=60, overlap=12`. Embedding cost scales linearly
 *     with file size, no surprises.
 *   - Cite-friendly: every chunk has exact line range. Click-through
 *     in the UI is `path:startLine`.
 *
 * AST-aware chunking (split per function/class) is a real upgrade
 * for retrieval quality and is on the post-MVP list.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface CodeChunk {
  /** Path relative to the index root, forward slashes. Stable across OS. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

export interface ChunkOptions {
  /** Lines per window. Default 60. */
  windowLines?: number;
  /** Lines of overlap between consecutive windows. Default 12. */
  overlap?: number;
  /** Skip files larger than this (bytes). Default 256 KB. */
  maxFileBytes?: number;
  /**
   * Hard ceiling on chunk text length, in characters. A 60-line slice
   * through a JSON blob or minified bundle can blow past nomic-embed-
   * text's context window (8K tokens, ~32K chars worst-case but as
   * little as 8K chars for non-English / dense token streams).
   * Default 4000 — comfortably under 1024 tokens for most code, with
   * room to spare for tokenizers that fragment unicode aggressively.
   */
  maxChunkChars?: number;
}

/** Default character cap per chunk — sized for nomic-embed-text. */
export const DEFAULT_MAX_CHUNK_CHARS = 4000;

/**
 * Default skip-list. Mirrors what `directory_tree` already prunes
 * plus binary extensions that have zero retrieval value (and waste
 * embedding tokens). Keep this in sync with src/tools/filesystem.ts
 * if either drifts.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".cache",
  "coverage",
  ".turbo",
  ".vercel",
  ".reasonix",
]);

const SKIP_FILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "go.sum",
  ".DS_Store",
]);

const BINARY_EXTS: ReadonlySet<string> = new Set([
  // Images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tiff",
  // Fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // Archives / binaries
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".jar",
  ".wasm",
  ".o",
  ".a",
  // Media
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  // Other
  ".pdf",
  ".sqlite",
  ".db",
]);

/**
 * Split file content into overlapping line windows. `overlap`
 * preserves context across chunk boundaries — a function whose
 * signature is on the boundary still appears in two adjacent chunks
 * so a query about it ranks both.
 *
 * Any window whose text exceeds `maxChunkChars` is post-split into
 * multiple sub-chunks at line boundaries (or hard-truncated for a
 * single overlong line) so every yielded chunk is safe to embed.
 */
export function chunkText(
  text: string,
  filePath: string,
  windowLines: number,
  overlap: number,
  maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS,
): CodeChunk[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return [];
  const stride = Math.max(1, windowLines - overlap);
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(lines.length, start + windowLines);
    const slice = lines.slice(start, end).join("\n").trim();
    if (slice.length === 0) {
      if (end >= lines.length) break;
      continue;
    }
    const window: CodeChunk = {
      path: filePath,
      startLine: start + 1,
      endLine: end,
      text: slice,
    };
    for (const sub of safeSplit(window, maxChunkChars)) chunks.push(sub);
    if (end >= lines.length) break;
  }
  return chunks;
}

/**
 * Post-process a window so no chunk exceeds `maxChars`. We try to
 * preserve full-line granularity for retrieval quality:
 *
 *   - Walk the window line by line, accumulating into a buffer until
 *     adding the next line would exceed `maxChars`. Flush the buffer
 *     as a sub-chunk, restart at that line.
 *   - A single line longer than `maxChars` (long minified statement
 *     / base64 blob / unicode-heavy line) gets emitted as its own
 *     chunk, hard-truncated to `maxChars`. Coverage loss is acceptable
 *     — minified content has near-zero retrieval value.
 *
 * Idempotent: chunks already under `maxChars` pass through unchanged
 * (well — the buffer logic still emits them as a single sub-chunk,
 * but the result is byte-equivalent).
 */
function safeSplit(chunk: CodeChunk, maxChars: number): CodeChunk[] {
  if (chunk.text.length <= maxChars) return [chunk];
  const lines = chunk.text.split("\n");
  const out: CodeChunk[] = [];
  let bufLines: string[] = [];
  let bufStart = chunk.startLine;
  let bufLen = 0;
  const flush = (untilLineNo: number): void => {
    if (bufLines.length === 0) return;
    out.push({
      path: chunk.path,
      startLine: bufStart,
      endLine: untilLineNo,
      text: bufLines.join("\n"),
    });
    bufLines = [];
    bufLen = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineLen = line.length + 1; // +newline
    if (lineLen > maxChars) {
      // Single line dwarfs the cap. Flush current buffer, then emit
      // a hard-truncated single-line chunk for this line.
      flush(chunk.startLine + i - 1);
      out.push({
        path: chunk.path,
        startLine: chunk.startLine + i,
        endLine: chunk.startLine + i,
        text: line.slice(0, maxChars),
      });
      bufStart = chunk.startLine + i + 1;
      continue;
    }
    if (bufLen + lineLen > maxChars && bufLines.length > 0) {
      flush(chunk.startLine + i - 1);
      bufStart = chunk.startLine + i;
    }
    bufLines.push(line);
    bufLen += lineLen;
  }
  flush(chunk.endLine);
  return out;
}

/**
 * Walk `root` recursively and yield code chunks for every indexable
 * file. Pure async generator so callers can pipe through embedding +
 * progress reporting without buffering the whole repo in memory.
 *
 * The generator silently skips files larger than `maxFileBytes` —
 * generated bundles, vendored data, etc. — to avoid one huge file
 * dominating the budget. The threshold is intentionally low; the
 * real signal in oversized files is rare and the embedding cost
 * scales with chunk count.
 */
export async function* walkChunks(
  root: string,
  opts: ChunkOptions = {},
): AsyncGenerator<CodeChunk> {
  const windowLines = opts.windowLines ?? 60;
  const overlap = Math.min(opts.overlap ?? 12, Math.max(0, windowLines - 1));
  const maxFileBytes = opts.maxFileBytes ?? 256 * 1024;
  const maxChunkChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".")) {
          // .git/.next/.cache etc. plus any hidden dir — same default
          // as `directory_tree`. Users opt in to dotfiles via a future
          // flag; MVP keeps the index lean.
          if (SKIP_DIRS.has(name) || name === ".git") continue;
          // Allow other dotdirs that aren't in SKIP_DIRS (rare).
        }
        stack.push(path.join(dir, name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(name)) continue;
      const ext = path.extname(name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;
      const abs = path.join(dir, name);
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) continue;
      // Read as utf-8. If decoding ever fails (random binary that
      // sneaks past the ext check), skip rather than crashing the
      // whole index build.
      let text: string;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      // Quick null-byte sniff — catches binary files with weird /
      // missing extensions that BINARY_EXTS missed.
      if (text.indexOf("\0") !== -1) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      for (const chunk of chunkText(text, rel, windowLines, overlap, maxChunkChars)) {
        yield chunk;
      }
    }
  }
}

/**
 * Convenience: collect all chunks from a directory into an array.
 * For very large repos prefer streaming via `walkChunks`.
 */
export async function chunkDirectory(root: string, opts: ChunkOptions = {}): Promise<CodeChunk[]> {
  const out: CodeChunk[] = [];
  for await (const c of walkChunks(root, opts)) out.push(c);
  return out;
}
