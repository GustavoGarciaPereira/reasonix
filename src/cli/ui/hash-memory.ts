/**
 * Hash-mode (`#note` / `#g note`) prefix parsing — instant memory write.
 *
 * A `#` at the start of the user's input writes a one-liner to memory
 * pinned in the prefix from now on. Two scopes:
 *
 *   - `#<note>`        → project memory   `<rootDir>/REASONIX.md`
 *                          (committable, team-shared)
 *   - `#g <note>`      → global memory    `~/.reasonix/REASONIX.md`
 *                          (private, cross-project — never committed)
 *
 * Same idea as Claude Code's `#` prefix — faster than going through
 * a `/memory remember ...` slash for a one-liner like "always use pnpm".
 *
 * Trigger shape:
 *   - `#` followed by zero-or-more spaces, then a non-empty body
 *   - NOT `##` / `###` / etc. — those stay markdown headings to the model
 *   - `\#foo` escape → not a memory write, leading backslash stripped before
 *     submission so the model sees `#foo` literally
 *
 * Each call appends one bullet at the bottom; we don't try to parse
 * section structure. The user can reorganize manually whenever they
 * want.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PROJECT_MEMORY_FILE } from "../../project-memory.js";

const PROJECT_HEADER = `# Reasonix project memory

Notes the user pinned via the \`#\` prompt prefix. The whole file is
loaded into the immutable system prefix every session — keep it terse.

`;

const GLOBAL_HEADER = `# Reasonix global memory

Cross-project notes the user pinned via the \`#g\` prompt prefix. Loaded
into every Reasonix session's prefix regardless of working directory.
Private to this machine — not committed anywhere.

`;

/**
 * Result of `detectHashMemory`.
 *
 *   - `kind: "memory"`  — input is `#<note>`; write to project REASONIX.md.
 *   - `kind: "memory-global"` — input is `#g <note>`; write to global file.
 *   - `kind: "escape"`  — input started with `\#`; submit `#foo` literally.
 *   - returning `null`  — input is unrelated to hash mode.
 */
export type HashMemoryParse =
  | { kind: "memory"; note: string }
  | { kind: "memory-global"; note: string }
  | { kind: "escape"; text: string };

/**
 * Classify a hash-prefixed input. Pure — no filesystem touch — so it's
 * trivially testable and can run before any I/O decision in handleSubmit.
 *
 * Order of checks matters:
 *   1. `\#…` escape (so `\#g foo` ALSO escapes — user can send `#g foo`
 *      to the model verbatim).
 *   2. `##…` markdown heading (level-2+ passes through unchanged).
 *   3. `#g <body>` — global memory. Requires whitespace after the `g` so
 *      a note that happens to start with `g` (e.g. `#good idea`) doesn't
 *      route to global by accident.
 *   4. `#<body>` — project memory.
 */
export function detectHashMemory(text: string): HashMemoryParse | null {
  if (text.startsWith("\\#")) {
    return { kind: "escape", text: text.slice(1) };
  }
  if (!text.startsWith("#")) return null;
  // Markdown headings of level 2+ pass through to the model unchanged.
  // Only a single leading `#` (level-1 heading shape) is ambiguous; we
  // resolve that ambiguity in favor of memory write and document the
  // `\#` escape for users who want a literal H1 in the prompt.
  if (text.startsWith("##")) return null;
  // `#g <note>` — global memory. The space after `g` is mandatory so
  // notes like `#golang preference` route to project memory, not global.
  // `#g` alone (or `#g` + only whitespace) is treated as null — the
  // user clearly wanted the global form but typed no body, so we don't
  // silently fall back to project memory with body=`g`.
  if (/^#g\s*$/.test(text)) return null;
  const globalMatch = /^#g\s+(.+)$/s.exec(text);
  if (globalMatch) {
    const body = globalMatch[1]!.trim();
    if (!body) return null;
    return { kind: "memory-global", note: body };
  }
  const body = text.slice(1).trim();
  if (!body) return null;
  return { kind: "memory", note: body };
}

export interface AppendMemoryResult {
  /** Absolute path written to. */
  path: string;
  /** True iff the file did not exist before this call. */
  created: boolean;
}

/**
 * Append `note` as a single bullet to `<rootDir>/REASONIX.md`. Creates
 * the file with a short header when absent. Inserts a leading newline
 * if the existing file doesn't end with one, so bullets don't collide
 * with the previous section's last line.
 */
export function appendProjectMemory(rootDir: string, note: string): AppendMemoryResult {
  return appendBulletToFile(join(rootDir, PROJECT_MEMORY_FILE), note, PROJECT_HEADER);
}

export const GLOBAL_MEMORY_DIR = ".reasonix";
export const GLOBAL_MEMORY_FILE = "REASONIX.md";

/**
 * Resolve the path to the global memory file. Defaults to
 * `~/.reasonix/REASONIX.md`; callers (mainly tests) can override the
 * home dir to point at a tmpdir.
 */
export function globalMemoryPath(homeDir: string = homedir()): string {
  return join(homeDir, GLOBAL_MEMORY_DIR, GLOBAL_MEMORY_FILE);
}

/**
 * Append `note` to `~/.reasonix/REASONIX.md`. Creates the parent
 * directory + file if either is missing.
 */
export function appendGlobalMemory(note: string, homeDir?: string): AppendMemoryResult {
  return appendBulletToFile(globalMemoryPath(homeDir), note, GLOBAL_HEADER);
}

function appendBulletToFile(path: string, note: string, newFileHeader: string): AppendMemoryResult {
  const trimmed = note.trim();
  if (!trimmed) throw new Error("note body cannot be empty");
  const bullet = `- ${trimmed}\n`;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${newFileHeader}${bullet}`, "utf8");
    return { path, created: true };
  }
  let prefix = "";
  try {
    const existing = readFileSync(path, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
  } catch {
    // Unreadable but exists — let appendFileSync surface the real error.
  }
  appendFileSync(path, `${prefix}${bullet}`, "utf8");
  return { path, created: false };
}
