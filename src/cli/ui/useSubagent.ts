import { useEffect, useRef, useState } from "react";
import type { SubagentEvent, SubagentSink } from "../../tools/subagent.js";
import { appendUsage } from "../../usage.js";
import type { DisplayEvent } from "./EventLog.js";

export interface SubagentActivity {
  task: string;
  iter: number;
  elapsedMs: number;
}

export interface UseSubagentParams {
  session: string | undefined;
  setHistorical: React.Dispatch<React.SetStateAction<DisplayEvent[]>>;
}

export interface UseSubagentResult {
  /** Live state for an in-flight subagent, null when none is running. */
  activity: SubagentActivity | null;
  /**
   * Ref captured by the loop's `subagentRunner` closure so even
   * late-spawned subagents find the current handler. Consumers pass
   * this to `spawnSubagent({ sink })`.
   */
  sinkRef: React.MutableRefObject<SubagentSink>;
}

/**
 * Subagent UI wiring. `start` opens the activity row; each `progress`
 * updates iter + elapsed in place; `end` clears the row and posts a
 * one-line summary (with inline cost) into Historical. Only one
 * subagent is active at a time in the MVP — overlapping events just
 * replace the prior activity.
 */
export function useSubagent({ session, setHistorical }: UseSubagentParams): UseSubagentResult {
  const [activity, setActivity] = useState<SubagentActivity | null>(null);
  const sinkRef = useRef<SubagentSink>({ current: null });

  useEffect(() => {
    sinkRef.current.current = (ev: SubagentEvent) => {
      if (ev.kind === "start") {
        setActivity({
          task: ev.task,
          iter: ev.iter ?? 0,
          elapsedMs: ev.elapsedMs ?? 0,
        });
        return;
      }
      if (ev.kind === "progress") {
        setActivity({
          task: ev.task,
          iter: ev.iter ?? 0,
          elapsedMs: ev.elapsedMs ?? 0,
        });
        return;
      }
      // end
      setActivity(null);
      const seconds = ((ev.elapsedMs ?? 0) / 1000).toFixed(1);
      // Inline cost: the one number most users look at. Shown in the
      // Historical row so they don't have to run `/stats` to see it.
      const costTail =
        ev.costUsd !== undefined && ev.costUsd > 0 ? ` · $${ev.costUsd.toFixed(4)}` : "";
      const summary = ev.error
        ? `⌬ subagent "${ev.task}" failed after ${seconds}s · ${ev.iter ?? 0} tool call(s) — ${ev.error}`
        : `⌬ subagent "${ev.task}" done in ${seconds}s · ${ev.iter ?? 0} tool call(s) · ${ev.turns ?? 0} turn(s)${costTail}`;
      setHistorical((prev) => [
        ...prev,
        {
          id: `subagent-end-${Date.now()}`,
          role: "info",
          text: summary,
        },
      ]);
      // Persist a subagent summary row to ~/.reasonix/usage.jsonl so
      // `/stats` and `reasonix stats` surface it. Skipped on error —
      // we only record what actually cost money and did work.
      if (!ev.error && ev.usage && ev.model) {
        appendUsage({
          session: session ?? null,
          model: ev.model,
          usage: ev.usage,
          kind: "subagent",
          subagent: {
            skillName: ev.skillName,
            taskPreview: ev.task.slice(0, 60),
            toolIters: ev.iter ?? 0,
            durationMs: ev.elapsedMs ?? 0,
          },
        });
      }
    };
    return () => {
      sinkRef.current.current = null;
    };
  }, [session, setHistorical]);

  return { activity, sinkRef };
}
