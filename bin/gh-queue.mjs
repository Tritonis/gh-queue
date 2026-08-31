#!/usr/bin/env node
// bin/gh-queue.mjs — CLI entrypoint: find `gh`, dispatch a subcommand.
//
// WHY THIS EXISTS. The controller's session-start ritual — read the state
// issue, list `ready`, list the blocked buckets, sometimes park or close a
// batch — was three-plus raw `gh` invocations glued together with `jq`, each
// re-typed by hand and each echoing gh's own noise (bare URLs from
// `edit`/`comment`/`close`, a literal backtick-n where a `jq` join was meant
// to be a newline). This collapses that into one call per operation with
// compact, jq-free output: JSON is parsed in Node rather than shelled
// through `-q`.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/parse-args.mjs';
import { loadFileConfig, resolveConfig } from '../lib/config.mjs';
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
  CONFIG_VALUE_FLAGS,
  USAGE,
} from '../lib/commands.mjs';

export const FALLBACK_GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';

/** Resolve the `gh` binary: `GH_QUEUE_GH` (or its alias `GH_PATH`), else
 * `gh` on PATH (probed via `where`/`which`), else the fixed Windows install
 * path — gh is routinely off PATH in non-interactive shells. `null` if none
 * of those exist. */
export function resolveGh() {
  if (process.env.GH_QUEUE_GH) return process.env.GH_QUEUE_GH;
  if (process.env.GH_PATH) return process.env.GH_PATH;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, ['gh'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0].trim();
  if (existsSync(FALLBACK_GH)) return FALLBACK_GH;
  return null;
}

/** Build the default `run(args) -> {status, stdout, stderr}` against a
 * resolved gh path. Argument arrays only — no shell string interpolation,
 * since issue bodies routinely carry quotes and backticks. */
export function makeRun(ghPath) {
  return (args) => {
    const r = spawnSync(ghPath, args, { encoding: 'utf8' });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

export function main(argv, run, cwd = process.cwd()) {
  const [command, ...rest] = argv;
  const fileCfg = loadFileConfig(cwd);
  const flags = parseArgs(rest);
  const cfg = resolveConfig(flags, fileCfg);
  const positional = (extra = []) => extractPositional(rest, [...CONFIG_VALUE_FLAGS, ...extra]);

  if (command === 'triage') return cmdTriage(run, cfg, flags);
  if (command === 'view') return cmdView(run, cfg, positional(['comments', 'lines']), flags);
  if (command === 'park') return cmdPark(run, cfg, positional(), flags);
  if (command === 'unpark') return cmdUnpark(run, cfg, positional());
  if (command === 'note') return cmdNote(run, cfg, positional());
  if (command === 'milestone') return cmdMilestone(run, cfg, positional());
  if (command === 'init') return cmdInit(run, cfg, flags, cwd);
  if (command === 'close-batch') return cmdCloseBatch(run, cfg, flags);

  console.log(USAGE);
  return command === 'help' || command === '--help' || command === undefined ? 0 : 2;
}

// `npm link` installs this file behind a symlink, and Node resolves
// import.meta.url to the real path while process.argv[1] stays the link —
// comparing the two directly made the globally installed `gh-queue` do
// nothing at all and exit 0. Both sides are realpath'd before comparing.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const ghPath = resolveGh();
  if (!ghPath) {
    console.log(`gh not found (looked at GH_QUEUE_GH, GH_PATH, PATH, and ${FALLBACK_GH})`);
    process.exit(2);
  }
  process.exit(main(process.argv.slice(2), makeRun(ghPath)));
}
