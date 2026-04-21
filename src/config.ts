/**
 * User-level config storage for the Reasonix CLI.
 *
 * Lookup order for the API key:
 *   1. `DEEPSEEK_API_KEY` env var (highest priority — for CI / power users)
 *   2. `~/.reasonix/config.json` (set by the first-run setup flow)
 *
 * The library itself never touches the config file — it only reads
 * `DEEPSEEK_API_KEY` from the environment. The CLI is responsible for
 * pulling from the config file and exposing it via env var to the loop.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ReasonixConfig {
  apiKey?: string;
  baseUrl?: string;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".reasonix", "config.json");
}

export function readConfig(path: string = defaultConfigPath()): ReasonixConfig {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ReasonixConfig;
  } catch {
    /* missing or malformed → empty config */
  }
  return {};
}

export function writeConfig(cfg: ReasonixConfig, path: string = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
  // Restrict permissions on Unix; chmod is a no-op on Windows but won't throw.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore on platforms without chmod */
  }
}

/** Resolve the API key from env var first, then the config file. */
export function loadApiKey(path: string = defaultConfigPath()): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  return readConfig(path).apiKey;
}

export function saveApiKey(key: string, path: string = defaultConfigPath()): void {
  const cfg = readConfig(path);
  cfg.apiKey = key.trim();
  writeConfig(cfg, path);
}

export function isPlausibleKey(key: string): boolean {
  const trimmed = key.trim();
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(trimmed);
}

/** Mask a key for display: `sk-abcd...wxyz`. */
export function redactKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
