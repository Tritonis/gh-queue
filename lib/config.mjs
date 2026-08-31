/**
 * lib/config.mjs — where gh-queue gets its three settings from.
 *
 * Nothing here is repo-specific. The state-issue number, the "ready" label
 * and the "blocked" prefix are resolved per invocation from, in order of
 * precedence: CLI flag > `GH_QUEUE_*` env var > `.gh-queue.json` in the
 * current directory > built-in default. The built-in default for
 * `stateIssue` is 0, meaning "not configured" — commands skip the
 * state-issue step rather than guessing at an issue number that belongs to
 * some other project.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strArg } from './parse-args.mjs';

export const CONFIG_FILE = '.gh-queue.json';

/** Load `.gh-queue.json` at `cwd`, if present. Absent -> `{}` silently;
 * malformed -> `{}` plus one warning line to stderr (never a silent
 * fallback to defaults with no explanation of why). */
export function loadFileConfig(cwd) {
  const p = join(cwd, CONFIG_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`ignoring ${CONFIG_FILE}: ${err.message}`);
    return {};
  }
}

/** Precedence: CLI flags > env vars > `.gh-queue.json` > built-in defaults.
 * A resolved `stateIssue` of 0 means "not configured" — callers skip the
 * state-issue step rather than failing (except `note`, which has nothing to
 * do without one). */
export function resolveConfig(flags, fileCfg = {}) {
  const stateIssueRaw =
    strArg(flags.stateIssue, undefined) ??
    process.env.GH_QUEUE_STATE_ISSUE ??
    (fileCfg.stateIssue !== undefined ? String(fileCfg.stateIssue) : undefined) ??
    '0';
  const stateIssue = Number(stateIssueRaw) || 0;
  const readyLabel =
    strArg(flags.readyLabel, undefined) ?? process.env.GH_QUEUE_READY_LABEL ?? fileCfg.readyLabel ?? 'ready';
  const blockedPrefix =
    strArg(flags.blockedPrefix, undefined) ??
    process.env.GH_QUEUE_BLOCKED_PREFIX ??
    fileCfg.blockedPrefix ??
    'blocked:user';
  const repo = strArg(flags.repo, undefined) ?? process.env.GH_QUEUE_REPO ?? fileCfg.repo;
  return { stateIssue, readyLabel, blockedPrefix, repo };
}
