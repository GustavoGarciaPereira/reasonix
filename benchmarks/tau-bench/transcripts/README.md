# Reference transcripts

These are the raw `.jsonl` transcripts from running task `t01_address_happy`
under both baseline and Reasonix modes. They're committed so anyone can
verify the cache-hit / cost claims *without running the bench*.

## Files

| file | what it is |
|---|---|
| `t01_address_happy.baseline.r1.jsonl` | Naive cache-hostile agent's record of the run |
| `t01_address_happy.reasonix.r1.jsonl` | Reasonix's record of the same task |
| `t01_address_happy.diff.md` | Output of `reasonix diff` on the two above |
| `mcp-demo.add.jsonl` | End-to-end run through an MCP tool (v0.3 integration). DeepSeek called the `add` tool from the bundled demo server; the second turn hit 96.6% cache, 94% cheaper than Claude at same token counts |

## Verify for yourself

```bash
# Install and build (or run from source via tsx)
npm install

# Rebuild the summary — this does NOT call the API; it reads the JSONL.
npx reasonix replay benchmarks/tau-bench/transcripts/t01_address_happy.reasonix.r1.jsonl

# Reproduce the diff:
npx reasonix diff \
  benchmarks/tau-bench/transcripts/t01_address_happy.baseline.r1.jsonl \
  benchmarks/tau-bench/transcripts/t01_address_happy.reasonix.r1.jsonl \
  --label-a baseline --label-b reasonix
```

Headline numbers from the committed run:

- cache hit: **45.9% → 93.9% (+48.0pp)**
- cost: **$0.001192 → $0.000953 (−20.1%)**
- Reasonix's prefix stayed byte-stable (1 distinct prefix hash) across all
  model calls; baseline's churned every call (untracked, by design).

## Regenerate

```bash
export DEEPSEEK_API_KEY=sk-...
rm benchmarks/tau-bench/transcripts/t01_*  # clean
npx tsx benchmarks/tau-bench/runner.ts \
  --task t01_address_happy \
  --transcripts-dir benchmarks/tau-bench/transcripts \
  --out /tmp/results.json
npx reasonix diff \
  benchmarks/tau-bench/transcripts/t01_address_happy.baseline.r1.jsonl \
  benchmarks/tau-bench/transcripts/t01_address_happy.reasonix.r1.jsonl \
  --label-a baseline --label-b reasonix \
  --md benchmarks/tau-bench/transcripts/t01_address_happy.diff.md
```

Cost: ~$0.003 per full regeneration.
