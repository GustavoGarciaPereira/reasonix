/**
 * Replay — reconstruct session economics from a transcript file.
 *
 * Given a transcript written by App.tsx or the bench runner, rebuild a
 * SessionSummary-compatible aggregate (turn count, total cost, cache-hit
 * ratio, vs-Claude estimate) without replaying the LLM calls.
 *
 * The whole point is offline auditing: a reader should be able to reproduce
 * the headline numbers from a transcript alone, without an API key.
 */

import { Usage } from "./client.js";
import {
  type SessionSummary,
  type TurnStats,
  claudeEquivalentCost,
  costUsd,
  inputCostUsd,
  outputCostUsd,
} from "./telemetry.js";
import { type ReadTranscriptResult, type TranscriptRecord, readTranscript } from "./transcript.js";

/**
 * A single turn's worth of records — the unit of navigation in replay TUI.
 * Records are grouped by their `turn` field, preserving file order within
 * each group (so tool events interleave with assistant_final events the
 * way they were actually emitted).
 */
export interface TurnPage {
  turn: number;
  records: TranscriptRecord[];
}

/**
 * Group transcript records into turn-pages. Pages are returned in ascending
 * turn order. Records without a numeric turn (meta lines, malformed) are
 * already filtered by the transcript reader, so this sees clean input.
 */
export function groupRecordsByTurn(records: TranscriptRecord[]): TurnPage[] {
  const byTurn = new Map<number, TranscriptRecord[]>();
  for (const rec of records) {
    const list = byTurn.get(rec.turn);
    if (list) list.push(rec);
    else byTurn.set(rec.turn, [rec]);
  }
  return [...byTurn.entries()]
    .sort(([a], [b]) => a - b)
    .map(([turn, records]) => ({ turn, records }));
}

/**
 * Cumulative replay stats up to and including pages[0..upToIdx]. Returns
 * empty stats if upToIdx < 0. Used by replay TUI's sidebar to show "stats
 * so far" as the user scrolls through a transcript.
 */
export function computeCumulativeStats(pages: TurnPage[], upToIdx: number): ReplayStats {
  if (upToIdx < 0) return computeReplayStats([]);
  const flat: TranscriptRecord[] = [];
  for (let i = 0; i <= upToIdx && i < pages.length; i++) {
    const records = pages[i]?.records;
    if (records) flat.push(...records);
  }
  return computeReplayStats(flat);
}

export interface ReplayStats extends SessionSummary {
  /** Per-turn stats, in turn order. Only assistant_final records contribute. */
  perTurn: TurnStats[];
  /** Unique models that appeared in the transcript's assistant_final records. */
  models: string[];
  /** Unique prefix hashes that appeared. Length > 1 means the prefix churned (cache-hostile). */
  prefixHashes: string[];
  /** Count of user-role records (user turns issued). */
  userTurns: number;
  /** Count of tool-role records (tool calls executed). */
  toolCalls: number;
  /** Count of assistant_final records that carry a non-empty planState (harvest signal). */
  harvestedTurns: number;
  /** Sum of uncertainties across all harvested turns — a proxy for "how much did R1 hedge?" */
  totalUncertainties: number;
  /** Sum of subgoals across all harvested turns. */
  totalSubgoals: number;
}

/**
 * Parse a transcript file and compute replay stats. Throws only on I/O
 * errors; malformed lines inside the file are skipped silently.
 */
export function replayFromFile(path: string): { parsed: ReadTranscriptResult; stats: ReplayStats } {
  const parsed = readTranscript(path);
  return { parsed, stats: computeReplayStats(parsed.records) };
}

export function computeReplayStats(records: TranscriptRecord[]): ReplayStats {
  const turns: TurnStats[] = [];
  const models = new Set<string>();
  const prefixHashes = new Set<string>();
  let userTurns = 0;
  let toolCalls = 0;
  let harvestedTurns = 0;
  let totalUncertainties = 0;
  let totalSubgoals = 0;

  for (const rec of records) {
    if (rec.role === "user") userTurns++;
    else if (rec.role === "tool") toolCalls++;
    else if (rec.role === "assistant_final") {
      if (rec.model) models.add(rec.model);
      if (rec.prefixHash) prefixHashes.add(rec.prefixHash);
      if (rec.planState) {
        harvestedTurns++;
        totalUncertainties += rec.planState.uncertainties.length;
        totalSubgoals += rec.planState.subgoals.length;
      }
      if (rec.usage && rec.model) {
        const u = new Usage(
          rec.usage.prompt_tokens ?? 0,
          rec.usage.completion_tokens ?? 0,
          rec.usage.total_tokens ?? 0,
          rec.usage.prompt_cache_hit_tokens ?? 0,
          rec.usage.prompt_cache_miss_tokens ?? 0,
        );
        turns.push({
          turn: rec.turn,
          model: rec.model,
          usage: u,
          // `rec.cost` wins when present — honors whatever the writer computed
          // even if pricing tables have since changed. Only recompute when
          // the transcript didn't record it (old format).
          cost: rec.cost ?? costUsd(rec.model, u),
          cacheHitRatio: u.cacheHitRatio,
        });
      }
    }
  }

  return {
    perTurn: turns,
    models: [...models],
    prefixHashes: [...prefixHashes],
    userTurns,
    toolCalls,
    harvestedTurns,
    totalUncertainties,
    totalSubgoals,
    ...summarizeTurns(turns),
  };
}

function summarizeTurns(turns: TurnStats[]): SessionSummary {
  const totalCost = turns.reduce((s, t) => s + t.cost, 0);
  const totalInput = turns.reduce((s, t) => s + inputCostUsd(t.model, t.usage), 0);
  const totalOutput = turns.reduce((s, t) => s + outputCostUsd(t.model, t.usage), 0);
  const totalClaude = turns.reduce((s, t) => s + claudeEquivalentCost(t.usage), 0);
  let hit = 0;
  let miss = 0;
  for (const t of turns) {
    hit += t.usage.promptCacheHitTokens;
    miss += t.usage.promptCacheMissTokens;
  }
  const cacheHitRatio = hit + miss > 0 ? hit / (hit + miss) : 0;
  const savingsVsClaude = totalClaude > 0 ? 1 - totalCost / totalClaude : 0;
  const lastTurn = turns[turns.length - 1];
  return {
    turns: turns.length,
    totalCostUsd: round(totalCost, 6),
    totalInputCostUsd: round(totalInput, 6),
    totalOutputCostUsd: round(totalOutput, 6),
    claudeEquivalentUsd: round(totalClaude, 6),
    savingsVsClaudePct: round(savingsVsClaude * 100, 2),
    cacheHitRatio: round(cacheHitRatio, 4),
    lastPromptTokens: lastTurn?.usage.promptTokens ?? 0,
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
