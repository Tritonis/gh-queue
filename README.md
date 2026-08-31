# gh-queue

Queue bookkeeping for a GitHub-Issues-driven workflow, as one command per
operation instead of three raw `gh` invocations glued together with `jq`.
Zero dependencies, Node >= 20.

The controller's session-start ritual — read the running state issue, list
what is `ready`, list what is blocked on the user — is one `gh-queue triage`.
JSON comes back from `gh --json` and is formatted in Node, so the output is
compact and free of gh's own noise (the bare URLs `edit`/`comment`/`close`
echo, the literal `\n` a `jq` join leaves behind).

## Install

```
git clone <this repo> && cd gh-queue
npm link
```

`npm link` puts `gh-queue` on PATH globally; it works from any directory.
There is nothing to install into the repos that use it beyond a
`.gh-queue.json`.

`gh` itself is found via `GH_QUEUE_GH` (or `GH_PATH`), else `gh` on PATH,
else `C:\Program Files\GitHub CLI\gh.exe` — the Windows install is routinely
off PATH in non-interactive shells.

## Commands

```
gh-queue triage                          state issue + ready list + blocked buckets
gh-queue view <n>                        one issue: body and last comments
gh-queue park <n> "<text>" [--keyboard]  ready -> blocked, with a comment saying why
gh-queue unpark <n>                      blocked -> ready
gh-queue note "<text>"                   comment on the state issue
gh-queue milestone <name-or-prefix>      open issues in a milestone, plus a true count
gh-queue close-batch --issues 1,2,3 --note "<text>" [--dry-run]
gh-queue init [--force] [--dry-run]      write .gh-queue.json, create the labels
gh-queue help
```

A bare `gh-queue` (or one that starts with a flag, e.g. `gh-queue --lines 5`)
is `triage` — it is the session-start call, so it is the default.

Display flags: `--lines N` (triage, view), `--comments K` (view).

`milestone` exists because GitHub's own milestone `open_issues` counter
drifts — it lags issue transfers and some API-side closes, so a milestone can
show a nonzero count with nothing actually open in it. The `N open` line here
is derived by listing the issues, never read off the milestone object.

The `<name-or-prefix>` argument doesn't have to be the exact title: an exact
match wins outright, otherwise it's resolved as a case-insensitive prefix
against all milestones. A prefix matching more than one title exits 2 as
ambiguous; a prefix matching none exits 2 as no match — either way the
candidate titles are printed and no issue list is fetched.

`close-batch` verifies every close with a re-fetch: an issue that comes back
`OPEN`, or one whose verification call fails, counts as a failure and the
command exits non-zero. It also strips a lingering ready label from a closed
issue.

Every gh call's exit status is checked. A failed lookup prints nothing to
stdout and exits non-zero, because an empty triage reads exactly like a
genuinely clean queue.

## Configuration

Three settings: `stateIssue`, `readyLabel`, `blockedPrefix` (plus an optional
`repo`). Resolved per invocation, highest precedence first:

1. CLI flag — `--state-issue N`, `--ready-label L`, `--blocked-prefix P`, `--repo OWNER/NAME`
2. environment — `GH_QUEUE_STATE_ISSUE`, `GH_QUEUE_READY_LABEL`, `GH_QUEUE_BLOCKED_PREFIX`, `GH_QUEUE_REPO`
3. the nearest `.gh-queue.json` in the current directory or any ancestor (so a
   session whose cwd is a subdirectory of the repo still finds the repo's config)
4. built-in defaults — `stateIssue` **0**, `readyLabel` `ready`, `blockedPrefix` `blocked:user`

`stateIssue: 0` means "no state issue configured": `triage` simply skips that
block rather than guessing at an issue number. `note` is the one command that
hard-errors (exit 2) without one, since a note with nowhere to go would
otherwise vanish silently.

`.gh-queue.json`:

```json
{
  "stateIssue": 16,
  "readyLabel": "ready",
  "blockedPrefix": "blocked:user"
}
```

A malformed config is ignored with one warning line on stderr — never a
silent fall-back to defaults with no explanation of why.

## The label contract

Four labels, and only the first two names are configurable:

| label | meaning |
|---|---|
| `readyLabel` (default `ready`) | queued and unblocked; an agent can pick it up now |
| `blockedPrefix` (default `blocked:user`) | blocked on the user, bucket not yet chosen |
| `${blockedPrefix}:keyboard` | blocked on the user: needs hands on a keyboard |
| `${blockedPrefix}:decision` | blocked on the user: needs a decision |

The two sub-buckets are **convention, not configuration**: the suffixes
`:keyboard` and `:decision` are fixed, and there are exactly two of them, so
every repo's blocked pile splits the same two ways and `triage` output means
the same thing everywhere. An issue carrying the bare prefix and neither
suffix shows up under "(unsplit)" — that is a prompt to sort it, not a third
bucket.

`gh-queue init` creates whichever of the four are missing. It is purely
additive: an existing label keeps its colour and description, and nothing is
ever deleted or renamed.

## Setting up a new repo

```
cd path/to/repo
gh-queue init --state-issue 38 --dry-run   # see exactly what it would do
gh-queue init --state-issue 38
git add .gh-queue.json && git commit -m "Add gh-queue config"
```

`init` refuses to overwrite an existing `.gh-queue.json` unless `--force`.

## Tests

```
npm test        # node --test
```

The command layer takes an injectable `run(args) -> {status, stdout, stderr}`,
so every branch — including every gh-failure path — is covered without a repo,
a network, or a real `gh`.
