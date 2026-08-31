import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, argValue, hasArg, strArg } from '../lib/parse-args.mjs';

test('parseArgs: space and = forms agree, including hyphenated names', () => {
  assert.deepEqual(parseArgs(['--lane', 'C', '--port', '5261']), { lane: 'C', port: '5261' });
  assert.deepEqual(parseArgs(['--lane=C', '--port=5261']), { lane: 'C', port: '5261' });
  assert.deepEqual(parseArgs(['--signal-port', '5262']), { signalPort: '5262' });
  assert.deepEqual(parseArgs(['--signal-port=5262']), { signalPort: '5262' });
});

test('parseArgs: boolean flags do not eat the next flag', () => {
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  const both = parseArgs(['--dry-run', '--lane', 'C']);
  assert.equal(both.dryRun, true);
  assert.equal(both.lane, 'C');
});

test('parseArgs: an empty = value fails closed rather than becoming the empty string', () => {
  // Number('') is 0, not NaN, so {port: ''} sails past every "?? default"
  // fallback. Rejecting it is the only way a caller notices.
  assert.throws(() => parseArgs(['--port=']), /--port=/);
  assert.throws(() => argValue(['--port='], '--port'), /--port=/);
  assert.equal(parseArgs(['--dry-run']).dryRun, true, 'a bare boolean flag is unaffected');
});

test('parseArgs: only the first = splits flag from value', () => {
  assert.equal(parseArgs(['--record=round9/a=b.json']).record, 'round9/a=b.json');
});

test('parseArgs: case is normalized on the name, preserved in the value', () => {
  assert.equal(parseArgs(['--Lane=C']).lane, 'C');
  assert.equal(parseArgs(['--LANE', 'B']).lane, 'B');
  assert.equal(parseArgs(['--PORT-BASE', '5240']).portBase, '5240');
  assert.equal(parseArgs(['--portBase', '5240']).portBase, '5240');
  assert.equal(parseArgs(['--Port-Base', '5240']).portBase, '5240');
});

test('argValue / hasArg: both spellings, and no prefix false-match', () => {
  assert.equal(argValue(['--lane', 'C'], '--lane'), 'C');
  assert.equal(argValue(['--lane=C'], '--lane'), 'C');
  assert.equal(argValue(['--lane-extra=X'], '--lane'), undefined);
  assert.equal(hasArg(['--dry-run'], '--dry-run'), true);
  assert.equal(hasArg(['--lane', 'C'], '--dry-run'), false);
});

test('strArg: a value-less flag falls back instead of leaking true', () => {
  assert.equal(strArg(true, 'fallback'), 'fallback');
  assert.equal(strArg(undefined, 'fallback'), 'fallback');
  assert.equal(strArg('given', 'fallback'), 'given');
});
