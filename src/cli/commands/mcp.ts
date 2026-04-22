/**
 * `reasonix mcp <subcmd>` — the MCP discovery / helper surface.
 *
 * Currently one subcommand: `list`. Prints a curated catalog of popular
 * MCP servers with their `--mcp` commands ready to copy-paste. More
 * subcommands (`init`, `try`, etc.) may land in later alphas.
 */

import { MCP_CATALOG, mcpCommandFor } from "../../mcp/catalog.js";

export interface McpListOptions {
  /** Emit JSON on stdout instead of the human-readable table. */
  json?: boolean;
}

export function mcpListCommand(opts: McpListOptions): void {
  if (opts.json) {
    console.log(JSON.stringify(MCP_CATALOG, null, 2));
    return;
  }

  console.log("Popular MCP servers you can bridge into Reasonix:");
  console.log("");
  for (const entry of MCP_CATALOG) {
    console.log(`  ${pad(entry.name, 12)} ${entry.summary}`);
    console.log(`               ${mcpCommandFor(entry)}`);
    if (entry.note) console.log(`               · ${entry.note}`);
    console.log("");
  }
  console.log("Usage:  reasonix chat <one-of-the---mcp-lines-above>");
  console.log(
    "Docs:   https://github.com/modelcontextprotocol/servers  —  Anthropic's official server repo",
  );
  console.log(
    "        https://mcp.so                                   —  community-maintained catalog",
  );
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
