/**
 * JSONL persistence + in-memory cosine search for the semantic index.
 *
 * Layout choice — JSONL not SQLite, not a packed binary file:
 *   - Zero native deps (matches Reasonix's npm-only install story).
 *   - `cat .reasonix/index.jsonl | wc -l` answers "how big is my
 *     index" without code; `head` peeks at content; `git diff`
 *     reads if you ever commit it.
 *   - Append-only writes survive Ctrl+C without corruption — the
 *     same atomic-append discipline `~/.reasonix/sessions/` uses.
 *
 * Search is a linear cosine scan. For ≤10k chunks (typical mid-size
 * project) one query is <5ms on a modern CPU because the inner loop
 * runs over Float32Array which V8 keeps unboxed. Switching to HNSW
 * is on the post-MVP list; doing it before linear scan hurts
 * (faster than necessary, opaque debugging, native deps).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodeChunk } from "./chunker.js";

export interface IndexEntry extends CodeChunk {
  /** L2-normalized embedding so cosine reduces to a dot product. */
  embedding: Float32Array;
  /** mtime of the source file when this entry was indexed (ms epoch).
   *  Lets the builder skip unchanged files on incremental rebuilds. */
  mtimeMs: number;
}

export interface SearchHit {
  entry: IndexEntry;
  score: number;
}

export interface IndexMeta {
  version: number;
  /** Embedding model the index was built with — invalidates when changed. */
  model: string;
  /** Embedding dimensionality — sanity check on append. */
  dim: number;
  /** ISO timestamp of last write. */
  updatedAt: string;
}

/** Bumped when the JSONL line schema changes. Old indexes are rebuilt. */
export const STORE_VERSION = 1;

const META_FILE = "index.meta.json";
const DATA_FILE = "index.jsonl";

/**
 * In-memory index. Owns the loaded entries + the directory paths,
 * provides cosine search, and writes through to disk on every
 * `add`. Each store instance is scoped to one project (one sandbox
 * root in `reasonix code`).
 */
export class SemanticStore {
  private entries: IndexEntry[] = [];
  private byPath = new Map<string, IndexEntry[]>();
  private dim = 0;

  constructor(
    /** Directory the index files live in (e.g. `<project>/.reasonix/`). */
    public readonly indexDir: string,
    /** Embedding model name written into meta and checked on load. */
    public readonly model: string,
  ) {}

  /** True when no entries are loaded — the index doesn't exist or is empty. */
  get empty(): boolean {
    return this.entries.length === 0;
  }

  /** Total number of indexed chunks. */
  get size(): number {
    return this.entries.length;
  }

  /** Read-only view, mostly for tests. */
  get all(): readonly IndexEntry[] {
    return this.entries;
  }

  /** Last-known mtime per indexed file (ms epoch) for incremental rebuilds. */
  fileMtimes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [p, group] of this.byPath) {
      // Every chunk from a given file shares the same mtime; first
      // entry's value is authoritative.
      const first = group[0];
      if (first) out.set(p, first.mtimeMs);
    }
    return out;
  }

  /** Append entries to in-memory state and to disk. Re-indexes the
   * `byPath` map. Caller is responsible for L2-normalizing each
   * embedding before calling — the search hot path assumes unit vectors. */
  async add(entries: readonly IndexEntry[]): Promise<void> {
    if (entries.length === 0) return;
    if (this.dim === 0) this.dim = entries[0]!.embedding.length;
    const lines: string[] = [];
    for (const e of entries) {
      if (e.embedding.length !== this.dim) {
        throw new Error(
          `embedding dim mismatch: expected ${this.dim}, got ${e.embedding.length} for ${e.path}:${e.startLine}`,
        );
      }
      this.entries.push(e);
      const list = this.byPath.get(e.path);
      if (list) list.push(e);
      else this.byPath.set(e.path, [e]);
      lines.push(serializeEntry(e));
    }
    await fs.mkdir(this.indexDir, { recursive: true });
    await fs.appendFile(path.join(this.indexDir, DATA_FILE), `${lines.join("\n")}\n`, "utf8");
    await this.writeMeta();
  }

  /**
   * Drop every entry whose `path` is in `paths`. Used by incremental
   * rebuild: when a file's mtime changes, the existing entries for
   * it are evicted before re-chunking + re-embedding. Implementation
   * rewrites the JSONL — append-only is fine for adds, but deletes
   * need a compaction pass.
   */
  async remove(paths: readonly string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const drop = new Set(paths);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !drop.has(e.path));
    for (const p of paths) this.byPath.delete(p);
    const removed = before - this.entries.length;
    if (removed > 0) await this.flush();
    return removed;
  }

  /**
   * Top-K cosine search. `query` MUST already be L2-normalized — the
   * caller embeds + normalizes once per query. Filtering hits by
   * minimum score (`minScore`) is optional; tune via UI to suppress
   * weakly relevant snippets that distract the model.
   */
  search(query: Float32Array, topK = 8, minScore = 0): SearchHit[] {
    if (this.entries.length === 0) return [];
    if (query.length !== this.dim && this.dim !== 0) {
      throw new Error(`query dim ${query.length} ≠ index dim ${this.dim}`);
    }
    // Use a small max-heap-ish structure: keep `topK + 1` entries,
    // drop smallest each insert. For typical topK (≤16) this beats
    // sorting the full list at small extra constant cost.
    const heap: SearchHit[] = [];
    for (const entry of this.entries) {
      const score = dot(query, entry.embedding);
      if (score < minScore) continue;
      if (heap.length < topK) {
        heap.push({ entry, score });
        if (heap.length === topK) heap.sort((a, b) => a.score - b.score);
      } else if (score > heap[0]!.score) {
        heap[0] = { entry, score };
        // Maintain partial order for the smallest at index 0.
        for (let i = 0; i < heap.length - 1; i++) {
          if (heap[i]!.score > heap[i + 1]!.score) {
            const tmp = heap[i]!;
            heap[i] = heap[i + 1]!;
            heap[i + 1] = tmp;
          }
        }
      }
    }
    return heap.sort((a, b) => b.score - a.score);
  }

  /**
   * Rewrite the JSONL on disk with the current in-memory state. Used
   * after `remove` and from `flush`. We write to a temp file and
   * rename so a Ctrl+C mid-write never leaves the index half-empty.
   */
  private async flush(): Promise<void> {
    await fs.mkdir(this.indexDir, { recursive: true });
    const tmp = path.join(this.indexDir, `${DATA_FILE}.tmp`);
    const final = path.join(this.indexDir, DATA_FILE);
    const lines = this.entries.map(serializeEntry).join("\n");
    await fs.writeFile(tmp, lines.length > 0 ? `${lines}\n` : "", "utf8");
    await fs.rename(tmp, final);
    await this.writeMeta();
  }

  private async writeMeta(): Promise<void> {
    const meta: IndexMeta = {
      version: STORE_VERSION,
      model: this.model,
      dim: this.dim,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(this.indexDir, META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8",
    );
  }

  /** Drop everything from disk + memory. Used by `--rebuild`. */
  async wipe(): Promise<void> {
    this.entries = [];
    this.byPath.clear();
    this.dim = 0;
    await fs.rm(path.join(this.indexDir, DATA_FILE), { force: true });
    await fs.rm(path.join(this.indexDir, META_FILE), { force: true });
  }
}

/**
 * Open an existing index from disk, or return an empty store if none
 * exists. Throws when the on-disk model name disagrees with the
 * caller's — the embeddings would be incomparable, so the caller
 * needs to wipe + rebuild deliberately.
 */
export async function openStore(indexDir: string, model: string): Promise<SemanticStore> {
  const store = new SemanticStore(indexDir, model);
  const dataPath = path.join(indexDir, DATA_FILE);
  const metaPath = path.join(indexDir, META_FILE);

  let meta: IndexMeta | null = null;
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    meta = JSON.parse(raw) as IndexMeta;
  } catch {
    /* no meta yet — fresh store */
  }

  if (meta) {
    if (meta.version !== STORE_VERSION) {
      throw new Error(
        `Index format version ${meta.version} does not match current ${STORE_VERSION}. Run \`reasonix index --rebuild\`.`,
      );
    }
    if (meta.model !== model) {
      throw new Error(
        `Index was built with model "${meta.model}" but current is "${model}". Run \`reasonix index --rebuild\`.`,
      );
    }
  }

  let raw: string;
  try {
    raw = await fs.readFile(dataPath, "utf8");
  } catch {
    return store;
  }
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const entry = deserializeEntry(line);
      (store as unknown as { dim: number }).dim = entry.embedding.length;
      // Bypass `add` to skip the per-line disk write on load.
      (store as unknown as { entries: IndexEntry[] }).entries.push(entry);
      const map = (store as unknown as { byPath: Map<string, IndexEntry[]> }).byPath;
      const list = map.get(entry.path);
      if (list) list.push(entry);
      else map.set(entry.path, [entry]);
    } catch {
      // Malformed line — drop it but keep going. Same tolerance as
      // session.ts shows for partially-flushed JSONL.
    }
  }
  return store;
}

/**
 * L2-normalize a vector in place + return it for chaining. Cosine
 * similarity reduces to a dot product when both operands are unit
 * vectors, which is what the search hot path assumes.
 */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * inv;
  return v;
}

/** Pure dot product of two same-length Float32Arrays. */
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Wire format — JSON object per line. Embedding is encoded as
 * base64 over the underlying bytes (Float32 → Uint8 → base64) which
 * is ~33% smaller than the JSON-array form and round-trips losslessly.
 */
function serializeEntry(e: IndexEntry): string {
  const buf = Buffer.from(e.embedding.buffer, e.embedding.byteOffset, e.embedding.byteLength);
  return JSON.stringify({
    p: e.path,
    s: e.startLine,
    e: e.endLine,
    m: e.mtimeMs,
    t: e.text,
    v: buf.toString("base64"),
  });
}

function deserializeEntry(line: string): IndexEntry {
  const parsed = JSON.parse(line) as {
    p: string;
    s: number;
    e: number;
    m: number;
    t: string;
    v: string;
  };
  const bytes = Buffer.from(parsed.v, "base64");
  // The float32 view shares memory with the buffer; copy so the
  // entry is independent of the parser's transient buffer.
  const f32 = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return {
    path: parsed.p,
    startLine: parsed.s,
    endLine: parsed.e,
    mtimeMs: parsed.m,
    text: parsed.t,
    embedding: f32,
  };
}
