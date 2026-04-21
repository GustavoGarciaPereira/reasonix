import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { diffTranscripts, renderMarkdown, renderSummaryTable } from "../../diff.js";
import { readTranscript } from "../../transcript.js";

export interface DiffOptions {
  a: string;
  b: string;
  mdPath?: string;
  labelA?: string;
  labelB?: string;
}

export function diffCommand(opts: DiffOptions): void {
  const aParsed = readTranscript(opts.a);
  const bParsed = readTranscript(opts.b);

  const report = diffTranscripts(
    { label: opts.labelA ?? basename(opts.a), parsed: aParsed },
    { label: opts.labelB ?? basename(opts.b), parsed: bParsed },
  );

  // Always print the stdout table — it's the primary consumer surface.
  console.log(renderSummaryTable(report));

  if (opts.mdPath) {
    const md = renderMarkdown(report);
    writeFileSync(opts.mdPath, md, "utf8");
    console.log(`\nmarkdown report written to ${opts.mdPath}`);
  }
}
