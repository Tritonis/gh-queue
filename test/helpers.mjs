// Shared capture helper. Not a test file itself (no test() calls), but it
// lives under test/ so the default `node --test` glob picks up its siblings.

/** Run `fn()` with console.log/error captured. Returns
 * `{ rc, out, err, logs, errs }` — `out`/`err` are the joined text. */
export function capture(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (s) => logs.push(String(s));
  console.error = (s) => errs.push(String(s));
  let rc;
  try {
    rc = fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { rc, logs, errs, out: logs.join('\n'), err: errs.join('\n') };
}

/** A `run()` that records every call and answers from `responder`. */
export function recorder(responder) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return responder(args, calls.length) ?? { status: 0, stdout: '[]', stderr: '' };
  };
  run.calls = calls;
  return run;
}

export const CFG = {
  stateIssue: 16,
  readyLabel: 'ready',
  blockedPrefix: 'blocked:user',
  repo: undefined,
};
