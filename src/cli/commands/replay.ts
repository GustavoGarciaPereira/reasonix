import { replayFromFile } from "../../replay.js";
import type { TranscriptRecord } from "../../transcript.js";

export interface ReplayOptions {
  path: string;
  head?: number;
  tail?: number;
}

/**
 * Non-TUI transcript replay — pretty-prints the records + a summary to stdout.
 * The full Ink TUI replay ships later; this command is enough for `less` +
 * scroll workflows and is what CI / blog tooling will use.
 */
export function replayCommand(opts: ReplayOptions): void {
  const { parsed, stats } = replayFromFile(opts.path);

  // Header: meta line if present
  if (parsed.meta) {
    const m = parsed.meta;
    const bits: string[] = [`source=${m.source}`];
    if (m.model) bits.push(`model=${m.model}`);
    if (m.task) bits.push(`task=${m.task}`);
    if (m.mode) bits.push(`mode=${m.mode}`);
    if (m.repeat !== undefined) bits.push(`repeat=${m.repeat}`);
    bits.push(`started=${m.startedAt}`);
    console.log(`[meta] ${bits.join(" ")}`);
    console.log("");
  }

  const records = sliceRecords(parsed.records, opts);
  for (const rec of records) {
    renderRecord(rec);
  }

  console.log("");
  console.log("── summary ─────────────────────────────────────────");
  console.log(`turns (assistant):   ${stats.turns}`);
  console.log(`user turns:          ${stats.userTurns}`);
  console.log(`tool calls:          ${stats.toolCalls}`);
  console.log(`cache hit:           ${(stats.cacheHitRatio * 100).toFixed(1)}%`);
  console.log(`cost:                $${stats.totalCostUsd.toFixed(6)}`);
  console.log(`claude equivalent:   $${stats.claudeEquivalentUsd.toFixed(6)}`);
  console.log(`savings vs claude:   ${stats.savingsVsClaudePct.toFixed(1)}%`);
  console.log(`models:              ${stats.models.join(", ") || "—"}`);
  console.log(`prefix hashes:       ${stats.prefixHashes.length} distinct`);
  if (stats.prefixHashes.length === 1) {
    console.log(`  (byte-stable prefix: ${stats.prefixHashes[0]?.slice(0, 16)}…)`);
  } else if (stats.prefixHashes.length > 1) {
    console.log("  (prefix churned — cache-hostile session)");
  }
}

function sliceRecords(records: TranscriptRecord[], opts: ReplayOptions): TranscriptRecord[] {
  if (opts.head !== undefined && opts.head > 0) return records.slice(0, opts.head);
  if (opts.tail !== undefined && opts.tail > 0) return records.slice(-opts.tail);
  return records;
}

function renderRecord(rec: TranscriptRecord): void {
  const turn = `[t${rec.turn}]`;
  if (rec.role === "user") {
    console.log(`${turn} USER: ${oneLine(rec.content)}`);
  } else if (rec.role === "assistant_final") {
    const cost = rec.cost !== undefined ? ` $${rec.cost.toFixed(6)}` : "";
    const cache =
      rec.usage &&
      (rec.usage.prompt_cache_hit_tokens !== undefined ||
        rec.usage.prompt_cache_miss_tokens !== undefined)
        ? (() => {
            const hit = rec.usage!.prompt_cache_hit_tokens ?? 0;
            const miss = rec.usage!.prompt_cache_miss_tokens ?? 0;
            const total = hit + miss;
            return total > 0 ? ` cache=${((hit / total) * 100).toFixed(1)}%` : "";
          })()
        : "";
    console.log(`${turn} AGENT:${cost}${cache} ${oneLine(rec.content)}`);
  } else if (rec.role === "tool") {
    const args = rec.args ? ` args=${oneLine(rec.args, 80)}` : "";
    console.log(`${turn} TOOL ${rec.tool ?? "?"}:${args} → ${oneLine(rec.content, 120)}`);
  } else if (rec.role === "error") {
    console.log(`${turn} ERROR: ${rec.error ?? rec.content}`);
  } else if (rec.role === "done") {
    // Suppress — visually noisy, not informative in replay.
  } else {
    console.log(`${turn} ${rec.role}: ${oneLine(rec.content)}`);
  }
}

function oneLine(s: string, max = 200): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
