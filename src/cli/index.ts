import { Command } from "commander";
import { VERSION } from "../index.js";
import { chatCommand } from "./commands/chat.js";
import { diffCommand } from "./commands/diff.js";
import { mcpListCommand } from "./commands/mcp.js";
import { replayCommand } from "./commands/replay.js";
import { runCommand } from "./commands/run.js";
import { sessionsCommand } from "./commands/sessions.js";
import { statsCommand } from "./commands/stats.js";
import { versionCommand } from "./commands/version.js";

const DEFAULT_SYSTEM =
  "You are Reasonix, a helpful DeepSeek-powered assistant. Be concise and accurate. Use tools when available.";

const program = new Command();
program
  .name("reasonix")
  .description("DeepSeek-native agent framework — built for cache hits and cheap tokens.")
  .version(VERSION);

program
  .command("chat")
  .description("Interactive Ink TUI with live cache/cost panel.")
  .option("-m, --model <id>", "DeepSeek model id", "deepseek-chat")
  .option("-s, --system <prompt>", "System prompt (pinned in the immutable prefix)", DEFAULT_SYSTEM)
  .option("--transcript <path>", "Write a JSONL transcript to this path")
  .option(
    "--harvest",
    "Extract typed plan state from R1 reasoning (Pillar 2, adds a cheap V3 call per turn)",
  )
  .option(
    "--branch <n>",
    "Self-consistency: run N parallel samples per turn and pick the most confident (disables streaming; enables harvest)",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--session <name>",
    "Use a named session (default: 'default'). Resume the same session next time.",
  )
  .option("--no-session", "Disable session persistence for this run (ephemeral chat)")
  .option(
    "--mcp <spec>",
    'MCP server spec; repeatable. Forms: "name=cmd args..." (namespaced, tools get `name_` prefix) or "cmd args..." (anonymous). Example: --mcp "fs=npx -y @scope/fs /tmp" --mcp "gh=npx -y @scope/gh"',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .option(
    "--mcp-prefix <str>",
    "Global prefix applied to every MCP tool (only honored when no per-spec name is set; avoids collisions with a single anonymous server)",
  )
  .action(async (opts) => {
    // Default behavior: every chat is auto-saved to a session named 'default'
    // and auto-resumed next launch. Pass --no-session to opt out, or
    // --session <name> to use a different session.
    let session: string | undefined;
    if (opts.session === false) {
      session = undefined; // --no-session
    } else if (typeof opts.session === "string" && opts.session.length > 0) {
      session = opts.session;
    } else {
      session = "default";
    }
    await chatCommand({
      model: opts.model,
      system: opts.system,
      transcript: opts.transcript,
      harvest: !!opts.harvest,
      branch: Number.isFinite(opts.branch) && opts.branch > 1 ? opts.branch : undefined,
      session,
      mcp: opts.mcp as string[],
      mcpPrefix: opts.mcpPrefix,
    });
  });

program
  .command("run <task>")
  .description("Run a single task non-interactively, streaming output.")
  .option("-m, --model <id>", "DeepSeek model id", "deepseek-chat")
  .option("-s, --system <prompt>", "System prompt", DEFAULT_SYSTEM)
  .option(
    "--harvest",
    "Extract typed plan state from R1 reasoning (Pillar 2, adds a cheap V3 call per turn)",
  )
  .option(
    "--branch <n>",
    "Self-consistency: run N parallel samples per turn and pick the most confident",
    (v) => Number.parseInt(v, 10),
  )
  .option("--transcript <path>", "Write a JSONL transcript to this path for replay/diff")
  .option(
    "--mcp <spec>",
    'MCP server spec; repeatable. "name=cmd args..." or "cmd args...".',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .option(
    "--mcp-prefix <str>",
    "Global prefix (only honored when no per-spec name is set; for a single anonymous server)",
  )
  .action(async (task: string, opts) => {
    await runCommand({
      task,
      model: opts.model,
      system: opts.system,
      harvest: !!opts.harvest,
      branch: Number.isFinite(opts.branch) && opts.branch > 1 ? opts.branch : undefined,
      transcript: opts.transcript,
      mcp: opts.mcp as string[],
      mcpPrefix: opts.mcpPrefix,
    });
  });

program
  .command("stats <transcript>")
  .description("Summarize a JSONL transcript produced by `reasonix chat --transcript`.")
  .action((transcript: string) => {
    statsCommand({ transcript });
  });

program
  .command("sessions [name]")
  .description("List saved chat sessions, or inspect one by name.")
  .option("-v, --verbose", "Include system prompts + tool-call metadata when inspecting")
  .action((name: string | undefined, opts) => {
    sessionsCommand({ name, verbose: !!opts.verbose });
  });

program
  .command("replay <transcript>")
  .description(
    "Interactive Ink TUI to scrub through a transcript + rebuild its session summary (cost, cache, prefix stability). No API calls.",
  )
  .option("--print", "Dump to stdout instead of mounting the TUI (auto when piped)")
  .option("--head <n>", "stdout mode only — show first N records", (v) => Number.parseInt(v, 10))
  .option("--tail <n>", "stdout mode only — show last N records", (v) => Number.parseInt(v, 10))
  .action(async (transcript: string, opts) => {
    await replayCommand({
      path: transcript,
      print: !!opts.print,
      head: Number.isFinite(opts.head) ? opts.head : undefined,
      tail: Number.isFinite(opts.tail) ? opts.tail : undefined,
    });
  });

program
  .command("diff <a> <b>")
  .description(
    "Compare two transcripts in a split-pane Ink TUI (default) or stdout table. Use n/N to jump across divergences.",
  )
  .option("--md <path>", "Write a markdown report (blog-ready) to this path")
  .option("--print", "Force stdout table instead of the TUI (auto when piped)")
  .option("--tui", "Force the TUI even when piped (rare)")
  .option("--label-a <label>", "Display label for transcript A (default: filename)")
  .option("--label-b <label>", "Display label for transcript B (default: filename)")
  .action(async (a: string, b: string, opts) => {
    await diffCommand({
      a,
      b,
      mdPath: opts.md,
      labelA: opts.labelA,
      labelB: opts.labelB,
      print: !!opts.print,
      tui: !!opts.tui,
    });
  });

const mcp = program
  .command("mcp")
  .description("Model Context Protocol helpers — discover servers, test your setup.");

mcp
  .command("list")
  .description("Show a curated catalog of popular MCP servers with ready-to-use --mcp commands.")
  .option("--json", "Emit the catalog as JSON instead of the human-readable table")
  .action((opts) => {
    mcpListCommand({ json: !!opts.json });
  });

program.command("version").description("Print Reasonix version.").action(versionCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
