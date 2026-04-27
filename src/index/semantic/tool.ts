/**
 * Register `semantic_search` on a ToolRegistry. The tool is gated on
 * an existing on-disk index — calling `registerSemanticSearchTool`
 * with no index is a no-op so the model never sees a tool it can't
 * actually use.
 *
 * The tool description teaches the model when this beats grep:
 *   - grep: known token / exact identifier / structural pattern
 *   - semantic_search: paraphrased intent ("where do we handle auth
 *     failures") / cross-language concept lookup / discovery in
 *     unfamiliar code
 * Without this nudge the model defaults to grep for everything and
 * misses retrieval-tool wins on the questions semantic_search is
 * actually built for.
 */

import type { ToolRegistry } from "../../tools.js";
import { indexExists, querySemantic } from "./builder.js";
import type { EmbedOptions } from "./embedding.js";
import type { SearchHit } from "./store.js";

export interface SemanticToolOptions extends EmbedOptions {
  /** Project root (sandbox dir). Index lives at `<root>/.reasonix/semantic/`. */
  root: string;
  /** Default top-K when the model omits it. Default 8. */
  defaultTopK?: number;
  /** Default min score. Default 0.3. */
  defaultMinScore?: number;
}

/**
 * Register the tool when an index is present. Returns `true` if
 * registered. Callers can warn the user when this returns `false`
 * so they know to run `reasonix index`.
 */
export async function registerSemanticSearchTool(
  registry: ToolRegistry,
  opts: SemanticToolOptions,
): Promise<boolean> {
  if (!(await indexExists(opts.root))) return false;
  const defaultTopK = opts.defaultTopK ?? 8;
  const defaultMinScore = opts.defaultMinScore ?? 0.3;

  registry.register({
    name: "semantic_search",
    description:
      "FIRST CHOICE for descriptive queries. Use this BEFORE search_content (grep) when the user describes WHAT code does ('where do we handle X', 'which file owns Y', 'how does Z work', 'find the logic that …'). Returns ranked snippets ordered by semantic relevance — finds the right file even when your description shares no words with the code. Falls back to search_content / search_files only for: exact identifiers, regex patterns, or counting occurrences of a known token. If your first instinct is grep on a paraphrased question, you are wrong — try semantic_search first.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language description, phrased as a question or noun phrase: 'where do we validate the session cookie?' / 'retry backoff logic' / 'code that prevents user changes from immediately landing on disk'. Do NOT pass exact identifiers — those are search_content's job.",
        },
        topK: {
          type: "integer",
          description: `Number of snippets to return (1..16). Default ${defaultTopK}.`,
        },
        minScore: {
          type: "number",
          description: `Drop snippets with cosine score below this (0..1). Default ${defaultMinScore}. Raise for stricter matches; lower if the index is small.`,
        },
      },
      required: ["query"],
    },
    fn: async (args: { query: string; topK?: number; minScore?: number }, ctx) => {
      const hits = await querySemantic(opts.root, args.query, {
        topK: args.topK ?? defaultTopK,
        minScore: args.minScore ?? defaultMinScore,
        baseUrl: opts.baseUrl,
        model: opts.model,
        signal: ctx?.signal,
      });
      if (hits === null) {
        return "No semantic index found for this project. Run `reasonix index` to build one.";
      }
      if (hits.length === 0) {
        return `query: ${args.query}\n\nno matches above the score threshold (${args.minScore ?? defaultMinScore}).`;
      }
      return formatHits(args.query, hits);
    },
  });
  return true;
}

/**
 * Render hits the same way `web_search` formats its results — header
 * with the query, numbered entries with file:line citation + score
 * + a snippet preview. Keeps tool-output style consistent so users
 * who learn to read one read both.
 */
export function formatHits(query: string, hits: readonly SearchHit[]): string {
  const lines: string[] = [`query: ${query}`, `\nresults (${hits.length}):`];
  hits.forEach((h, i) => {
    const { entry, score } = h;
    lines.push(
      `\n${i + 1}. ${entry.path}:${entry.startLine}-${entry.endLine}  (score ${score.toFixed(3)})`,
    );
    // Cap each snippet so a 60-line chunk doesn't dominate the
    // model's context. The full chunk is still discoverable via
    // read_file once the model picks the most relevant hit.
    const preview = entry.text.split("\n").slice(0, 8).join("\n");
    lines.push(indentBlock(preview, "   "));
    if (entry.text.split("\n").length > 8) {
      lines.push(
        `   …(${entry.text.split("\n").length - 8} more lines — read_file ${entry.path}:${entry.startLine} for the full chunk)`,
      );
    }
  });
  return lines.join("\n");
}

function indentBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

/**
 * `reasonix code` startup bootstrap. Deliberately silent and
 * non-prompting:
 *
 *   - Index exists → register the tool. The model can use it this
 *     session.
 *   - No index → skip. NO probe of Ollama, NO setup question.
 *
 * Why no startup prompt: even a one-time Y/n at launch is intrusive
 * for users who just want to start coding. Discovery happens via
 * `/semantic` slash inside the TUI when the user is curious, plus a
 * single dim line in the welcome banner. Users explicitly opt in by
 * running `reasonix index` in their shell — the established Reasonix
 * pattern (see `/setup`, `/update`).
 */
export async function bootstrapSemanticSearchInCodeMode(
  registry: ToolRegistry,
  rootDir: string,
  opts: EmbedOptions = {},
): Promise<{ enabled: boolean }> {
  if (await indexExists(rootDir)) {
    await registerSemanticSearchTool(registry, { ...opts, root: rootDir });
    return { enabled: true };
  }
  return { enabled: false };
}
