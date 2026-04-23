/**
 * Native shell tool — lets the model run commands inside the sandbox
 * root so it can actually verify its own work (run tests, check git
 * status, inspect a lockfile, etc.). Without this the coding-mode
 * loop is "write code, hope it works, ask the user to run it" —
 * defeats the purpose.
 *
 * Safety model:
 *   - Commands run with `cwd` pinned to the registered root. No
 *     path traversal via the command itself is enforced (users can
 *     `cat ../outside.txt`); the trust boundary is the directory
 *     you opened Reasonix from.
 *   - Commands are matched against a read-only / testing allowlist.
 *     Allowlisted commands execute immediately and return stdout +
 *     stderr merged. Everything else throws with a clear message —
 *     the UI translates that into an `/apply`-style confirm gate so
 *     the user sees the exact command before it runs.
 *   - Default timeout: 60s. Output cap: matches tool-result budget.
 *   - Every command that DOES run is spawned with `shell: false` and
 *     a tokenized argv — no string-to-shell interpolation, so the
 *     model can't accidentally construct a chained `rm` via quoting.
 *
 * This is intentionally narrower than what Claude Code / Aider ship:
 * we gate more commands behind confirmation by default. Users who
 * trust the model can widen the allowlist by instantiating their
 * own tool registry.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as pathMod from "node:path";
import type { ToolRegistry } from "../tools.js";

export interface ShellToolsOptions {
  /** Directory to run commands in. Must be an absolute path. */
  rootDir: string;
  /** Seconds before an individual command is killed. Default: 60. */
  timeoutSec?: number;
  /**
   * Per-command stdout+stderr cap in characters. Default: 32_000 to
   * match the tool-result budget.
   */
  maxOutputChars?: number;
  /**
   * Extra command-name prefixes the user explicitly trusts. Added on
   * top of the built-in allowlist. Examples: `["my-ci-script", "lint"]`.
   */
  extraAllowed?: string[];
  /**
   * When true, skip the allowlist entirely and auto-run every command.
   * Off by default — this is an escape hatch for non-interactive use
   * (CI, benchmarks) where a human can't be in the loop to confirm.
   */
  allowAll?: boolean;
}

const DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_MAX_OUTPUT_CHARS = 32_000;

/**
 * Command prefixes we consider safe to run without asking the user.
 * Rule of thumb: read-only reports, or test runners whose failure mode
 * is "exit 1 with output." Nothing that can rewrite state, escalate,
 * or touch the network.
 */
const BUILTIN_ALLOWLIST: ReadonlyArray<string> = [
  // Repo inspection
  "git status",
  "git diff",
  "git log",
  "git show",
  "git blame",
  "git branch",
  "git remote",
  "git rev-parse",
  "git config --get",
  // Filesystem inspection
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "tree",
  "find",
  "grep",
  "rg",
  // Language version probes
  "node --version",
  "node -v",
  "npm --version",
  "npx --version",
  "python --version",
  "python3 --version",
  "cargo --version",
  "go version",
  "rustc --version",
  "deno --version",
  "bun --version",
  // Test runners (non-destructive by convention)
  "npm test",
  "npm run test",
  "npx vitest run",
  "npx vitest",
  "npx jest",
  "pytest",
  "python -m pytest",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "go test",
  "go vet",
  "deno test",
  "bun test",
  // Linters / typecheckers (read-only by convention)
  "npm run lint",
  "npm run typecheck",
  "npx tsc --noEmit",
  "npx biome check",
  "npx eslint",
  "npx prettier --check",
  "ruff",
  "mypy",
];

/**
 * Tokenize a shell-ish command string into argv. Handles single/double
 * quoting; rejects unclosed quotes. Does NOT expand env vars, globs,
 * backticks, or `$(…)` — the goal is to prevent the model from
 * accidentally (or not) sneaking arbitrary shells past the allowlist
 * via concatenation. Exported for testing.
 */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (quote) throw new Error(`unclosed ${quote} in command`);
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Return true when `cmd` matches an allowlisted prefix. Exported for
 * testing. Match is on the space-normalized leading tokens so
 * `git   status  -s ` and `git status` both match `git status`.
 */
export function isAllowed(cmd: string, extra: readonly string[] = []): boolean {
  const normalized = cmd.trim().replace(/\s+/g, " ");
  const allowlist = [...BUILTIN_ALLOWLIST, ...extra];
  for (const prefix of allowlist) {
    if (normalized === prefix) return true;
    if (normalized.startsWith(`${prefix} `)) return true;
  }
  return false;
}

export interface RunCommandResult {
  exitCode: number | null;
  /** Combined stdout+stderr, truncated to `maxOutputChars` with a marker. */
  output: string;
  /** True when the process was killed for exceeding `timeoutSec`. */
  timedOut: boolean;
}

export async function runCommand(
  cmd: string,
  opts: {
    cwd: string;
    timeoutSec?: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
  },
): Promise<RunCommandResult> {
  const argv = tokenizeCommand(cmd);
  if (argv.length === 0) throw new Error("run_command: empty command");
  const timeoutMs = (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    shell: false, // no shell-expansion — see header comment
    windowsHide: true,
    env: process.env,
  };

  // Windows: two layered fixes on top of shell:false —
  //   1. Resolve bare command names via PATH × PATHEXT (CreateProcess
  //      ignores PATHEXT, so `npm` alone misses `npm.cmd`).
  //   2. Node 21.7.3+ (CVE-2024-27980) refuses to spawn `.cmd`/`.bat`
  //      directly even with shell:false and safe args — throws
  //      EINVAL at invocation time. Wrap those via `cmd.exe /d /s /c`
  //      with verbatim args + manual quoting, so shell metacharacters
  //      in arguments stay literal.
  // Unix path is unchanged.
  const { bin, args, spawnOverrides } = prepareSpawn(argv);
  const effectiveSpawnOpts = { ...spawnOpts, ...spawnOverrides };

  return await new Promise<RunCommandResult>((resolve, reject) => {
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(bin, args, effectiveSpawnOpts);
    } catch (err) {
      reject(err);
      return;
    }
    let buf = "";
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      // Soft cap: we let the process keep running (killing early could
      // hide a real failure), but we stop growing the buffer past 2×
      // the cap so a chatty test can't OOM us.
      if (buf.length > maxChars * 2) buf = `${buf.slice(0, maxChars * 2)}`;
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      const output =
        buf.length > maxChars
          ? `${buf.slice(0, maxChars)}\n\n[… truncated ${buf.length - maxChars} chars …]`
          : buf;
      resolve({ exitCode: code, output, timedOut });
    });
  });
}

/**
 * Test/override hooks for {@link resolveExecutable}. Omitting any field
 * falls through to the real process globals — the runtime call path
 * uses defaults; tests inject `platform` + `env` + `isFile` to exercise
 * Windows-specific lookup from a Linux CI runner without touching
 * actual fs.
 */
export interface ResolveExecutableOptions {
  platform?: NodeJS.Platform;
  env?: { PATH?: string; PATHEXT?: string };
  /** Predicate swapped in by tests to avoid creating real files. */
  isFile?: (path: string) => boolean;
  /** Path.join used for the lookup. Defaults to Windows semantics on Windows. */
  pathDelimiter?: string;
}

/**
 * Resolve a bare command name (e.g. `npm`) to its on-disk path via
 * PATH × PATHEXT on Windows. Returns the input unchanged on non-Windows
 * platforms, when the input is already a path (contains `/`, `\`, or is
 * absolute), or when no match is found in PATH × PATHEXT (caller gets a
 * natural ENOENT from spawn, which surfaces cleanly).
 *
 * Why this exists: `child_process.spawn` with `shell: false` invokes
 * Windows `CreateProcess`, which does not honor `PATHEXT` and does not
 * search for `.cmd` / `.bat` wrappers. Node-ecosystem tools ship as
 * `npm.cmd`, `npx.cmd`, `yarn.cmd`, etc., so a bare `npm` fails with
 * ENOENT under `shell: false`. Flipping to `shell: true` would work
 * but reintroduces shell-expansion (pipes, redirects, chained cmds)
 * that the tool was explicitly designed to forbid. This resolver
 * threads the needle.
 */
export function resolveExecutable(cmd: string, opts: ResolveExecutableOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return cmd;
  if (!cmd) return cmd;
  // Already a path fragment — spawn handles these natively.
  if (cmd.includes("/") || cmd.includes("\\") || pathMod.isAbsolute(cmd)) return cmd;
  // If the model wrote `npm.cmd` explicitly, respect that verbatim.
  if (pathMod.extname(cmd)) return cmd;

  const env = opts.env ?? process.env;
  const pathExt = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const delimiter = opts.pathDelimiter ?? (platform === "win32" ? ";" : pathMod.delimiter);
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const isFile = opts.isFile ?? defaultIsFile;

  for (const dir of pathDirs) {
    for (const ext of pathExt) {
      // Force win32 join so CI tests that pass `platform: "win32"`
      // from a Linux runner get backslash-joined paths; the real-
      // Windows runtime path lands here too and gets the correct
      // separator regardless of where pathMod defaults.
      const full = pathMod.win32.join(dir, cmd + ext);
      if (isFile(full)) return full;
    }
  }
  return cmd;
}

function defaultIsFile(full: string): boolean {
  try {
    return existsSync(full) && statSync(full).isFile();
  } catch {
    return false;
  }
}

/**
 * Prepare `(bin, args, spawnOpts)` for the runCommand spawn call,
 * applying Windows-specific workarounds for (a) PATHEXT lookup and
 * (b) the CVE-2024-27980 prohibition on direct `.cmd`/`.bat` spawns.
 *
 * Exported so tests can assert the transformation without booting an
 * actual child process.
 */
export function prepareSpawn(
  argv: readonly string[],
  opts: ResolveExecutableOptions = {},
): { bin: string; args: string[]; spawnOverrides: SpawnOptions } {
  const head = argv[0] ?? "";
  const tail = argv.slice(1);
  const platform = opts.platform ?? process.platform;
  const resolved = resolveExecutable(head, opts);

  if (platform !== "win32") {
    return { bin: resolved, args: [...tail], spawnOverrides: {} };
  }

  // `.cmd` / `.bat` wrappers require cmd.exe on post-CVE Node.
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const cmdline = [resolved, ...tail].map(quoteForCmdExe).join(" ");
    return {
      bin: "cmd.exe",
      args: ["/d", "/s", "/c", cmdline],
      // windowsVerbatimArguments prevents Node from re-quoting the /c
      // payload — we've already composed an exact cmd.exe command
      // line. Without this Node wraps our already-quoted string in
      // another round of quotes and cmd.exe can't parse it.
      spawnOverrides: { windowsVerbatimArguments: true },
    };
  }

  return { bin: resolved, args: [...tail], spawnOverrides: {} };
}

/**
 * Quote an argument so cmd.exe parses it back as a single token. We
 * always wrap in double quotes when the arg contains whitespace or
 * any cmd.exe metacharacter, doubling embedded quotes per cmd.exe's
 * `""` escape rule. Bare alphanumeric args pass through unquoted for
 * readability in logs.
 *
 * Exported for test coverage of the quoting semantics.
 */
export function quoteForCmdExe(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^%(),;!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Error thrown by `run_command` when the command isn't allowlisted. */
export class NeedsConfirmationError extends Error {
  readonly command: string;
  constructor(command: string) {
    super(
      `run_command: "${command}" needs the user's approval before it runs. STOP calling tools now — the TUI has already prompted the user to press y (run) or n (deny). Wait for their next message; it will either be the command's output (if they approved) or an instruction to continue without it (if they denied). Don't retry the command or call other shell commands in the meantime.`,
    );
    this.name = "NeedsConfirmationError";
    this.command = command;
  }
}

export function registerShellTools(registry: ToolRegistry, opts: ShellToolsOptions): ToolRegistry {
  const rootDir = pathMod.resolve(opts.rootDir);
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const extraAllowed = opts.extraAllowed ?? [];
  const allowAll = opts.allowAll ?? false;

  registry.register({
    name: "run_command",
    description:
      "Run a shell command in the project root and return its combined stdout+stderr. Common read-only inspection and test/lint/typecheck commands run immediately; anything that could mutate state, install dependencies, or touch the network is refused until the user confirms it in the TUI. Prefer this over asking the user to run a command manually — after edits, run the project's tests to verify.",
    // Plan-mode gate: allow allowlisted commands through (git status,
    // cargo check, ls, grep …) so the model can actually investigate
    // during planning. Anything that would otherwise trigger a
    // confirmation prompt is treated as "not read-only" and bounced.
    readOnlyCheck: (args: { command?: unknown }) => {
      if (allowAll) return true;
      const cmd = typeof args?.command === "string" ? args.command.trim() : "";
      if (!cmd) return false;
      return isAllowed(cmd, extraAllowed);
    },
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Full command line. Tokenized with POSIX-ish quoting; no shell expansion, no pipes, no redirects.",
        },
        timeoutSec: {
          type: "integer",
          description: `Override the default ${timeoutSec}s timeout for a single command.`,
        },
      },
      required: ["command"],
    },
    fn: async (args: { command: string; timeoutSec?: number }, ctx) => {
      const cmd = args.command.trim();
      if (!cmd) throw new Error("run_command: empty command");
      if (!allowAll && !isAllowed(cmd, extraAllowed)) {
        throw new NeedsConfirmationError(cmd);
      }
      const effectiveTimeout = Math.max(1, Math.min(600, args.timeoutSec ?? timeoutSec));
      const result = await runCommand(cmd, {
        cwd: rootDir,
        timeoutSec: effectiveTimeout,
        maxOutputChars,
        signal: ctx?.signal,
      });
      return formatCommandResult(cmd, result);
    },
  });

  return registry;
}

export function formatCommandResult(cmd: string, r: RunCommandResult): string {
  const header = r.timedOut
    ? `$ ${cmd}\n[killed after timeout]`
    : `$ ${cmd}\n[exit ${r.exitCode ?? "?"}]`;
  return r.output ? `${header}\n${r.output}` : header;
}
