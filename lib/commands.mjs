/**
 * lib/commands.mjs — one exported function per subcommand.
 *
 * Every command takes an injectable `run(args) -> {status, stdout, stderr}`
 * so the whole surface is testable without a repo, a network, or a real
 * `gh`. Arguments are always arrays, never shell strings: issue bodies and
 * decision notes routinely carry quotes and backticks.
 *
 * A gh failure must never look like success. Every call's exit status is
 * checked; a failed lookup aborts with nothing printed to stdout, because an
 * empty triage reads identically to a genuinely clean queue.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strArg } from './parse-args.mjs';
import { formatTriage, formatView, formatIssueRow, bucketBlocked, parseMilestones, resolveMilestone } from './format.mjs';
import { CONFIG_FILE } from './config.mjs';

export function withRepo(cfg, args) {
  return cfg.repo ? ['-R', cfg.repo, ...args] : args;
}

export function formatCmd(args) {
  return ['gh', ...args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/** Collect leftover non-flag tokens from a subcommand's argv. `valueFlags`
 * lists (hyphenated) flag names that consume the following token as a
 * value, so that value is not mistaken for a positional. */
export function extractPositional(argv, valueFlags) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (/^--[\w-]+=/.test(tok)) continue;
    const bare = tok.match(/^--([\w-]+)$/);
    if (bare) {
      if (valueFlags.includes(bare[1])) i++;
      continue;
    }
    positional.push(tok);
  }
  return positional;
}

export const CONFIG_VALUE_FLAGS = ['state-issue', 'ready-label', 'blocked-prefix', 'repo'];

function firstStderrLine(r) {
  return (r.stderr || '').trim().split('\n')[0] || 'gh call failed';
}

/** The four labels the queue convention needs. The two sub-buckets are
 * `:keyboard` (the user has to type/click something) and `:decision` (the
 * user has to make a call) — fixed by convention, deliberately not
 * configurable, so every repo's blocked pile splits the same two ways. */
export function labelSpecs(cfg) {
  return [
    { name: cfg.readyLabel, color: '0e8a16', description: 'Queued and unblocked: an agent can pick this up now' },
    { name: cfg.blockedPrefix, color: 'd93f0b', description: 'Blocked on the user (unsplit)' },
    { name: `${cfg.blockedPrefix}:keyboard`, color: 'fbca04', description: 'Blocked on the user: needs hands on a keyboard' },
    { name: `${cfg.blockedPrefix}:decision`, color: '5319e7', description: 'Blocked on the user: needs a decision' },
  ];
}

export function cmdTriage(run, cfg, flags) {
  const lines = Number(strArg(flags.lines, '120'));
  const fields = 'number,title,state,body,labels,milestone';

  const fail = (r) => {
    console.error(`triage failed: ${firstStderrLine(r)}`);
    return 1;
  };

  let stateIssue = null;
  if (cfg.stateIssue) {
    const r = run(withRepo(cfg, ['issue', 'view', String(cfg.stateIssue), '--json', fields]));
    if (r.status !== 0) return fail(r);
    stateIssue = JSON.parse(r.stdout);
  }

  const readyRes = run(
    withRepo(cfg, ['issue', 'list', '--state', 'open', '--label', cfg.readyLabel, '--json', fields, '--limit', '200']),
  );
  if (readyRes.status !== 0) return fail(readyRes);
  const readyIssues = JSON.parse(readyRes.stdout);

  const blockedLabels = [cfg.blockedPrefix, `${cfg.blockedPrefix}:keyboard`, `${cfg.blockedPrefix}:decision`];
  const seen = new Map();
  for (const label of blockedLabels) {
    const r = run(withRepo(cfg, ['issue', 'list', '--state', 'open', '--label', label, '--json', fields, '--limit', '200']));
    if (r.status !== 0) return fail(r);
    for (const issue of JSON.parse(r.stdout)) seen.set(issue.number, issue);
  }
  const buckets = bucketBlocked([...seen.values()], cfg.blockedPrefix);

  console.log(formatTriage(stateIssue, readyIssues, buckets, { lines, readyLabel: cfg.readyLabel, blockedPrefix: cfg.blockedPrefix }));
  return 0;
}

export function cmdView(run, cfg, positional, flags) {
  const n = positional[0];
  if (!n) {
    console.log('usage: gh-queue view <n> [--comments k] [--lines N]');
    return 2;
  }
  const lines = Number(strArg(flags.lines, '120'));
  const comments = Number(strArg(flags.comments, '3'));
  const fields = 'number,title,state,body,labels,milestone,comments';
  const r = run(withRepo(cfg, ['issue', 'view', String(n), '--json', fields]));
  if (r.status !== 0) {
    console.log(r.stderr.trim() || `gh issue view ${n} failed`);
    return 1;
  }
  const issue = JSON.parse(r.stdout);
  console.log(formatView(issue, { lines, comments }));
  return 0;
}

export function cmdPark(run, cfg, positional, flags) {
  const [n, decisionText] = positional;
  if (!n || decisionText === undefined) {
    console.log('usage: gh-queue park <n> "<decision text>" [--keyboard]');
    return 2;
  }
  const targetLabel = flags.keyboard ? `${cfg.blockedPrefix}:keyboard` : `${cfg.blockedPrefix}:decision`;
  const editRes = run(withRepo(cfg, ['issue', 'edit', String(n), '--remove-label', cfg.readyLabel, '--add-label', targetLabel]));
  if (editRes.status !== 0) {
    console.log(editRes.stderr.trim() || `gh issue edit ${n} failed`);
    return 1;
  }
  const commentRes = run(withRepo(cfg, ['issue', 'comment', String(n), '--body', decisionText]));
  if (commentRes.status !== 0) {
    console.log(commentRes.stderr.trim() || `gh issue comment ${n} failed`);
    return 1;
  }
  console.log(`parked #${n} (${cfg.readyLabel} -> ${targetLabel})`);
  return 0;
}

/** The inverse of `park`: drop all three blocked labels, restore `ready`.
 * gh tolerates `--remove-label` for a label the issue does not carry, so
 * this is one call regardless of which bucket the issue was sitting in. */
export function cmdUnpark(run, cfg, positional) {
  const n = positional[0];
  if (!n) {
    console.log('usage: gh-queue unpark <n>');
    return 2;
  }
  const args = ['issue', 'edit', String(n)];
  for (const label of [cfg.blockedPrefix, `${cfg.blockedPrefix}:keyboard`, `${cfg.blockedPrefix}:decision`]) {
    args.push('--remove-label', label);
  }
  args.push('--add-label', cfg.readyLabel);
  const r = run(withRepo(cfg, args));
  if (r.status !== 0) {
    console.log(r.stderr.trim() || `gh issue edit ${n} failed`);
    return 1;
  }
  console.log(`unparked #${n} (-> ${cfg.readyLabel})`);
  return 0;
}

/** Append a line to the running state issue. Without a configured state
 * issue there is nothing to append to, and silently doing nothing would
 * lose the note — so this is the one command that hard-errors on
 * `stateIssue === 0`. */
export function cmdNote(run, cfg, positional) {
  const text = positional[0];
  if (text === undefined) {
    console.log('usage: gh-queue note "<text>"');
    return 2;
  }
  if (!cfg.stateIssue) {
    console.error(`no state issue configured — set stateIssue in ${CONFIG_FILE}, GH_QUEUE_STATE_ISSUE, or --state-issue N`);
    return 2;
  }
  const r = run(withRepo(cfg, ['issue', 'comment', String(cfg.stateIssue), '--body', text]));
  if (r.status !== 0) {
    console.log(r.stderr.trim() || `gh issue comment ${cfg.stateIssue} failed`);
    return 1;
  }
  console.log(`noted on #${cfg.stateIssue}`);
  return 0;
}

/** List a milestone's open issues and count them. GitHub's own milestone
 * `open_issues` counter drifts (it lags transfers, and closes made through
 * some API paths), so the count printed here is derived by listing rather
 * than read off the milestone object. */
export function cmdMilestone(run, cfg, positional) {
  const query = positional[0];
  if (!query) {
    console.log('usage: gh-queue milestone "<name-or-prefix>"');
    return 2;
  }
  const path = cfg.repo
    ? `repos/${cfg.repo}/milestones?state=all&per_page=100`
    : `repos/{owner}/{repo}/milestones?state=all&per_page=100`;
  const mr = run(['api', path, '--paginate']);
  if (mr.status !== 0) {
    console.error(`milestone failed: ${firstStderrLine(mr)}`);
    return 1;
  }
  const milestones = parseMilestones(mr.stdout);
  const resolved = resolveMilestone(query, milestones);
  if (resolved.error === 'ambiguous') {
    console.log(`milestone "${query}": ambiguous — matches: ${resolved.candidates.join(' | ')}`);
    return 2;
  }
  if (resolved.error === 'none') {
    console.log(`milestone "${query}": no match — milestones: ${resolved.candidates.join(' | ')}`);
    return 2;
  }
  const title = resolved.title;
  if (title !== query) console.log(`milestone: ${title}`);
  const r = run(
    withRepo(cfg, ['issue', 'list', '--milestone', title, '--state', 'open', '--json', 'number,title,labels', '--limit', '200']),
  );
  if (r.status !== 0) {
    console.error(`milestone failed: ${firstStderrLine(r)}`);
    return 1;
  }
  const issues = JSON.parse(r.stdout);
  for (const issue of issues) console.log(formatIssueRow(issue));
  console.log(`${issues.length} open`);
  return 0;
}

/** Bootstrap a repo: write `.gh-queue.json`, then create whichever of the
 * four convention labels are missing. Purely additive — an existing label
 * is left exactly as it is (colour, description and all), and nothing is
 * ever deleted or renamed. */
export function cmdInit(run, cfg, flags, cwd = process.cwd()) {
  const dryRun = flags.dryRun === true;
  const path = join(cwd, CONFIG_FILE);
  const contents = `${JSON.stringify(
    { stateIssue: cfg.stateIssue, readyLabel: cfg.readyLabel, blockedPrefix: cfg.blockedPrefix },
    null,
    2,
  )}\n`;

  if (existsSync(path) && flags.force !== true) {
    console.error(`${CONFIG_FILE} already exists — pass --force to overwrite it`);
    return 2;
  }

  if (dryRun) {
    console.log(`would write ${CONFIG_FILE}: ${JSON.stringify(JSON.parse(contents))}`);
    console.log(formatCmd(withRepo(cfg, ['label', 'list', '--json', 'name', '--limit', '200'])));
    for (const spec of labelSpecs(cfg)) {
      console.log(
        formatCmd(withRepo(cfg, ['label', 'create', spec.name, '--description', spec.description, '--color', spec.color])),
      );
    }
    return 0;
  }

  const listRes = run(withRepo(cfg, ['label', 'list', '--json', 'name', '--limit', '200']));
  if (listRes.status !== 0) {
    console.error(`init failed: ${firstStderrLine(listRes)}`);
    return 1;
  }
  const existing = new Set(JSON.parse(listRes.stdout).map((l) => l.name));

  writeFileSync(path, contents, 'utf8');
  console.log(`wrote ${CONFIG_FILE}`);

  let failures = 0;
  for (const spec of labelSpecs(cfg)) {
    if (existing.has(spec.name)) {
      console.log(`${spec.name}: exists`);
      continue;
    }
    const r = run(withRepo(cfg, ['label', 'create', spec.name, '--description', spec.description, '--color', spec.color]));
    if (r.status !== 0) {
      console.log(`${spec.name}: create failed — ${firstStderrLine(r)}`);
      failures++;
      continue;
    }
    console.log(`${spec.name}: created`);
  }
  return failures > 0 ? 1 : 0;
}

export function cmdCloseBatch(run, cfg, flags) {
  const issuesRaw = strArg(flags.issues, '');
  const issueNumbers = issuesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const note = strArg(flags.note, '');
  const dryRun = flags.dryRun === true;

  if (!issueNumbers.length) {
    console.log('usage: gh-queue close-batch --issues 1,2,3 --note "<text>" [--dry-run]');
    return 2;
  }

  if (dryRun) {
    if (cfg.stateIssue) console.log(formatCmd(withRepo(cfg, ['issue', 'comment', String(cfg.stateIssue), '--body', note])));
    for (const n of issueNumbers) console.log(formatCmd(withRepo(cfg, ['issue', 'close', String(n)])));
    for (const n of issueNumbers) console.log(formatCmd(withRepo(cfg, ['issue', 'view', String(n), '--json', 'number,state,labels'])));
    return 0;
  }

  // A failed state-issue note does not abort the batch — the issues still
  // get closed — but it, and every other failed gh call below, counts
  // against the exit code: `failures > 0` is the only thing that makes
  // this return non-zero, so a caller scripting close-batch can trust the
  // exit code rather than grepping the printed lines.
  let failures = 0;
  if (cfg.stateIssue) {
    const r = run(withRepo(cfg, ['issue', 'comment', String(cfg.stateIssue), '--body', note]));
    if (r.status !== 0) {
      console.log(`#${cfg.stateIssue}: note comment failed — ${r.stderr.trim()}`);
      failures++;
    }
  }

  let closed = 0;
  for (const n of issueNumbers) {
    const closeRes = run(withRepo(cfg, ['issue', 'close', String(n)]));
    if (closeRes.status !== 0) {
      console.log(`#${n}: close failed — ${closeRes.stderr.trim()}`);
      failures++;
      continue;
    }
    const verifyRes = run(withRepo(cfg, ['issue', 'view', String(n), '--json', 'number,state,labels']));
    if (verifyRes.status !== 0) {
      console.log(`#${n}: closed, but verification failed — ${verifyRes.stderr.trim()}`);
      failures++;
      continue;
    }
    const issue = JSON.parse(verifyRes.stdout);
    let line = `#${n}: `;
    if (issue.state !== 'CLOSED') {
      line += `NOT CLOSED (state=${issue.state})`;
      failures++;
    } else {
      line += 'closed';
      closed++;
    }
    const names = (issue.labels ?? []).map((l) => l.name);
    if (names.includes(cfg.readyLabel)) {
      run(withRepo(cfg, ['issue', 'edit', String(n), '--remove-label', cfg.readyLabel]));
      line += `; removed lingering ${cfg.readyLabel} label`;
    }
    console.log(line);
  }

  if (failures > 0) {
    console.log(`batch closed with ${failures} failure${failures === 1 ? '' : 's'} (${closed}/${issueNumbers.length} closed)`);
    return 1;
  }
  console.log(`closed ${closed}/${issueNumbers.length}`);
  return 0;
}

export const USAGE = `gh-queue — GitHub issue-queue bookkeeping over the gh CLI

usage: gh-queue <command> [args] [config flags]

commands:
  triage                          state issue + ready list + the blocked buckets
  view <n>                        one issue: body and last comments
  park <n> "<text>" [--keyboard]  ready -> blocked (decision, or keyboard), with a comment
  unpark <n>                      blocked -> ready
  note "<text>"                   comment on the state issue
  milestone "<name-or-prefix>"    open issues in a milestone, plus a true count
  close-batch --issues 1,2,3 --note "<text>" [--dry-run]
  init [--force] [--dry-run]      write .gh-queue.json and create the four labels
  help                            this text

config flags (any command): --state-issue N  --ready-label L  --blocked-prefix P  --repo OWNER/NAME
display flags: --lines N (triage, view)  --comments K (view)

precedence: flag > GH_QUEUE_STATE_ISSUE / GH_QUEUE_READY_LABEL / GH_QUEUE_BLOCKED_PREFIX / GH_QUEUE_REPO
            > .gh-queue.json in the current directory > defaults (state issue 0 = none, ready, blocked:user)`;
