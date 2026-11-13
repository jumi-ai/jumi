# Repository settings (`.jumi.yml`)

Repository settings live in the repository itself, in `.jumi.yml` at the root of the
default branch. There is no other name, location, or format, and there is no
schema-version key.

The parent reads the file from the default branch when a job needs it — never from
a pull request head, and never from a working tree an agent can write to — so a change
takes effect when it reaches the default branch, with no restart and no deployment
change. A pull that edits the file is still reviewed and run under the settings the
default branch already has; nothing an agent writes during a job changes the settings
that job runs under. No setting is handed to a model: the parent parses the file, and
the reviewer only sees its consequences (for example, patches withheld by
`review_exclude`).

The file is strict: text that does not parse, an unknown key, or a value of the wrong
type makes the whole file invalid, and invalid is never treated as "no file". A missing
file is normal and silent.

## Key table

Types are what the parser enforces; a value of any other type invalidates the whole
file. "Deployer setting" is the environment / deployment value the key combines with.

| Key | Type | Default when absent | Effect | Combines with deployer setting |
|-----|------|---------------------|--------|-------------------------------|
| `automerge` | boolean | `false` (off) | `true` lets Jumi schedule the forge's native auto-merge on pull requests it opens, once every other gate passes | Both switches: the deployer list (`JUMI_AUTOMERGE_REPOS`) must allow the repository **and** this key must be `true`. Either one alone schedules nothing |
| `allowed_runners` | list of runner names | no restriction (the full active chain) | Narrows every job for the repository — review, implement, follow-up, conflict — to the chain entries whose name is on the list, keeping chain order | Narrowing only: names outside the active chain grant nothing and are only logged. An empty list matches no runner, so the job fails closed (see Runners row below). Without `JUMI_RUNNERS_FILE` the chain is synthesized and its entries are stably named `primary` (and `fallback` when a fallback model is set) |
| `review_exclude` | list of glob strings | `[]` (nothing is left out) | A changed file whose repository-relative path matches is left out of the review: its patch is withheld from the reviewer in first and later reviews. The file is still listed as changed and marked as left out, and the published review names the files (or the count, when the list is long) | No deployer setting. Uses the same gitignore-style glob dialect as `REVIEW.md` path sections (`**/generated/**`, `pnpm-lock.yaml`, `docs/`; a bare word is not a glob, so scope it like `**/Dockerfile`). The settings file itself can never be left out: a pattern matching it has no effect on it. Patterns come from the default branch only, so a pull that adds a pattern is still reviewed in full |
| `followup_on_suggestions` | boolean | `true` (follow up, as today) | `false` turns off follow-up on a `success` review that only has suggestions. Failing reviews, blocking questions, red CI, and conflicts still run as today, and a comment or review from someone allowed to steer follow-up still starts it whatever this setting says | No deployer setting |
| `max_followup_rounds` | non-negative integer (`0` is valid and means no rounds) | the deployment value (`MAX_FOLLOWUP_ROUNDS`) | Caps follow-up rounds per pull request for this repository. Rounds are counted as today; only the cap changes | Ceiling: a higher file value applies as the deployment value (`min(deployment, file)`) |
| `max_conflict_rounds` | non-negative integer (`0` is valid and means no rounds) | the deployment value (`MAX_CONFLICT_ROUNDS`) | Caps consecutive failed conflict-resolution rounds per issue for this repository | Ceiling: a higher file value applies as the deployment value (`min(deployment, file)`) |
| `takeover_authors` (aliases: `takeover-authors`, `takeoverAuthors`) | list of logins | `[]` (off) | A pull request opened by a listed author is taken over exactly like a pull handed over by hand: same follow-up on red CI, review findings, conflicts, and comments, under the same open / non-draft / non-`WIP:` / same-repo bar, leaving the same marker (assigned Jumi on Gitea, `jumi` label on GitHub). Removing the marker stops the work and the pull is never taken over again. Listing the same setting under two spellings is invalid (`duplicate setting`). Logins match whole, case-insensitive | The sender check still applies: a listed author is taken over only when that author would pass the same check a manual handover needs (`TRUSTED_SENDER_LOGINS` when set, write-level access otherwise). A refused author gets one note and no takeover |
| `ignore_conflicts_authors` (aliases: `ignore-conflicts-authors`, `ignoreConflictsAuthors`) | list of logins | `[]` (off) | A pull request whose author is listed gets what the `ignore-conflicts` label gives, without the label: while Jumi has not committed to the branch, no `conflict` job runs and follow-up never merges the default branch, for taken-over and handed-over pulls alike. Logins match whole, case-insensitive | Works alongside the `ignore-conflicts` label (`IGNORE_CONFLICTS_LABEL`): either one suppresses the same behavior |
| `blocking_question_authors` | list of logins | `[]` (none) | Names PR authors whose open `❓` questions block the review status: a review whose only findings are `❓` posts `failure` with `N open questions` instead of `success`, so required-check auto-merge waits. Logins match whole, case-insensitive; blank entries are dropped | Union: the effective list is the deployer list (`REVIEW_BLOCKING_QUESTION_AUTHORS`) plus this list. The file cannot remove a login the deployer listed |
| `mode` | `"full"` \| `"review-only"` \| `"off"` | `"full"` | `review-only` keeps reviews and the review status working as today but starts no implement, follow-up, or conflict job (handing work to Jumi leaves one note saying worker jobs are turned off). `off` starts no job of any kind, posts no status, and comments nothing. The mode is checked before a runner starts so a restricted repository costs no model time; it is read when a job starts, so a running job finishes while a queued job follows the new mode. Auto-merge is never scheduled in a restricted mode | No deployer setting |
| `timeouts` | mapping (may be empty) | `{}` (no overrides) | Per-kind run timeouts in whole minutes (see the four rows below). Read once when the job starts; a change never affects an already running job. Everything derived from the timeout follows the effective value for that job: the queue lease length and the credential-refresh budget at job start | Each present key is a ceiling against its deployer maximum (below); a smaller, non-integer, or non-numeric value makes the whole file invalid |
| `timeouts.review` | integer minutes, at least 1 | `OPENCODE_TIMEOUT_MS` | How long reviews may run | Ceiling: `OPENCODE_TIMEOUT_MAX_MS` (unset defaults to the deployment timeout, so a repository can only shorten out of the box); a value above the maximum runs with the maximum |
| `timeouts.implement` | integer minutes, at least 1 | `OPENCODE_TIMEOUT_MS` (worker default is 4h) | How long first implementations may run | Ceiling: `OPENCODE_TIMEOUT_MAX_MS`, same rule as `review`. Each kind has its own deployer maximum |
| `timeouts.followup` | integer minutes, at least 1 | `FOLLOWUP_TIMEOUT_MS`. Does not inherit `OPENCODE_TIMEOUT_MS` | How long follow-up rounds (`follow-up` jobs) may run | Ceiling: `FOLLOWUP_TIMEOUT_MAX_MS` (unset defaults to the deployment timeout for this kind) |
| `timeouts.conflict` | integer minutes, at least 1 | `CONFLICT_TIMEOUT_MS`. Does not inherit `OPENCODE_TIMEOUT_MS` | How long conflict resolution may run | Ceiling: `CONFLICT_TIMEOUT_MAX_MS` (unset defaults to the deployment timeout for this kind) |

## Complete example

One file using every key, with notes on what each line does. It parses with
`parseRepoSettingsText()` (see `scripts/opencode/test/repo_settings_docs.test.ts`,
which keeps this page and the parser from drifting apart).

```yaml
# .jumi.yml at the root of the default branch.
automerge: true # both switches needed: JUMI_AUTOMERGE_REPOS must also allow this repo

allowed_runners: # absent means no restriction; present narrows every job to these chain names
  - primary

review_exclude: # patches for these paths are withheld from the reviewer, but they can still merge
  - "**/generated/**"
  - "pnpm-lock.yaml"
  - "docs/"

followup_on_suggestions: false # true (the default) follows up on success-with-suggestions as today

max_followup_rounds: 2 # ceiling against MAX_FOLLOWUP_ROUNDS; 0 means no follow-up rounds
max_conflict_rounds: 1 # ceiling against MAX_CONFLICT_ROUNDS; 0 means no conflict rounds

takeover_authors: # take over pulls opened by these logins, like a manual handover
  - renovate
ignore_conflicts_authors: # same effect as the ignore-conflicts label, without the label
  - renovate

blocking_question_authors: # union with REVIEW_BLOCKING_QUESTION_AUTHORS; cannot remove deployer logins
  - alice

mode: full # full (default) | review-only | off

timeouts: # whole minutes per kind; absent keys run with the deployment timeout
  review: 10 # ceiling: OPENCODE_TIMEOUT_MAX_MS
  implement: 120 # ceiling: OPENCODE_TIMEOUT_MAX_MS
  followup: 60 # controls follow-up jobs; ceiling: FOLLOWUP_TIMEOUT_MAX_MS
  conflict: 60 # ceiling: CONFLICT_TIMEOUT_MAX_MS
```

## Recipes

Auto-merge only (still needs the deployer switch `JUMI_AUTOMERGE_REPOS` to allow the
repository, and the base branch to require the `jumi/opencode-review` check):

```yaml
automerge: true
```

Review-only repository (reviews keep working; no implement, follow-up, or conflict jobs):

```yaml
mode: review-only
```

## What happens when the file is missing, invalid, or unreadable

"Unreadable" is a failed read (for example a forge error); the parent logs it. Missing
(or no file API, or no default branch to read from) behaves the same as unreadable
everywhere except auto-merge, which stays silent only for missing/`false`.

| Feature | Missing | Invalid (whole file) | Unreadable |
|---------|---------|----------------------|------------|
| Auto-merge | No schedule, silent (same as `automerge: false`) | No schedule; the pull request gets one note naming the parser's error | No schedule; the pull request gets one note saying the file could not be read |
| `review_exclude` | No exclusions; the review runs in full | No exclusions; the review runs in full (the pull still carries the parser-error note via auto-merge/head validation, but nothing is left out) | No exclusions; the review runs in full |
| Follow-up (`followup_on_suggestions`, `max_*_rounds`) | Deployment caps, suggestions on | Policy falls back to deployment caps with suggestions on — but like any other runner job, no runner job starts while the default-branch file is invalid (see Runners row) | Deployment caps, suggestions on (fail-open); a runner job still runs on the full chain |
| `mode` | `full` | Reads as `full`, but like any other runner job, no runner job starts while the file is invalid | `full` |
| Runners (`allowed_runners`) | Full chain (unrestricted) | No runner job starts: a review ends with a `failure` status naming the parser's error, and a worker job says so once where it was started | Full chain (fail-open, logged). An empty list is not "missing": it matches no runner and fails closed with a `failure`/note saying the settings left no eligible runner. Unknown names are only logged |

Two related guards: a pull request that changes `.jumi.yml` never auto-merges through
Jumi (a schedule Jumi set earlier is cancelled when a Jumi push brings the file into the
pull), and a pull whose head leaves the file invalid gets a failing
`jumi/opencode-review` status naming the error — the head copy is only ever checked,
never applied.

## Before you set

- Do not set `mode: off` on a repository where `jumi/opencode-review` is a required
  check: pull requests there become unable to merge, because the status that would let
  them merge never posts.
- Do not combine `review_exclude` with `automerge` lightly: a green review does not
  cover left-out files, so a left-out change merges with nobody reading it.
- Every change to `.jumi.yml` needs a person's merge: a pull request that touches the
  file never auto-merges through Jumi, and turning auto-merge on (or changing any
  later setting) only takes effect once a person has merged it to the default branch.
