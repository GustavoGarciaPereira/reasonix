# RFC: Memory Layer

**Status:** Draft · 2026-04-22
**Target:** v0.5.0 (estimated 1-2 days)
**Author:** discussion thread between user + assistant

## Motivation

Reasonix persists three things today:

| | Scope | Lifetime | Example |
|---|---|---|---|
| `~/.reasonix/config.json` | Per-user, global | Permanent | API key, preset |
| `~/.reasonix/sessions/<name>.jsonl` | Per-session | Until `/forget` | Conversation log |
| `<repo>/REASONIX.md` | Per-repo, committable | Repo lifetime | House conventions |

What's **missing** is the most useful scope in practice: **per-user
knowledge about a specific project, not committed to the repo**.
Examples R1 should carry across sessions but we can't check into git:

- "User prefers snake_case for new Python modules in this repo."
- "The `DEEPSEEK_API_KEY` lives in 1Password entry 'ds-main'."
- "Last week we decided against auth-strategy X because of compliance."
- "The build command on this machine is `bun run build`, not `npm run
  build` — user has bun but not npm in this shell."

Today every `npx reasonix code` in this directory starts with amnesia
about all of these. R1 re-learns them, user re-corrects, every session.

Claude Code solves this with `~/.claude/projects/<hash>/memory/` —
markdown files pinned into the system prompt at launch. The user is
literally using it right now to remember things about Reasonix. The
pattern works, is simple, and requires no embedding / vector / graph
infrastructure.

## Goals

1. Ship cross-session, cross-project memory that **strengthens prefix
   caching** (Pillar 1) rather than fighting it.
2. Zero new runtime dependencies. Zero new external providers. Zero
   embedding infra.
3. Markdown-first, human-editable. The memory files are a hand-edit
   surface, not a black box.
4. Separation of concerns: `REASONIX.md` stays the committable
   team-level memory; `~/.reasonix/memory/` is the private per-user
   memory.

## Non-goals

- **Semantic recall.** Retrieval is "load the index file into the
  prefix" — no embedding, no BM25, no ranking. If the index grows
  past the cap, we truncate and log a warning; the user trims.
- **Auto-remember without confirmation.** The model can propose a
  memory via the `remember` tool, but writing requires user ✓ by
  default (same gate as `/apply` in `reasonix code`).
  `REASONIX_AUTO_REMEMBER=on` opts in.
- **Multi-user shared memory.** Single-user tool. Team knowledge
  lives in `REASONIX.md` (committed).
- **Memory in non-code chat mode.** For consistency, plain `reasonix`
  (no sandbox) gets only **global** memory; project memory requires
  a sandbox root.

## Architecture

### Directory layout

```
~/.reasonix/
├── config.json                  # existing
├── sessions/                    # existing
└── memory/                      # NEW
    ├── global/
    │   ├── MEMORY.md            # index, always loaded
    │   └── <name>.md            # detail files, loaded on demand
    └── <project-hash>/
        ├── MEMORY.md
        └── <name>.md
```

**`<project-hash>`**: sha1 of the absolute sandbox root path,
truncated to 16 hex chars. Matches how Claude Code hashes project
directories. Stable across sessions but independent per machine.

**Inside sandbox (already exists, unchanged):**
```
<sandbox_root>/REASONIX.md       # committable team memory
```

### Loading into the immutable prefix

Memory extends `ImmutablePrefix.system` after the existing
`REASONIX.md` block. Load sequence on session start:

```
┌───────────────────────────────────────┐
│ base system prompt                    │
├───────────────────────────────────────┤
│ <REASONIX_PROJECT>                    │ ← existing, v0.4.17
│   contents of <root>/REASONIX.md      │   cap 8 KB
│ </REASONIX_PROJECT>                   │
├───────────────────────────────────────┤
│ <MEMORY_GLOBAL>                       │ ← NEW
│   contents of memory/global/MEMORY.md │   cap 4 KB
│ </MEMORY_GLOBAL>                      │
├───────────────────────────────────────┤
│ <MEMORY_PROJECT>                      │ ← NEW
│   contents of <project-hash>/MEMORY.md│   cap 4 KB
│ </MEMORY_PROJECT>                     │
├───────────────────────────────────────┤
│ tool specs, few-shots, etc.           │
└───────────────────────────────────────┘
```

Total memory budget: **16 KB of system prompt** (~4k tokens), split
across the three sections. Individual detail files under
`<name>.md` are **not loaded eagerly** — they're only fetched via
the `recall_memory` tool when R1 decides the one-liner isn't enough.
This is the same pattern the user is relying on right now in Claude
Code, and it keeps the prefix stable.

**Cap enforcement:** exceed cap → truncate to cap, append
`[truncated — run /memory trim or edit MEMORY.md]`. Never fail
loading.

**Missing files:** any of the three blocks may be empty. If MEMORY.md
doesn't exist, block is omitted from the prefix entirely (not an
empty tag — omission keeps prefix hash stable as "never had memory").

### Cache invariants

1. **Session-stable by default.** Memory is read once at session
   start, hashed into the prefix, pinned for the life of the session.
   Same semantics as REASONIX.md.
2. **`remember` / `forget` tool calls rewrite the files but do not
   re-load the prefix mid-session.** The change takes effect next
   session (or `/new` within the same session).
3. **Rationale:** live re-loading would bust cache every
   `remember` call. DeepSeek cache miss on ~100k tokens is not
   catastrophic ($0.03), but it defeats the point. One turn of
   latency between "save" and "uptake" is a fair trade.

### Memory file format

```markdown
---
name: user_prefers_snake_case
description: User prefers snake_case for new Python modules
type: feedback
scope: project
created: 2026-04-22
---

User corrected me on 2026-04-22 when I used camelCase in
src/analysis/*. Their rule: new Python modules use snake_case; legacy
camelCase modules keep their existing style.

**Why:** existing codebase inconsistency — rewriting legacy is out of
scope, but new code should follow PEP 8.

**How to apply:** when creating a new `.py` file, default to
snake_case unless the nearest existing module nearby already uses
camelCase.
```

`type` vocabulary (borrowed from Claude Code's pattern because it
works):

- `user` — user role / skills / preferences
- `feedback` — corrections / confirmed approaches
- `project` — facts about the current work, deadlines, decisions
- `reference` — pointers to external systems (Jira, Linear, dashboards)

`scope`: `global` (stored in `memory/global/`) or `project` (stored
in `memory/<project-hash>/`). Drives which directory the file lives
in.

### MEMORY.md format

One line per memory, under ~150 chars:

```markdown
- [User prefers snake_case](user_prefers_snake_case.md) — snake_case for new Python modules; legacy camelCase kept as-is
- [Bun not npm](bun_not_npm.md) — build command on this machine is `bun run build`
- [Auth decision 2026-04-15](auth_strategy_rejected.md) — strategy X rejected for compliance; current path is Y
```

The index is what's pinned into the prefix. Detail files are recalled
on demand.

MEMORY.md has **no frontmatter**. It's an index, regenerated from the
`.md` file frontmatter whenever `remember` / `forget` run. Users may
also hand-edit it; hand edits are preserved (we only re-sort and
append, never clobber user lines that point to existing files).

## Tool surface

Three new tools registered with R1 (read-only + mutating) + slash
commands.

### `remember`

```ts
{
  name: "remember",
  description:
    "Save a memory for future sessions. Use when the user states a " +
    "preference, corrects your approach, shares a non-obvious fact " +
    "about this project, or explicitly asks you to remember something. " +
    "Don't remember transient task state — only things worth recalling " +
    "next session.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["user", "feedback", "project", "reference"]
      },
      scope: {
        type: "string",
        enum: ["global", "project"],
        description:
          "global = applies across all projects (prefs, tooling); " +
          "project = scoped to this sandbox root (decisions, local facts)"
      },
      name: {
        type: "string",
        description:
          "filename-safe identifier, 3-40 chars, no extension. " +
          "Used as <name>.md on disk."
      },
      description: {
        type: "string",
        description: "one-line summary for MEMORY.md (under 150 chars)"
      },
      content: {
        type: "string",
        description:
          "full memory body in markdown. For feedback/project types, " +
          "structure as: rule/fact, then **Why:** line, then " +
          "**How to apply:** line."
      }
    },
    required: ["type", "scope", "name", "description", "content"]
  }
}
```

Write gate: by default, emits a user confirm prompt showing the
`description` and asking `[y] save / [n] skip / [v] view full`.
`REASONIX_AUTO_REMEMBER=on` skips the prompt. Same UX as the
`/apply` gate in `reasonix code`.

### `forget`

```ts
{
  name: "forget",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      scope: { type: "string", enum: ["global", "project"] }
    },
    required: ["name", "scope"]
  }
}
```

Deletes `<name>.md` and its MEMORY.md line. Confirm prompt same as
`remember`.

### `recall_memory`

```ts
{
  name: "recall_memory",
  description:
    "Read the full body of a memory file when its MEMORY.md " +
    "one-liner doesn't have enough detail. Most of the time the " +
    "one-liner in the pinned index is sufficient — only call this " +
    "when the user's question genuinely requires the full context.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      scope: { type: "string", enum: ["global", "project"] }
    },
    required: ["name", "scope"]
  },
  readOnly: true
}
```

Returns the memory file's body (without frontmatter). No write.

### Slash commands

`/memory` is extended (currently just shows REASONIX.md from v0.4.17):

```
/memory              → show what's currently pinned
                       (REASONIX.md + both MEMORY.md blocks, cap-aware)
/memory list         → list all memory files (both scopes) with sizes
/memory show <name>  → print full content of one memory file
/memory edit <name>  → open in $EDITOR; if unset, print contents + instruct
                       user to edit on disk
/memory forget <name> → shortcut for `forget` tool (no LLM involved)
/memory trim         → interactive UI to pick memories to delete until cap fits
/memory clear <scope> → wipe all memories in scope (typed-confirm)
```

## Interaction with existing features

- **`REASONIX.md` coexists unchanged.** It's still the committable
  project memory. The three blocks (`REASONIX_PROJECT`,
  `MEMORY_GLOBAL`, `MEMORY_PROJECT`) are distinct and
  independently capped. No migration, no behavior change for users
  who don't adopt memory.
- **`REASONIX_MEMORY=off`** extends to disable this layer too. The
  flag was originally for REASONIX.md only (v0.4.17); broaden it to
  mean "all memory sources off." Opt-out for CI / offline repro /
  privacy.
- **`--no-session`** (ephemeral mode): memory IS still loaded (the
  source is files on disk, not the session log). If the user wants
  truly ephemeral, combine with `REASONIX_MEMORY=off`.
- **`/new`** inside a live session: re-loads memory, picks up any
  `remember` calls made in the previous chat. Same mechanism as
  REASONIX.md's re-read on `/new`.
- **`reasonix code <subdir>`**: `<project-hash>` is the hash of the
  passed subdir, not the caller's cwd. So `reasonix code src/` and
  `reasonix code .` get different project memories by design —
  match the sandbox.
- **Plain `reasonix` / `reasonix chat`** (no sandbox): global
  memory loads, project memory does not (no sandbox root to hash).

## Privacy and safety

1. **Local only.** `~/.reasonix/memory/` is per-user, per-machine.
   Never transmitted except as part of the DeepSeek API call system
   prompt (which is pinned context, same as any prompt content).
2. **Not committed.** Directory is user-home, outside any repo.
   Users can't accidentally check it in.
3. **Prompt injection surface.** A malicious file content read by R1
   (e.g. `README.md` in an untrusted clone) could emit a `remember`
   tool call with crafted content. Mitigations:
   - Default-on confirm gate on `remember` shows the full content
     before writing.
   - `REASONIX_AUTO_REMEMBER=on` is the user's choice, not the
     default.
   - MEMORY.md entries are one-liners — a crafted long entry is
     visibly out of place in `/memory list`.
4. **Inspection.** `/memory` is the user-visible proof of what's
   pinned. If anything looks wrong, `/memory forget <name>` removes
   it on the spot.

## Implementation sketch

New module `src/memory.ts`:

```ts
export interface MemoryEntry {
  name: string;
  type: "user" | "feedback" | "project" | "reference";
  scope: "global" | "project";
  description: string;
  body: string;
  createdAt: Date;
}

export class MemoryStore {
  constructor(opts: { homeDir: string; projectRoot?: string });

  /** Read MEMORY.md for a scope. Returns truncated-to-cap content. */
  loadIndex(scope: "global" | "project"): string | null;

  /** Write a new memory file + update MEMORY.md. */
  write(entry: Omit<MemoryEntry, "createdAt">): Promise<void>;

  /** Delete a memory file + remove from MEMORY.md. */
  delete(scope: "global" | "project", name: string): Promise<void>;

  /** Read one memory's full body. */
  read(scope: "global" | "project", name: string): Promise<string>;

  /** List all memories with sizes. */
  list(): Promise<MemoryEntry[]>;
}
```

Wire-up:

- `src/project-memory.ts` (v0.4.17) already has the REASONIX.md
  loader. Extend its `loadIntoSystem()` helper to concatenate the
  two MEMORY.md blocks after REASONIX.md.
- `src/tools/memory.ts` new file — registers `remember` / `forget` /
  `recall_memory` via `ToolRegistry`.
- CLI entry points (`chat`, `run`, `code`) already call the
  project-memory loader; no new call sites needed.
- Slash command handlers in `App.tsx` gain the `/memory list`,
  `/memory show`, `/memory edit`, `/memory trim`, `/memory clear`
  branches. `/memory forget <name>` routes through `MemoryStore`
  directly (no LLM turn).

## Rollout

### v0.5.0 (target 1-2 days)

- `src/memory.ts` + unit tests (write/read/delete, MEMORY.md
  regeneration, filename sanitization, cap enforcement)
- `src/tools/memory.ts` + tool-registration tests
- Extend `src/project-memory.ts` to include the two MEMORY.md blocks
- Extend `/memory` slash with the 7 sub-forms
- Write gate UI in `App.tsx` matching the `/apply` pattern
- `REASONIX_AUTO_REMEMBER` env + `REASONIX_MEMORY=off` extension
- README: new subsection under "Project memory — REASONIX.md"
  explaining the three scopes
- Test count target: +20-25 tests (current baseline 542 → ~565)

### Deferred (v0.5.1+, only if users ask)

- Memory conflict detection (`remember` with name that exists →
  prompt merge vs overwrite)
- Memory export/import (`reasonix memory export` / `import` for
  machine migration)
- Memory search over bodies (keyword match, no embedding —
  `/memory grep <pattern>`)

## Open questions

1. **`edit` subcommand when `$EDITOR` is unset.** On Windows
   especially, `$EDITOR` is often unset. Fallback: print contents to
   scrollback, tell user the path, reload on `/new`. Acceptable?
2. **Cap choice of 4 KB per MEMORY.md.** The user's Claude Code
   memory (which works fine) is ~15 entries ≈ 2 KB. 4 KB gives
   headroom without eating the context budget. If users hit it, we
   revisit — not over-engineering day one.
3. **Confirm gate UX for `remember`.** Should the description alone
   be enough, or always show the full `content`? Proposal: show
   description + first 200 chars of content, `[v]` to expand. Matches
   how `/apply` shows SEARCH/REPLACE previews truncated.
4. **Do we let the global system prompt itself instruct R1 when to
   call `remember`?** Adding `"If the user expresses a preference,
   correction, or asks you to remember something, call remember."`
   to the system prompt makes memory actually populate over time.
   Without it, R1 will rarely initiate. Worth including — but
   measure prefix-hash impact (one static sentence, should be fine
   for caching).

## Why this is different from the symbol-index RFC we killed

- **Strengthens Pillar 1 (cache).** More stable prefix content ⇒
  higher hit rate. The symbol index was cache-neutral.
- **Zero new dependencies.** Just filesystem I/O + existing
  frontmatter parsing (the markdown memory files use the same
  `gray-matter`-style frontmatter we can parse with ~20 lines of
  regex; no dep needed).
- **Bounded complexity.** No parsers, no watchers, no workers, no
  incremental indexing, no graph traversal. It's a file loader.
- **Generalizes to plain `reasonix`.** The symbol index only helped
  `reasonix code`. Memory helps every entry point.
- **User-visible surface is 7 slash commands + 3 tools.** The
  symbol index's user-visible surface was 3 tools + 2 slashes but
  its hidden surface (SQLite file, wasm grammars, watcher, schema
  migrations) was ~10× larger.

## Success criteria

v0.5.0 ships if:

1. A fresh `npx reasonix code` in an empty directory adds 0 files
   and loads in the same time as v0.4.17 (no regression when the
   user never uses memory).
2. After a session where `remember` was called 3 times, opening a
   new shell and running `npx reasonix code` in the same directory
   shows the 3 memories in `/memory` and R1 references them
   appropriately in the next turn.
3. `/memory clear project` with typed-confirm wipes only the project
   scope, leaves `global` intact.
4. Running `reasonix code` with `REASONIX_MEMORY=off` loads neither
   REASONIX.md nor any MEMORY.md (verified by `/status` showing the
   prefix byte length).
5. `+20-25` tests, no regressions, lint / tsc / build clean.
