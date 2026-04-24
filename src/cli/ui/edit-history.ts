import { formatAllBlockDiffs } from "../../code/diff-preview.js";
import type { ApplyResult, EditBlock, EditSnapshot } from "../../code/edit-blocks.js";

/**
 * One batch of edits that actually landed on disk — durable enough for
 * `/undo`, `/history`, and `/show` within a session. Not persisted
 * across restarts: restoring pre-apply content from a process that
 * crashed last week is git's job, not ours.
 */
export interface EditHistoryEntry {
  /** Sequence number within the session, stable for `/show <id>`. */
  id: number;
  /** Epoch ms when the entry was opened (first edit landed). */
  at: number;
  /**
   * Short tag for what produced the batch — "auto" (auto-mode tool
   * call), "auto-text" (auto-mode text SEARCH/REPLACE at turn end),
   * "review-apply" (user-approved modal edit or /apply flush).
   */
  source: string;
  /** Edit blocks included in this batch, in arrival order. */
  blocks: EditBlock[];
  /** Per-block outcome — some may be "not-found" if SEARCH drifted. */
  results: ApplyResult[];
  /**
   * First-snapshot-per-path wins: this is what `/undo` restores to.
   * Deduped so multi-edit turns still roll back to pre-turn state.
   */
  snapshots: EditSnapshot[];
  /**
   * Paths within this entry that have already been reverted (via
   * `/undo <id>`, `/undo <id> <path>`, or the newest-non-undone /undo
   * shortcut). Per-path instead of entry-level so a batch can be
   * partially undone — user reverts src/foo.ts out of a 3-file batch
   * without rolling back the other two.
   */
  undoneFiles: Set<string>;
}

/** True when every path in the entry has been undone. */
export function isEntryFullyUndone(e: EditHistoryEntry): boolean {
  return e.snapshots.length > 0 && e.snapshots.every((s) => e.undoneFiles.has(s.path));
}

/** Per-entry three-state status label for display. */
export function entryStatus(e: EditHistoryEntry): "applied" | "UNDONE" | "PARTIAL" {
  if (e.undoneFiles.size === 0) return "applied";
  if (isEntryFullyUndone(e)) return "UNDONE";
  return "PARTIAL";
}

/**
 * Render a batch of SEARCH/REPLACE application results as one
 * human-scannable info line per edit. Prefixes denote status so the
 * line reads well even without color (e.g. when piped to a log file
 * or stripped for screenshots):
 *   ✓ applied  src/foo.ts
 *   ✓ created  src/new.ts
 *   ✗ not-found  src/bar.ts (SEARCH text does not match…)
 */
export function formatEditResults(results: ApplyResult[]): string {
  const lines = results.map((r) => {
    const mark = r.status === "applied" || r.status === "created" ? "✓" : "✗";
    const detail = r.message ? ` (${r.message})` : "";
    return `  ${mark} ${r.status.padEnd(11)} ${r.path}${detail}`;
  });
  const ok = results.filter((r) => r.status === "applied" || r.status === "created").length;
  const total = results.length;
  const header = `▸ edit blocks: ${ok}/${total} applied — /undo to roll back, or \`git diff\` to review`;
  return [header, ...lines].join("\n");
}

/**
 * Pending-edits preview shown after each assistant turn that proposed
 * changes. Per-block path header + ±line-count, then a unified-diff-
 * style preview (context trimmed to 2 lines each side, total capped
 * at 20 lines per block). Users can eyeball what's about to land
 * BEFORE pressing `y` — the old summary-only view was a common
 * mistake surface.
 */
export function formatPendingPreview(blocks: EditBlock[]): string {
  const header = `▸ ${blocks.length} pending edit block(s) — /apply (or y) to commit · /discard (or n) to drop`;
  const diffLines = formatAllBlockDiffs(blocks);
  return [header, ...diffLines].join("\n");
}

/**
 * Per-file rows for the multi-level `/undo` output, without the
 * single-batch header (the caller prepends its own).
 */
export function formatUndoRows(results: ApplyResult[]): string[] {
  return results.map((r) => {
    const mark = r.status === "applied" ? "✓" : "✗";
    const detail = r.message ? ` (${r.message})` : "";
    return `  ${mark} ${r.path}${detail}`;
  });
}

export function describeRepair(repair: {
  scavenged: number;
  truncationsFixed: number;
  stormsBroken: number;
}): string {
  const parts: string[] = [];
  if (repair.scavenged) parts.push(`scavenged ${repair.scavenged}`);
  if (repair.truncationsFixed) parts.push(`repaired ${repair.truncationsFixed} truncation`);
  if (repair.stormsBroken) parts.push(`broke ${repair.stormsBroken} storm`);
  return parts.length ? `[repair] ${parts.join(", ")}` : "";
}
