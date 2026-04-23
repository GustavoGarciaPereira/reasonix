/**
 * `reasonix stats` — two modes, decided by whether the user passed
 * a transcript path.
 *
 *   - `reasonix stats`          → cross-session usage dashboard
 *                                  (reads `~/.reasonix/usage.jsonl`)
 *   - `reasonix stats <path>`   → summary of a single JSONL transcript
 *                                  (original v0.1 behavior, kept so
 *                                   existing scripts don't break)
 *
 * The dashboard is the new story: for every turn `reasonix chat|code|run`
 * has ever executed on this machine, we aggregate tokens + cost + the
 * equivalent Claude spend, and print rolling-window totals (today /
 * week / month / all-time). The savings column is the Pillar 1 pitch
 * made concrete — "you paid $X; Claude would have charged $Y, a N%
 * reduction."
 */

import { existsSync, readFileSync } from "node:fs";
import {
  type UsageAggregate,
  type UsageBucket,
  aggregateUsage,
  bucketCacheHitRatio,
  bucketSavingsFraction,
  defaultUsageLogPath,
  formatLogSize,
  readUsageLog,
} from "../../usage.js";

export interface StatsOptions {
  /** Optional transcript path. Absent → dashboard mode. */
  transcript?: string;
  /** Override usage log location (tests). */
  logPath?: string;
  /** Inject a fixed timestamp (tests) so rolling windows are deterministic. */
  now?: number;
}

export function statsCommand(opts: StatsOptions): void {
  if (opts.transcript) {
    transcriptSummary(opts.transcript);
    return;
  }
  dashboard(opts);
}

// ---------------------------------------------------------------------
// Transcript summary — legacy v0.1 behavior, preserved verbatim.
// ---------------------------------------------------------------------

function transcriptSummary(path: string): void {
  if (!existsSync(path)) {
    console.error(`no such transcript: ${path}`);
    process.exit(1);
  }
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  let assistantTurns = 0;
  let toolCalls = 0;
  let lastTurn = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.role === "assistant_final") assistantTurns++;
      if (rec.role === "tool") toolCalls++;
      if (typeof rec.turn === "number") lastTurn = Math.max(lastTurn, rec.turn);
    } catch {
      /* skip */
    }
  }
  console.log(`transcript:       ${path}`);
  console.log(`assistant turns:  ${assistantTurns}`);
  console.log(`tool invocations: ${toolCalls}`);
  console.log(`last turn index:  ${lastTurn}`);
}

// ---------------------------------------------------------------------
// Dashboard — aggregates ~/.reasonix/usage.jsonl.
// ---------------------------------------------------------------------

function dashboard(opts: StatsOptions): void {
  const path = opts.logPath ?? defaultUsageLogPath();
  const records = readUsageLog(path);
  if (records.length === 0) {
    console.log("no usage data yet.");
    console.log("");
    console.log(`  ${path}`);
    console.log("");
    console.log("run `reasonix chat`, `reasonix code`, or `reasonix run <task>` — every turn");
    console.log("appends one line to the log and `reasonix stats` will roll it up.");
    return;
  }

  const agg = aggregateUsage(records, { now: opts.now });
  console.log(renderDashboard(agg, path));
}

/** Pure renderer — pulled out so tests can assert on the string directly. */
export function renderDashboard(agg: UsageAggregate, logPath: string): string {
  const lines: string[] = [];
  const size = formatLogSize(logPath);
  lines.push(`Reasonix usage — ${logPath}${size ? ` (${size})` : ""}`);
  lines.push("");
  lines.push(header());
  lines.push(divider());
  for (const b of agg.buckets) {
    lines.push(bucketRow(b));
  }
  lines.push("");

  // Model + session breakdown — both trim to top 3 so a user with 20
  // sessions doesn't drown the table.
  if (agg.byModel.length > 0) {
    const totalTurns = agg.buckets[agg.buckets.length - 1]?.turns ?? 0;
    const top = agg.byModel[0];
    if (top && totalTurns > 0) {
      const pct = ((top.turns / totalTurns) * 100).toFixed(0);
      lines.push(`most used model:   ${top.model} (${pct}% of turns)`);
    }
  }
  if (agg.bySession.length > 0) {
    const top = agg.bySession[0];
    if (top) lines.push(`top session:       ${top.session} (${top.turns} turns)`);
  }
  if (agg.firstSeen) {
    lines.push(`tracked since:     ${new Date(agg.firstSeen).toISOString().slice(0, 10)}`);
  }
  return lines.join("\n");
}

function header(): string {
  // Fixed column widths so alignment works in any TTY.
  return [
    pad("", 10),
    pad("turns", 8, "right"),
    pad("cache hit", 10, "right"),
    pad("cost (USD)", 14, "right"),
    pad("vs Claude", 14, "right"),
    pad("saved", 10, "right"),
  ].join("  ");
}

function divider(): string {
  return "-".repeat(70);
}

function bucketRow(b: UsageBucket): string {
  const hit = bucketCacheHitRatio(b);
  const savings = bucketSavingsFraction(b);
  return [
    pad(b.label, 10),
    pad(b.turns.toString(), 8, "right"),
    pad(b.turns > 0 ? `${(hit * 100).toFixed(1)}%` : "—", 10, "right"),
    pad(b.turns > 0 ? `$${b.costUsd.toFixed(6)}` : "—", 14, "right"),
    pad(b.turns > 0 ? `$${b.claudeEquivUsd.toFixed(4)}` : "—", 14, "right"),
    pad(b.turns > 0 && savings > 0 ? `${(savings * 100).toFixed(1)}%` : "—", 10, "right"),
  ].join("  ");
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "right" ? `${fill}${s}` : `${s}${fill}`;
}
