import test from 'node:test';
import assert from 'node:assert/strict';
import { capLines, bucketBlocked, formatView, formatIssueRow } from '../lib/format.mjs';

test('capLines: truncation marker appears only when over the cap', () => {
  assert.equal(capLines('a\nb\nc', 5), 'a\nb\nc');
  const long = capLines(Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'), 4);
  assert.ok(long.startsWith('line0\nline1\nline2\nline3\n'));
  assert.ok(long.endsWith('... (+6 more lines)'));
});

test('bucketBlocked: keyboard / decision / unsplit, and nothing else', () => {
  const issues = [
    { number: 1, title: 'needs hands', labels: [{ name: 'blocked:user:keyboard' }] },
    { number: 2, title: 'needs a call', labels: [{ name: 'blocked:user:decision' }] },
    { number: 3, title: 'bare only', labels: [{ name: 'blocked:user' }] },
    { number: 4, title: 'not blocked at all', labels: [{ name: 'ready' }] },
  ];
  const b = bucketBlocked(issues, 'blocked:user');
  assert.deepEqual(b.keyboard.map((i) => i.number), [1]);
  assert.deepEqual(b.decision.map((i) => i.number), [2]);
  assert.deepEqual(b.unsplit.map((i) => i.number), [3]);
});

test('formatIssueRow: labels and milestone, with the bucket label omitted', () => {
  const issue = { number: 5, title: 'Thing', labels: [{ name: 'ready' }, { name: 'infra' }], milestone: { title: 'v1' } };
  assert.equal(formatIssueRow(issue, 'ready'), '#5  Thing  [infra]  {v1}');
  assert.equal(formatIssueRow({ number: 6, title: 'Bare', labels: [] }), '#6  Bare');
});

test('formatView: header with and without milestone; last-k comment selection', () => {
  const comments = ['a', 'b', 'c', 'd'].map((login, i) => ({
    author: { login },
    createdAt: `2026-01-0${i + 1}T00:00:00Z`,
    body: login,
  }));
  const withMilestone = formatView(
    { number: 42, title: 'Thing', state: 'OPEN', labels: [{ name: 'ready' }], milestone: { title: 'v1' }, body: 'body text', comments },
    { comments: 2 },
  );
  assert.ok(withMilestone.startsWith('#42 Thing — OPEN — labels: ready — milestone: v1'));
  assert.ok(withMilestone.includes('(4 comments total, showing last 2)'));
  assert.ok(withMilestone.includes('--- @c 2026-01-03 ---') && withMilestone.includes('--- @d 2026-01-04 ---'));
  assert.ok(!withMilestone.includes('--- @a ') && !withMilestone.includes('--- @b '));

  const withoutMilestone = formatView(
    { number: 7, title: 'Other', state: 'CLOSED', labels: [], milestone: null, body: 'x', comments: [] },
    {},
  );
  assert.ok(withoutMilestone.startsWith('#7 Other — CLOSED — labels: '));
  assert.ok(!withoutMilestone.includes('milestone:'));
});
