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
type makes the whole file invalid, and invalid is never treated as "no file". Each key
has exactly one spelling (snake_case): a hyphen or camelCase variant is an unknown key,
rejected as `unknown key "..." (did you mean "..."?)` when it normalizes to a known key.
Every list key rejects blank or non-string entries: one blank entry makes the whole file
invalid instead of being dropped. An explicitly empty `allowed_runners` or `trusted_senders`
list is invalid (no runner could work on the repository, or no sender could start work,
so use `mode: off` or `mode: review-only` instead). A missing file is normal and silent.

## Key table

Types are what the parser enforces; a value of any other type invalidates the whole
file. "Deployer setting" is the environment / deployment value the key combines with.

| Key | Type | Default when absent | Effect | Combines with deployer setting |
|-----|------|---------------------|--------|-------------------------------|
| `automerge` | boolean | `false` (off) | `true` lets Jumi schedule the forge's native auto-merge on pull requests it opens, once every other gate passes | Both switches: the deployment (`JUMI_AUTOMERGE_ENABLED` on, and deprecated `JUMI_AUTOMERGE_REPOS` when set must allow the repository) **and** this key must be `true` — unless a per-PR override label decides (see below). Either one alone schedules nothing |
| `automerge_label` | non-blank string | `automerge` | Name of the per-PR label that opts one Jumi PR into auto-merge, even when `automerge` is `false` or absent. Matches case-insensitively. A blank, non-string, or identical (case-insensitive) pair with `no_automerge_label` makes the whole file invalid; hyphen/camel spellings are unknown keys rejected with the usual "did you mean" error | The label only counts when the person who added it passes the same sender check a handover needs (`TRUSTED_SENDER_LOGINS` when set, write access otherwise). Jumi copies the label from the worked issue onto the PR at open time, then the PR's labels decide; label history that cannot be read fails closed |
| `no_automerge_label` | non-blank string | `no-automerge` | Name of the per-PR label that opts one Jumi PR out of auto-merge, even when `automerge` is `true`. Honoured whoever added it (safe direction). Matches case-insensitively; same validation as `automerge_label` | Overrides `automerge` and `automerge_label`: both labels together never schedule, with one conflict note. Adding/removing either label on an open Jumi PR re-runs every gate |
| `allowed_runners` | list of runner names | no restriction (the full active chain) | Narrows every job for the repository — review, implement, follow-up, conflict — to the chain entries whose name is on the list, keeping chain order | Narrowing only: names outside the active chain grant nothing and are only logged. An explicitly empty list is invalid (the whole file is invalid — use `mode: off` or `mode: review-only` instead); a non-empty list that matches nothing fails closed with no runner job starting (see Runners row below). Without `JUMI_RUNNERS_FILE` the chain is synthesized and its entries are stably named `primary` (and `fallback` when a fallback model is set) |
| `review_exclude` | list of glob strings | `[]` (nothing is left out) | A changed file whose repository-relative path matches is left out of the review: its patch is withheld from the reviewer in first and later reviews. The file is still listed as changed and marked as left out, and the published review names the files (or the count, when the list is long) | No deployer setting. Uses the same gitignore-style glob dialect as `REVIEW.md` path sections (`**/generated/**`, `pnpm-lock.yaml`, `docs/`; a bare word is not a glob, so scope it like `**/Dockerfile`). The settings file itself can never be left out: a pattern matching it has no effect on it. Patterns come from the default branch only, so a pull that adds a pattern is still reviewed in full |
| `followup_on_suggestions` | boolean | `true` (follow up, as today) | `false` turns off follow-up on a `success` review that only has suggestions. Failing reviews, blocking questions, red CI, and conflicts still run as today, and a comment or review from someone allowed to steer follow-up still starts it whatever this setting says | No deployer setting |
| `max_followup_rounds` | non-negative integer (`0` is valid and means no rounds) | the deployment value (`MAX_FOLLOWUP_ROUNDS`) | Caps follow-up rounds per pull request for this repository. Rounds are counted as today; only the cap changes | Ceiling: a higher file value applies as the deployment value (`min(deployment, file)`) |
| `max_conflict_rounds` | non-negative integer (`0` is valid and means no rounds) | the deployment value (`MAX_CONFLICT_ROUNDS`) | Caps consecutive failed conflict-resolution rounds per issue for this repository | Ceiling: a higher file value applies as the deployment value (`min(deployment, file)`) |
| `takeover_authors` | list of logins | `[]` (off) | A pull request opened by a listed author is taken over exactly like a pull handed over by hand: same follow-up on red CI, review findings, conflicts, and comments, under the same open / non-draft / non-`WIP:` / same-repo bar, leaving the same marker (assigned Jumi on Gitea, `jumi` label on GitHub). Removing the marker stops the work and the pull is never taken over again. Exactly one spelling: `takeover-authors` or `takeoverAuthors` is an unknown key rejected as `unknown key "..." (did you mean "takeover_authors"?)`. A blank or non-string entry makes the whole file invalid. Logins match whole, case-insensitive | The sender check still applies: a listed author is taken over only when that author would pass the same check a manual handover needs (`TRUSTED_SENDER_LOGINS` when set, write-level access otherwise). A refused author gets one note and no takeover |
| `ignore_conflicts_authors` | list of logins | `[]` (off) | A pull request whose author is listed gets what the `ignore-conflicts` label gives, without the label: while Jumi has not committed to the branch, no `conflict` job runs and follow-up never merges the default branch, for taken-over and handed-over pulls alike. Exactly one spelling: `ignore-conflicts-authors` or `ignoreConflictsAuthors` is an unknown key rejected as `unknown key "..." (did you mean "ignore_conflicts_authors"?)`. A blank or non-string entry makes the whole file invalid. Logins match whole, case-insensitive | Works alongside the `ignore-conflicts` label (`IGNORE_CONFLICTS_LABEL`): either one suppresses the same behavior |
| `blocking_question_authors` | list of logins | `[]` (none) | Names PR authors whose open `❓` questions block the review status: a review whose only findings are `❓` posts `failure` with `N open questions` instead of `success`, so required-check auto-merge waits. Logins match whole, case-insensitive; a blank or non-string entry makes the whole file invalid (`"blocking_question_authors" must not contain blank entries`) | Union: the effective list is the deployer list (`REVIEW_BLOCKING_QUESTION_AUTHORS`) plus this list. The file cannot remove a login the deployer listed |
| `trusted_senders` | list of logins | deployment list (`TRUSTED_SENDER_LOGINS`) or write access | Repository version of `TRUSTED_SENDER_LOGINS`. Applies everywhere that check applies: starting implement (assign / pickup label), steering follow-up, the `takeover_authors` admission check, and admitting the auto-merge label. When the deployment sets `TRUSTED_SENDER_LOGINS`, the effective list is the intersection: a repository can narrow it, never widen it. When the deployment leaves it unset, the repository list is the list (listing is the admit, same as the env list today, no forge permission lookup). Neither set keeps the write-access fallback. Logins match whole, case-insensitive; a blank or non-string entry makes the whole file invalid. An explicitly empty list is invalid (use `mode: off` or `mode: review-only` to stop work), the same reasoning as `allowed_runners`. An unreadable settings file falls back to the deployment behaviour, but an invalid file never widens access | Intersection (ceiling): when `TRUSTED_SENDER_LOGINS` is set, the effective list is the intersection; when unset, the repository list alone admits |
| `followup_ignore_logins` | list of logins | `[]` (none) | Repository version of `FOLLOWUP_IGNORE_LOGINS`, for a repo's own bots (preview deployers, coverage bots). Logins match whole, case-insensitive; a blank or non-string entry makes the whole file invalid | Union: the effective list is the deployer list (`FOLLOWUP_IGNORE_LOGINS`) plus this list. The repository cannot remove a login the deployer listed, the same rule as `blocking_question_authors` |
| `ignore_conflicts_label` | non-blank string | the deployment value (`IGNORE_CONFLICTS_LABEL`, default `ignore-conflicts`) | Overrides `IGNORE_CONFLICTS_LABEL` for this repository. Behaviour of the label is unchanged. A blank or non-string value makes the whole file invalid | Override: the file value wins when present; the deployment value stays the default when the key is absent |
| `pickup_label` | non-blank string | `jumi` | The GitHub label that hands an issue or pull to Jumi. Covers every place the `jumi` label is used on GitHub: issue pickup, handing over a pull, and the marker Jumi leaves on taken-over pulls (removing it still cancels). Gitea keeps using assignment and ignores this key. Because the label webhook reads the repository's default-branch settings for the name, a missing, unreadable, or invalid file falls back to `jumi`. A blank or non-string value makes the whole file invalid. Logins are not involved; label matching stays case-insensitive | No deployer setting (the deployment default is `jumi`) |
| `conflict_regenerate` | list of `{file, run}` mappings | no repository entries (only the built-in helm locks regenerate) | Names lockfiles the conflict job rebuilds with a shell command instead of handing to the model: `file` is a lock basename (no slash, matched the same way as `Chart.lock`/`requirements.lock`), `run` is the shell command run in the directory that contains the conflicted file. The entry comes from the default branch only, never the pull request head, so a pull cannot add a command. The command runs in the worker sandbox with the same sanitized child environment the conflict model run gets (no forge token, same network policy), bounded by 10 minutes; when it fails, times out, or leaves the file conflicted or missing, the file is logged and handed to the model. Each mapping has exactly the keys `file` and `run`, both non-blank strings; a duplicate basename or a basename the built-ins own (`Chart.lock`, `requirements.lock`) makes the whole file invalid | No deployer setting |
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
automerge: true # needs the deployment switch (JUMI_AUTOMERGE_ENABLED on, no
  # JUMI_AUTOMERGE_REPOS narrowing) plus the base branch requiring jumi/opencode-review
automerge_label: automerge # per-PR opt-in label (default automerge)
no_automerge_label: no-automerge # per-PR opt-out label (default no-automerge)

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

trusted_senders: # intersection with TRUSTED_SENDER_LOGINS when set; alone admits when unset
  - alice
followup_ignore_logins: # union with FOLLOWUP_IGNORE_LOGINS; cannot remove deployer logins
  - preview-bot
ignore_conflicts_label: ignore-conflicts # override for IGNORE_CONFLICTS_LABEL
pickup_label: jumi # override for the GitHub pickup label; Gitea ignores it

conflict_regenerate: # rebuild these locks with a command instead of handing them to the model
  - file: package-lock.json
    run: npm install --package-lock-only --ignore-scripts

mode: full # full (default) | review-only | off

timeouts: # whole minutes per kind; absent keys run with the deployment timeout
  review: 10 # ceiling: OPENCODE_TIMEOUT_MAX_MS
  implement: 120 # ceiling: OPENCODE_TIMEOUT_MAX_MS
  followup: 60 # controls follow-up jobs; ceiling: FOLLOWUP_TIMEOUT_MAX_MS
  conflict: 60 # ceiling: CONFLICT_TIMEOUT_MAX_MS
```

## Recipes

Auto-merge only (still needs the deployment switch `JUMI_AUTOMERGE_ENABLED` on and no
`JUMI_AUTOMERGE_REPOS` narrowing, and the base branch to require the `jumi/opencode-review` check):

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
| Auto-merge | No schedule, silent (same as `automerge: false`), unless an admitted `automerge` label opts that PR in (copied from the worked issue at open time) | No schedule; the pull request gets one note naming the parser's error | No schedule; the pull request gets one note saying the file could not be read |
| Override labels | Label names fall back to `automerge` / `no-automerge`; `no-automerge` present opts out silently, an admitted `automerge` forces a schedule through every gate, both together cancel with a conflict note, an untrusted or unreadable `automerge` labeller posts one note and never schedules | Custom label names are invalid with the rest of the file, so the invalid note above applies and labels change nothing | Label history that cannot be read fails closed with one note |
| `review_exclude` | No exclusions; the review runs in full | No exclusions; the review runs in full (the pull still carries the parser-error note via auto-merge/head validation, but nothing is left out) | No exclusions; the review runs in full |
| Follow-up (`followup_on_suggestions`, `max_*_rounds`) | Deployment caps, suggestions on | Policy falls back to deployment caps with suggestions on — but like any other runner job, no runner job starts while the default-branch file is invalid (see Runners row) | Deployment caps, suggestions on (fail-open); a runner job still runs on the full chain |
| Trusted senders (`trusted_senders`) | Deployment list, or write access when the deployment leaves `TRUSTED_SENDER_LOGINS` unset | Invalid never widens: the deployment list (or write access) still decides, so no new sender is admitted | Deployment list, or write access when unset (fail-open, logged) |
| Follow-up ignores (`followup_ignore_logins`) | Deployer list (`FOLLOWUP_IGNORE_LOGINS`) | Deployer list still applies; the repository list contributes nothing | Deployer list (fail-open, logged) |
| Ignore-conflicts label (`ignore_conflicts_label`) | Deployment value (`IGNORE_CONFLICTS_LABEL`) | Deployment value still applies | Deployment value (fail-open, logged) |
| Pickup label (`pickup_label`, GitHub only; Gitea ignores it) | `jumi` | `jumi`: a custom label in an invalid file changes nothing, and `jumi` no longer starts work in a repo whose valid file names another label | `jumi` (fail-open, logged) |
| `conflict_regenerate` | No repository entries: only the built-in helm locks regenerate | No repository entries (the whole file is invalid, so no entry applies) | No repository entries (fail-open, logged) |
| `mode` | `full` | Reads as `full`, but like any other runner job, no runner job starts while the file is invalid | `full` |
| Runners (`allowed_runners`) | Full chain (unrestricted) | No runner job starts: a review ends with a `failure` status naming the parser's error, and a worker job says so once where it was started | Full chain (fail-open, logged). An explicitly empty list is not "missing": it makes the whole file invalid (`"allowed_runners" is empty, so no runner could work ...; use mode: off or mode: review-only`), so no runner job starts like the Invalid column. A non-empty list that matches no runner fails closed with a `failure`/note saying the settings left no eligible runner. Unknown names are only logged |

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
