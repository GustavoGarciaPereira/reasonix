/**
 * Ink TUI for `reasonix replay`. Read-only: no input box, no loop.
 * j/k navigation across turn-pages, cumulative stats sidebar updates
 * as you move through time.
 *
 * The navigation logic (grouping records into pages, computing cumulative
 * stats) lives in src/replay.ts as pure functions; this file is just
 * presentation + key bindings.
 */

import { Box, Static, Text, useApp, useInput } from "ink";
import React, { useMemo, useState } from "react";
import { type TurnPage, computeCumulativeStats } from "../../replay.js";
import type { TranscriptMeta, TranscriptRecord } from "../../transcript.js";
import { StatsPanel } from "./StatsPanel.js";

export interface ReplayAppProps {
  meta: TranscriptMeta | null;
  pages: TurnPage[];
}

export function ReplayApp({ meta, pages }: ReplayAppProps) {
  const { exit } = useApp();
  const maxIdx = Math.max(0, pages.length - 1);
  // Start at the last page — more useful than "start from the beginning"
  // in practice: users mostly want to see the summary + last turn first.
  const [idx, setIdx] = useState(maxIdx);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === "j" || key.downArrow || input === " " || key.return) {
      setIdx((i) => Math.min(maxIdx, i + 1));
    } else if (input === "k" || key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
    } else if (input === "g") {
      setIdx(0);
    } else if (input === "G") {
      setIdx(maxIdx);
    } else if (input === "h" || key.leftArrow) {
      setIdx(0);
    } else if (input === "l" || key.rightArrow) {
      setIdx(maxIdx);
    }
  });

  const cumStats = useMemo(() => computeCumulativeStats(pages, idx), [pages, idx]);

  const summary = {
    turns: cumStats.turns,
    totalCostUsd: cumStats.totalCostUsd,
    claudeEquivalentUsd: cumStats.claudeEquivalentUsd,
    savingsVsClaudePct: cumStats.savingsVsClaudePct,
    cacheHitRatio: cumStats.cacheHitRatio,
  };

  const prefixHash =
    cumStats.prefixHashes.length === 1
      ? cumStats.prefixHashes[0]!.slice(0, 16)
      : cumStats.prefixHashes.length === 0
        ? "(untracked)"
        : `(churned ×${cumStats.prefixHashes.length})`;

  const currentPage = pages[idx];
  const progressLabel =
    pages.length === 0 ? "empty transcript" : `turn ${idx + 1} / ${pages.length}`;

  return (
    <Box flexDirection="column">
      <StatsPanel
        summary={summary}
        model={cumStats.models[0] ?? meta?.model ?? "?"}
        prefixHash={prefixHash}
      />

      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Box justifyContent="space-between">
          <Text color="cyan" bold>
            {progressLabel}
          </Text>
          {meta ? (
            <Text dimColor>
              {meta.source}
              {meta.task ? ` · ${meta.task}` : ""}
              {meta.mode ? ` · ${meta.mode}` : ""}
            </Text>
          ) : null}
        </Box>

        {currentPage ? (
          <Static items={currentPage.records.map((rec, i) => ({ key: `${idx}-${i}`, rec }))}>
            {({ key, rec }) => <RecordView key={key} rec={rec} />}
          </Static>
        ) : (
          <Text dimColor italic>
            no records
          </Text>
        )}
      </Box>

      <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="gray">
        <Text dimColor>
          <Text bold>j</Text>/<Text bold>↓</Text>/<Text bold>space</Text> next · <Text bold>k</Text>
          /<Text bold>↑</Text> prev · <Text bold>g</Text> first · <Text bold>G</Text> last ·{" "}
          <Text bold>q</Text> quit
        </Text>
      </Box>
    </Box>
  );
}

// ----------------------------------------------------------------------------

function RecordView({ rec }: { rec: TranscriptRecord }) {
  if (rec.role === "user") {
    return (
      <Box marginTop={1}>
        <Text bold color="cyan">
          you ›{" "}
        </Text>
        <Text>{rec.content}</Text>
      </Box>
    );
  }
  if (rec.role === "assistant_final") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color="green">
            assistant
          </Text>
          {rec.cost !== undefined ? (
            <Text dimColor>
              {"  $"}
              {rec.cost.toFixed(6)}
            </Text>
          ) : null}
          {rec.usage ? <CacheBadge usage={rec.usage} /> : null}
        </Box>
        {rec.content ? (
          <Text>{rec.content}</Text>
        ) : (
          <Text dimColor italic>
            (tool-call response only)
          </Text>
        )}
      </Box>
    );
  }
  if (rec.role === "tool") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">
          {"tool<"}
          {rec.tool ?? "?"}
          {">"}
        </Text>
        {rec.args ? (
          <Text dimColor>
            {"  args: "}
            {truncate(rec.args, 200)}
          </Text>
        ) : null}
        <Text dimColor>
          {"  → "}
          {truncate(rec.content, 400)}
        </Text>
      </Box>
    );
  }
  if (rec.role === "error") {
    return (
      <Box marginTop={1}>
        <Text color="red" bold>
          error{" "}
        </Text>
        <Text color="red">{rec.error ?? rec.content}</Text>
      </Box>
    );
  }
  if (rec.role === "done" || rec.role === "assistant_delta") {
    // Don't render — noise in replay
    return null;
  }
  return (
    <Box>
      <Text dimColor>
        [{rec.role}] {rec.content}
      </Text>
    </Box>
  );
}

function CacheBadge({ usage }: { usage: NonNullable<TranscriptRecord["usage"]> }) {
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? 0;
  const total = hit + miss;
  if (total === 0) return null;
  const pct = (hit / total) * 100;
  const color = pct >= 70 ? "green" : pct >= 40 ? "yellow" : "red";
  return (
    <Text>
      <Text dimColor>{"  · cache "}</Text>
      <Text color={color}>{pct.toFixed(1)}%</Text>
    </Text>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} chars)`;
}
