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
import { type SessionSummary, type TurnStats, claudeEquivalentCost, costUsd } from "./telemetry.js";
import { type ReadTranscriptResult, type TranscriptRecord, readTranscript } from "./transcript.js";

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

  for (const rec of records) {
    if (rec.role === "user") userTurns++;
    else if (rec.role === "tool") toolCalls++;
    else if (rec.role === "assistant_final") {
      if (rec.model) models.add(rec.model);
      if (rec.prefixHash) prefixHashes.add(rec.prefixHash);
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
    ...summarizeTurns(turns),
  };
}

function summarizeTurns(turns: TurnStats[]): SessionSummary {
  const totalCost = turns.reduce((s, t) => s + t.cost, 0);
  const totalClaude = turns.reduce((s, t) => s + claudeEquivalentCost(t.usage), 0);
  let hit = 0;
  let miss = 0;
  for (const t of turns) {
    hit += t.usage.promptCacheHitTokens;
    miss += t.usage.promptCacheMissTokens;
  }
  const cacheHitRatio = hit + miss > 0 ? hit / (hit + miss) : 0;
  const savingsVsClaude = totalClaude > 0 ? 1 - totalCost / totalClaude : 0;
  return {
    turns: turns.length,
    totalCostUsd: round(totalCost, 6),
    claudeEquivalentUsd: round(totalClaude, 6),
    savingsVsClaudePct: round(savingsVsClaude * 100, 2),
    cacheHitRatio: round(cacheHitRatio, 4),
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
