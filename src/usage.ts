/**
 * Persistent per-turn usage log at `~/.reasonix/usage.jsonl`.
 *
 * Each line is a single `UsageRecord` — one turn's tokens + cost
 * snapshot — appended after every `assistant_final` event. This is
 * what drives `reasonix stats` (the dashboard, no-arg form), so the
 * user can see how much they've spent vs what the equivalent Claude
 * spend would have been. The Pillar 1 pitch (94–97% cost reduction
 * vs Claude, from the v0.3 hard-number table) becomes a fact users
 * can verify on their own machine.
 *
 * Format choices:
 *   - **append-only JSONL** — one line per turn, durable, survives
 *     abrupt exits. A corrupted tail line loses at most one record.
 *   - **flat keys, no nesting** — readable with `jq` / `cut` / `awk`;
 *     the model doesn't need to parse this, humans do.
 *   - **best-effort writes** — disk errors never propagate into the
 *     turn. We log nothing (no `console.error`) because the TUI is
 *     rendering Ink; a silent skip is the least-worst failure mode.
 *   - **no PII, no prompts, no completions** — the log contains
 *     tokens and costs, that's it. Sessions are identified by the
 *     user-chosen name (never a prompt).
 *
 * This file is deliberately NOT wired through project memory or
 * skills — those are content pins. Usage is pure telemetry.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Usage } from "./client.js";
import {
  CLAUDE_SONNET_PRICING,
  DEEPSEEK_PRICING,
  claudeEquivalentCost,
  costUsd,
} from "./telemetry.js";

/** One turn's snapshot — serialized verbatim as a JSONL line. */
export interface UsageRecord {
  /** Epoch millis when the record was written. */
  ts: number;
  /** Session name if the turn ran inside a persisted session, `null` for ephemeral. */
  session: string | null;
  /** Model id the turn ran against (drives the pricing lookup). */
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** Total cost of the turn in USD. */
  costUsd: number;
  /** What the same turn would have cost at Claude Sonnet 4.6 rates. */
  claudeEquivUsd: number;
}

/** Where the log lives. Tests override via `opts.path`. */
export function defaultUsageLogPath(homeDirOverride?: string): string {
  return join(homeDirOverride ?? homedir(), ".reasonix", "usage.jsonl");
}

export interface AppendUsageInput {
  session: string | null;
  model: string;
  usage: Usage;
  /** Override the timestamp (tests). */
  now?: number;
  /** Override the log path (tests). */
  path?: string;
}

/**
 * Append one record and return it. Swallows disk errors — the TUI
 * should keep working even if `~/.reasonix/` is read-only.
 *
 * Returns the record that was written (or would have been written
 * if the disk had cooperated) so tests / callers can assert on the
 * computed cost fields without a round trip through the log file.
 */
export function appendUsage(input: AppendUsageInput): UsageRecord {
  const record: UsageRecord = {
    ts: input.now ?? Date.now(),
    session: input.session,
    model: input.model,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    cacheHitTokens: input.usage.promptCacheHitTokens,
    cacheMissTokens: input.usage.promptCacheMissTokens,
    costUsd: costUsd(input.model, input.usage),
    claudeEquivUsd: claudeEquivalentCost(input.usage),
  };

  const path = input.path ?? defaultUsageLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    /* best-effort — disk failure shouldn't break the chat */
  }
  return record;
}

/**
 * Read + parse the log. Malformed lines are silently skipped so a
 * single corrupted write (half-flushed on power loss, user hand-edit)
 * doesn't throw away the rest of the history.
 */
export function readUsageLog(path: string = defaultUsageLogPath()): UsageRecord[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (isValidRecord(rec)) out.push(rec);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function isValidRecord(rec: unknown): rec is UsageRecord {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Partial<UsageRecord>;
  return (
    typeof r.ts === "number" &&
    typeof r.model === "string" &&
    typeof r.promptTokens === "number" &&
    typeof r.completionTokens === "number" &&
    typeof r.cacheHitTokens === "number" &&
    typeof r.cacheMissTokens === "number" &&
    typeof r.costUsd === "number" &&
    typeof r.claudeEquivUsd === "number"
  );
}

/** One row of the `reasonix stats` dashboard — a rolled-up window. */
export interface UsageBucket {
  label: string;
  /** Start of the window as epoch millis. `0` = unbounded (all-time). */
  since: number;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  claudeEquivUsd: number;
}

/** Cache hit ratio for a bucket — zero denominator returns 0. */
export function bucketCacheHitRatio(b: UsageBucket): number {
  const denom = b.cacheHitTokens + b.cacheMissTokens;
  return denom > 0 ? b.cacheHitTokens / denom : 0;
}

/** Savings vs Claude as a fraction (0.94 = 94% savings). 0 if Claude cost is 0. */
export function bucketSavingsFraction(b: UsageBucket): number {
  return b.claudeEquivUsd > 0 ? 1 - b.costUsd / b.claudeEquivUsd : 0;
}

function emptyBucket(label: string, since: number): UsageBucket {
  return {
    label,
    since,
    turns: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costUsd: 0,
    claudeEquivUsd: 0,
  };
}

function addToBucket(b: UsageBucket, r: UsageRecord): void {
  b.turns += 1;
  b.promptTokens += r.promptTokens;
  b.completionTokens += r.completionTokens;
  b.cacheHitTokens += r.cacheHitTokens;
  b.cacheMissTokens += r.cacheMissTokens;
  b.costUsd += r.costUsd;
  b.claudeEquivUsd += r.claudeEquivUsd;
}

export interface AggregateOptions {
  /** Override `Date.now()` for deterministic tests. */
  now?: number;
}

export interface UsageAggregate {
  /** Fixed-order rolling windows: today, week, month, all-time. */
  buckets: UsageBucket[];
  /** Model id → turn count. Sorted descending; top entry is the "most used." */
  byModel: Array<{ model: string; turns: number }>;
  /** Session name → turn count. Sorted descending. Null sessions are grouped under `"(ephemeral)"`. */
  bySession: Array<{ session: string; turns: number }>;
  /** Earliest record's ts, or `null` when the log is empty. Drives "saved $X since <date>". */
  firstSeen: number | null;
  /** Latest record's ts, or `null` when the log is empty. */
  lastSeen: number | null;
}

/**
 * Fold a flat record list into the dashboard shape — rolling windows
 * plus model / session histograms. Windows are INCLUSIVE of boundary:
 *   - today = last 24h (rolling, not calendar-day)
 *   - week  = last 7d
 *   - month = last 30d
 *   - all   = every record
 * Rolling windows avoid "it's 00:03, 'today' is empty" surprises.
 */
export function aggregateUsage(
  records: UsageRecord[],
  opts: AggregateOptions = {},
): UsageAggregate {
  const now = opts.now ?? Date.now();
  const day = 24 * 60 * 60 * 1000;
  const today = emptyBucket("today", now - day);
  const week = emptyBucket("week", now - 7 * day);
  const month = emptyBucket("month", now - 30 * day);
  const all = emptyBucket("all-time", 0);

  const modelCounts = new Map<string, number>();
  const sessionCounts = new Map<string, number>();
  let firstSeen: number | null = null;
  let lastSeen: number | null = null;

  for (const r of records) {
    addToBucket(all, r);
    if (r.ts >= today.since) addToBucket(today, r);
    if (r.ts >= week.since) addToBucket(week, r);
    if (r.ts >= month.since) addToBucket(month, r);

    modelCounts.set(r.model, (modelCounts.get(r.model) ?? 0) + 1);
    const sessKey = r.session ?? "(ephemeral)";
    sessionCounts.set(sessKey, (sessionCounts.get(sessKey) ?? 0) + 1);

    if (firstSeen === null || r.ts < firstSeen) firstSeen = r.ts;
    if (lastSeen === null || r.ts > lastSeen) lastSeen = r.ts;
  }

  const byModel = Array.from(modelCounts.entries())
    .map(([model, turns]) => ({ model, turns }))
    .sort((a, b) => b.turns - a.turns);
  const bySession = Array.from(sessionCounts.entries())
    .map(([session, turns]) => ({ session, turns }))
    .sort((a, b) => b.turns - a.turns);

  return {
    buckets: [today, week, month, all],
    byModel,
    bySession,
    firstSeen,
    lastSeen,
  };
}

/** File-size helper for the stats header — "1.2 MB" etc. Returns "" if missing. */
export function formatLogSize(path: string = defaultUsageLogPath()): string {
  if (!existsSync(path)) return "";
  try {
    const s = statSync(path);
    const bytes = s.size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return "";
  }
}

/** Re-exports for downstream consumers that also want the pricing constants. */
export { CLAUDE_SONNET_PRICING, DEEPSEEK_PRICING };
