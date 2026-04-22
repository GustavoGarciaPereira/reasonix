/**
 * Curated catalog of popular MCP servers.
 *
 * Hardcoded because (a) this list changes slowly — maybe monthly, (b)
 * fetching it over the network would make `reasonix mcp list` flaky
 * offline or behind a proxy. When it does change, update this file and
 * ship a patch release.
 *
 * Inclusion criteria:
 *   - actively maintained (official Anthropic repo OR widely used)
 *   - stdio-compatible (Reasonix doesn't do SSE yet)
 *   - installable with one `npx -y ...` command — zero manual setup
 *   - has a clear value proposition in one short line
 *
 * Not included: servers that need API keys / OAuth / complex config.
 * Those get their own docs once we have patterns for them.
 */

export interface CatalogEntry {
  /** Short name, used as the namespace prefix when suggested. */
  name: string;
  /** One-line description shown in `reasonix mcp list`. */
  summary: string;
  /** npm package id (for `npx -y <pkg>`). */
  package: string;
  /** Extra args the user must supply (e.g. a directory path). */
  userArgs?: string;
  /** Notes the user needs to know — shown dimmed. */
  note?: string;
}

export const MCP_CATALOG: CatalogEntry[] = [
  {
    name: "filesystem",
    summary: "read/write/search files inside a sandboxed directory",
    package: "@modelcontextprotocol/server-filesystem",
    userArgs: "<dir>",
    note: "the directory is a hard sandbox — the server refuses access outside it",
  },
  {
    name: "fetch",
    summary: "fetch URLs (markdown-friendly extraction, not a full browser)",
    package: "@modelcontextprotocol/server-fetch",
  },
  {
    name: "memory",
    summary: "persistent key-value memory across sessions",
    package: "@modelcontextprotocol/server-memory",
  },
  {
    name: "github",
    summary: "read issues, PRs, code search (needs GITHUB_PERSONAL_ACCESS_TOKEN)",
    package: "@modelcontextprotocol/server-github",
    note: "set GITHUB_PERSONAL_ACCESS_TOKEN in your env before spawning",
  },
  {
    name: "sqlite",
    summary: "read/write a sqlite database file",
    package: "@modelcontextprotocol/server-sqlite",
    userArgs: "<db.sqlite>",
  },
  {
    name: "puppeteer",
    summary: "browser automation — take screenshots, click, type",
    package: "@modelcontextprotocol/server-puppeteer",
    note: "downloads Chromium on first run (~200 MB)",
  },
  {
    name: "everything",
    summary: "official test server — exercises every MCP feature",
    package: "@modelcontextprotocol/server-everything",
    note: "useful for debugging your Reasonix setup",
  },
];

/**
 * Build the `reasonix chat --mcp "..."` command line for a catalog entry.
 * Returns a copy-pasteable fragment starting at `--mcp`.
 */
export function mcpCommandFor(entry: CatalogEntry): string {
  const pkg = entry.package;
  const tail = entry.userArgs ? ` ${entry.userArgs}` : "";
  return `--mcp "${entry.name}=npx -y ${pkg}${tail}"`;
}
