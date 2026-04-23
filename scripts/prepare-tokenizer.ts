#!/usr/bin/env node
/**
 * Regenerate `data/deepseek-tokenizer.json.gz` from an upstream
 * `tokenizer.json` (as shipped in DeepSeek's deepseek_v3_tokenizer.zip).
 *
 * Why slim+gz: the full tokenizer.json is 7.5MB; we only need four
 * fields (vocab, merges, pre_tokenizer, added_tokens). Strip + gzip
 * drops the committed artifact to ~1.7MB with no loss of fidelity
 * for encode-side token counting.
 *
 * Usage: `node --experimental-strip-types scripts/prepare-tokenizer.ts <path/to/tokenizer.json>`
 * (or via `tsx` / `ts-node`.)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const src = process.argv[2];
if (!src) {
  process.stderr.write("usage: prepare-tokenizer.ts <tokenizer.json>\n");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(src, "utf8"));
const slim = {
  added_tokens: raw.added_tokens,
  pre_tokenizer: raw.pre_tokenizer,
  model: { type: raw.model.type, vocab: raw.model.vocab, merges: raw.model.merges },
};
const gz = gzipSync(Buffer.from(JSON.stringify(slim)), { level: 9 });
const outPath = join(process.cwd(), "data", "deepseek-tokenizer.json.gz");
writeFileSync(outPath, gz);
process.stdout.write(`wrote ${outPath} (${(gz.length / 1024).toFixed(1)} KB)\n`);
