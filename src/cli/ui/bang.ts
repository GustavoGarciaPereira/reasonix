/**
 * Bash-mode (`!cmd`) prefix parsing.
 *
 * A `!` at the start of the user's input means "run this as a shell
 * command in the sandbox root, and put both the command and its output
 * into the conversation so the model sees it next turn." Same idea as
 * Claude Code's `!` prefix — faster than round-tripping through the
 * model just to cat a file or check git status.
 *
 * Design choice: user-typed `!` commands skip the allowlist. The
 * allowlist exists to bound what the MODEL can do with run_command;
 * the user typing `!git push` by hand is explicit consent. If a user
 * wants stricter gating they can set `REASONIX_BANG_CONFIRM=1` in a
 * future iteration.
 */

/**
 * Return the command portion of a `!`-prefixed input, or `null` if
 * the text isn't a bang invocation. Trims leading/trailing whitespace
 * from the command body. `!` alone (or `!` followed by only whitespace)
 * returns `null` — no command to run.
 */
export function detectBangCommand(text: string): string | null {
  if (!text.startsWith("!")) return null;
  const body = text.slice(1).trim();
  if (!body) return null;
  return body;
}

/**
 * Format a bang command + its output into a single user-role message
 * body that the model will see on the next turn. The `[!cmd]` header
 * marks the run explicitly so the model can distinguish
 * user-typed shell output from its own `run_command` tool results
 * (which are `role: tool`, different message shape entirely).
 */
export function formatBangUserMessage(cmd: string, output: string): string {
  return `[!${cmd}]\n${output}`;
}
