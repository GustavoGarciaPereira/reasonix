/**
 * One place that defines what each preset means. Both `slash.ts`
 * (in-chat `/preset`) and the wizard (first-run setup) read from here.
 *
 * Presets are the single vocabulary we teach new users: they don't need
 * to know model IDs, Pillar 2, branch budgets, or cost tradeoffs
 * independently — they pick "fast / smart / max" and we translate.
 */

import type { PresetName } from "../../config.js";

export interface PresetSettings {
  model: string;
  harvest: boolean;
  /** Branch budget. `1` means branching off. */
  branch: number;
}

export const PRESETS: Record<PresetName, PresetSettings> = {
  // `deepseek-chat` / `deepseek-reasoner` are retained as the fast /
  // smart models because they're deprecated-but-working compat aliases
  // for v4-flash's non-thinking and thinking modes respectively. Same
  // billing, smaller config churn for existing users. `max` promotes
  // to v4-pro — 12× flash on input/output, reserved for hard tasks.
  fast: { model: "deepseek-chat", harvest: false, branch: 1 },
  smart: { model: "deepseek-reasoner", harvest: true, branch: 1 },
  max: { model: "deepseek-v4-pro", harvest: true, branch: 3 },
};

export const PRESET_DESCRIPTIONS: Record<PresetName, { headline: string; cost: string }> = {
  fast: {
    headline: "deepseek-chat (= v4-flash non-thinking), no harvest, no branching",
    cost: "~1¢ per 100 turns · default",
  },
  smart: {
    headline: "deepseek-reasoner (= v4-flash thinking) + Pillar 2 harvest",
    cost: "same price as fast · slower · better on multi-step tasks",
  },
  max: {
    headline: "deepseek-v4-pro + harvest + self-consistency (3 branches)",
    cost: "~30× cost vs fast · slowest · for hard single-shots",
  },
};

export function resolvePreset(name: PresetName | undefined): PresetSettings {
  return PRESETS[name ?? "fast"];
}
