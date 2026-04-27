/**
 * Build + query orchestrator for the semantic index.
 *
 * `buildIndex(root, opts)` walks the project, embeds new/changed
 * files, and persists. It is incremental by default — files whose
 * mtime hasn't moved since the last build are skipped, which is the
 * main reason the index can be kept fresh as a `Stop` hook or a
 * pre-`reasonix code` warm-up.
 *
 * `querySemantic(root, query, opts)` opens the on-disk index, embeds
 * the query, and returns top-K hits formatted for tool output. No
 * mutation; safe to call from any tool fn.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { walkChunks } from "./chunker.js";
import type { CodeChunk } from "./chunker.js";
import { embed, embedAll, probeOllama } from "./embedding.js";
import type { EmbedOptions } from "./embedding.js";
import { normalize, openStore } from "./store.js";
import type { IndexEntry, SearchHit } from "./store.js";

/** Default index dir relative to the project root. */
export const INDEX_DIR_NAME = path.join(".reasonix", "semantic");

export interface BuildOptions extends EmbedOptions {
  /** Skip files larger than this many bytes. Default 256 KB. */
  maxFileBytes?: number;
  /** Lines per window. Default 60. */
  windowLines?: number;
  /** Window overlap. Default 12. */
  overlap?: number;
  /** Force a full rebuild (drop the existing index first). */
  rebuild?: boolean;
  /** Progress callback for the CLI to render counters. */
  onProgress?: (info: BuildProgress) => void;
}

export interface BuildProgress {
  phase: "scan" | "embed" | "write" | "done";
  filesScanned?: number;
  chunksTotal?: number;
  chunksDone?: number;
  filesSkipped?: number;
  filesChanged?: number;
}

export interface BuildResult {
  filesScanned: number;
  filesChanged: number;
  chunksAdded: number;
  chunksRemoved: number;
  /** Chunks that failed to embed (Ollama 500, transient errors) and
   *  were skipped. Reported in the success line so users notice. */
  chunksSkipped: number;
  durationMs: number;
}

/**
 * Build (or incrementally update) the semantic index for `root`.
 * Probes Ollama first so a missing daemon fails before any chunking.
 */
export async function buildIndex(root: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const t0 = Date.now();
  const indexDir = path.join(root, INDEX_DIR_NAME);

  const probe = await probeOllama({ baseUrl: opts.baseUrl, signal: opts.signal });
  if (!probe.ok) {
    throw new Error(
      `Ollama is not reachable: ${probe.error}. Install from https://ollama.com, then \`ollama serve\` and \`ollama pull ${opts.model ?? "nomic-embed-text"}\`.`,
    );
  }

  const model = opts.model ?? process.env.REASONIX_EMBED_MODEL ?? "nomic-embed-text";
  const store = await openStore(indexDir, model);
  if (opts.rebuild) await store.wipe();

  // Snapshot the index's per-file mtimes so we can detect (a) changed
  // files (mtime moved) and (b) deleted files (path no longer exists
  // on disk after the walk).
  const lastMtimes = store.fileMtimes();
  const seenPaths = new Set<string>();

  // Phase 1 — scan + chunk + collect mtime per file. Buffer chunks
  // by file because we need to drop+re-add per file when its mtime
  // changes (a partial update would leave stale chunks).
  const fileChunks = new Map<string, { chunks: CodeChunk[]; mtimeMs: number }>();
  let filesScanned = 0;
  let filesSkipped = 0;
  for await (const chunk of walkChunks(root, {
    windowLines: opts.windowLines,
    overlap: opts.overlap,
    maxFileBytes: opts.maxFileBytes,
  })) {
    seenPaths.add(chunk.path);
    let bucket = fileChunks.get(chunk.path);
    if (!bucket) {
      filesScanned++;
      const abs = path.join(root, chunk.path);
      let mtimeMs = 0;
      try {
        const stat = await fs.stat(abs);
        mtimeMs = stat.mtimeMs;
      } catch {
        continue;
      }
      const last = lastMtimes.get(chunk.path);
      if (last !== undefined && last === mtimeMs && !opts.rebuild) {
        filesSkipped++;
        continue; // Unchanged — skip embedding.
      }
      bucket = { chunks: [], mtimeMs };
      fileChunks.set(chunk.path, bucket);
    }
    bucket.chunks.push(chunk);
    opts.onProgress?.({ phase: "scan", filesScanned });
  }

  // Phase 2 — drop entries for files that disappeared (rename/delete).
  const deletedPaths: string[] = [];
  for (const oldPath of lastMtimes.keys()) {
    if (!seenPaths.has(oldPath)) deletedPaths.push(oldPath);
  }
  // Files whose chunks we re-built also need their old entries
  // evicted before the new ones are inserted, otherwise the index
  // grows duplicate snippets for the same range.
  const replacePaths = [...fileChunks.keys()].filter((p) => lastMtimes.has(p));
  const removed = await store.remove([...deletedPaths, ...replacePaths]);

  // Phase 3 — embed buffered chunks file by file. Sequential per
  // file so the progress counter advances visibly; embedAll is
  // sequential internally (Ollama serializes anyway). Per-chunk
  // failures (Ollama 500, transient errors) are logged + skipped
  // via embedAll's null-slot convention so a single bad chunk
  // doesn't kill a long-running build.
  let chunksAdded = 0;
  let chunksSkipped = 0;
  const filesChanged = fileChunks.size;
  let chunksTotal = 0;
  for (const { chunks } of fileChunks.values()) chunksTotal += chunks.length;
  let chunksDone = 0;
  for (const [, bucket] of fileChunks) {
    if (bucket.chunks.length === 0) continue;
    const texts = bucket.chunks.map((c) => c.text);
    const vectors = await embedAll(texts, {
      ...opts,
      onProgress: (done, total) => {
        opts.onProgress?.({
          phase: "embed",
          filesScanned,
          filesChanged,
          chunksTotal,
          chunksDone: chunksDone + done,
        });
        if (done === total) chunksDone += total;
      },
      onError: (idx, err) => {
        chunksSkipped++;
        const c = bucket.chunks[idx];
        const where = c ? `${c.path}:${c.startLine}-${c.endLine}` : `chunk #${idx}`;
        const msg = err instanceof Error ? err.message : String(err);
        // stderr only — non-fatal warnings shouldn't pollute stdout
        // (which the rest of the CLI keeps clean for piping).
        process.stderr.write(`\n  ! skipped ${where}: ${msg}\n`);
      },
    });
    const entries: IndexEntry[] = [];
    for (let i = 0; i < bucket.chunks.length; i++) {
      const vec = vectors[i];
      if (!vec) continue; // skipped due to per-chunk error
      const c = bucket.chunks[i];
      if (!c) continue;
      normalize(vec);
      entries.push({
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        embedding: vec,
        mtimeMs: bucket.mtimeMs,
      });
    }
    if (entries.length > 0) await store.add(entries);
    chunksAdded += entries.length;
  }

  opts.onProgress?.({
    phase: "done",
    filesScanned,
    filesSkipped,
    filesChanged,
    chunksTotal,
    chunksDone,
  });

  return {
    filesScanned,
    filesChanged,
    chunksAdded,
    chunksRemoved: removed,
    chunksSkipped,
    durationMs: Date.now() - t0,
  };
}

export interface QueryOptions extends EmbedOptions {
  topK?: number;
  /** Drop hits below this cosine score. Default 0.3 — anything weaker is noise. */
  minScore?: number;
}

/**
 * Embed `query` and return ranked hits from the index. Returns
 * `null` when no index exists for `root` so the caller can decide
 * whether to fall back to grep + a "run reasonix index" hint.
 */
export async function querySemantic(
  root: string,
  query: string,
  opts: QueryOptions = {},
): Promise<SearchHit[] | null> {
  const indexDir = path.join(root, INDEX_DIR_NAME);
  const model = opts.model ?? process.env.REASONIX_EMBED_MODEL ?? "nomic-embed-text";
  const store = await openStore(indexDir, model);
  if (store.empty) return null;
  const qvec = await embed(query, opts);
  normalize(qvec);
  return store.search(qvec, opts.topK ?? 8, opts.minScore ?? 0.3);
}

/**
 * Cheap synchronous-ish probe — returns true if the index dir
 * contains an index.meta.json. Used to gate `semantic_search` tool
 * registration: no index → no tool (model can't call something it
 * can't use).
 */
export async function indexExists(root: string): Promise<boolean> {
  const meta = path.join(root, INDEX_DIR_NAME, "index.meta.json");
  try {
    await fs.access(meta);
    return true;
  } catch {
    return false;
  }
}
