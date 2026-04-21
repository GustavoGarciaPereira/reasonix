# Reasonix

**The DeepSeek-native agent framework.** TypeScript. Ink TUI. No LangChain.

Reasonix is not another generic agent framework. It does one thing: take DeepSeek's
unusual economic and behavioral profile — dirt-cheap tokens, R1 reasoning traces,
automatic prefix caching — and turn them into agent-loop superpowers that generic
frameworks leave on the table.

```bash
npx reasonix chat          # prompts for your DeepSeek key on first run,
                           # then live TUI with real-time cache/cost panel
```

On first run the TUI asks for your DeepSeek API key (get one at
[platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)) and
saves it to `~/.reasonix/config.json`. Set `DEEPSEEK_API_KEY` in the
environment to override.

## Why Reasonix?

Every other framework treats DeepSeek as an OpenAI-compatible endpoint with a
different base URL. That works, but it leaves most of DeepSeek's advantages
unused. Reasonix is opinionated about three things:

### 1. Cache-First Loop
DeepSeek bills cached input tokens at **~10% of the miss rate**. Reasonix
structures the agent loop as `[Immutable Prefix] + [Append-Only Log] +
[Volatile Scratch]` so every turn reuses the exact byte prefix.

**Validated on real DeepSeek API (`deepseek-chat`):**

| scenario | turns | cache hit | cost | cost on Claude Sonnet 4.6 | savings |
|---|---|---|---|---|---|
| Chinese multi-turn chat | 5 | **85.2%** | $0.000923 | $0.015174 | **93.9%** |
| Tool-use (calculator) | 2 | **94.9%** | $0.000142 | $0.003351 | **95.8%** |

### 2. R1 Thought Harvesting
R1's `reasoning_content` contains a *plan*, not just trivia to display. Reasonix
pipes it through a cheap V3 call (~$0.0001 / turn) in JSON mode and extracts
a typed plan state:

```ts
{ subgoals: string[], hypotheses: string[], uncertainties: string[], rejectedPaths: string[] }
```

Opt-in to keep default cost identical: `reasonix chat --harvest` or
`new CacheFirstLoop({ harvest: true })`. The TUI renders the harvested state
as a compact magenta block above the answer.

### 3. Tool-Call Repair
R1/V3 have known quirks — tool calls leaking into `<think>`, dropped arguments
on deep schemas, truncated JSON, call-storm loops. Reasonix ships a full repair
pipeline: **scavenge + flatten + truncation recovery + storm breaker**.

## Usage

### Library

```ts
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix, ToolRegistry } from "reasonix";

const client = new DeepSeekClient();
const tools = new ToolRegistry();

tools.register({
  name: "add",
  description: "Add two integers",
  parameters: {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "integer" } },
    required: ["a", "b"],
  },
  fn: ({ a, b }) => a + b,
});

const loop = new CacheFirstLoop({
  client,
  prefix: new ImmutablePrefix({
    system: "You are a math helper.",
    toolSpecs: tools.specs(),
  }),
  tools,
});

for await (const ev of loop.step("What is 17 + 25?")) {
  console.log(ev);
}
console.log(loop.stats.summary());
```

### CLI / TUI

```bash
reasonix chat             # full-screen Ink TUI, live cache/cost panel
reasonix run "task"       # one-shot, streaming output
reasonix stats <file>     # summarize transcript JSONL
reasonix version
```

## Status

Pre-alpha. All three pillars ship working end-to-end as of v0.0.3.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Non-goals

- Multi-agent orchestration (use LangGraph if you need it).
- RAG / vector stores.
- Multi-provider abstraction. **Reasonix does DeepSeek, deeply.**
- Web UI / SaaS.

## Development

```bash
npm install
npm run dev chat          # run CLI directly from TS (tsx)
npm run build             # bundle to dist/
npm test                  # vitest
npm run lint              # biome
```

## License

MIT
