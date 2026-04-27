/**
 * Shared Ollama preflight + readline confirm. Used by both the
 * standalone `reasonix index` command and the code-mode bootstrap
 * (`bootstrapSemanticSearchInCodeMode` in tool.ts) so users see one
 * consistent setup story however they reach it.
 *
 * All user-facing text routes through the i18n table — Chinese
 * locales get Chinese, everyone else gets English. See ./i18n.ts.
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { t } from "./i18n.js";
import { checkOllamaStatus, pullOllamaModel, startOllamaDaemon } from "./ollama-launcher.js";

export interface PreflightOptions {
  /** Embedding model to verify is pulled. */
  model: string;
  /** Override Ollama base URL. */
  baseUrl?: string | undefined;
  /** Allow interactive prompts (TTY only). When false, missing
   *  daemon / model causes a hard failure with a remediation hint. */
  interactive: boolean;
  /** Skip prompts and act on every offer. Implies non-interactive. */
  yesToAll: boolean;
  /** Optional log sink. Defaults to stderr writes. */
  log?: (line: string) => void;
}

/**
 * Walk through the Ollama setup story before any chunking happens.
 * Returns true when ready to embed, false when something is missing
 * we can't or shouldn't fix automatically. Prints actionable hints
 * for every failure path so the user always knows what to do next.
 */
export async function ollamaPreflight(opts: PreflightOptions): Promise<boolean> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line));
  const status = await checkOllamaStatus(opts.model, opts.baseUrl);

  if (!status.binaryFound) {
    log(t("ollamaNotFound"));
    return false;
  }

  if (!status.daemonRunning) {
    if (!opts.interactive && !opts.yesToAll) {
      log(t("daemonNotReachableHint"));
      return false;
    }
    const ok = opts.yesToAll || (await confirm(t("daemonStartConfirm"), true));
    if (!ok) {
      log(t("daemonAbortStart"));
      return false;
    }
    log(t("daemonStarting"));
    const started = await startOllamaDaemon({ baseUrl: opts.baseUrl, timeoutMs: 15_000 });
    if (!started.ready) {
      log(t("daemonStartTimeout"));
      return false;
    }
    log(t("daemonReady", { pid: started.pid ? ` (pid ${started.pid})` : "" }));
  }

  // Re-check the pulled-models list after a fresh daemon start —
  // the prior status snapshot was taken when the daemon was down.
  const after = status.daemonRunning ? status : await checkOllamaStatus(opts.model, opts.baseUrl);

  if (!after.modelPulled) {
    if (!opts.interactive && !opts.yesToAll) {
      log(t("modelNotPulledHint", { model: opts.model }));
      return false;
    }
    const ok = opts.yesToAll || (await confirm(t("modelPullConfirm", { model: opts.model }), true));
    if (!ok) {
      log(t("modelAbortPull"));
      return false;
    }
    log(t("modelPulling", { model: opts.model }));
    // Strip ANSI CSI sequences from ollama's verbose pull output so
    // our log stays readable. ESC built from char code so biome's
    // noControlCharactersInRegex doesn't flag the literal.
    const ESC = String.fromCharCode(0x1b);
    const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
    const code = await pullOllamaModel(opts.model, {
      onLine: (line) => {
        const cleaned = line.replace(ANSI_CSI, "").trim();
        if (cleaned.length === 0) return;
        log(`  ${cleaned}\n`);
      },
    });
    if (code !== 0) {
      log(t("modelPullFailed", { model: opts.model, code }));
      return false;
    }
    log(t("modelPulled", { model: opts.model }));
  }

  return true;
}

/**
 * Yes/no readline prompt. `[Y/n]` or `[y/N]` rendered based on
 * `defaultYes`; empty input takes the default. Closes its readline
 * interface so the parent process exits cleanly.
 */
export async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const raw = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (raw === "") return defaultYes;
    return raw === "y" || raw === "yes";
  } finally {
    rl.close();
  }
}
