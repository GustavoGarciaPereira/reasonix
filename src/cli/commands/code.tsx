/**
 * `reasonix code [dir]` — opinionated wrapper around `reasonix chat` for
 * code-editing workflows.
 *
 * What it does differently from plain chat:
 *   - Auto-bridges the official filesystem MCP server rooted at the
 *     given directory (CWD by default). No wizard, no config merge.
 *   - Uses a coding-focused system prompt (src/code/prompt.ts) that
 *     teaches the model to propose edits as SEARCH/REPLACE blocks.
 *   - Defaults to the `smart` preset (reasoner + harvest) because
 *     coding tasks pay back R1 thinking.
 *   - Scopes its session to the directory so projects don't share
 *     conversation history.
 *   - Hooks `codeMode` into the TUI so assistant replies get parsed
 *     for SEARCH/REPLACE blocks and applied on disk after each turn.
 *
 * Out of scope for v1: /commit, /undo, diff preview, .gitignore
 * filtering. The user's own `git diff` + `git checkout` is the review
 * / undo surface for now.
 */

import { basename, resolve } from "node:path";
import { sanitizeName } from "../../session.js";
import { chatCommand } from "./chat.js";

export interface CodeOptions {
  /** Directory to root the filesystem MCP at. Defaults to process.cwd(). */
  dir?: string;
  /** Override the default `smart` model. */
  model?: string;
  /** Disable session persistence. */
  noSession?: boolean;
  /** Transcript file for replay/diff. */
  transcript?: string;
}

export async function codeCommand(opts: CodeOptions = {}): Promise<void> {
  const { codeSystemPrompt } = await import("../../code/prompt.js");
  const rootDir = resolve(opts.dir ?? process.cwd());
  // Per-directory session so switching projects doesn't mix histories.
  // `code-<sanitized-basename>` fits the session name rules without
  // truncating most project names.
  const session = opts.noSession ? undefined : `code-${sanitizeName(basename(rootDir))}`;
  // Filesystem MCP spec pointing at rootDir. Quote the path in case it
  // has spaces — the existing shellSplit inside parseMcpSpec understands
  // double quotes.
  const fsSpec = `filesystem=npx -y @modelcontextprotocol/server-filesystem ${quoteIfNeeded(rootDir)}`;

  process.stderr.write(
    `▸ reasonix code: rooted at ${rootDir}, session "${session ?? "(ephemeral)"}"\n`,
  );

  await chatCommand({
    model: opts.model ?? "deepseek-reasoner",
    harvest: true, // smart preset's harvest setting, always on for code
    system: codeSystemPrompt(rootDir),
    transcript: opts.transcript,
    session,
    mcp: [fsSpec],
    codeMode: { rootDir },
  });
}

function quoteIfNeeded(s: string): string {
  return /\s|"/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}
