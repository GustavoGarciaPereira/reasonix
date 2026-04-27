/**
 * `/semantic` slash — show whether semantic_search is set up for
 * this project, and what to run if not.
 *
 * Behavior is purely informational. The actual setup happens via
 * `reasonix index` in the user's shell — same pattern `/setup` and
 * `/update` use. Doing the install / build inline would mean
 * suspending Ink and bringing it back, which is fragile (especially
 * the ANSI-cursor-up paths Windows shells already mishandle).
 *
 * All user-facing strings come from the i18n table so Chinese-locale
 * users see Chinese; everyone else gets English.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { probeOllama } from "../../../../index/semantic/embedding.js";
import { t } from "../../../../index/semantic/i18n.js";
import { findOllamaBinary } from "../../../../index/semantic/ollama-launcher.js";
import type { SlashHandler } from "../dispatch.js";

const semantic: SlashHandler = (_args, _loop, ctx) => {
  const root = ctx.codeRoot;
  if (!root) {
    return {
      info: "/semantic is only available inside `reasonix code` (needs a project root).",
    };
  }
  // Fire-and-forget: probes (file stat, optional Ollama HTTP) take
  // ~50–200ms which is too long to block the prompt. Same pattern
  // /kill uses — return a placeholder, post the rich result through
  // ctx.postInfo when ready. ctx.postInfo is wired by the TUI when
  // it owns historical rendering.
  void (async () => {
    const status = await renderSemanticStatus(root);
    ctx.postInfo?.(status);
  })();
  return { info: "▸ checking semantic_search status…" };
};

/**
 * Async status renderer. The slash returns a synchronous
 * "fetching…" placeholder, then this function — invoked via
 * ctx.postInfo from the slash dispatcher wrapper — posts the real
 * status when probes finish. Keeps the slash handler signature sync
 * (the established pattern across the codebase).
 *
 * Exposed separately so tests can call it without faking the slash
 * machinery.
 */
export async function renderSemanticStatus(rootDir: string): Promise<string> {
  const lines: string[] = [t("slashHeader"), ""];
  const indexExists = await indexFileExists(rootDir);
  if (indexExists) {
    const meta = await readIndexMeta(rootDir);
    lines.push(t("slashEnabled"));
    if (meta) {
      lines.push(
        t("slashEnabledDetail", {
          chunks: meta.chunks,
          files: meta.files,
        }),
      );
    }
    lines.push(t("slashEnabledHowto"));
    return lines.join("\n");
  }
  // Not built yet. Walk the prerequisites in priority order.
  lines.push(t("slashIndexMissing"));
  lines.push(t("slashIndexInfo"));
  lines.push("");
  if (findOllamaBinary() === null) {
    lines.push(t("slashOllamaMissing"));
  } else {
    const probe = await probeOllama();
    if (!probe.ok) lines.push(t("slashDaemonDown"));
  }
  lines.push(t("slashHowToBuild"));
  return lines.join("\n");
}

async function indexFileExists(rootDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(rootDir, ".reasonix", "semantic", "index.meta.json"));
    return true;
  } catch {
    return false;
  }
}

interface IndexSummary {
  chunks: number;
  files: number;
}

/**
 * Cheap summary of the index for the `/semantic` status panel.
 * Counts JSONL lines (each = one chunk) and unique paths via a Set.
 * For typical projects (<10k chunks) this is well under 50ms; for
 * very large repos we cap reads at 10MB to keep `/semantic` snappy.
 */
async function readIndexMeta(rootDir: string): Promise<IndexSummary | null> {
  const dataPath = path.join(rootDir, ".reasonix", "semantic", "index.jsonl");
  try {
    const stat = await fs.stat(dataPath);
    if (stat.size > 10 * 1024 * 1024) {
      // For huge indexes, give an order-of-magnitude estimate from
      // file size (avg ~500 bytes/chunk in practice). Files won't
      // be available, so we report just the chunk approximation.
      return { chunks: Math.round(stat.size / 500), files: 0 };
    }
    const raw = await fs.readFile(dataPath, "utf8");
    const seenPaths = new Set<string>();
    let chunks = 0;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      chunks++;
      try {
        const parsed = JSON.parse(line) as { p?: string };
        if (parsed.p) seenPaths.add(parsed.p);
      } catch {
        /* tolerated — store rebuilds drop bad lines */
      }
    }
    return { chunks, files: seenPaths.size };
  } catch {
    return null;
  }
}

export const handlers: Record<string, SlashHandler> = {
  semantic,
};
