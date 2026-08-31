import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFileConfig, resolveConfig } from '../lib/config.mjs';
import { capture } from './helpers.mjs';

function clearEnv() {
  delete process.env.GH_QUEUE_STATE_ISSUE;
  delete process.env.GH_QUEUE_READY_LABEL;
  delete process.env.GH_QUEUE_BLOCKED_PREFIX;
  delete process.env.GH_QUEUE_REPO;
}

test('resolveConfig: defaults are repo-neutral — no state issue is assumed', () => {
  clearEnv();
  const def = resolveConfig({}, {});
  assert.equal(def.stateIssue, 0, 'the default state issue is 0 (unconfigured), never another project\'s number');
  assert.equal(def.readyLabel, 'ready');
  assert.equal(def.blockedPrefix, 'blocked:user');
  assert.equal(def.repo, undefined);
});

test('resolveConfig: precedence flag > env > file > default', () => {
  clearEnv();
  const fromFile = resolveConfig({}, { stateIssue: 99, readyLabel: 'go', blockedPrefix: 'held' });
  assert.equal(fromFile.stateIssue, 99);
  assert.equal(fromFile.readyLabel, 'go');
  assert.equal(fromFile.blockedPrefix, 'held');

  process.env.GH_QUEUE_STATE_ISSUE = '5';
  assert.equal(resolveConfig({}, { stateIssue: 99 }).stateIssue, 5, 'env beats the file');
  assert.equal(resolveConfig({ stateIssue: '3' }, { stateIssue: 99 }).stateIssue, 3, 'a flag beats env and file');
  clearEnv();

  assert.equal(resolveConfig({ stateIssue: '0' }, { stateIssue: 99 }).stateIssue, 0, '--state-issue 0 means skip');
});

test('resolveConfig: a value-less --ready-label falls back rather than becoming true', () => {
  clearEnv();
  assert.equal(resolveConfig({ readyLabel: true }, {}).readyLabel, 'ready');
});

test('loadFileConfig: absent file is silent; malformed is one warning, not a silent default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-queue-test-'));
  try {
    const absent = capture(() => loadFileConfig(dir));
    assert.deepEqual(absent.rc, {});
    assert.equal(absent.errs.length, 0);

    writeFileSync(join(dir, '.gh-queue.json'), '{ not valid json', 'utf8');
    const bad = capture(() => loadFileConfig(dir));
    assert.deepEqual(bad.rc, {});
    assert.equal(bad.errs.length, 1);
    assert.ok(bad.errs[0].startsWith('ignoring .gh-queue.json: '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
