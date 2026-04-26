/**
 * User memory — `~/.reasonix/memory/` markdown notes pinned into the
 * immutable-prefix system prompt across sessions.
 *
 * Two scopes:
 *   - `global`  → `~/.reasonix/memory/global/`         (cross-project)
 *   - `project` → `~/.reasonix/memory/<hash>/`          (per sandbox root)
 *
 * Each scope has an always-loaded `MEMORY.md` index plus zero-or-more
 * `<name>.md` detail files loaded on demand via `recall_memory`.
 *
 * Distinct from `src/project-memory.ts` (REASONIX.md) in purpose:
 *   REASONIX.md        is committable, team-shared project memory.
 *   ~/.reasonix/memory is user-private memory, never committed.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { applyProjectMemory, memoryEnabled } from "./project-memory.js";
import { applySkillsIndex } from "./skills.js";

export const USER_MEMORY_DIR = "memory";
export const MEMORY_INDEX_FILE = "MEMORY.md";
/** Cap on the index file content loaded into the prefix, per scope. */
export const MEMORY_INDEX_MAX_CHARS = 4000;

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "global" | "project";

export interface MemoryEntry {
  name: string;
  type: MemoryType;
  scope: MemoryScope;
  description: string;
  body: string;
  /** ISO date string (YYYY-MM-DD). */
  createdAt: string;
}

export interface MemoryStoreOptions {
  /** Override `~/.reasonix` — tests set this to a tmpdir. */
  homeDir?: string;
  /** Absolute sandbox root. Required to use `scope: "project"`. */
  projectRoot?: string;
}

export interface WriteInput {
  name: string;
  type: MemoryType;
  scope: MemoryScope;
  description: string;
  body: string;
}

const VALID_NAME = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{1,38}[a-zA-Z0-9]$/;

/**
 * Throws on filename injection attempts (`../foo`, `foo/bar`, leading
 * dots, etc.). Allowed: 3-40 chars, alnum + `_` + `-` + interior `.`.
 */
export function sanitizeMemoryName(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!VALID_NAME.test(trimmed)) {
    throw new Error(
      `invalid memory name: ${JSON.stringify(raw)} — must be 3-40 chars, alnum/_/-, no path separators`,
    );
  }
  return trimmed;
}

/** Stable 16-hex-char hash of an absolute sandbox root path. */
export function projectHash(rootDir: string): string {
  const abs = resolve(rootDir);
  return createHash("sha1").update(abs).digest("hex").slice(0, 16);
}

function scopeDir(opts: { homeDir: string; scope: MemoryScope; projectRoot?: string }): string {
  if (opts.scope === "global") {
    return join(opts.homeDir, USER_MEMORY_DIR, "global");
  }
  if (!opts.projectRoot) {
    throw new Error("scope=project requires a projectRoot on MemoryStore");
  }
  return join(opts.homeDir, USER_MEMORY_DIR, projectHash(opts.projectRoot));
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/**
 * Parse a `---` frontmatter block off the top of a markdown string.
 * Tolerates missing frontmatter, returning `{}` for data and the full
 * string as body. Only recognizes the simple `key: value` shape — no
 * quoting, no multi-line, no YAML features. Matches what we emit.
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return { data: {}, body: raw };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m?.[1]) data[m[1]] = (m[2] ?? "").trim();
  }
  return {
    data,
    body: lines
      .slice(end + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

function formatFrontmatter(e: WriteInput & { createdAt: string }): string {
  return [
    "---",
    `name: ${e.name}`,
    `description: ${e.description.replace(/\n/g, " ")}`,
    `type: ${e.type}`,
    `scope: ${e.scope}`,
    `created: ${e.createdAt}`,
    "---",
    "",
  ].join("\n");
}

function todayIso(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * A `MEMORY.md` index line for one entry. One-liner, under ~150 chars.
 * `description` is truncated if it would push past the soft limit.
 */
function indexLine(e: Pick<MemoryEntry, "name" | "description">): string {
  const safeDesc = e.description.replace(/\n/g, " ").trim();
  const max = 130 - e.name.length;
  const clipped = safeDesc.length > max ? `${safeDesc.slice(0, Math.max(1, max - 1))}…` : safeDesc;
  return `- [${e.name}](${e.name}.md) — ${clipped}`;
}

export class MemoryStore {
  private readonly homeDir: string;
  private readonly projectRoot: string | undefined;

  constructor(opts: MemoryStoreOptions = {}) {
    this.homeDir = opts.homeDir ?? join(homedir(), ".reasonix");
    this.projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : undefined;
  }

  /** Directory this store writes `scope` files into, creating it if needed. */
  dir(scope: MemoryScope): string {
    const d = scopeDir({ homeDir: this.homeDir, scope, projectRoot: this.projectRoot });
    ensureDir(d);
    return d;
  }

  /** Absolute path to a memory file (no existence check). */
  pathFor(scope: MemoryScope, name: string): string {
    return join(this.dir(scope), `${sanitizeMemoryName(name)}.md`);
  }

  /** True iff this store is configured with a project scope available. */
  hasProjectScope(): boolean {
    return this.projectRoot !== undefined;
  }

  /**
   * Read the `MEMORY.md` index for a scope. Returns post-cap content
   * (with a truncation marker if clipped), or `null` when absent / empty.
   */
  loadIndex(
    scope: MemoryScope,
  ): { content: string; originalChars: number; truncated: boolean } | null {
    if (scope === "project" && !this.projectRoot) return null;
    const file = join(
      scopeDir({ homeDir: this.homeDir, scope, projectRoot: this.projectRoot }),
      MEMORY_INDEX_FILE,
    );
    if (!existsSync(file)) return null;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const originalChars = trimmed.length;
    const truncated = originalChars > MEMORY_INDEX_MAX_CHARS;
    const content = truncated
      ? `${trimmed.slice(0, MEMORY_INDEX_MAX_CHARS)}\n… (truncated ${originalChars - MEMORY_INDEX_MAX_CHARS} chars)`
      : trimmed;
    return { content, originalChars, truncated };
  }

  /** Read one memory file's body (frontmatter stripped). Throws if missing. */
  read(scope: MemoryScope, name: string): MemoryEntry {
    const file = this.pathFor(scope, name);
    if (!existsSync(file)) {
      throw new Error(`memory not found: scope=${scope} name=${name}`);
    }
    const raw = readFileSync(file, "utf8");
    const { data, body } = parseFrontmatter(raw);
    return {
      name: data.name ?? name,
      type: (data.type as MemoryType) ?? "project",
      scope: (data.scope as MemoryScope) ?? scope,
      description: data.description ?? "",
      body: body.trim(),
      createdAt: data.created ?? "",
    };
  }

  /**
   * List every memory in this store. Scans both scopes (skips project
   * scope if unconfigured). Silently skips malformed files; the index
   * must stay queryable even if one file is hand-edited into nonsense.
   */
  list(): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    const scopes: MemoryScope[] = this.projectRoot ? ["global", "project"] : ["global"];
    for (const scope of scopes) {
      const dir = scopeDir({ homeDir: this.homeDir, scope, projectRoot: this.projectRoot });
      if (!existsSync(dir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry === MEMORY_INDEX_FILE) continue;
        if (!entry.endsWith(".md")) continue;
        const name = entry.slice(0, -3);
        try {
          out.push(this.read(scope, name));
        } catch {
          // malformed file — skip rather than fail the whole list
        }
      }
    }
    return out;
  }

  /**
   * Write a new memory (or overwrite existing). Creates the scope dir,
   * writes the `.md` file, and regenerates `MEMORY.md`. Returns the
   * absolute path written to.
   */
  write(input: WriteInput): string {
    if (input.scope === "project" && !this.projectRoot) {
      throw new Error("cannot write project-scoped memory: no projectRoot configured");
    }
    const name = sanitizeMemoryName(input.name);
    const desc = String(input.description ?? "").trim();
    if (!desc) throw new Error("memory description cannot be empty");
    const body = String(input.body ?? "").trim();
    if (!body) throw new Error("memory body cannot be empty");
    const entry: WriteInput & { createdAt: string } = {
      ...input,
      name,
      description: desc,
      body,
      createdAt: todayIso(),
    };
    const dir = this.dir(input.scope);
    const file = join(dir, `${name}.md`);
    const content = `${formatFrontmatter(entry)}${body}\n`;
    writeFileSync(file, content, "utf8");
    this.regenerateIndex(input.scope);
    return file;
  }

  /** Delete one memory + its index line. No-op if the file is already gone. */
  delete(scope: MemoryScope, rawName: string): boolean {
    if (scope === "project" && !this.projectRoot) {
      throw new Error("cannot delete project-scoped memory: no projectRoot configured");
    }
    const file = this.pathFor(scope, rawName);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    this.regenerateIndex(scope);
    return true;
  }

  /**
   * Rebuild `MEMORY.md` from the `.md` files currently in the scope dir.
   * Called after every write/delete. Sorted by name for stable prefix
   * hashing — two stores with the same set of files produce byte-identical
   * MEMORY.md content, keeping the cache prefix reproducible.
   */
  private regenerateIndex(scope: MemoryScope): void {
    const dir = scopeDir({ homeDir: this.homeDir, scope, projectRoot: this.projectRoot });
    if (!existsSync(dir)) return;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    const mdFiles = files
      .filter((f) => f !== MEMORY_INDEX_FILE && f.endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
    const indexPath = join(dir, MEMORY_INDEX_FILE);
    if (mdFiles.length === 0) {
      if (existsSync(indexPath)) unlinkSync(indexPath);
      return;
    }
    const lines: string[] = [];
    for (const f of mdFiles) {
      const name = f.slice(0, -3);
      try {
        const entry = this.read(scope, name);
        lines.push(indexLine({ name: entry.name || name, description: entry.description }));
      } catch {
        // Malformed: still surface it in the index so the user notices.
        lines.push(`- [${name}](${name}.md) — (malformed, check frontmatter)`);
      }
    }
    writeFileSync(indexPath, `${lines.join("\n")}\n`, "utf8");
  }
}

/**
 * Read the freeform global REASONIX.md (~/.reasonix/REASONIX.md). This
 * is the destination for the `#g <note>` quick-write prefix — symmetric
 * to project REASONIX.md but pinned across every session regardless of
 * working directory. Returns post-cap content or `null` when the file
 * is absent / empty / unreadable.
 *
 * Distinct from MEMORY.md (the curated index of named .md files) — this
 * is one freeform bullet list the user appends to with `#g`.
 */
export function readGlobalReasonixMemory(
  homeDir: string = join(homedir(), ".reasonix"),
): { path: string; content: string; originalChars: number; truncated: boolean } | null {
  const path = join(homeDir, "REASONIX.md");
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const originalChars = trimmed.length;
  // Reuse the project-memory cap so both freeform files have the same
  // headroom (8000 chars ≈ 2k tokens). They serve the same purpose at
  // different scopes.
  const truncated = originalChars > 8000;
  const content = truncated
    ? `${trimmed.slice(0, 8000)}\n… (truncated ${originalChars - 8000} chars)`
    : trimmed;
  return { path, content, originalChars, truncated };
}

/**
 * Append the global freeform REASONIX.md to `basePrompt` as its own
 * pinned section. No-op when the file is absent / empty / disabled.
 * Stable byte output for stable prefix hashing — same file content
 * always produces the same prompt suffix.
 */
export function applyGlobalReasonixMemory(basePrompt: string, homeDir?: string): string {
  if (!memoryEnabled()) return basePrompt;
  const dir = homeDir ?? join(homedir(), ".reasonix");
  const mem = readGlobalReasonixMemory(dir);
  if (!mem) return basePrompt;
  return [
    basePrompt,
    "",
    "# Global memory (~/.reasonix/REASONIX.md)",
    "",
    "Cross-project notes the user pinned via the `#g` prompt prefix. Treat as authoritative — same level of trust as project memory.",
    "",
    "```",
    mem.content,
    "```",
  ].join("\n");
}

/**
 * Append `MEMORY_GLOBAL` and (optionally) `MEMORY_PROJECT` blocks to
 * `basePrompt`. Omits a block entirely when its index is absent — an
 * empty tag would add bytes to the prefix hash without content.
 * Respects `REASONIX_MEMORY=off` via `memoryEnabled()` from
 * `project-memory.ts`.
 */
export function applyUserMemory(
  basePrompt: string,
  opts: { homeDir?: string; projectRoot?: string } = {},
): string {
  if (!memoryEnabled()) return basePrompt;
  const store = new MemoryStore(opts);
  const global = store.loadIndex("global");
  const project = store.hasProjectScope() ? store.loadIndex("project") : null;
  if (!global && !project) return basePrompt;
  const parts: string[] = [basePrompt];
  if (global) {
    parts.push(
      "",
      "# User memory — global (~/.reasonix/memory/global/MEMORY.md)",
      "",
      "Cross-project facts and preferences the user has told you in prior sessions. TREAT AS AUTHORITATIVE — don't re-verify via filesystem or web. One-liners index detail files; call `recall_memory` for full bodies only when the one-liner isn't enough.",
      "",
      "```",
      global.content,
      "```",
    );
  }
  if (project) {
    parts.push(
      "",
      "# User memory — this project",
      "",
      "Per-project facts the user established in prior sessions (not committed to the repo). TREAT AS AUTHORITATIVE. Same recall pattern as global memory.",
      "",
      "```",
      project.content,
      "```",
    );
  }
  return parts.join("\n");
}

/**
 * Compose every lazy-loaded prefix block in one call: project REASONIX.md,
 * global REASONIX.md (`#g` destination), user memory indexes (global +
 * per-project), and the skills index. Drop-in replacement for
 * `applyProjectMemory` at CLI entry points. Stacking order is stable —
 * the prefix hash only changes when block *content* changes, not when
 * this helper is called a second time with the same filesystem state.
 */
export function applyMemoryStack(basePrompt: string, rootDir: string): string {
  const withProject = applyProjectMemory(basePrompt, rootDir);
  const withGlobal = applyGlobalReasonixMemory(withProject);
  const withMemory = applyUserMemory(withGlobal, { projectRoot: rootDir });
  return applySkillsIndex(withMemory, { projectRoot: rootDir });
}
