/**
 * Bridge: register an MCP server's tools into a Reasonix ToolRegistry.
 *
 * This is the integration surface. Once done, `CacheFirstLoop` sees the
 * MCP tools as if they were native — they inherit Cache-First + repair
 * (scavenge / truncation / storm) automatically. That's the payoff: any
 * MCP ecosystem tool, wrapped in Reasonix's Pillar 1 + Pillar 3 benefits.
 */

import { countTokens } from "../tokenizer.js";
import { ToolRegistry } from "../tools.js";
import type { JSONSchema } from "../types.js";
import type { McpClient } from "./client.js";
import type { CallToolResult, McpContentBlock } from "./types.js";

export interface BridgeOptions {
  /**
   * Prefix prepended to every MCP tool name when registered. Defaults to
   * empty (no prefix). Useful when bridging multiple servers into one
   * registry and names collide — e.g. `fs` + `gh` both exposing `search`.
   */
  namePrefix?: string;
  /** Registry to populate. Creates a fresh one if omitted. */
  registry?: ToolRegistry;
  /** Auto-flatten deep schemas (Pillar 3). Defaults to the registry's own default (true). */
  autoFlatten?: boolean;
  /**
   * Per-tool-call result cap, in characters. If a tool returns more than
   * this, the result is truncated and a `[…truncated N chars…]` marker is
   * appended before the last KB so the model still sees a useful tail.
   * Defaults to {@link DEFAULT_MAX_RESULT_CHARS}.
   *
   * Why this exists: DeepSeek V3's context is 131,072 tokens. A single
   * `read_file` against a big source file can return >3 MB of text
   * (~900k tokens) and permanently poison the session — every subsequent
   * turn rebuilds the history and 400s. This cap is a floor. Users who
   * legitimately want bigger payloads can raise it explicitly.
   */
  maxResultChars?: number;
  /**
   * Callback fired for every `notifications/progress` frame the server
   * emits during any bridged tool call. Includes the registered
   * (prefix-applied) tool name so a multi-server UI can attribute
   * progress correctly. Absent → no `_meta.progressToken` is sent and
   * the server won't emit progress for these calls.
   */
  onProgress?: (info: {
    toolName: string;
    progress: number;
    total?: number;
    message?: string;
  }) => void;
}

/**
 * 32,000 chars ≈ 8k English tokens, or ~16k CJK tokens. Small enough to
 * fit comfortably in history even across 5–10 tool calls, large enough
 * that most file reads and directory listings fit un-truncated.
 */
export const DEFAULT_MAX_RESULT_CHARS = 32_000;

/**
 * Token-aware cap for tool results, in DeepSeek V3 tokens.
 *
 * 8,000 tokens ≈ 6% of DeepSeek V3's 131K context. One oversized tool
 * result can't eat more than that no matter what character density the
 * content has. The char cap (32K chars) only bounds tokens for English
 * — CJK text at 1 char/token blows past 16K tokens under the same
 * ceiling. With the tokenizer shipped in 0.5.0 we can cap the thing
 * that actually matters.
 */
export const DEFAULT_MAX_RESULT_TOKENS = 8_000;

export interface BridgeResult {
  registry: ToolRegistry;
  /** Names actually registered (may differ from MCP names when a prefix is applied). */
  registeredNames: string[];
  /** Names the server listed but the bridge skipped (e.g. invalid schemas). */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Walk a connected `McpClient`'s tools/list result, register each into a
 * Reasonix `ToolRegistry`. Each registered `fn` proxies through the
 * client's tools/call. Tool results are flattened into a string (joining
 * text blocks with newlines, prefixing image blocks as placeholders) so
 * they fit Reasonix's existing tool-dispatch contract.
 */
export async function bridgeMcpTools(
  client: McpClient,
  opts: BridgeOptions = {},
): Promise<BridgeResult> {
  const registry = opts.registry ?? new ToolRegistry({ autoFlatten: opts.autoFlatten });
  const prefix = opts.namePrefix ?? "";
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const result: BridgeResult = { registry, registeredNames: [], skipped: [] };

  const listed = await client.listTools();
  for (const mcpTool of listed.tools) {
    if (!mcpTool.name) {
      result.skipped.push({ name: "?", reason: "empty tool name" });
      continue;
    }
    const registeredName = `${prefix}${mcpTool.name}`;
    registry.register({
      name: registeredName,
      description: mcpTool.description ?? "",
      parameters: mcpTool.inputSchema as JSONSchema,
      fn: async (args: Record<string, unknown>, ctx) => {
        const toolResult = await client.callTool(mcpTool.name, args, {
          // Forward server-side progress frames to the bridge caller,
          // tagged with the registered name so multi-server UIs can
          // disambiguate. No-op when `onProgress` isn't configured —
          // the client then also omits the _meta.progressToken and
          // the server won't emit progress.
          onProgress: opts.onProgress
            ? (info) => opts.onProgress!({ toolName: registeredName, ...info })
            : undefined,
          // Thread the tool-dispatch AbortSignal all the way down to
          // the MCP request so Esc truly cancels in flight — the
          // client will emit notifications/cancelled AND reject the
          // pending promise immediately, no "wait for subprocess".
          signal: ctx?.signal,
        });
        return flattenMcpResult(toolResult, { maxChars: maxResultChars });
      },
    });
    result.registeredNames.push(registeredName);
  }
  return result;
}

export interface FlattenOptions {
  /** Cap the flattened string at this many characters. Default: no cap. */
  maxChars?: number;
}

/**
 * Turn an MCP CallToolResult into a string — the contract Reasonix's
 * ToolRegistry.dispatch returns. We:
 *   - join text blocks with newlines (most common case)
 *   - stringify image blocks as placeholders (LLM can't use bytes anyway
 *     in Reasonix's current surface; image support comes with multimodal
 *     prompts later)
 *   - prefix error results with "ERROR: " so the calling model sees the
 *     failure clearly even through JSON mode
 *   - optionally truncate to `maxChars` so a single oversized tool result
 *     (e.g. a big `read_file`) can't poison the session by blowing past
 *     the model's context window
 */
export function flattenMcpResult(result: CallToolResult, opts: FlattenOptions = {}): string {
  const parts = result.content.map(blockToString);
  const joined = parts.join("\n").trim();
  const prefixed = result.isError ? `ERROR: ${joined || "(no error message from server)"}` : joined;
  return opts.maxChars ? truncateForModel(prefixed, opts.maxChars) : prefixed;
}

/**
 * Keep the head AND a short tail so the model sees both "what the tool
 * started returning" and "how it ended". Head-only loses file endings
 * (e.g. an error message appended at the bottom of a stack trace); the
 * 1KB tail window covers that while costing almost nothing. Exported for
 * tests and reuse by non-MCP tool adapters that want the same policy.
 */
export function truncateForModel(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const tailBudget = Math.min(1024, Math.floor(maxChars * 0.1));
  const headBudget = Math.max(0, maxChars - tailBudget);
  const head = s.slice(0, headBudget);
  const tail = s.slice(-tailBudget);
  const dropped = s.length - head.length - tail.length;
  return `${head}\n\n[…truncated ${dropped} chars — raise BridgeOptions.maxResultChars, or call the tool with a narrower scope (filter, head, pagination)…]\n\n${tail}`;
}

/**
 * Token-aware truncation. Same head+tail policy as `truncateForModel`,
 * but sizes the slices against a DeepSeek V3 token budget instead of a
 * raw character count — so CJK text (which previously survived at 2×
 * the token cost per char) gets capped at the same effective context
 * footprint as English.
 *
 * Strategy: fast path when `s.length <= maxTokens` (every token is ≥1
 * char, so this bounds tokens ≤ maxTokens — skip tokenize entirely).
 * Short-ish strings are confirmed against the real token count.
 * Long strings go straight to char-sliced head+tail with one or two
 * tokenize-verify-and-shrink rounds per slice — we deliberately never
 * tokenize the full input, because pathological repetitive text
 * (megabytes of `AAAA…`) can cost 30s+ on the pure-TS BPE port.
 */
export function truncateForModelByTokens(s: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  // Every token is ≥1 char — if length ≤ budget, tokens ≤ budget.
  if (s.length <= maxTokens) return s;
  // Small enough to tokenize-check without pathological cost: confirm
  // whether we're actually over budget. (Threshold is the char-bound
  // worst case for English/code — ~4 chars/token.)
  if (s.length <= maxTokens * 4) {
    const tokens = countTokens(s);
    if (tokens <= maxTokens) return s;
  }

  const markerOverhead = 48; // rough token cost of the truncation marker
  const contentBudget = Math.max(0, maxTokens - markerOverhead);
  const tailBudget = Math.min(256, Math.floor(contentBudget * 0.1));
  const headBudget = Math.max(0, contentBudget - tailBudget);

  const head = sizePrefixToTokens(s, headBudget);
  const tail = sizeSuffixToTokens(s, tailBudget);
  const droppedChars = s.length - head.length - tail.length;
  // Estimate dropped tokens from the per-slice char/token ratio we
  // already measured, rather than paying another full-string tokenize.
  // The marker says "~N tokens" so the ≤10% slop is visible to readers.
  const headTokens = head ? countTokens(head) : 0;
  const tailTokens = tail ? countTokens(tail) : 0;
  const sampleChars = head.length + tail.length;
  const sampleTokens = headTokens + tailTokens;
  const ratio = sampleChars > 0 ? sampleTokens / sampleChars : 0.3;
  const estTotalTokens = Math.ceil(s.length * ratio);
  const droppedTokens = Math.max(0, estTotalTokens - sampleTokens);
  return `${head}\n\n[…truncated ~${droppedTokens} tokens (${droppedChars} chars) — raise BridgeOptions.maxResultTokens, or call the tool with a narrower scope (filter, head, pagination)…]\n\n${tail}`;
}

/**
 * Slice `s` from the start to the largest prefix that fits `budget`
 * tokens. Never tokenizes the full input: starts with a char-bound
 * estimate, then verifies and shrinks. Converges in 1–2 iterations.
 */
function sizePrefixToTokens(s: string, budget: number): string {
  if (budget <= 0 || s.length === 0) return "";
  // Optimistic starting size: assume ~4 chars/token (English/code
  // average). If the content is denser (CJK ~1 char/token), the first
  // tokenize will show we're over and we shrink.
  let size = Math.min(s.length, budget * 4);
  for (let iter = 0; iter < 6; iter++) {
    if (size <= 0) return "";
    const slice = s.slice(0, size);
    const count = countTokens(slice);
    if (count <= budget) return slice;
    // Shrink by the overshoot fraction plus a small safety margin.
    const next = Math.floor(size * (budget / count) * 0.95);
    if (next >= size) return s.slice(0, Math.max(0, size - 1));
    size = next;
  }
  return s.slice(0, Math.max(0, size));
}

/** Slice `s` from the end to the largest suffix that fits `budget` tokens. */
function sizeSuffixToTokens(s: string, budget: number): string {
  if (budget <= 0 || s.length === 0) return "";
  let size = Math.min(s.length, budget * 4);
  for (let iter = 0; iter < 6; iter++) {
    if (size <= 0) return "";
    const slice = s.slice(-size);
    const count = countTokens(slice);
    if (count <= budget) return slice;
    const next = Math.floor(size * (budget / count) * 0.95);
    if (next >= size) return s.slice(-Math.max(0, size - 1));
    size = next;
  }
  return s.slice(-Math.max(0, size));
}

function blockToString(block: McpContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "image") return `[image ${block.mimeType}, ${block.data.length} chars base64]`;
  // Unknown block type — preserve for diagnostics.
  return `[unknown block: ${JSON.stringify(block)}]`;
}
