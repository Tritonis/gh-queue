// The command layer takes an injectable `run(args)`, so every branch below —
// including every gh-failure path — is exercised without a repo or a
// network. Assertions are on concrete strings and call shapes, never on
// "did not throw".
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdTriage,
  cmdView,
  cmdPark,
  cmdUnpark,
  cmdNote,
  cmdMilestone,
  cmdInit,
  cmdCloseBatch,
  extractPositional,
  labelSpecs,
  formatCmd,
} from '../lib/commands.mjs';
import { capture, recorder, CFG } from './helpers.mjs';

const FAIL = (stderr) => ({ status: 1, stdout: '', stderr });
const OK = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const label = (args) => {
  const i = args.indexOf('--label');
  return i >= 0 ? args[i + 1] : undefined;
};

function tempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-queue-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- triage ---------------------------------------------------------------

test('triage: uses the configured label names, not hardcoded ones', () => {
  const run = recorder((args) => {
    if (args[1] === 'view') return OK(JSON.stringify({ number: 9, title: 'Roadmap', body: 'plan text' }));
    if (label(args) === 'go') return OK(JSON.stringify([{ number: 11, title: 'Do it', labels: [{ name: 'go' }] }]));
    return OK('[]');
  });
  const { rc, out } = capture(() => cmdTriage(run, { stateIssue: 9, readyLabel: 'go', blockedPrefix: 'held' }, {}));
  assert.equal(rc, 0);
  assert.ok(out.includes('#9 Roadmap'));
  assert.ok(out.includes('READY (go)') && out.includes('#11  Do it'));
  assert.ok(out.includes('HELD:KEYBOARD') && out.includes('HELD:DECISION') && out.includes('HELD (unsplit)'));
});

test('triage: --repo threads -R through every gh call', () => {
  const run = recorder((args) => (args[3] === 'view' ? OK('{"number":1,"title":"S","body":"b"}') : OK('[]')));
  capture(() => cmdTriage(run, { ...CFG, stateIssue: 1, repo: 'o/n' }, {}));
  assert.ok(run.calls.every((c) => c[0] === '-R' && c[1] === 'o/n'), 'every call carries -R o/n');
});

test('triage: the state-issue fetch fails — nothing on stdout, non-zero, no further calls', () => {
  const run = recorder(() => FAIL('gh: state issue fetch failed'));
  const { rc, logs, errs } = capture(() => cmdTriage(run, CFG, {}));
  assert.equal(rc, 1);
  assert.equal(run.calls.length, 1, 'stops at the failing call');
  assert.deepEqual(logs, [], 'an empty triage must never be printed for a failed gh call');
  assert.ok(errs.includes('triage failed: gh: state issue fetch failed'));
});

test('triage: the ready list fails after a good state issue — no partial triage', () => {
  const run = recorder((args) => {
    if (args[1] === 'view') return OK(JSON.stringify({ number: 16, title: 'State', body: 'body' }));
    if (label(args) === 'ready') return FAIL('gh: ready list failed');
    return OK('[]');
  });
  const { rc, logs, errs } = capture(() => cmdTriage(run, CFG, {}));
  assert.equal(rc, 1);
  assert.deepEqual(logs, [], 'the state-issue body is not leaked to stdout');
  assert.ok(errs.includes('triage failed: gh: ready list failed'));
});

test('triage: only the 2nd blocked-label call fails — the 3rd is never made', () => {
  let blocked = 0;
  const run = recorder((args) => {
    if (args[1] === 'view') return OK(JSON.stringify({ number: 16, title: 'State', body: 'body' }));
    if (label(args) === 'ready') return OK('[]');
    blocked++;
    return blocked === 2 ? FAIL('gh: blocked label call 2 failed') : OK('[]');
  });
  const { rc, logs, errs } = capture(() => cmdTriage(run, CFG, {}));
  assert.equal(rc, 1);
  assert.equal(blocked, 2);
  assert.deepEqual(logs, []);
  assert.ok(errs.includes('triage failed: gh: blocked label call 2 failed'));
});

test('triage: stateIssue 0 skips the issue-view call but still fails loudly', () => {
  const run = recorder(() => FAIL('gh: ready list failed'));
  const { rc, logs } = capture(() => cmdTriage(run, { ...CFG, stateIssue: 0 }, {}));
  assert.equal(rc, 1);
  assert.ok(run.calls.every((c) => c[1] !== 'view'));
  assert.deepEqual(logs, []);
});

// --- view -----------------------------------------------------------------

test('view: no positional is a usage error, not a gh call', () => {
  const run = recorder(() => OK());
  const { rc, out } = capture(() => cmdView(run, CFG, [], {}));
  assert.equal(rc, 2);
  assert.equal(run.calls.length, 0);
  assert.ok(out.startsWith('usage: gh-queue view'));
});

test('view: a gh failure is reported and exits non-zero', () => {
  const { rc, out } = capture(() => cmdView(recorder(() => FAIL('gh: no such issue')), CFG, ['5'], {}));
  assert.equal(rc, 1);
  assert.equal(out, 'gh: no such issue');
});

// --- park / unpark --------------------------------------------------------

test('park: exactly two gh calls, right args, no gh URL echoed', () => {
  const run = recorder(() => OK('https://github.com/x/y/issues/42\n'));
  const { rc, out } = capture(() => cmdPark(run, CFG, ['42', 'because reasons'], {}));
  assert.equal(rc, 0);
  assert.equal(run.calls.length, 2);
  assert.deepEqual(run.calls[0], ['issue', 'edit', '42', '--remove-label', 'ready', '--add-label', 'blocked:user:decision']);
  assert.deepEqual(run.calls[1], ['issue', 'comment', '42', '--body', 'because reasons']);
  assert.equal(out, 'parked #42 (ready -> blocked:user:decision)');
});

test('park: --keyboard picks the keyboard sub-bucket', () => {
  const run = recorder(() => OK('https://x\n'));
  capture(() => cmdPark(run, CFG, ['7', 'txt'], { keyboard: true }));
  assert.ok(run.calls[0].includes('blocked:user:keyboard'));
});

test('park: a failed comment call is non-zero and prints no success line', () => {
  const run = recorder((args) => (args[1] === 'comment' ? FAIL('gh: comment failed') : OK('https://x\n')));
  const { rc, logs } = capture(() => cmdPark(run, CFG, ['42', 'because reasons'], {}));
  assert.equal(rc, 1);
  assert.ok(!logs.some((l) => l.startsWith('parked #')));
});

test('park: missing decision text is a usage error with no gh call', () => {
  const run = recorder(() => OK());
  const { rc } = capture(() => cmdPark(run, CFG, ['42'], {}));
  assert.equal(rc, 2);
  assert.equal(run.calls.length, 0);
});

test('unpark: one call removing all three blocked labels and adding ready', () => {
  const run = recorder(() => OK('https://x\n'));
  const { rc, out } = capture(() => cmdUnpark(run, CFG, ['42']));
  assert.equal(rc, 0);
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.calls[0], [
    'issue', 'edit', '42',
    '--remove-label', 'blocked:user',
    '--remove-label', 'blocked:user:keyboard',
    '--remove-label', 'blocked:user:decision',
    '--add-label', 'ready',
  ]);
  assert.equal(out, 'unparked #42 (-> ready)');
});

test('unpark: a gh failure is non-zero and prints no success line', () => {
  const { rc, out } = capture(() => cmdUnpark(recorder(() => FAIL('gh: edit failed')), CFG, ['42']));
  assert.equal(rc, 1);
  assert.equal(out, 'gh: edit failed');
  assert.ok(!out.includes('unparked'));
});

test('unpark: no positional is a usage error', () => {
  const run = recorder(() => OK());
  assert.equal(capture(() => cmdUnpark(run, CFG, [])).rc, 2);
  assert.equal(run.calls.length, 0);
});

// --- note -----------------------------------------------------------------

test('note: comments on the configured state issue, body passed as one argument', () => {
  const run = recorder(() => OK('https://x\n'));
  const { rc, out } = capture(() => cmdNote(run, CFG, ['said "no" to the `plan`']));
  assert.equal(rc, 0);
  assert.deepEqual(run.calls[0], ['issue', 'comment', '16', '--body', 'said "no" to the `plan`']);
  assert.equal(out, 'noted on #16');
});

test('note: with no state issue configured, exits 2 and makes no gh call', () => {
  const run = recorder(() => OK('https://x\n'));
  const { rc, errs, logs } = capture(() => cmdNote(run, { ...CFG, stateIssue: 0 }, ['text']));
  assert.equal(rc, 2, 'a note with nowhere to go must fail, not silently vanish');
  assert.equal(run.calls.length, 0, 'no gh call is attempted');
  assert.deepEqual(logs, []);
  assert.ok(errs.some((l) => l.includes('no state issue configured')));
});

test('note: a gh failure is non-zero', () => {
  const { rc, out } = capture(() => cmdNote(recorder(() => FAIL('gh: comment failed')), CFG, ['t']));
  assert.equal(rc, 1);
  assert.ok(!out.includes('noted on'));
});

test('note: no text is a usage error', () => {
  const run = recorder(() => OK());
  assert.equal(capture(() => cmdNote(run, CFG, [])).rc, 2);
  assert.equal(run.calls.length, 0);
});

// --- milestone ------------------------------------------------------------

const MS = (titles) => OK(JSON.stringify(titles.map((title) => ({ title, state: 'open', number: 1 }))));

test('milestone: lists open issues and derives the count itself', () => {
  const run = recorder((args) => {
    if (args[0] === 'api') return MS(['Batch 5']);
    return OK(JSON.stringify([
      { number: 1, title: 'One', labels: [{ name: 'ready' }] },
      { number: 2, title: 'Two', labels: [] },
    ]));
  });
  const { rc, logs } = capture(() => cmdMilestone(run, CFG, ['Batch 5']));
  assert.equal(rc, 0);
  assert.deepEqual(run.calls[0], ['api', 'repos/{owner}/{repo}/milestones?state=all&per_page=100', '--paginate']);
  assert.deepEqual(run.calls[1], [
    'issue', 'list', '--milestone', 'Batch 5', '--state', 'open', '--json', 'number,title,labels', '--limit', '200',
  ]);
  assert.deepEqual(logs, ['#1  One  [ready]', '#2  Two', '2 open']);
});

test('milestone: an empty milestone still prints an explicit count', () => {
  const run = recorder((args) => (args[0] === 'api' ? MS(['Batch 6']) : OK('[]')));
  const { logs } = capture(() => cmdMilestone(run, CFG, ['Batch 6']));
  assert.deepEqual(logs, ['0 open']);
});

test('milestone: a gh api failure is non-zero and prints no count', () => {
  const { rc, logs, errs } = capture(() => cmdMilestone(recorder(() => FAIL('gh: unknown milestone')), CFG, ['Nope']));
  assert.equal(rc, 1);
  assert.deepEqual(logs, [], 'a failure must not read as "0 open"');
  assert.ok(errs.some((l) => l.includes('gh: unknown milestone')));
});

test('milestone: no name is a usage error', () => {
  const run = recorder(() => OK());
  assert.equal(capture(() => cmdMilestone(run, CFG, [])).rc, 2);
  assert.equal(run.calls.length, 0);
});

test('milestone: exact title used verbatim, no header line', () => {
  const run = recorder((args) => {
    if (args[0] === 'api') return MS(['M0 — Project foundations', 'M1 — Data pipeline']);
    return OK('[]');
  });
  const { logs } = capture(() => cmdMilestone(run, CFG, ['M0 — Project foundations']));
  assert.deepEqual(logs, ['0 open']);
  assert.deepEqual(run.calls[1].slice(0, 3), ['issue', 'list', '--milestone']);
  assert.equal(run.calls[1][3], 'M0 — Project foundations');
});

test('milestone: unambiguous prefix resolves and prints a header line', () => {
  const run = recorder((args) => {
    if (args[0] === 'api') return MS(['M0 — Project foundations', 'M1 — Data pipeline']);
    return OK('[]');
  });
  const { logs } = capture(() => cmdMilestone(run, CFG, ['M0']));
  assert.equal(logs[0], 'milestone: M0 — Project foundations');
  assert.equal(run.calls[1][3], 'M0 — Project foundations');
});

test('milestone: ambiguous prefix exits 2 and names both candidates, no issue list', () => {
  const run = recorder((args) => {
    if (args[0] === 'api') return MS(['M0 — Project foundations', 'M1 — Data pipeline']);
    return OK('[]');
  });
  const { rc, logs } = capture(() => cmdMilestone(run, CFG, ['M']));
  assert.equal(rc, 2);
  assert.equal(logs[0], 'milestone "M": ambiguous — matches: M0 — Project foundations | M1 — Data pipeline');
  assert.ok(!run.calls.some((c) => c[0] === 'issue'));
});

test('milestone: no match exits 2 and lists all titles, no issue list', () => {
  const run = recorder((args) => {
    if (args[0] === 'api') return MS(['M0 — Project foundations', 'M1 — Data pipeline']);
    return OK('[]');
  });
  const { rc, logs } = capture(() => cmdMilestone(run, CFG, ['Zzz']));
  assert.equal(rc, 2);
  assert.equal(logs[0], 'milestone "Zzz": no match — milestones: M0 — Project foundations | M1 — Data pipeline');
  assert.ok(!run.calls.some((c) => c[0] === 'issue'));
});

test('milestone: cfg.repo set uses the owner/name api path', () => {
  const run = recorder((args) => {
    if (args[0] === 'api') return MS(['Batch 5']);
    return OK('[]');
  });
  capture(() => cmdMilestone(run, { ...CFG, repo: 'o/n' }, ['Batch 5']));
  assert.equal(run.calls[0][1], 'repos/o/n/milestones?state=all&per_page=100');
});

test('milestone: cfg.repo unset uses the {owner}/{repo} placeholder path', () => {
  const run = recorder((args) => {
    if (args[0] === 'api') return MS(['Batch 5']);
    return OK('[]');
  });
  capture(() => cmdMilestone(run, CFG, ['Batch 5']));
  assert.equal(run.calls[0][1], 'repos/{owner}/{repo}/milestones?state=all&per_page=100');
});

// --- init -----------------------------------------------------------------

test('init: creates only the missing labels, leaves existing ones untouched', () =>
  tempDir((dir) => {
    const run = recorder((args) => {
      if (args[1] === 'list') return OK(JSON.stringify([{ name: 'ready' }, { name: 'bug' }]));
      return OK('');
    });
    const cfg = { ...CFG, stateIssue: 38 };
    const { rc, logs } = capture(() => cmdInit(run, cfg, {}, dir));
    assert.equal(rc, 0);
    assert.ok(logs.includes('ready: exists'));
    assert.ok(logs.includes('blocked:user: created'));
    assert.ok(logs.includes('blocked:user:keyboard: created'));
    assert.ok(logs.includes('blocked:user:decision: created'));
    const created = run.calls.filter((c) => c[1] === 'create').map((c) => c[2]);
    assert.deepEqual(created, ['blocked:user', 'blocked:user:keyboard', 'blocked:user:decision']);
    assert.ok(!run.calls.some((c) => c[1] === 'delete' || c[1] === 'edit'), 'init never deletes or renames a label');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.gh-queue.json'), 'utf8')), {
      stateIssue: 38,
      readyLabel: 'ready',
      blockedPrefix: 'blocked:user',
    });
  }));

test('init: refuses to overwrite an existing .gh-queue.json without --force', () =>
  tempDir((dir) => {
    const path = join(dir, '.gh-queue.json');
    writeFileSync(path, '{"stateIssue": 7}\n', 'utf8');
    const run = recorder(() => OK('[]'));
    const { rc, errs } = capture(() => cmdInit(run, { ...CFG, stateIssue: 38 }, {}, dir));
    assert.equal(rc, 2);
    assert.equal(run.calls.length, 0, 'no gh call is made when init refuses');
    assert.ok(errs.some((l) => l.includes('already exists')));
    assert.equal(readFileSync(path, 'utf8'), '{"stateIssue": 7}\n', 'the existing config is untouched');
  }));

test('init: --force does overwrite', () =>
  tempDir((dir) => {
    const path = join(dir, '.gh-queue.json');
    writeFileSync(path, '{"stateIssue": 7}\n', 'utf8');
    const run = recorder((args) => (args[1] === 'list' ? OK('[]') : OK('')));
    const { rc } = capture(() => cmdInit(run, { ...CFG, stateIssue: 38 }, { force: true }, dir));
    assert.equal(rc, 0);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).stateIssue, 38);
  }));

test('init: --dry-run prints the commands and writes nothing', () =>
  tempDir((dir) => {
    const run = recorder(() => OK('[]'));
    const { rc, logs } = capture(() => cmdInit(run, { ...CFG, stateIssue: 38 }, { dryRun: true }, dir));
    assert.equal(rc, 0);
    assert.equal(run.calls.length, 0, 'dry-run invokes run() zero times');
    assert.ok(!existsSync(join(dir, '.gh-queue.json')), 'dry-run writes no config file');
    assert.ok(logs.some((l) => l.includes('gh label list')));
    for (const spec of labelSpecs(CFG)) assert.ok(logs.some((l) => l.includes(`gh label create ${spec.name}`)));
  }));

test('init: a failed label list aborts before writing anything', () =>
  tempDir((dir) => {
    const run = recorder(() => FAIL('gh: not authenticated'));
    const { rc, errs } = capture(() => cmdInit(run, { ...CFG, stateIssue: 38 }, {}, dir));
    assert.equal(rc, 1);
    assert.equal(run.calls.length, 1);
    assert.ok(!existsSync(join(dir, '.gh-queue.json')));
    assert.ok(errs.some((l) => l.includes('gh: not authenticated')));
  }));

test('init: a failed label create is reported and makes the command non-zero', () =>
  tempDir((dir) => {
    const run = recorder((args) => {
      if (args[1] === 'list') return OK('[]');
      return args[2] === 'blocked:user:decision' ? FAIL('gh: label create failed') : OK('');
    });
    const { rc, logs } = capture(() => cmdInit(run, { ...CFG, stateIssue: 38 }, {}, dir));
    assert.equal(rc, 1, 'a failed create must not read as success');
    assert.ok(logs.some((l) => l.startsWith('blocked:user:decision: create failed')));
  }));

test('init: honours a custom label vocabulary', () =>
  tempDir((dir) => {
    const run = recorder((args) => (args[1] === 'list' ? OK('[]') : OK('')));
    capture(() => cmdInit(run, { stateIssue: 1, readyLabel: 'go', blockedPrefix: 'held' }, {}, dir));
    const created = run.calls.filter((c) => c[1] === 'create').map((c) => c[2]);
    assert.deepEqual(created, ['go', 'held', 'held:keyboard', 'held:decision']);
  }));

// --- close-batch ----------------------------------------------------------

test('close-batch --dry-run: prints the commands, runs nothing', () => {
  const run = recorder(() => OK('[]'));
  const { logs } = capture(() => cmdCloseBatch(run, CFG, { issues: '1,2', note: 'batch done', dryRun: true }));
  assert.equal(run.calls.length, 0);
  assert.ok(logs.some((l) => l.includes('gh issue close 1')) && logs.some((l) => l.includes('gh issue close 2')));
});

test('close-batch --dry-run: a note with quotes stays one argument', () => {
  const { logs } = capture(() =>
    cmdCloseBatch(recorder(() => OK('[]')), CFG, { issues: '9', note: 'said "no" to the plan', dryRun: true }),
  );
  const commentLine = logs.find((l) => l.includes('issue comment 16'));
  assert.ok(commentLine.includes(JSON.stringify('said "no" to the plan')));
});

test('close-batch: a lingering ready label is removed and reported', () => {
  const run = recorder((args) => {
    if (args[1] === 'view') return OK(JSON.stringify({ number: 3, state: 'CLOSED', labels: [{ name: 'ready' }] }));
    return OK('https://x\n');
  });
  const { out } = capture(() => cmdCloseBatch(run, CFG, { issues: '3', note: 'batch done' }));
  assert.ok(out.includes('removed lingering ready label'));
  assert.ok(run.calls.some((c) => c.join(' ') === 'issue edit 3 --remove-label ready'));
});

test('close-batch: a failed state note still closes the batch but exits non-zero', () => {
  const run = recorder((args) => {
    if (args[1] === 'comment') return FAIL('gh: comment failed');
    if (args[1] === 'view') return OK(JSON.stringify({ number: 5, state: 'CLOSED', labels: [] }));
    return OK('https://x\n');
  });
  const { rc, out } = capture(() => cmdCloseBatch(run, CFG, { issues: '5', note: 'batch done' }));
  assert.equal(rc, 1);
  assert.ok(out.includes('#5: closed'));
  assert.ok(out.includes('batch closed with 1 failure'));
});

test('close-batch: the close call itself fails — no verify call follows', () => {
  const run = recorder((args) => {
    if (args[1] === 'close') return FAIL('gh: close failed');
    return OK('https://x\n');
  });
  const { rc, out } = capture(() => cmdCloseBatch(run, CFG, { issues: '6', note: 'batch done' }));
  assert.equal(rc, 1);
  assert.ok(out.includes('#6: close failed'));
  assert.ok(!run.calls.some((c) => c[1] === 'view'));
});

test('close-batch: the verify re-fetch fails', () => {
  const run = recorder((args) => (args[1] === 'view' ? FAIL('gh: verify failed') : OK('https://x\n')));
  const { rc, out } = capture(() => cmdCloseBatch(run, CFG, { issues: '7', note: 'batch done' }));
  assert.equal(rc, 1);
  assert.ok(out.includes('#7: closed, but verification failed'));
});

test('close-batch: verify says the issue is still OPEN', () => {
  const run = recorder((args) => {
    if (args[1] === 'view') return OK(JSON.stringify({ number: 8, state: 'OPEN', labels: [] }));
    return OK('https://x\n');
  });
  const { rc, out } = capture(() => cmdCloseBatch(run, CFG, { issues: '8', note: 'batch done' }));
  assert.equal(rc, 1);
  assert.ok(out.includes('#8: NOT CLOSED (state=OPEN)'));
});

test('close-batch: no --issues is a usage error', () => {
  const run = recorder(() => OK());
  assert.equal(capture(() => cmdCloseBatch(run, CFG, {})).rc, 2);
  assert.equal(run.calls.length, 0);
});

// --- helpers --------------------------------------------------------------

test('extractPositional: value flags do not donate their values as positionals', () => {
  assert.deepEqual(extractPositional(['42', '--state-issue', '9', 'text'], ['state-issue']), ['42', 'text']);
  assert.deepEqual(extractPositional(['42', '--state-issue=9', '--keyboard', 'text'], ['state-issue']), ['42', 'text']);
});

test('formatCmd: an argument with spaces or quotes is printed as one quoted token', () => {
  assert.equal(formatCmd(['issue', 'comment', '--body', 'a "b" c']), 'gh issue comment --body "a \\"b\\" c"');
});
