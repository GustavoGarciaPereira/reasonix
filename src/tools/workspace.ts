/**
 * `change_workspace` — model-callable workspace switching, gated on
 * an explicit user confirmation in the TUI.
 *
 * The tool function itself never performs the switch. It validates
 * the requested path and throws {@link WorkspaceConfirmationError},
 * which the loop serializes into the tool result. App.tsx detects the
 * marker, mounts a confirmation modal, and on approval drives the
 * actual `setCwd` callback (the same one the `/cwd` slash uses).
 *
 * Why this shape (mirrors `run_command`):
 *   - The tool fn is pure / synchronous — no React or App-state
 *     coupling lives in tools/.
 *   - The model gets a clear "stop and wait" message in the tool
 *     result, which prevents a chain of switches before the user
 *     has had a chance to confirm even one.
 *   - Approval / denial flow back through a synthetic user message,
 *     so the model sees outcome on its next turn.
 *
 * Why no `always_allow`: workspace switches are per-target by nature
 * (each target is a different project root with different secrets,
 * different .gitignore, different memory); there's no useful "I trust
 * the model to switch to ANY directory it picks" allowlist semantics.
 * The modal offers Switch / Deny only.
 */

import { existsSync, statSync } from "node:fs";
import * as pathMod from "node:path";
import type { ToolRegistry } from "../tools.js";

export class WorkspaceConfirmationError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `change_workspace: switching to "${path}" needs the user's approval before it takes effect. STOP calling tools now — the TUI has already prompted the user to press Enter (switch) or Esc (deny). Wait for their next message; it will either confirm the switch (and your subsequent file/shell tools will resolve against the new root) or tell you to continue without changing directories.`,
    );
    this.name = "WorkspaceConfirmationError";
    this.path = path;
  }
}

export interface ChangeWorkspaceArgs {
  path: string;
}

/**
 * Register `change_workspace` on `registry`. The tool always throws
 * `WorkspaceConfirmationError(absolutePath)` after path validation —
 * the actual swap happens in App.tsx when the user approves the
 * modal. Path validation matches `/cwd`'s: must exist, must be a
 * directory, supports `~` expansion and relative paths (resolved
 * against `process.cwd()` at call time, NOT the session root, so
 * a model emitting `~/projects/foo` lands where the user expects).
 */
export function registerWorkspaceTool(registry: ToolRegistry): ToolRegistry {
  registry.register({
    name: "change_workspace",
    description:
      "Switch the session's working directory to a different project root. Re-registers filesystem / shell / memory tools against the new path so subsequent file reads, edits, and run_command calls all land there. EVERY switch requires explicit user approval via a modal — do NOT batch switches or chain a switch with subsequent tool calls before the user has confirmed. Use ONLY when the user explicitly asked to change directory or open a different project; never use to 'preview' a sibling repo. MCP servers stay anchored to the original launch root (their child processes can't be reconnected mid-session); the modal warns the user about this.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description:
            "Target directory. Absolute paths land verbatim. Leading `~` expands to the user's home. Relative paths resolve against the user's launch cwd (not the current session root, so paths the user typed in chat resolve where they expect).",
        },
      },
    },
    fn: (rawArgs) => {
      const args = (rawArgs ?? {}) as Partial<ChangeWorkspaceArgs>;
      if (typeof args.path !== "string" || args.path.trim() === "") {
        throw new Error("change_workspace: `path` must be a non-empty string");
      }
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const expanded =
        args.path.startsWith("~") && home ? pathMod.join(home, args.path.slice(1)) : args.path;
      const abs = pathMod.resolve(expanded);
      if (!existsSync(abs)) {
        throw new Error(`change_workspace: path does not exist — ${abs}`);
      }
      try {
        if (!statSync(abs).isDirectory()) {
          throw new Error(`change_workspace: not a directory — ${abs}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`change_workspace: path does not exist — ${abs}`);
        }
        throw err;
      }
      // Always defer to the user. The tool itself does not switch —
      // approval drives the swap in App.tsx.
      throw new WorkspaceConfirmationError(abs);
    },
  });
  return registry;
}
