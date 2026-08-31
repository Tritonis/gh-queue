/**
 * tools/lib/gh-queue-format.mjs — pure formatting for tools/gh-queue.mjs (#240).
 *
 * Every function here takes plain data (parsed `gh --json` output, already
 * a JS object — no jq) and returns a plain string. No `gh`, no `spawnSync`,
 * no process state, so `tests/gh-queue.test.mjs` can exercise every branch
 * without a repo or a network. Kept separate from the command runner for
 * exactly that reason.
 */

/** Cap `text` at `n` lines, appending a "... (+M more lines)" marker when
 * truncated. No marker, no truncation when the text already fits. */
export function capLines(text, n) {
  const lines = String(text ?? '').split('\n');
  if (lines.length <= n) return lines.join('\n');
  const shown = lines.slice(0, n).join('\n');
  const more = lines.length - n;
  return `${shown}\n... (+${more} more lines)`;
}

/** Sort labels into blocked-pile buckets under `prefix` (default
 * `blocked:user`). An issue carrying `${prefix}:keyboard` or
 * `${prefix}:decision` goes in that bucket; one carrying the bare `${prefix}`
 * label with neither sub-label goes in `unsplit`. An issue with none of the
 * three is in no bucket. */
export function bucketBlocked(issues, prefix = 'blocked:user') {
  const keyboard = [];
  const decision = [];
  const unsplit = [];
  const kwLabel = `${prefix}:keyboard`;
  const decLabel = `${prefix}:decision`;
  for (const issue of issues) {
    const names = (issue.labels ?? []).map((l) => l.name);
    if (names.includes(kwLabel)) keyboard.push(issue);
    else if (names.includes(decLabel)) decision.push(issue);
    else if (names.includes(prefix)) unsplit.push(issue);
  }
  return { keyboard, decision, unsplit };
}

/** One compact row: `#N  title  [other labels]  {milestone}`. `omitLabel`,
 * when given, is dropped from the printed label list (the label that
 * defines the bucket the row is already sitting in). */
export function formatIssueRow(issue, omitLabel) {
  const names = (issue.labels ?? []).map((l) => l.name).filter((n) => n !== omitLabel);
  let row = `#${issue.number}  ${issue.title}`;
  if (names.length) row += `  [${names.join(', ')}]`;
  const milestoneTitle = issue.milestone?.title;
  if (milestoneTitle) row += `  {${milestoneTitle}}`;
  return row;
}

function formatList(issues, omitLabel) {
  if (!issues.length) return '(none)';
  return issues.map((i) => formatIssueRow(i, omitLabel)).join('\n');
}

/**
 * `triage`: the state issue's (capped) body, then the ready list, then the
 * three blocked buckets. `stateIssue` may be null (no state issue
 * configured, or `--state-issue 0`) in which case that block is skipped
 * entirely.
 */
export function formatTriage(stateIssue, readyIssues, buckets, opts = {}) {
  const lines = opts.lines ?? 120;
  const readyLabel = opts.readyLabel ?? 'ready';
  const blockedPrefix = opts.blockedPrefix ?? 'blocked:user';
  const parts = [];
  if (stateIssue) {
    parts.push(`#${stateIssue.number} ${stateIssue.title}\n${capLines(stateIssue.body, lines)}`);
  }
  parts.push(`READY (${readyLabel})\n${formatList(readyIssues, readyLabel)}`);
  parts.push(`${blockedPrefix.toUpperCase()}:KEYBOARD\n${formatList(buckets.keyboard, `${blockedPrefix}:keyboard`)}`);
  parts.push(`${blockedPrefix.toUpperCase()}:DECISION\n${formatList(buckets.decision, `${blockedPrefix}:decision`)}`);
  parts.push(`${blockedPrefix.toUpperCase()} (unsplit)\n${formatList(buckets.unsplit, blockedPrefix)}`);
  return parts.join('\n\n');
}

/** `view <n>`: header line, capped body, then the last `opts.comments`
 * comments (default 3), each capped at 40 lines. */
export function formatView(issue, opts = {}) {
  const lines = opts.lines ?? 120;
  const k = opts.comments ?? 3;
  const names = (issue.labels ?? []).map((l) => l.name);
  let header = `#${issue.number} ${issue.title} — ${issue.state} — labels: ${names.join(', ')}`;
  const milestoneTitle = issue.milestone?.title;
  if (milestoneTitle) header += ` — milestone: ${milestoneTitle}`;

  const body = capLines(issue.body, lines);

  const all = issue.comments ?? [];
  const last = k > 0 ? all.slice(-k) : [];
  const commentBlocks = last.map((c) => {
    const author = c.author?.login ?? '(unknown)';
    const date = String(c.createdAt ?? '').slice(0, 10);
    return `--- @${author} ${date} ---\n${capLines(c.body, 40)}`;
  });
  const summary = `(${all.length} comments total, showing last ${last.length})`;

  return [header, body, summary, ...commentBlocks].join('\n\n');
}
