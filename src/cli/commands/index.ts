/**
 * `reasonix index` — build (or incrementally refresh) the project's
 * semantic search index.
 *
 * Usage:
 *   reasonix index                  # incremental: only re-embeds changed files
 *   reasonix index --rebuild        # wipe + rebuild from scratch
 *   reasonix index --model MODEL    # override embedding model
 *   reasonix index --dir PATH       # index a different directory
 *
 * Output is rendered to stderr so piping the index to a script
 * (which we don't actually do today, but might) keeps stdout clean.
 *
 * On a TTY the progress writer paints `<spinner> <status>  <elapsed>s`
 * on a single line, ticking every 120ms via setInterval — so the
 * line keeps animating even between onProgress events. That's the
 * load-bearing UX guarantee: builds that take 30+ seconds never
 * leave the user wondering whether the process is hung.
 *
 * On non-TTY (CI, piped logs) we emit one line per phase + a
 * periodic heartbeat. No \r tricks because they make logs unreadable.
 */

import { resolve } from "node:path";
import { buildIndex } from "../../index/semantic/builder.js";
import type { BuildProgress, BuildResult } from "../../index/semantic/builder.js";
import { t } from "../../index/semantic/i18n.js";
import { ollamaPreflight } from "../../index/semantic/preflight.js";

export interface IndexCommandOptions {
  rebuild?: boolean;
  model?: string;
  dir?: string;
  /** Ollama base URL override. */
  ollamaUrl?: string;
  /** Skip preflight prompts (yes to all). For scripts that already
   *  know Ollama is set up. Default false. */
  yes?: boolean;
}

export async function indexCommand(opts: IndexCommandOptions = {}): Promise<void> {
  const root = resolve(opts.dir ?? process.cwd());
  const tty = process.stderr.isTTY === true && process.stdin.isTTY === true;
  const model = opts.model ?? process.env.REASONIX_EMBED_MODEL ?? "nomic-embed-text";

  // Preflight: detect Ollama state and offer to fix what's missing.
  // Runs before chunking so the user doesn't watch a scan finish only
  // to hit "daemon not reachable" on the first embed call.
  const preflightOk = await ollamaPreflight({
    model,
    baseUrl: opts.ollamaUrl,
    interactive: tty && !opts.yes,
    yesToAll: opts.yes ?? false,
  });
  if (!preflightOk) process.exit(1);

  const writer = makeProgressWriter(tty);

  const t0 = Date.now();
  let result: BuildResult;
  try {
    result = await buildIndex(root, {
      rebuild: opts.rebuild,
      model,
      baseUrl: opts.ollamaUrl,
      onProgress: (p) => writer.update(p),
    });
  } catch (err) {
    writer.clear();
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(t("indexFailed", { msg }));
    process.exit(1);
  }
  writer.clear();

  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const successKey = result.chunksSkipped > 0 ? "indexSuccessWithSkips" : "indexSuccess";
  process.stderr.write(
    t(successKey, {
      scanned: result.filesScanned,
      changed: result.filesChanged,
      added: result.chunksAdded,
      removed: result.chunksRemoved,
      skipped: result.chunksSkipped,
      seconds,
    }),
  );
  if (result.filesChanged === 0 && !opts.rebuild) {
    process.stderr.write(t("indexNothingToDo"));
  }
}

interface ProgressWriter {
  update(p: BuildProgress): void;
  clear(): void;
}

/**
 * Braille spinner — same alphabet most CLI spinners use. Ten frames,
 * cycled at ~120ms each. Visually clear that the process is alive
 * even when no progress events fire (e.g. during phase transitions
 * or while waiting on Ollama's first model-load latency).
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;

function makeProgressWriter(tty: boolean): ProgressWriter {
  if (!tty) return makeNonTtyWriter();
  return makeTtyWriter();
}

/**
 * Non-TTY writer — one line per phase transition + a heartbeat every
 * 50 embedded chunks. Keeps logs short and parseable while still
 * proving forward motion.
 */
function makeNonTtyWriter(): ProgressWriter {
  let lastPhase: BuildProgress["phase"] | null = null;
  let lastChunks = 0;
  return {
    update(p) {
      if (p.phase !== lastPhase) {
        lastPhase = p.phase;
        if (p.phase === "scan") {
          process.stderr.write(t("progressScanLine"));
        } else if (p.phase === "embed") {
          process.stderr.write(
            t("progressEmbedLine", {
              total: p.chunksTotal ?? 0,
              files: p.filesChanged ?? 0,
            }),
          );
        }
      }
      if (p.phase === "embed" && p.chunksDone !== undefined && p.chunksDone - lastChunks >= 50) {
        lastChunks = p.chunksDone;
        process.stderr.write(
          t("progressEmbedHeartbeat", {
            done: p.chunksDone,
            total: p.chunksTotal ?? "?",
          }),
        );
      }
    },
    clear() {
      /* non-TTY keeps its accumulated lines */
    },
  };
}

/**
 * TTY writer — paints `<spinner> <status>  <elapsed>s` on a single
 * line via \r. The spinner ticks on a setInterval, INDEPENDENT of
 * onProgress events: even if the embedder hangs for 5 seconds on
 * the first model-load, the spinner keeps spinning so the user sees
 * the process is alive.
 */
function makeTtyWriter(): ProgressWriter {
  let status = t("progressStarting");
  let lastLineLen = 0;
  let frameIdx = 0;
  const startTs = Date.now();

  const repaint = () => {
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length];
    frameIdx++;
    const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
    const line = `${frame} ${status}  ${elapsed}s`;
    const padded = line + " ".repeat(Math.max(0, lastLineLen - line.length));
    process.stderr.write(`\r${padded}`);
    lastLineLen = line.length;
  };

  // Paint the initial frame immediately so the user sees text on
  // line one — don't wait for the first interval tick.
  repaint();
  const interval = setInterval(repaint, SPINNER_INTERVAL_MS);

  return {
    update(p) {
      if (p.phase === "scan") {
        status = t("progressScan", { files: p.filesScanned ?? 0 });
      } else if (p.phase === "embed") {
        const done = p.chunksDone ?? 0;
        const total = p.chunksTotal ?? 0;
        const pct = total > 0 ? ((done / total) * 100).toFixed(0) : "0";
        status = t("progressEmbed", { done, total, pct });
      }
      // Repaint immediately on event arrival so the new counter
      // shows up before the next interval tick (avoids a 120ms lag
      // on each progress update).
      repaint();
    },
    clear() {
      clearInterval(interval);
      if (lastLineLen > 0) {
        process.stderr.write(`\r${" ".repeat(lastLineLen)}\r`);
        lastLineLen = 0;
      }
    },
  };
}
