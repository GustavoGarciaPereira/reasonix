/**
 * Reusable prompt fragments. Every rule that applies across multiple
 * prompt surfaces (main agent + subagents + built-in skills) lives
 * here so one edit covers every place the model learns the house
 * style. The 4-copy formatting-rule drift that motivated this was a
 * real bug: Unicode box-drawing warnings diverged between subagent
 * prompts, and the main code prompt lacked them entirely even though
 * its reply goes through the same markdown renderer.
 */

/**
 * How replies get rendered. Matches behaviors the TUI's markdown
 * pipeline (src/cli/ui/markdown.tsx) actually handles best.
 * Embedded literally into prompts — no string interpolation, so it
 * survives Reasonix's prefix-cache hashing unchanged across sessions.
 */
export const TUI_FORMATTING_RULES = `Formatting (rendered in a TUI with a real markdown renderer):
- Tabular data → GitHub-Flavored Markdown tables with ASCII pipes (\`| col | col |\` header + \`| --- | --- |\` separator). Never use Unicode box-drawing characters (│ ─ ┼ ┌ ┐ └ ┘ ├ ┤) — they look intentional but break terminal word-wrap and render as garbled columns at narrow widths.
- Keep table cells short (one phrase each). If a cell needs a paragraph, use bullets below the table instead.
- Code, file paths with line ranges, and shell commands → fenced code blocks (\`\`\`).
- Do NOT draw decorative frames around content with \`┌──┐ │ └──┘\` characters. The renderer adds its own borders; extra ASCII art adds noise and shatters at narrow widths.
- For flow charts and diagrams: a plain bullet list with \`→\` or \`↓\` between steps. Don't try to draw boxes-and-arrows in ASCII; it never survives word-wrap.`;

/**
 * Self-report escalation contract — teaches the model (running on
 * flash by default) how to ask for a retry on v4-pro. When Reasonix
 * sees "<<<NEEDS_PRO>>>" as the first line of assistant output on
 * flash, it aborts the call, upgrades this turn to pro, and re-issues
 * the same messages. One retry per turn; pro never re-escalates.
 *
 * Why this exists: non-expert users can't reliably predict which
 * tasks need the frontier tier, and reactive-only escalation (wait
 * for flash to fail N times) wastes tokens + time. Letting the model
 * self-assess catches hard tasks upfront when flash recognizes the
 * difficulty — without silently auto-upgrading every prompt (which
 * would destroy cost savings).
 *
 * Use sparingly: most coding tasks stay on flash. The escape hatch
 * is for tasks where flash would otherwise emit a mediocre / guessed
 * answer.
 */
export const ESCALATION_CONTRACT = `Cost-aware escalation (when you're running on deepseek-v4-flash):

If a task CLEARLY exceeds what flash can do well — complex cross-file architecture refactors, subtle concurrency / security / correctness invariants you can't resolve with confidence, or a design trade-off you'd be guessing at — output the exact string \`<<<NEEDS_PRO>>>\` as the FIRST line of your response (nothing before it, not even whitespace on a separate line). This aborts the current call and retries this turn on deepseek-v4-pro, one shot. Do NOT emit any other content in the same response when you request escalation.

Use this sparingly. Normal tasks — reading files, small edits, clear bug fixes, straightforward feature additions — stay on flash. Request escalation ONLY when you would otherwise produce a guess or a visibly-mediocre answer. If in doubt, attempt the task on flash first; the system also escalates automatically if you hit 3+ repair / SEARCH-mismatch errors in a single turn.`;

/**
 * "Don't assert absence without checking." Subagents that run without
 * this rule will confidently report "X is missing" based on their
 * partial exploration, and the parent agent swallows it as fact. The
 * main code prompt has its own, longer version of this — kept separate
 * because the code agent is in a richer conversational frame.
 */
export const NEGATIVE_CLAIM_RULE = `Negative claims ("X is missing", "Y isn't implemented", "there's no Z") are the #1 hallucination shape. They feel safe to write because no citation seems possible — but that's exactly why you must NOT write them on instinct.

If you have a search tool (\`search_content\`, \`grep\`, web search), call it FIRST before asserting absence:
- Returns matches → you were wrong; correct yourself and cite the matches.
- Returns nothing → state the absence WITH the search query as evidence: \`No callers of \\\`foo()\\\` found (search_content "foo").\`

If you have no search tool, qualify hard: "I haven't verified — this is a guess." Never assert absence with fake authority.`;
