/**
 * Ollama preflight: detect, prompt, launch.
 *
 * `reasonix index` shouldn't punt the entire setup story to a wall-of-
 * text README. The flow we want, in order:
 *
 *   1. Is the `ollama` binary on PATH?
 *      - No  → print install URL + abort. (We don't run package
 *              managers on the user's behalf — too much blast radius.)
 *      - Yes → continue.
 *
 *   2. Is the daemon reachable on the configured URL?
 *      - No  → ask "Start Ollama daemon now?" → spawn detached, poll
 *              until /api/tags responds (timeout 15s) → continue.
 *      - Yes → continue.
 *
 *   3. Is the embedding model pulled?
 *      - No  → ask "Pull <model> now?" → run `ollama pull <model>`
 *              with streamed progress → continue.
 *      - Yes → continue.
 *
 * Each step is gated on user consent (TTY only) — non-interactive
 * shells (CI, scripts) get a clear error message instead of a hang.
 * Daemon spawn is detached + unref'd so the daemon survives past the
 * Reasonix process; users own its lifecycle from then on.
 */

import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { probeOllama } from "./embedding.js";

export interface OllamaStatus {
  /** `ollama` binary present on PATH. */
  binaryFound: boolean;
  /** HTTP daemon reachable at the configured base URL. */
  daemonRunning: boolean;
  /** True if `<model>` (or `<model>:latest`) appears in `ollama list`. */
  modelPulled: boolean;
  /** Model the caller asked about — echoed for log clarity. */
  modelName: string;
  /** Models the daemon reported, for diagnostics. Empty when daemon down. */
  installedModels: string[];
}

/**
 * Best-effort PATH lookup for `ollama`. We use `which` / `where` over
 * `process.env.PATH` parsing because OS shells (and Windows
 * App-installer entries) handle resolution rules we'd otherwise have
 * to mirror. Synchronous because this runs once at startup, not in a
 * hot loop.
 */
export function findOllamaBinary(): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  const out = spawnSync(cmd, ["ollama"], { encoding: "utf8" });
  if (out.status !== 0) return null;
  const first = out.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  return first ? first.trim() : null;
}

/**
 * Composite status check used by the CLI. Calls `findOllamaBinary` +
 * `probeOllama` and tag-matches `<model>` against the daemon's listed
 * models. Treats `<model>` and `<model>:latest` as the same — Ollama
 * appends `:latest` to plain pulls.
 */
export async function checkOllamaStatus(
  modelName: string,
  baseUrl?: string,
): Promise<OllamaStatus> {
  const binary = findOllamaBinary();
  const probe = await probeOllama({ baseUrl });
  const installedModels = probe.ok ? probe.models : [];
  const wanted = modelName.includes(":") ? modelName : `${modelName}:latest`;
  const modelPulled = installedModels.some((m) => m === modelName || m === wanted);
  return {
    binaryFound: binary !== null,
    daemonRunning: probe.ok,
    modelPulled,
    modelName,
    installedModels,
  };
}

/**
 * Spawn `ollama serve` detached so it survives past our process.
 * Polls /api/tags until it responds OK (or `timeoutMs` elapses);
 * resolves with `ready: true` on success, `ready: false` on timeout
 * so the caller can surface a sensible error without throwing.
 *
 * On Windows we set `windowsHide: true` to avoid a ghost cmd window
 * popping up next to the user's terminal. Output is discarded —
 * users who want daemon logs run `ollama serve` themselves.
 */
export async function startOllamaDaemon(
  opts: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ready: boolean; pid: number | null }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const child = spawn("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const pid = child.pid ?? null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (opts.signal?.aborted) return { ready: false, pid };
    const probe = await probeOllama({ baseUrl: opts.baseUrl, signal: opts.signal });
    if (probe.ok) return { ready: true, pid };
    await sleep(500);
  }
  return { ready: false, pid };
}

/**
 * Run `ollama pull <model>` and stream output to the caller. Resolves
 * with the exit code; non-zero means the pull failed (network down,
 * disk full, model name typo) and the CLI should surface stderr.
 *
 * `onLine` is called per stdout/stderr line so the CLI can render its
 * own progress bar instead of dumping ollama's TTY-aware output verbatim.
 */
export async function pullOllamaModel(
  modelName: string,
  opts: { onLine?: (line: string, stream: "stdout" | "stderr") => void; signal?: AbortSignal } = {},
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn("ollama", ["pull", modelName], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (opts.signal) {
      const onAbort = () => child.kill();
      opts.signal.addEventListener("abort", onAbort, { once: true });
      child.once("exit", () => opts.signal?.removeEventListener("abort", onAbort));
    }
    streamLines(child.stdout, (l) => opts.onLine?.(l, "stdout"));
    streamLines(child.stderr, (l) => opts.onLine?.(l, "stderr"));
    child.once("exit", (code) => resolve(code ?? -1));
    child.once("error", () => resolve(-1));
  });
}

/**
 * Read newline-delimited output from a stream and invoke `cb` per
 * line. Buffers partial lines so a chunk that splits mid-token
 * doesn't fragment the output the user sees.
 */
function streamLines(stream: NodeJS.ReadableStream | null, cb: (line: string) => void): void {
  if (!stream) return;
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.length > 0) cb(line);
      nl = buf.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buf.length > 0) cb(buf.replace(/\r$/, ""));
  });
}
