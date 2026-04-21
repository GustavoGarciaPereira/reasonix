# Harvest eval harness (Pillar 2)

Measures Pillar 2 (R1 Thought Harvesting) the same way `tau-bench/`
measures Pillar 1 (Cache-First Loop): isolate one variable, produce
numbers anyone can reproduce.

## What's different from τ-bench-lite?

Deliberately different task shape:

| | τ-bench-lite | harvest-bench |
|---|---|---|
| task style | multi-turn tool-use | single-turn reasoning |
| user simulator | yes (LLM) | no |
| DB state | yes | no |
| checker | DB-predicate | regex + set/value compare |
| target | Pillar 1 | Pillar 2 |
| model | deepseek-chat (default) | deepseek-reasoner (only R1 has `reasoning_content` for harvest to work on) |

The two harnesses answer different questions:

- **τ-bench-lite**: *"Does Cache-First actually cut cost on real tool-use
  workflows?"* (yes — 47.7pp cache, −39% cost on 48-run data.)
- **harvest-bench**: *"Does the extra V3 harvest call add measurable
  value above plain R1?"* (TBD — run it to find out.)

## Modes

Three modes isolate one variable each:

| mode | model | harvest | what it measures |
|---|---|---|---|
| `baseline` | deepseek-chat | off | floor reference — V3 at its best |
| `reasoner` | deepseek-reasoner | off | raw R1 gain over V3 on reasoning |
| `reasoner-harvest` | deepseek-reasoner | on | R1 + the extra V3 harvest call |

Deltas:

- `baseline → reasoner` answers "is R1 worth the price on these
  problems?"
- `reasoner → reasoner-harvest` answers "is the harvest call worth
  its incremental cost?"

## Quickstart

```bash
# Dry-run — no API, smoke-test the wiring
npx tsx benchmarks/harvest/runner.ts --dry

# Full run (live DeepSeek, costs ~$0.20-0.60 for 6 tasks × 3 modes × 1 repeat)
export DEEPSEEK_API_KEY=sk-...
npx tsx benchmarks/harvest/runner.ts

# Tighter run with 3 repeats (~$0.60-2.00)
npx tsx benchmarks/harvest/runner.ts --repeats 3

# Only the hard tasks (skip the easy floor)
npx tsx benchmarks/harvest/runner.ts --task pseudoprime_base2
npx tsx benchmarks/harvest/runner.ts --task derangements_d7
npx tsx benchmarks/harvest/runner.ts --task euler_quadratic_break

# Bump per-call timeout (reasoner + harvest occasionally blow past the 120s default)
npx tsx benchmarks/harvest/runner.ts --timeout 600

# Per-run transcripts so you can reasonix replay / diff them
npx tsx benchmarks/harvest/runner.ts --repeats 3 --transcripts-dir transcripts/

# Render report
npx tsx benchmarks/harvest/report.ts benchmarks/harvest/results-*.json
```

## Tasks (v0.3 seed)

Split into two bands:

**Easy band** — V3 chat solves these, so baseline has a real pass rate and the bench has a reference floor.

| id | shape | why |
|---|---|---|
| `mod7_list` | number theory, 29-element list | R1 often tries enumeration first, then reaches for modular arithmetic — clean rejectedPaths signal |
| `flips_until_3heads` | probability, single integer | classic recurrence; R1 either derives or recalls, harvest should see hypotheses diverge |
| `three_hats` | logic puzzle, one-word answer | pure deduction chain, tests harvest's ability to extract the nested reasoning |

**Hard band** — picked specifically for known V3 failure modes. If R1 systematically beats V3 on these, and harvest further beats R1-only, we have our Pillar 2 story.

| id | shape | why V3 tends to fail |
|---|---|---|
| `pseudoprime_base2` | smallest Fermat pseudoprime to base 2 = **341** | V3 often answers 561 (Carmichael) or some other composite it remembers — R1 actually checks 2^n mod n |
| `derangements_d7` | D_7 = **1854** | V3 approximates via n!/e and rounds wrong, or recalls D_6/D_8; R1 uses the recurrence D_n=(n−1)(D_{n−1}+D_{n−2}) |
| `euler_quadratic_break` | smallest n where n²+n+41 is composite = **40** | V3 frequently confuses with n²−n+41 (first fails at 41); R1 checks small n systematically |

Adding a new task: see `tasks.ts`. Any checker that's deterministic is
fair game — extract numeric/list/text with regex, compare with set
equality or string matching.

## Non-goals

- **No LLM-as-judge.** Brittle and expensive; defeats the point of a
  reproducible bench. If a checker is too hard to write deterministically,
  the task doesn't belong here.
- **No tool-use tasks.** Those live in `tau-bench/`. Different story.
- **No multi-turn.** v0.3 harness is single-turn Q/A. Multi-turn reasoning
  eval is separate scope.
- **No benchmark-data cherry-picking.** When results come in, we publish
  them whether they validate Pillar 2 or not. "harvest didn't help on
  these 3 tasks" is still useful information.
