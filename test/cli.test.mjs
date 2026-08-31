import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, resolveGh } from '../bin/gh-queue.mjs';
import { capture, recorder } from './helpers.mjs';

test('main: help prints the usage listing every command', () => {
  for (const argv of [['help'], ['--help']]) {
    const { rc, out } = capture(() => main(argv, recorder(() => ({ status: 0, stdout: '[]', stderr: '' }))));
    assert.equal(rc, 0, `${argv[0]} exits 0`);
    for (const cmd of ['triage', 'view', 'park', 'unpark', 'note', 'milestone', 'close-batch', 'init']) {
      assert.ok(out.includes(cmd), `usage mentions ${cmd}`);
    }
  }
});

test('main: a bare invocation, or one starting with a flag, is triage', () => {
  for (const argv of [[], ['--lines', '5'], ['--repo=o/n']]) {
    const run = recorder(() => ({ status: 0, stdout: '[]', stderr: '' }));
    const { rc, out } = capture(() => main(argv, run, tmpdir()));
    assert.equal(rc, 0, `${JSON.stringify(argv)} exits 0`);
    assert.ok(out.includes('READY (ready)'), `${JSON.stringify(argv)} produced a triage, not usage`);
    assert.ok(run.calls.length > 0, 'gh was actually called');
  }
  const flagged = recorder(() => ({ status: 0, stdout: '[]', stderr: '' }));
  capture(() => main(['--repo=o/n'], flagged, tmpdir()));
  assert.deepEqual(flagged.calls[0].slice(0, 2), ['-R', 'o/n'], 'the leading flag is honoured by the implied triage');
});

test('main: an unknown command prints usage and exits 2', () => {
  const { rc, out } = capture(() => main(['frobnicate'], recorder(() => ({ status: 0, stdout: '[]', stderr: '' }))));
  assert.equal(rc, 2);
  assert.ok(out.startsWith('gh-queue —'));
});

test('main: .gh-queue.json in the working directory configures the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-queue-cli-'));
  try {
    writeFileSync(join(dir, '.gh-queue.json'), JSON.stringify({ stateIssue: 21, readyLabel: 'go', blockedPrefix: 'held' }), 'utf8');
    const run = recorder((args) =>
      args[1] === 'view'
        ? { status: 0, stdout: JSON.stringify({ number: 21, title: 'State', body: 'b' }), stderr: '' }
        : { status: 0, stdout: '[]', stderr: '' },
    );
    const { rc, out } = capture(() => main(['triage'], run, dir));
    assert.equal(rc, 0);
    assert.deepEqual(run.calls[0].slice(0, 3), ['issue', 'view', '21']);
    assert.ok(out.includes('READY (go)') && out.includes('HELD:KEYBOARD'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main: park positionals survive an interleaved config flag', () => {
  const run = recorder(() => ({ status: 0, stdout: 'https://x\n', stderr: '' }));
  const { rc } = capture(() => main(['park', '42', '--repo', 'o/n', 'decision text'], run, tmpdir()));
  assert.equal(rc, 0);
  assert.deepEqual(run.calls[1].slice(0, 5), ['-R', 'o/n', 'issue', 'comment', '42']);
  assert.equal(run.calls[1][6], 'decision text', 'the repo value was not mistaken for the decision text');
});

test('resolveGh: GH_QUEUE_GH wins, GH_PATH is honoured as its alias', () => {
  const saved = { q: process.env.GH_QUEUE_GH, p: process.env.GH_PATH };
  try {
    process.env.GH_QUEUE_GH = 'C:\\a\\gh.exe';
    process.env.GH_PATH = 'C:\\b\\gh.exe';
    assert.equal(resolveGh(), 'C:\\a\\gh.exe');
    delete process.env.GH_QUEUE_GH;
    assert.equal(resolveGh(), 'C:\\b\\gh.exe');
  } finally {
    if (saved.q === undefined) delete process.env.GH_QUEUE_GH;
    else process.env.GH_QUEUE_GH = saved.q;
    if (saved.p === undefined) delete process.env.GH_PATH;
    else process.env.GH_PATH = saved.p;
  }
});
