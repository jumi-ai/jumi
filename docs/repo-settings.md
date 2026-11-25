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
| `automerge_method` | one of `"merge"`, `"squash"`, `"rebase"`, `"rebase-merge"`, `"fast-forward-only"` | today's method (first allowed on GitHub, default style on Gitea) | Merge method Jumi schedules with, on the first schedule and the restore/re-arm path. `merge`, `squash`, `rebase` work on both forges; `rebase-merge` and `fast-forward-only` are Gitea-only. A non-string or unknown value makes the whole file invalid; `automerge-method` / `automergeMethod` are unknown keys rejected with the usual "did you mean" error. The method must be one the repository allows (GitHub: `allow_merge_commit` / `allow_squash_merge` / `allow_rebase_merge`; Gitea: `allow_merge_commits` / `allow_squash_merge` / `allow_rebase` / `allow_rebase_explicit` / `allow_fast_forward_only_merge`): when the repository does not allow it, or a Gitea-only value is set on GitHub, Jumi schedules nothing and leaves one note saying the repository does not allow `<method>` merges. An unknown allow flag (older forge, fakes) trusts the setting | No deployer setting |
| `allowed_runners` | list of runner names | no restriction (the full active chain) | Narrows every job for the repository — review, implement, follow-up, conflict — to the chain entries whose name is on the list, keeping chain order | Narrowing only: names outside the active chain grant nothing and are only logged. An explicitly empty list is invalid (the whole file is invalid — use `mode: off` or `mode: review-only` instead); a non-empty list that matches nothing fails closed with no runner job starting (see Runners row below). Without `JUMI_RUNNERS_FILE` the chain is synthesized and its entries are stably named `primary` (and `fallback` when a fallback model is set) |
| `review_exclude` | list of glob strings | `[]` (nothing is left out) | A changed file whose repository-relative path matches is left out of the review: its patch is withheld from the reviewer in first and later reviews. The file is still listed as changed and marked as left out, and the published review names the files (or the count, when the list is long) | No deployer setting. Uses the same gitignore-style glob dialect as `REVIEW.md` path sections (`**/generated/**`, `pnpm-lock.yaml`, `docs/`; a bare word is not a glob, so scope it like `**/Dockerfile`). The settings file itself can never be left out: a pattern matching it has no effect on it. Patterns come from the default branch only, so a pull that adds a pattern is still reviewed in full |
| `followup_on_suggestions` | boolean | `true` (follow up, as today) | `false` turns off follow-up on a `success` review that only has suggestions. Failing reviews, blocking questions, red CI, and conflicts still run as today, and a comment or review from someone allowed to steer follow-up still starts it whatever this setting says | No deployer setting |
| `auto_rerun_flakes` | boolean | `true` (rerun once, as today) | `false` turns off the automatic rerun after a worker `no_changes` on red CI: no forge rerun call ever happens and the round keeps today's no-changes sit. Absent (or a missing/invalid/unreadable file) reruns each still-failed check once per head SHA and check name, then falls back to the no-changes sit once the budget is spent. Exactly one spelling: `auto-rerun-flakes` or `autoRerunFlakes` is an unknown key rejected with the usual "did you mean" error | No deployer setting |
| `suggestions_hold_merge` | boolean | follows `automerge` (`true` when `automerge: true`, otherwise off) | `false` turns off the one-round suggestion hold in an auto-merge repository; absent holds once per PR while the PR will auto-merge (`automerge: true` or an admitted `automerge` label, same trust check and custom label names as auto-merge, never with `no-automerge`) and the deployment switch is on. Holds only `success` reviews whose only findings are 💡: the status posts `pending` (`N suggestions waiting for follow-up`) until the follow-up pushes (next review posts `success` even with new 💡) or the round ends without a push (the held head turns `success` with a note). 🔴/🟡 and blocking ❓ work as today and take precedence. Repositories and PRs that don't auto-merge keep today's behavior | Deployment switch (`JUMI_AUTOMERGE_ENABLED` on) plus the shared auto-merge opt-in (file or admitted label); either one off never holds |
| `maintainer_questions_hold_merge` | boolean | `true` (hold) | `false` turns off the maintainer-question hold; absent (or a missing/invalid/unreadable file) holds. An open `❓ maintainer:` on a `success` review posts `pending` (`waiting on maintainer: N question(s)`) instead of `success`, so every required-check merge waits — Jumi-owned, label-forced, `automerge: true`, or hand-scheduled. A maintainer-only review still starts no worker round (the board shows `waiting-maintainer`); a reply on the PR from a trusted sender (or write access) runs the normal comment-triggered follow-up, which turns the held head to `success` when no change is needed and pushes otherwise. 🔴/🟡 and blocking ❓ take precedence (failure > pending > success). A person merging by hand is not blocked by Jumi beyond the status itself | No deployer setting |
| `max_followup_rounds` | non-negative integer (`0` is valid and means no rounds) | the deployment value (`MAX_FOLLOWUP_ROUNDS`) | Caps follow-up rounds per pull request for this repository. Rounds are counted as today; only the cap changes | Ceiling: a higher file value applies as the deployment value (`min(deployment, file)`) |
| `max_conflict_rounds` | non-negative integer (`0` is valid and means no rounds) | the deployment value (`MAX_CONFLICT_ROUNDS`) | Caps consecutive failed conflict-resolution rounds per issue for this repository | Ceiling: a higher file value applies as the deployment value (`min(deployment, file)`) |
| `takeover_authors` | list of logins | `[]` (off) | A pull request opened by a listed author is taken over exactly like a pull handed over by hand: same follow-up on red CI, review findings, conflicts, and comments, under the same open / non-draft / non-`WIP:` / same-repo bar, leaving the same marker (assigned Jumi on Gitea, `jumi` label on GitHub). Removing the marker stops the work and the pull is never taken over again. Exactly one spelling: `takeover-authors` or `takeoverAuthors` is an unknown key rejected as `unknown key "..." (did you mean "takeover_authors"?)`. A blank or non-string entry makes the whole file invalid. Logins match whole, case-insensitive | The sender check still applies: a listed author is taken over only when that author would pass the same check a manual handover needs (`TRUSTED_SENDER_LOGINS` when set, write-level access otherwise). A refused author gets one note and no takeover |
| `ignore_conflicts_authors` | list of logins | `[]` (off) | A pull request whose author is listed gets what the `ignore-conflicts` label gives, without the label: while Jumi has not committed to the branch, no `conflict` job runs and follow-up never merges the default branch, for taken-over and handed-over pulls alike. Exactly one spelling: `ignore-conflicts-authors` or `ignoreConflictsAuthors` is an unknown key rejected as `unknown key "..." (did you mean "ignore_conflicts_authors"?)`. A blank or non-string entry makes the whole file invalid. Logins match whole, case-insensitive | Works alongside the `ignore-conflicts` label (`IGNORE_CONFLICTS_LABEL`): either one suppresses the same behavior |
| `blocking_question_authors` | list of logins | `[]` (none) | Names PR authors whose open `❓` questions block the review status: a review whose only findings are `❓` posts `failure` with `N open questions` instead of `success`, so required-check auto-merge waits. Logins match whole, case-insensitive; a blank or non-string entry makes the whole file invalid (`"blocking_question_authors" must not contain blank entries`) | Union: the effective list is the deployer list (`REVIEW_BLOCKING_QUESTION_AUTHORS`) plus this list. The file cannot remove a login the deployer listed |
| `trusted_senders` | list of logins | deployment list (`TRUSTED_SENDER_LOGINS`) or write access | Repository version of `TRUSTED_SENDER_LOGINS`. Applies everywhere that check applies: starting implement (assign / pickup label), steering follow-up, the `takeover_authors` admission check, and admitting the auto-merge label. When the deployment sets `TRUSTED_SENDER_LOGINS`, the effective list is the intersection: a repository can narrow it, never widen it. When the deployment leaves it unset, the repository list is the list (listing is the admit, same as the env list today, no forge permission lookup). Neither set keeps the write-access fallback. Combining two otherwise valid policies can leave no eligible senders: that explicitly empty effective list (`[]`, distinct from an absent policy) denies everyone without a forge lookup; only a truly unconfigured policy (or only blank deployment entries) keeps the write-access fallback. Logins match whole, case-insensitive; a blank or non-string entry makes the whole file invalid. An explicitly empty list is invalid (use `mode: off` or `mode: review-only` to stop work), the same reasoning as `allowed_runners`. An unreadable settings file falls back to the deployment behaviour, but an invalid file never widens access | Intersection (ceiling): when `TRUSTED_SENDER_LOGINS` is set, the effective list is the intersection; when unset, the repository list alone admits |
| `followup_ignore_logins` | list of logins | `[]` (none) | Repository version of `FOLLOWUP_IGNORE_LOGINS`, for a repo's own bots (preview deployers, coverage bots). Logins match whole, case-insensitive; a blank or non-string entry makes the whole file invalid | Union: the effective list is the deployer list (`FOLLOWUP_IGNORE_LOGINS`) plus this list. The repository cannot remove a login the deployer listed, the same rule as `blocking_question_authors` |
| `ignore_conflicts_label` | non-blank string | the deployment value (`IGNORE_CONFLICTS_LABEL`, default `ignore-conflicts`) | Overrides `IGNORE_CONFLICTS_LABEL` for this repository. Behaviour of the label is unchanged. A blank or non-string value makes the whole file invalid | Override: the file value wins when present; the deployment value stays the default when the key is absent |
| `pickup_label` | non-blank string | `jumi` | The GitHub label that hands an issue or pull to Jumi. Covers every place the `jumi` label is used on GitHub: issue pickup, handing over a pull, and the marker Jumi leaves on taken-over pulls (removing it still cancels). Gitea keeps using assignment and ignores this key. Because the label webhook reads the repository's default-branch settings for the name, a missing, unreadable, or invalid file falls back to `jumi`. A blank or non-string value makes the whole file invalid. Logins are not involved; label matching stays case-insensitive | No deployer setting (the deployment default is `jumi`) |
| `conflict_regenerate` | list of `{file, run}` mappings | no repository entries (only the built-in helm locks regenerate) | Names lockfiles the conflict job rebuilds with a shell command instead of handing to the model: `file` is a lock basename (no slash, matched the same way as `Chart.lock`/`requirements.lock`), `run` is the shell command run in the directory that contains the conflicted file. The entry comes from the default branch only, never the pull request head, so a pull cannot add a command. The command runs in the worker sandbox with the same sanitized child environment the conflict model run gets (no forge token, same network policy), bounded by 10 minutes; when it fails, times out, or leaves the file conflicted or missing, the file is logged and handed to the model. Each mapping has exactly the keys `file` and `run`, both non-blank strings; a duplicate basename or a basename the built-ins own (`Chart.lock`, `requirements.lock`) makes the whole file invalid | No deployer setting |
| `mode` | `"full"` \| `"review-only"` \| `"off"` | `"full"` | `review-only` keeps reviews and the review status working as today but starts no implement, follow-up, or conflict job (handing work to Jumi leaves one note saying worker jobs are turned off). `off` starts no job of any kind, posts no status, and comments nothing. The mode is checked before a runner starts so a restricted repository costs no model time; it is read when a job starts, so a running job finishes while a queued job follows the new mode. Auto-merge is never scheduled in a restricted mode | No deployer setting |
| `ci_gate` | mapping (may be empty) | `{}` (waits for required checks) | Chooses which CI checks gate reviews (see the `ci_gate.wait` row). Read from the default branch like every other key; a non-mapping value makes the whole file invalid | No deployer setting |
| `ci_gate.wait` | `"all"` \| `"required"` \| `"none"` | `"required"` | `required` waits only for the base branch's required checks, falling back to every check when protection can't be read or names no required check besides `jumi/opencode-review`; `all` waits for every non-Jumi check whatever branch protection says (the pre-#502 behaviour, never resolves the required set); `none` never waits for pending or absent CI — the router gate dispatches at once and the review job runs, listing pending checks as still running so the reviewer never reads them as green. A red check fails the review and runs the CI follow-up in every mode. `ci_gate` must be a mapping, `wait` one of the three strings; unknown sub-keys and dash/camel spellings (`ci-gate`, `ciGate`) are rejected with the usual "did you mean" error, and any invalid value makes the whole file invalid | No deployer setting |
| `timeouts` | mapping (may be empty) | `{}` (no overrides) | Per-kind run timeouts in whole minutes (see the four rows below). Read once when the job starts; a change never affects an already running job. Everything derived from the timeout follows the effective value for that job: the queue lease length and the credential-refresh budget at job start | Each present key is a ceiling against its deployer maximum (below); a smaller, non-integer, or non-numeric value makes the whole file invalid |
| `timeouts.review` | integer minutes, at least 1 | `OPENCODE_TIMEOUT_MS` | How long reviews may run | Ceiling: `OPENCODE_TIMEOUT_MAX_MS` (unset defaults to the deployment timeout, so a repository can only shorten out of the box); a value above the maximum runs with the maximum |
| `timeouts.implement` | integer minutes, at least 1 | `OPENCODE_TIMEOUT_MS` (worker default is 4h) | How long first implementations may run | Ceiling: `OPENCODE_TIMEOUT_MAX_MS`, same rule as `review`. Each kind has its own deployer maximum |
| `timeouts.followup` | integer minutes, at least 1 | `FOLLOWUP_TIMEOUT_MS`. Does not inherit `OPENCODE_TIMEOUT_MS` | How long follow-up rounds (`follow-up` jobs) may run | Ceiling: `FOLLOWUP_TIMEOUT_MAX_MS` (unset defaults to the deployment timeout for this kind) |
| `timeouts.conflict` | integer minutes, at least 1 | `CONFLICT_TIMEOUT_MS`. Does not inherit `OPENCODE_TIMEOUT_MS` | How long conflict resolution may run | Ceiling: `CONFLICT_TIMEOUT_MAX_MS` (unset defaults to the deployment timeout for this kind) |
| `setup` | mapping (see the four rows below) | absent (no setup) | Runs a repository's own preparation command in the job's worktree once per job, after the checkout is ready and before the first engine spawn. Read from the default branch only; a pull request cannot change its own setup. `run` is required; `timeout`, `on_failure`, and `kinds` are optional. Unknown sub-keys, a non-mapping `setup`, a missing or blank `run`, a non-integer or below-1 `timeout`, an unknown `on_failure`, or a blank or unknown `kinds` entry makes the whole file invalid. Exactly one spelling per key (`kinds` entries use the `timeouts` spelling, `followup`); dash and camel spellings are unknown keys rejected with "did you mean" | Timeout is a ceiling against `SETUP_TIMEOUT_MAX_MS` (below); the job's own timeout and queue lease are not extended |
| `setup.run` | non-blank string | — (required when `setup` is present) | Shell script run from the worktree root with `sh -e`, so a failing line stops it. The command string comes from the default branch, but it runs against the checked-out pull request head (see "Before you set"). Review setup runs sandboxed through the Landlock shell wrapper with a scratch `HOME` (see `docs/review-sandbox.md`) and its git through a read-only credential proxy (fetch/clone allowed, push refused without reaching the forge); worker setup kinds run with today's env and the read-write proxy | No deployer setting |
| `setup.timeout` | integer minutes, at least 1 | `10` | How long the setup command may run. A failed, timed-out, or dirty setup never counts as a runner exit, never triggers a hop, and never consumes hop budget | Ceiling: `SETUP_TIMEOUT_MAX_MS` (unset defaults to 10 minutes, so a repository can only shorten out of the box); a value above the maximum applies as the maximum |
| `setup.on_failure` | `"continue"` \| `"fail"` | `"continue"` | `continue` runs the job anyway (the agent prompt carries a `<repo_setup state="failed\|timeout\|dirty">` block with the output tail); `fail` starts no engine (a review posts a `failure` status naming the setup error, a worker job leaves one comment where it was started) | No deployer setting |
| `setup.kinds` | list of `"review"`, `"implement"`, `"followup"`, `"conflict"` | all four | Which job kinds run setup. Can only narrow; there is no way to run setup on another kind. A blank or unknown entry makes the whole file invalid | No deployer setting |
| `verify` | mapping (see the four rows below) | absent (no verify) | Runs the repository's fast checks after the worker exits with commits and before the push, for `implement` and `follow-up` jobs only. Reviews never run verify; they read its `Verify:` line in the PR body. Read from the default branch only; a pull request cannot change its own verify. `run` is required; `timeout`, `attempts`, and `kinds` are optional. A code failure resumes the same runner session with the exact command and the redacted output tail; timeouts and infrastructure errors (missing command, spawn failure) never resume. Attempts are bounded; the job pushes anyway after the last one. Unknown sub-keys, a non-mapping `verify`, a missing or blank `run`, a non-integer or below-1 `timeout`, a negative or non-integer `attempts`, or a blank or unknown `kinds` entry makes the whole file invalid. Exactly one spelling per key; dash and camel spellings are unknown keys rejected with "did you mean" | Kill switch `JUMI_VERIFY_ENABLED` (unset defaults to on; `false` runs no verify); ceilings `JUMI_VERIFY_TIMEOUT_MAX_MS` and `JUMI_VERIFY_ATTEMPTS_MAX` (below) |
| `verify.run` | non-blank string | — (required when `verify` is present) | Shell script run from the worktree root with `sh -e`, after commits and before the push. Runs in the same credential-free sandbox as `setup`: no forge or provider credentials. The worker prompt names this command so the worker can run the same thing first | No deployer setting |
| `verify.timeout` | integer minutes, at least 1 | `10` | How long the verify command may run. A timeout never resumes the session; the job pushes with `Verify: not run (timeout ...)` in the PR body | Ceiling: `JUMI_VERIFY_TIMEOUT_MAX_MS` (unset defaults to 10 minutes, so a repository can only shorten out of the box); a value above the maximum applies as the maximum |
| `verify.attempts` | non-negative integer (`0` is valid and means no resume) | `2` | How many times a code failure resumes the same runner session. A verify failure never counts as a runner failure and never uses the hop budget | Ceiling: `JUMI_VERIFY_ATTEMPTS_MAX` (unset defaults to 2; a higher file value applies as the maximum); `0` disables resumes |
| `verify.kinds` | list of `"implement"`, `"followup"` | both | Which worker kinds run verify. Can only narrow; reviews never run verify. A blank or unknown entry makes the whole file invalid | No deployer setting |
| `branch_prefix` | non-blank string | `jumi` | Branch prefix for issue branches: `<prefix>/issue-<N>-<slug>`. One or more path segments of `[a-z0-9._-]`; no leading or trailing slash, no `..`. The full branch must pass `git check-ref-format`, and prefixes colliding with Jumi's internal refs (`jumi/target`, `jumi/pr-*`, `refs/jumi/wip/`) are invalid. Branch recognition accepts the configured prefix and keeps accepting `jumi/issue-<N>-`, so PRs opened before a prefix change keep working. A branch name alone never makes a PR count as Jumi's: the existing author and identity checks still apply. Exactly one spelling: `branch-prefix` or `branchPrefix` is an unknown key rejected with the usual "did you mean" error. A blank or non-string value makes the whole file invalid | No deployer setting. Read from the default branch only; forge issues only (external-tracker branches keep today's format) |
| `pr_title` | non-blank string template | `{title}` | Pull-request title template for forge issues. The only placeholders are `{title}` (the issue title) and `{issue}` (the issue number). Any other `{...}` or stray brace makes the whole file invalid. Exactly one spelling: `pr-title` or `prTitle` is an unknown key rejected with the usual "did you mean" error. A blank or non-string value makes the whole file invalid | No deployer setting. Read from the default branch only; forge issues only (external-tracker titles keep today's format) |
| `commit_message` | non-blank string template | `Implement #{issue}: {title}` | Commit message template for the commit Jumi's parent creates. The only placeholders are `{title}` and `{issue}`; any other `{...}` or stray brace makes the whole file invalid. When set, the worker prompt also names the template as the repository's commit message convention. Exactly one spelling: `commit-message` or `commitMessage` is an unknown key rejected with the usual "did you mean" error | No deployer setting. Read from the default branch only; forge issues only |
| `closing_keyword` | `"closes"` \| `"refs"` | `"closes"` | `closes` keeps today's `Fixes #N` fallback body; `refs` uses a non-closing `Refs #N` fallback and asks the worker for a non-closing reference. When set to `refs`, a model body that uses a closing keyword for the worked issue is rewritten to `Refs #N`, and the issue stays open after merge. A blocker issue then stays unresolved until someone closes it. Exactly one spelling: `closing-keyword` or `closingKeyword` is an unknown key rejected with the usual "did you mean" error. A blank, non-string, or other value makes the whole file invalid | No deployer setting. Read from the default branch only |
| `review_drafts` | boolean | `false` (skip drafts, as today) | `true` reviews draft PRs and `WIP:`-titled PRs on every review-dispatch path, on both forges. Worker eligibility stays draft-excluded: no follow-up, takeover, or auto-merge on a draft. `PR title disables review` (`wip` / `[wip]` prefix) keeps working, and marking the PR ready still triggers a review, as today | No deployer setting. Missing, invalid, or unreadable files skip drafts, as today |
| `max_suggestions` | non-negative integer (`0` is valid and means no suggestions) | the parent ceiling (`5`) | Caps 💡 findings for this repository. 🔴, 🟡 and ❓ findings are never capped. The `Jumi dropped N suggestions (cap X)` note shows the effective cap | Ceiling: `MAX_SUGGESTION_FINDINGS` (`5`); a higher file value applies as `5`, like the `max_followup_rounds` ceiling rule |
| `review_budget` | mapping (may be empty) | `{}` (no overrides) | Size budget overrides for reviews in this repository (see the two rows below). Read once when the job starts; applied wherever `maxFiles` and `maxPatchBytes` are read for a review (including replay) | Each present key is a ceiling against its deployer maximum (below); a non-mapping value, an unknown sub-key, or a non-positive-integer value makes the whole file invalid |
| `review_budget.max_files` | positive integer, at least 1 | `MAX_FILES` | How many changed files are sent to OpenCode for reviews in this repository | Ceiling: `MAX_FILES_MAX` (unset defaults to `MAX_FILES`, so a repository can only lower the budget out of the box); a value above the maximum applies as the maximum |
| `review_budget.max_patch_bytes` | positive integer, at least 1 | `MAX_PATCH_BYTES` | How many patch bytes are sent to OpenCode for reviews in this repository | Ceiling: `MAX_PATCH_BYTES_MAX` (unset defaults to `MAX_PATCH_BYTES`, so a repository can only lower the budget out of the box); a value above the maximum applies as the maximum |
| `strict_branch_refresh` | boolean | `false` (off) | Gitea-only fallback for strict branch refresh: `true` lets Jumi refresh an outdated head with a merge-only update when the base branch protection cannot be read (write-level token gets 403 on the admin route). The readable forge rule always wins (rule off plus this on means off); on GitHub this key has no effect. Exactly one spelling: `strict-branch-refresh` or `strictBranchRefresh` is an unknown key rejected with the usual "did you mean" error. A non-boolean value makes the whole file invalid | No deployer setting. Read from the default branch only |
| `worker_review_rules` | boolean | `true` (on) | Shares the base-branch `REVIEW.md` rules with implement and follow-up workers: the severity bar and pre-write questions plus the sections that apply (implement gets repo-wide plus all path sections, follow-up gets the sections matching the PR's changed files; the reviewer-only `Not a finding` section is left out). `false` keeps workers on today's prompts. Exactly one spelling: `worker-review-rules` or `workerReviewRules` is an unknown key rejected with the usual "did you mean" error. A non-boolean value makes the whole file invalid | No deployer setting. Read from the default branch only |

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
automerge_method: squash # merge (default) | squash | rebase | rebase-merge (Gitea-only) | fast-forward-only (Gitea-only)

allowed_runners: # absent means no restriction; present narrows every job to these chain names
  - primary

review_exclude: # patches for these paths are withheld from the reviewer, but they can still merge
  - "**/generated/**"
  - "pnpm-lock.yaml"
  - "docs/"

followup_on_suggestions: false # true (the default) follows up on success-with-suggestions as today
auto_rerun_flakes: true # false never reruns after no_changes; the round keeps the no-changes sit (default reruns once)
suggestions_hold_merge: true # false turns off the one-round hold in an automerge repo (default follows automerge)
maintainer_questions_hold_merge: true # false turns off the maintainer-question hold (default holds)

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
branch_prefix: bot/jumi # issue branches are bot/jumi/issue-<N>-<slug> (default jumi)
pr_title: "feat: {title}" # PR title template (default "{title}")
commit_message: "chore: {title} (#{issue})" # parent commit template (default "Implement #{issue}: {title}")
closing_keyword: closes # closes (default) | refs (non-closing Refs #N)

mode: full # full (default) | review-only | off

review_drafts: true # false (the default) skips draft PRs and WIP:-titled PRs, as today
max_suggestions: 2 # ceiling against MAX_SUGGESTION_FINDINGS (5); 0 means no suggestions

review_budget: # file count and patch bytes sent to OpenCode; absent keys run with the deployment values
  max_files: 300 # ceiling: MAX_FILES_MAX
  max_patch_bytes: 2000000 # ceiling: MAX_PATCH_BYTES_MAX

ci_gate: # absent (or wait absent) means required: wait for required checks, falling back to every check
  wait: required # all waits for every check regardless of branch protection; none reviews without waiting

timeouts: # whole minutes per kind; absent keys run with the deployment timeout
  review: 10 # ceiling: OPENCODE_TIMEOUT_MAX_MS
  implement: 120 # ceiling: OPENCODE_TIMEOUT_MAX_MS
  followup: 60 # controls follow-up jobs; ceiling: FOLLOWUP_TIMEOUT_MAX_MS
  conflict: 60 # ceiling: CONFLICT_TIMEOUT_MAX_MS

setup: # preparation command run once per job before the first engine spawn
  run: |
    helm dependency build deploy/chart
  timeout: 5 # whole minutes, default 10; ceiling: SETUP_TIMEOUT_MAX_MS
  on_failure: continue # continue (default) | fail
  kinds: [review, implement, followup, conflict] # default: all four

verify: # fast checks run after the worker with commits and before the push
  run: bun run lint:repo && bun run knip # one command, no tiers
  timeout: 5 # whole minutes, default 10; ceiling: JUMI_VERIFY_TIMEOUT_MAX_MS
  attempts: 2 # resumes on code failure, default 2; ceiling: JUMI_VERIFY_ATTEMPTS_MAX
  kinds: [implement, followup] # default: both; reviews never run verify

strict_branch_refresh: false # Gitea-only fallback when branch protection is unreadable (default false); GitHub ignores it
worker_review_rules: true # false keeps implement/follow-up workers off the REVIEW.md rules (default shares them)
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

Conventional-commits repository (commitlint / title checks pass: prefixed
branches, `feat:` PR titles, `chore:` parent commits, no closing keyword):

```yaml
branch_prefix: bot/jumi
pr_title: "feat: {title}"
commit_message: "chore: {title} (#{issue})"
closing_keyword: refs
```

Review before slow CI finishes (the review does not wait for pending or absent CI; pending
checks are still listed as still running, and red checks still fail the review as today).
Note that it spends review time on pull requests whose tests may still fail:

```yaml
ci_gate:
  wait: none
```

Wait for every check regardless of branch protection (the pre-#502 behaviour; the required
set is never resolved):

```yaml
ci_gate:
  wait: all
```

Prepare vendored charts before the review (a Helm chart that depends on a sibling
library chart through `file://`):

```yaml
setup:
  run: |
    helm dependency build deploy/chart
  timeout: 5
  on_failure: continue
  kinds: [review, implement, followup, conflict]
```

Run fast checks before every push (lint, typecheck, knip — never Postgres or
image builds):

```yaml
verify:
  run: bun run lint:repo && bun run knip
  timeout: 5
  attempts: 2
  kinds: [implement, followup]
```

## What happens when the file is missing, invalid, or unreadable

"Unreadable" is a failed read (for example a forge error); the parent logs it. Missing
(or no file API, or no default branch to read from) behaves the same as unreadable
everywhere except auto-merge, which stays silent only for missing/`false`.

| Feature | Missing | Invalid (whole file) | Unreadable |
|---------|---------|----------------------|------------|
| Auto-merge | No schedule, silent (same as `automerge: false`), unless an admitted `automerge` label opts that PR in (copied from the worked issue at open time) | No schedule; the pull request gets one note naming the parser's error | No schedule; the pull request gets one note saying the file could not be read |
| `automerge_method` | Today's method (first allowed on GitHub, default style on Gitea) | Whole file invalid: no schedule; the pull request gets one note naming the parser's error (same as `automerge`) | No schedule; the pull request gets one note saying the file could not be read (same as `automerge`). A method the repository does not allow, or a Gitea-only value on GitHub, schedules nothing with one note saying the repository does not allow `<method>` merges |
| Override labels | Label names fall back to `automerge` / `no-automerge`; `no-automerge` present opts out silently, an admitted `automerge` forces a schedule through every gate, both together cancel with a conflict note, an untrusted or unreadable `automerge` labeller posts one note and never schedules | Custom label names are invalid with the rest of the file, so the invalid note above applies and labels change nothing | Label history that cannot be read fails closed with one note |
| `review_exclude` | No exclusions; the review runs in full | No exclusions; the review runs in full (the pull still carries the parser-error note via auto-merge/head validation, but nothing is left out) | No exclusions; the review runs in full |
| Follow-up (`followup_on_suggestions`, `max_*_rounds`) | Deployment caps, suggestions on | Policy falls back to deployment caps with suggestions on — but like any other runner job, no runner job starts while the default-branch file is invalid (see Runners row) | Deployment caps, suggestions on (fail-open); a runner job still runs on the full chain |
| Flake reruns (`auto_rerun_flakes`) | Rerun once per head and check after `no_changes`, then the no-changes sit | Reruns once (invalid never disables the rerun by accident); the pull still carries the parser-error note via auto-merge/head validation | Reruns once (fail-open, logged) |
| Suggestion hold (`suggestions_hold_merge`) | Holds when an admitted `automerge` label opts the PR in (same trust check and label names as auto-merge; `no-automerge`, conflicting labels, untrusted/unreadable labellers, and `suggestions_hold_merge: false` never hold); otherwise today's `success` | No hold; the pull still carries the parser-error note via auto-merge/head validation, and `success` reviews follow up as today when `followup_on_suggestions` allows | No hold (fail-open, logged); deployment caps and suggestions on still apply |
| Maintainer hold (`maintainer_questions_hold_merge`) | Holds (`pending` with `waiting on maintainer: N question(s)`) | Holds (safe direction: the merge still waits while the file is invalid); the pull still carries the parser-error note via auto-merge/head validation | Holds (fail-open, logged) |
| Trusted senders (`trusted_senders`) | Deployment list, or write access when the deployment leaves `TRUSTED_SENDER_LOGINS` unset | Invalid never widens: the deployment list (or write access) still decides, so no new sender is admitted | Deployment list, or write access when unset (fail-open, logged) |
| Follow-up ignores (`followup_ignore_logins`) | Deployer list (`FOLLOWUP_IGNORE_LOGINS`) | Deployer list still applies; the repository list contributes nothing | Deployer list (fail-open, logged) |
| Ignore-conflicts label (`ignore_conflicts_label`) | Deployment value (`IGNORE_CONFLICTS_LABEL`) | Deployment value still applies | Deployment value (fail-open, logged) |
| Pickup label (`pickup_label`, GitHub only; Gitea ignores it) | `jumi` | `jumi`: a custom label in an invalid file changes nothing, and `jumi` no longer starts work in a repo whose valid file names another label | `jumi` (fail-open, logged) |
| `conflict_regenerate` | No repository entries: only the built-in helm locks regenerate | No repository entries (the whole file is invalid, so no entry applies) | No repository entries (fail-open, logged) |
| PR conventions (`branch_prefix`, `pr_title`, `commit_message`, `closing_keyword`) | Today's formats: `jumi/issue-<N>-<slug>` branches, the issue title as PR title, `Implement #N: <title>` commits, `Fixes #N` bodies | Whole file invalid, so today's formats apply but — like any other runner job — no runner job starts while the default-branch file is invalid (see Runners row). A reserved or malformed prefix (`jumi/target`, `a//b`, `../x`, `/x`), an unknown `{...}` placeholder or stray brace, or a blank/non-string value invalidates the file | Today's formats (fail-open, logged) |
| `mode` | `full` | Reads as `full`, but like any other runner job, no runner job starts while the file is invalid | `full` |
| Review drafts (`review_drafts`) | Drafts skipped, as today | Drafts skipped (invalid never reviews a draft by accident) | Drafts skipped (fail-open, logged) |
| Suggestion cap (`max_suggestions`) | Parent ceiling (`5`) | Parent ceiling still applies — but like any other runner job, no runner job starts while the default-branch file is invalid (see Runners row) | Parent ceiling (fail-open, logged) |
| Review budget (`review_budget`) | Deployment values (`MAX_FILES`, `MAX_PATCH_BYTES`) | Deployment values still apply — but like any other runner job, no runner job starts while the default-branch file is invalid (see Runners row) | Deployment values (fail-open, logged) |
| CI gate (`ci_gate.wait`) | Wait for required checks (today's behaviour) | Whole file invalid, so the gate behaves as `required` (nothing ever falls back to `none`) | Wait for required checks (fail-open, logged); nothing ever falls back to `none` |
| Strict branch refresh (`strict_branch_refresh`, Gitea only; GitHub ignores it) | No opt-in: unreadable protection means `unknown`, no refresh | No opt-in (the whole file is invalid, so no entry applies) | No opt-in (fail-open, logged); unreadable protection means `unknown`, no refresh |
| Worker review rules (`worker_review_rules`) | Share base-branch `REVIEW.md` rules with workers when the repo has one (nothing new when it does not) | Share when the file is valid; an invalid file starts no runner job, so nothing is shared (see Runners row) | Share (fail-open, logged); nothing new when the repo has no `REVIEW.md` |
| Runners (`allowed_runners`) | Full chain (unrestricted) | No runner job starts: a review ends with a `failure` status naming the parser's error, and a worker job says so once where it was started | Full chain (fail-open, logged). An explicitly empty list is not "missing": it makes the whole file invalid (`"allowed_runners" is empty, so no runner could work ...; use mode: off or mode: review-only`), so no runner job starts like the Invalid column. A non-empty list that matches no runner fails closed with a `failure`/note saying the settings left no eligible runner. Unknown names are only logged |
| Setup (`setup`) | No setup: the job runs as today, with no extra log line and no prompt change | Whole file invalid, so like any other runner job, no runner job starts (a review posts `failure` naming the parser's error; a worker job comments once where it was started) | No setup, logged; the job otherwise runs as today |
| Verify (`verify`) | No verify: the job pushes as today, with no `Verify:` line | Whole file invalid, so like any other runner job, no runner job starts (a review posts `failure` naming the parser's error; a worker job comments once where it was started) | No verify, logged; the job otherwise pushes as today |

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
- Before you set `setup.run`: the command string comes from the default branch, but
  it runs against the checked-out pull request head, so anything it calls from the
  tree is pull-request code. The sandbox has no forge token and no model credentials,
  and review setup additionally runs inside the Landlock shell sandbox with a scratch
  `HOME` (checkout plus scratch read-write, no agent `HOME`; an unavailable sandbox
  fails the setup under `on_failure` instead of running unwrapped) and a read-only
  git proxy (private fetches are served with the parent-held credential, but pushes
  are refused without contacting the forge, and a missing credential fails the setup
  instead of falling back), but egress is
  open. Prefer commands that only invoke installed tools; don't point
  `run` at a script a contributor can rewrite unless that's acceptable.
- Before you set `verify.run`: the same trust rule as `setup.run` applies —
  the command string comes from the default branch but runs against the
  pull-request head in the same credential-free sandbox (no forge or provider
  credentials), so anything it calls from the tree is pull-request code.
  Keep it to fast static checks (lint, typecheck, knip); never point it at
  suites that need Postgres, containers, or the network beyond what `setup`
  allows. A code failure resumes the same runner session, so the command must
  be one the worker can fix without weakening the check.
- Every change to `.jumi.yml` needs a person's merge: a pull request that touches the
  file never auto-merges through Jumi, and turning auto-merge on (or changing any
  later setting) only takes effect once a person has merged it to the default branch.
