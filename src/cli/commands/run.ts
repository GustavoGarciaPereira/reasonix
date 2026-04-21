import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { defaultConfigPath, isPlausibleKey, loadApiKey, saveApiKey } from "../../config.js";
import { loadDotenv } from "../../env.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../../index.js";

export interface RunOptions {
  task: string;
  model: string;
  system: string;
}

async function ensureApiKey(): Promise<string> {
  const existing = loadApiKey();
  if (existing) return existing;

  if (!stdin.isTTY) {
    process.stderr.write(
      "DEEPSEEK_API_KEY is not set and stdin is not a TTY (cannot prompt).\n" +
        "Set the env var, or run `reasonix chat` once interactively to save a key.\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    "DeepSeek API key not configured.\nGet one at https://platform.deepseek.com/api_keys\n",
  );
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = (await rl.question("API key › ")).trim();
      if (!answer) continue;
      if (!isPlausibleKey(answer)) {
        process.stdout.write("Invalid format. Keys start with 'sk-' and are 30+ chars.\n");
        continue;
      }
      saveApiKey(answer);
      process.stdout.write(`Saved to ${defaultConfigPath()}\n\n`);
      return answer;
    }
  } finally {
    rl.close();
  }
}

export async function runCommand(opts: RunOptions): Promise<void> {
  loadDotenv();
  const apiKey = await ensureApiKey();
  process.env.DEEPSEEK_API_KEY = apiKey;

  const client = new DeepSeekClient();
  const prefix = new ImmutablePrefix({ system: opts.system });
  const loop = new CacheFirstLoop({ client, prefix, model: opts.model });

  for await (const ev of loop.step(opts.task)) {
    if (ev.role === "assistant_delta" && ev.content) process.stdout.write(ev.content);
    if (ev.role === "tool") process.stdout.write(`\n[tool ${ev.toolName}] ${ev.content}\n`);
    if (ev.role === "error") process.stderr.write(`\n[error] ${ev.error}\n`);
    if (ev.role === "done") process.stdout.write("\n");
  }
  const s = loop.stats.summary();
  process.stdout.write(
    `\n— turns:${s.turns} cache:${(s.cacheHitRatio * 100).toFixed(1)}% ` +
      `cost:$${s.totalCostUsd.toFixed(6)} save-vs-claude:${s.savingsVsClaudePct.toFixed(1)}%\n`,
  );
}
