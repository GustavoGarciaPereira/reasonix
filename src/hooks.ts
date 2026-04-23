/**
 * Hooks — user-defined automation that fires at well-known points in
 * the agent loop. Mirrors the two-scope layout we use for memory and
 * skills:
 *
 *   - `<project>/.reasonix/settings.json` — committable per-project
 *   - `~/.reasonix/settings.json`         — every session
 *
 * A hook is a shell command. We invoke it with stdin = a JSON
 * payload describing the event, and interpret the exit code:
 *
 *   - `0` — pass; loop continues normally
 *   - `2` — block; for `PreToolUse` / `UserPromptSubmit` the
 *     loop refuses to continue with that step and surfaces the
 *     hook's stderr as the reason. For `PostToolUse` / `Stop` block
 *     is meaningless (the action already happened) — treat as warn.
 *   - anything else — warn; loop continues but stderr is rendered
 *     to the user as an inline notice.
 *
 * stdin JSON shape (one envelope per event):
 *
 *   {
 *     "event":    "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop",
 *     "cwd":      "<absolute project root or process.cwd()>",
 *     "toolName": "<string>",   // tool events only
 *     "toolArgs": <unknown>,    // tool events only — already JSON-decoded
 *     "toolResult": "<string>", // PostToolUse only — same body the model sees
 *     "prompt":   "<string>",   // UserPromptSubmit only
 *     "lastAssistantText": "<string>", // Stop only
 *     "turn":     <number>,     // Stop only
 *   }
 *
 * Hooks are executed in order: project scope first, then global.
 * `Pre*` events stop dispatching at the first block; non-block
 * outcomes accumulate into a single report so the UI can render
 * each warning inline.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";

/** All four events as a const array — drives slash listing + validation. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
] as const;

/** Only the gating events can block the loop. */
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "UserPromptSubmit"]);

/** Per-event default timeout. Tool/prompt hooks gate progress, so they're tight. */
const DEFAULT_TIMEOUTS_MS: Record<HookEvent, number> = {
  PreToolUse: 5_000,
  UserPromptSubmit: 5_000,
  PostToolUse: 30_000,
  Stop: 30_000,
};

export type HookScope = "project" | "global";

export interface HookConfig {
  /**
   * Tool-name pattern (PreToolUse / PostToolUse only). Anchored regex.
   * Omitted or `"*"` matches every tool. Ignored for prompt / Stop
   * events (they have no tool name to match against).
   */
  match?: string;
  /** Shell command to run. Spawned through the platform shell. */
  command: string;
  /** Optional human description — surfaced in `/hooks`. */
  description?: string;
  /** Per-hook timeout override in ms. */
  timeout?: number;
  /**
   * Working directory for the spawned process. Defaults to:
   *   - project scope → the project root
   *   - global scope  → process.cwd()
   */
  cwd?: string;
}

/** Shape of `<scope>/.reasonix/settings.json` — only `hooks` for now. */
export interface HookSettings {
  hooks?: Partial<Record<HookEvent, HookConfig[]>>;
}

/** A loaded hook with its origin scope baked in (used for ordering and `/hooks`). */
export interface ResolvedHook extends HookConfig {
  event: HookEvent;
  scope: HookScope;
  /** Absolute path to the settings.json the hook came from. */
  source: string;
}

/** Outcome of a single hook invocation. */
export interface HookOutcome {
  /** Which hook fired. */
  hook: ResolvedHook;
  /**
   * Decision:
   *   - `pass`    — exit 0
   *   - `block`   — exit 2 on a blocking event (otherwise downgraded to `warn`)
   *   - `warn`    — non-zero exit that is not a successful block
   *   - `timeout` — the spawn was killed past `timeout`
   *   - `error`   — could not spawn at all (missing command, etc.)
   */
  decision: "pass" | "block" | "warn" | "timeout" | "error";
  exitCode: number | null;
  /** Captured stdout (trimmed). May be empty. */
  stdout: string;
  /** Captured stderr (trimmed). The block / warn message comes from here. */
  stderr: string;
  durationMs: number;
}

/** Aggregate report for `runHooks`. */
export interface HookReport {
  event: HookEvent;
  outcomes: HookOutcome[];
  /** True iff at least one outcome was a `block` — only meaningful for blocking events. */
  blocked: boolean;
}

export const HOOK_SETTINGS_FILENAME = "settings.json";
export const HOOK_SETTINGS_DIRNAME = ".reasonix";

/** Where the global settings.json lives. Equivalent to `~/.reasonix/settings.json`. */
export function globalSettingsPath(homeDirOverride?: string): string {
  return join(homeDirOverride ?? homedir(), HOOK_SETTINGS_DIRNAME, HOOK_SETTINGS_FILENAME);
}

/** Where the project settings.json lives for a given root. */
export function projectSettingsPath(projectRoot: string): string {
  return join(projectRoot, HOOK_SETTINGS_DIRNAME, HOOK_SETTINGS_FILENAME);
}

function readSettingsFile(path: string): HookSettings | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as HookSettings;
  } catch {
    /* malformed JSON → treat as no hooks; do NOT throw, the user
     * shouldn't lose the whole CLI to a typo in their settings */
  }
  return null;
}

/**
 * Pull every configured hook out of the project + global settings
 * files, in the order they should fire (project first, global second,
 * within each scope: array order from the file).
 *
 * Returns a flat list — the dispatcher filters by event + match
 * pattern at run time. Loading is cheap (one or two JSON files), so
 * we don't memoize across processes; re-load is allowed via
 * `/hooks reload` and on every fresh App mount.
 */
export interface LoadHookSettingsOptions {
  /** Absolute project root, if any. Without it, only global hooks load. */
  projectRoot?: string;
  /** Override `~` for tests. */
  homeDir?: string;
}

export function loadHooks(opts: LoadHookSettingsOptions = {}): ResolvedHook[] {
  const out: ResolvedHook[] = [];
  if (opts.projectRoot) {
    const projPath = projectSettingsPath(opts.projectRoot);
    const settings = readSettingsFile(projPath);
    if (settings) appendResolved(out, settings, "project", projPath);
  }
  const globalPath = globalSettingsPath(opts.homeDir);
  const settings = readSettingsFile(globalPath);
  if (settings) appendResolved(out, settings, "global", globalPath);
  return out;
}

function appendResolved(
  out: ResolvedHook[],
  settings: HookSettings,
  scope: HookScope,
  source: string,
): void {
  if (!settings.hooks) return;
  for (const event of HOOK_EVENTS) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    for (const cfg of list) {
      if (!cfg || typeof cfg.command !== "string" || cfg.command.trim() === "") continue;
      out.push({ ...cfg, event, scope, source });
    }
  }
}

/**
 * True if `toolName` matches the hook's `match` field. `"*"` and
 * undefined match everything. Otherwise we anchor the field as a
 * regex — partial-name matches don't fire, so `"file"` would not
 * trigger on `read_file` (use `".*file"` for that).
 */
export function matchesTool(hook: ResolvedHook, toolName: string): boolean {
  if (hook.event !== "PreToolUse" && hook.event !== "PostToolUse") return true;
  const m = hook.match;
  if (!m || m === "*") return true;
  try {
    const re = new RegExp(`^(?:${m})$`);
    return re.test(toolName);
  } catch {
    /* malformed regex → don't fire (safer than firing on every tool) */
    return false;
  }
}

/** Payload envelope passed to hook stdin. */
export interface HookPayload {
  event: HookEvent;
  cwd: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: string;
  prompt?: string;
  lastAssistantText?: string;
  turn?: number;
}

/** Test seam — same shape as Node's spawn but returns a Promise of the raw outcome bits. */
export interface HookSpawnInput {
  command: string;
  cwd: string;
  stdin: string;
  timeoutMs: number;
}

export interface HookSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True iff spawn() itself failed (ENOENT, EACCES, …). */
  spawnError?: Error;
}

export type HookSpawner = (input: HookSpawnInput) => Promise<HookSpawnResult>;

/**
 * Default spawner — runs `command` through the platform shell so
 * `&&`, pipes, env-var expansion all work without a tokenizer.
 * Stdin is the JSON payload, stdout / stderr are buffered.
 *
 * Why `shell: true`? A hook is intentionally a shell command — that's
 * the contract. Treating it like an argv array would surprise users
 * who write `bun run check && eslint .` and expect it to behave the
 * way it does in their terminal.
 */
function defaultSpawner(input: HookSpawnInput): Promise<HookSpawnResult> {
  return new Promise<HookSpawnResult>((resolve) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // SIGTERM may not land on Windows for shell children — followed
      // by a hard kill a moment later if the process is still around.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 500);
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut: false,
        spawnError: err,
      });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });

    try {
      child.stdin.write(input.stdin);
      child.stdin.end();
    } catch {
      /* stdin write can race with spawn errors; the close handler
       * still fires with exit 0/null */
    }
  });
}

/**
 * Format a hook outcome as a single-line UI string. Used by both the
 * loop (for `warning` events) and the App (for UserPromptSubmit /
 * Stop outcomes). Centralizing keeps the language consistent across
 * scopes.
 */
export function formatHookOutcomeMessage(outcome: HookOutcome): string {
  if (outcome.decision === "pass") return "";
  const detail = (outcome.stderr || outcome.stdout || "").trim();
  const tag = `${outcome.hook.scope}/${outcome.hook.event}`;
  const cmd =
    outcome.hook.command.length > 60
      ? `${outcome.hook.command.slice(0, 60)}…`
      : outcome.hook.command;
  const head = `hook ${tag} \`${cmd}\` ${outcome.decision}`;
  return detail ? `${head}: ${detail}` : head;
}

/**
 * Decide the hook's outcome decision from raw spawn results.
 * Pulled out as a pure function so tests can pin the matrix.
 */
export function decideOutcome(
  event: HookEvent,
  raw: HookSpawnResult,
): "pass" | "block" | "warn" | "timeout" | "error" {
  if (raw.spawnError) return "error";
  if (raw.timedOut) return BLOCKING_EVENTS.has(event) ? "block" : "warn";
  if (raw.exitCode === 0) return "pass";
  if (raw.exitCode === 2 && BLOCKING_EVENTS.has(event)) return "block";
  return "warn";
}

export interface RunHooksOptions {
  payload: HookPayload;
  hooks: ResolvedHook[];
  /** Test seam — defaults to a real `spawn`. */
  spawner?: HookSpawner;
}

/**
 * Filter hooks down to the ones that match `payload.event` (and
 * `payload.toolName`, for tool events), then run them in order.
 * Stops at the first `block` outcome on a blocking event so a
 * gating hook can prevent later hooks from incorrectly seeing a
 * success that wasn't going to happen.
 */
export async function runHooks(opts: RunHooksOptions): Promise<HookReport> {
  const spawner = opts.spawner ?? defaultSpawner;
  const event = opts.payload.event;
  const toolName = opts.payload.toolName ?? "";
  const matching = opts.hooks.filter((h) => h.event === event && matchesTool(h, toolName));

  const outcomes: HookOutcome[] = [];
  let blocked = false;
  const stdin = `${JSON.stringify(opts.payload)}\n`;

  for (const hook of matching) {
    const start = Date.now();
    const timeoutMs = hook.timeout ?? DEFAULT_TIMEOUTS_MS[event];
    const cwd = hook.cwd ?? opts.payload.cwd;
    const raw = await spawner({ command: hook.command, cwd, stdin, timeoutMs });
    const decision = decideOutcome(event, raw);
    outcomes.push({
      hook,
      decision,
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr:
        raw.stderr ||
        (raw.spawnError ? raw.spawnError.message : "") ||
        (raw.timedOut ? `hook timed out after ${timeoutMs}ms` : ""),
      durationMs: Date.now() - start,
    });
    if (decision === "block") {
      blocked = true;
      break;
    }
  }

  return { event, outcomes, blocked };
}
