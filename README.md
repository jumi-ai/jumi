# jumi

Deterministic control plane for Gitea: one Postgres job ledger, implement then review, capped iterate graph. OpenCode is the inner CLI plugin — the parent writes task files, the child has no forge token, the parent commits, pushes, and publishes.

A stranger cloning this repo should set **their** Gitea origin, owner allowlist, org hook, Postgres URL, and OpenCode auth. Do not copy another cluster’s hostnames or owner names. Compiled env defaults in this tree (`GITEA_ALLOWED_ORGS`, `OPENCODE_WELLKNOWN_URL`) exist so this cluster’s GitOps can keep pinning them; override them for any other deploy.

Reference deploy is Kubernetes standing pods. GitOps lives outside this repository (`deploy/contract.md` is the runtime contract). There is no Compose file or Helm chart here. Agents working in this checkout follow `AGENTS.md`, including the rule to update this file when a user-visible contract changes.

## Loop

Pickup depends on `FORGE` (unset stays the `gitea` homelab default). There is no periodic issue scan.

- Gitea default: assign the issue to the bot.
- GitHub (`FORGE=github`): add label `jumi` to a non-PR issue (first-run) or to an open same-repo non-draft non-fork PR (follow-up on that head ref); removing that label cancels. Do not assign the GitHub App.

```text
assign issue to bot
  → ledger kind implement
  → OpenCode reads JUMI_TASK.md, writes the tree + JUMI_PR.md
  → parent commits, pushes jumi/issue-{n}-…, opens PR (Fixes #n)
  → ledger kind review
  → OpenCode writes JUMI_REVIEW.md (trailer is the merge gate)
  → parent posts one sticky + jumi/opencode-review on the head SHA
  → failure trailer / leftover simplifications / writer comment / red CI
      → ledger kind follow-up (capped re-implement on the same branch)
  → default-branch push with git conflicts
      → ledger kind conflict (capped, same branch)
```

Unassign is the kill switch. Caps: 3 review-comment follow-up rounds and 3 conflict rounds per skip-latch generation (CI follow-up is a separate per-`{head SHA, failed check}` budget). Cancel/unassign/unlabel bumps generation so a later pickup can handover again; succeeded history may remain. Missing `JUMI_REVIEW.md` after OpenCode exit 0 retries at most twice on that head, then posts stuck (not worker follow-up). Stuck loops (same finding 4×, same error 3×, A→B→A) skip OpenCode that round and do not fail the review check.

## Control plane

One `review_jobs` ledger (`kind`: `review` | `implement` | `follow-up` | `conflict`). Roles share it:

| Role | Image / process | Job |
|------|-----------------|-----|
| `router` | reviewer image, `JUMI_ROLE=router` | Org-hook **HMAC mailbox**: verify signature, persist rows, reclaim expired leases, queue metrics. No OpenCode, no HOME, no auth seed. |
| `engine` | reviewer image, `JUMI_ROLE=engine` | Lease `review` only, run OpenCode, persist `JUMI_REVIEW.md` before workspace teardown, publish sticky/status. |
| `worker` | worker image (`bun run src/worker_server.ts`) | Lease `implement` / `follow-up` / `conflict`. Not `JUMI_ROLE=router`. |
| `control` | reviewer image, `JUMI_ROLE=control` (`bun run src/control.ts`) | Own the Codex login: device login on `control:3010`, refresh the grant when remaining life drops below a lifetime fraction, publish a token-only Secret. One replica, one retained volume, no public ingress. The router stays diskless and holds no Codex credentials. |

Router writes every kind: `pull_request` opened/reopened/synchronize enqueue `review`; assign/comment/red CI enqueue `implement` / `follow-up`; default-branch `push` enqueue `conflict`; unassign cancels queued and leased worker rows for that issue and posts `stopped`. Ping is `200`. Unknown events `202`-skip. Ledger down is `503` (never `202` into RAM). Cheap 202 skips log the reason. After the engine publishes a current-head `<!-- jumi-check: failure -->` trailer, or a `success` trailer with a suggestion count, on a jumi closing PR whose issue is still assigned to the bot, persist inserts a `follow-up` row. Review does not start OpenCode while any other (non-jumi) check on that head SHA is pending or red, or before checks have appeared. A finished sibling check — completed `workflow_job`, GitHub `status` / `check_run`, or a Gitea commit `status` — re-enqueues the same SHA (deduped) so the review runs once CI is green, without a new push. Jumi's own `jumi/opencode-review` status does not wake. A head that still has no checks after the CI lookup budget is reviewed then, and the review says the repository has no CI.

`router` and `engine` need `DATABASE_URL` and `GITEA_BOT_TOKEN`. `GITEA_WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET` is not required for `engine`; required on `router` / worker. GitOps must set `DATABASE_URL` on the worker too, but the worker does not fail process start without it: that is local/dev mode (in-process queue, no ledger tick, startup log says `ledger=none`). Production correctness never depends on it — the router is the mailbox and never 202s jobs into worker RAM.

The org hook hits the **router** mailbox. Worker pods do not need a public webhook path. Worker HTTP (`POST /webhooks/gitea`) still exists for local/dev and healthz/metrics.

Control owns the Codex login: one replica with one retained volume (no public ingress) runs the reviewer image as `JUMI_ROLE=control`. It writes the real `auth.json` to the retained volume via `codex login --device-auth`, refreshes when the remaining access-token life drops below a lifetime fraction (never a hardcoded number of days), writes the rotated pair atomically and durably, and publishes a token-only `auth.json` (`auth_mode: chatgpt`, empty `refresh_token`, current access/id tokens, `last_refresh`, `account_id`) to one named Kubernetes Secret via plain authenticated HTTP. A failed publish is retried; a document that fails the probe-proved shape is never published, and no published document ever contains a refresh token. `refresh_token_reused` and `invalid_refresh_token` are login death: refresh stops and the board and `codex_login_dead` metric surface it. Metrics export access-token seconds remaining, its total lifetime, and last successful refresh time, so alerts use a fraction rather than fixed days. Job pods mount only the token-only Secret and hold no refresh token. The old rule "one login per ordinal, never a copied auth.json" holds for Grok ordinals; for Codex on control deployments the copy is the token-only Secret, never the grant.

### Inner CLI (plugin)

OpenCode is Engine impl #0: run to completion in a workspace. Stdout is logs, not the deliverable. The parent writes `JUMI_TASK.md` / `JUMI_FEEDBACK.md` / `JUMI_CI.md` / `JUMI_CONFLICT.md` and reads `JUMI_PR.md` / `JUMI_REVIEW.md`. The child is started with a sanitized env and does **not** receive `GITEA_BOT_TOKEN` or webhook secrets. Jumi treats its checkouts as trusted, so every runner loads the repository's own setup: its instructions, skills, hooks, plugins, MCP servers, and config. On a review those are the pull request head's copies, the same trust `REVIEW.md` gets. The forge-host deny is the one thing a repository cannot lift; see [Reviewer skills](#reviewer-skills).

The parent stamps every PR description, review writeup, and worker diary comment with the runner that actually produced it (after any hop), as one visible line such as `_Jumi · opencode · xai/grok-4.6 (high)_` or `_Jumi · claude · claude-opus-5 (high)_` (an `agy` runner stamps `_Jumi · agy · <model> (<effort>)_`; a `codex` runner stamps `_Jumi · codex · <model> (<effort>)_`, not ChatGPT). On reviews the stamp sits above the `jumi-check` trailer, which stays last. A published review carries only the child's finding lines (`<file>:<line>:`, `L<line>:` on a single-file PR, or a 🔴/🟡/💡/❓ marker) plus the trailer; the rest of `JUMI_REVIEW.md` (tour, what-was-checked, "no findings" prose) is dropped at publish time, and inline comments come only from the kept finding lines. Later follow-up rounds stamp their own diary comment.

## Point Gitea + Postgres + OpenCode at it

1. Run standing pods: router (ingress), engine (review), worker (implement). Same images this repo builds; pin tags from your registry.
2. Postgres: set `DATABASE_URL` on router, engine, and worker.
3. Forge: set `GITEA_URL` to **your** Gitea origin, `GITEA_BOT_TOKEN` for a bot that can read PRs and post comments, `GITEA_ALLOWED_ORGS` to **your** owners (`*` = every owner on that instance). Optional `GITEA_ALLOWED_REPOS` as `owner/repo`.
4. OpenCode auth: mount a volume at `/data` and seed `{HOME}/.local/share/opencode/auth.json` (see [OpenCode Auth](#opencode-auth)). Engine and worker need this; router does not.
5. Org hook: POST JSON to `https://<your-ingress>/webhooks/gitea` with secret = `GITEA_WEBHOOK_SECRET`. Enable **both** Issues and Issue Assign (Gitea 1.27 fires assign only on the latter), plus pull request, comments, push, workflow_job, and status. See [Webhook Setup](#webhook-setup).

Do not point the hook at a worker pod. Do not put a public Phoenix hostname in `PHOENIX_OTLP_ENDPOINT`.

## Configuration

Required:

| Name | Who | Description |
|------|-----|-------------|
| `GITEA_URL` | all | Trusted Gitea base URL (your origin, not another cluster’s) |
| `GITEA_BOT_TOKEN` | all | Bot token to fetch PR data and post comments |
| `GITEA_WEBHOOK_SECRET` | `router` / worker | HMAC-SHA256 of the raw body (`X-Gitea-Signature`). Not required for `engine` |
| `DATABASE_URL` | `router` / `engine` / worker | Postgres URL for the shared ledger. `router` / `engine` fail process start without it; GitOps must set it on the worker, which otherwise starts in local/dev mode (no ledger) |
| `JUMI_ROLE` | reviewer | `router` or `engine`. Unset, empty, or unknown fails process start. Worker is a separate image, not this flag |

Required when `FORGE=github` (set `FORGE=github` to select them; they replace `GITEA_URL` / `GITEA_BOT_TOKEN` / `GITEA_WEBHOOK_SECRET`, and with `FORGE` unset, empty, or `gitea` they are never read). GitOps must set every one of them on **both** images, so `deploy/contract.md` lists them under `gitops env` and adding one is a major bump:

| Name | Who | Description |
|------|-----|-------------|
| `FORGE_URL` | all | Trusted GitHub base URL (for example `https://github.com`, trailing slashes trimmed). Clone origins and the git auth host are checked against it |
| `GITHUB_APP_ID` | all | GitHub App id used to mint installation tokens |
| `GITHUB_APP_PRIVATE_KEY` | all | GitHub App private key, PEM (literal or `\n`-escaped newlines). Not a PEM fails process start |
| `GITHUB_ALLOWED_ORGS` | all | Comma-separated allowed owners. Unlike `GITEA_ALLOWED_ORGS` there is no compiled default: unset fails process start |
| `GITHUB_WEBHOOK_SECRET` | `router` / worker | HMAC-SHA256 of the raw body. Not required for `engine`, same as `GITEA_WEBHOOK_SECRET` |

Optional under either forge — unset never fails process start, so `deploy/contract.md` lists these under `optional env` and adding one is a minor bump:

| Name | Who | Description |
|------|-----|-------------|
| `FORGE` | all | Set `github` to select the table above. Unset or empty is `gitea`; any other value fails process start |
| `GITHUB_APP_INSTALLATION_ID` | all | Fallback installation id for calls with no `owner`/`repo` to resolve against; per-repository resolution still wins |
| `GITHUB_ALLOWED_REPOS` | all | Comma-separated `owner/repo` allowlist |

Optional (unset keeps the compiled default; set your own owners and well-known origin):

| Name | Default | Description |
|------|---------|-------------|
| `HOST` | `0.0.0.0` | HTTP bind host |
| `PORT` | `3000` | HTTP bind port |
| `GITEA_WEBHOOK_AUTH_TOKEN` | unset | Optional exact or bearer `Authorization` header value |
| `GITEA_ALLOWED_ORGS` | `kirmanak` | Comma-separated allowed owners. Include `*` to accept every repository owner. Set this; do not inherit another cluster’s org name |
| `GITEA_ALLOWED_REPOS` | unset | Optional comma-separated `owner/repo` allowlist |
| `BOT_USERNAME` | `jumi` | Bot login used to find the sticky comment and for assign pickup |
| `FOLLOWUP_IGNORE_LOGINS` | unset | Optional comma-separated logins skipped for follow-up in addition to `BOT_USERNAME` |
| `TRUSTED_SENDER_LOGINS` | unset | Optional comma-separated logins that may start implement and steer follow-up (label, assign, review, comment). When set, only these logins are admitted, whole login, case-insensitive, and the forge is not asked. Unset or empty admits only a sender whose collaborator lookup says write, admin, or owner (or a maintain/push role); an App's public permission record and team grants the lookup does not show are not consulted, so list such senders. Router and worker both read it |
| `IGNORE_CONFLICTS_LABEL` | `ignore-conflicts` | Optional PR label that tells Jumi to leave merge conflicts to the author. While the label is present and Jumi has not committed to the branch, no `conflict` job runs and follow-up never merges the default branch; red CI and review findings are still handled. After Jumi's first push the label no longer applies. Set it on Renovate PRs so Renovate keeps rebasing for free |
| `OPENCODE_MODEL` | `openai/gpt-5.5` | OpenCode model ID passed to `opencode run -m`; shared provider/small-model defaults come from the remote `.well-known/opencode` config |
| `OPENCODE_VARIANT` | unset | OpenCode reasoning effort, passed to `opencode run` as `-m <model>#<variant>`. Unset or empty omits it (model default). Do not bake an effort into the image |
| `OPENCODE_FALLBACK_MODEL` | unset | Optional OpenCode model ID (`provider/model`) for one from-scratch hop when the primary child exits because the provider/model is unavailable. Unset, empty, or same-provider fallback does not hop: Zen/Free quota then delayed-requeues the same job instead of a human kill-switch |
| `OPENCODE_FALLBACK_VARIANT` | unset | OpenCode reasoning effort for the fallback spawn. Unset or empty omits it (model default) |
| `JUMI_RUNNERS_FILE` | unset | Optional JSON catalog of named runners and an ordered hop chain. `type` is `opencode`, `claude`, `agy`, or `codex`; unknown `type` fails process start. Unset synthesizes a 1–2 entry **OpenCode** chain from `OPENCODE_MODEL` / `OPENCODE_VARIANT` / `OPENCODE_FALLBACK_*` — pinning the Claude binary does not flip either factory. Claude entries use `model`, optional `effort` (`--effort`; one of `low`, `medium`, `high`, `xhigh`, `max` — any other level fails process start, because the binary only warns about a level it does not know and then silently runs at the default), and spawn with `--setting-sources user,project` (the checkout's instructions, skills, and `.claude/settings.json` load natively, see [Reviewer skills](#reviewer-skills)) plus `--disallowedTools WebFetch(domain:<forge host>),WebFetch(domain:*.<forge host>)` derived by `src/forge_webfetch.ts` from the spawn's own `GIT_AUTH_HOST`, so the forge host is refused by the binary while `WebFetch` stays on the allow-list for public docs (a deny outranks every allow). Auth is `HOME` / `CLAUDE_CODE_OAUTH_TOKEN` from the parent env, not this file. `agy` entries (official Antigravity CLI) are the isolated GitHub factory only: a Gitea reviewer or worker (`FORGE` unset, empty, or `gitea`) whose runners file names `type: agy` exits at process start with `AntigravityRefusedError`; `FORGE=github` may still name it. They use `model` and optional `effort` (`--effort`) and spawn `agy -p --output-format stream-json --dangerously-skip-permissions` with `--print-timeout` from the job timeout, after merging `read_url(<forge host>)` into `permissions.deny` of `$HOME/.gemini/antigravity-cli/settings.json` (the CLI permission engine; deny outranks allow and `--dangerously-skip-permissions`, and `read_url(host)` covers subdomains) from that spawn's `GIT_AUTH_HOST` — a settings file that cannot take the rule fails the spawn closed; extra rounds on the same runner resume its own conversation id, never across runners. The parent never passes a prompt starting with `/`. Token usage comes from the stream-json `result` event (or accumulated `step_update` usage when the child is killed) under `source=agy`. An empty SUCCESS with `denied_actions` is a failed run. `Please sign in` / `authentication required` hops as auth; `RESOURCE_EXHAUSTED` / `out of quota` / 429 / 5xx hop as provider-unavailable. There is no headless quota preflight. Auth is the operator's own login under `$HOME/.gemini/antigravity-cli/` (keep it on the retained auth volume like `~/.claude`); when that directory has no `settings.json`, Jumi seeds `enableTelemetry: false` and `useG1Credits: false` plus the forge `read_url` deny; an existing file is not replaced, but the deny entry is merged in on every spawn. `codex` entries (official Codex CLI, ChatGPT login) use `model` and `effort` (omitted effort defaults to `high`; `ultra` is refused; intended model `gpt-6-sol`) and spawn non-interactive `codex exec --json --sandbox danger-full-access` (not the TUI, not `--full-auto`). Pinning the binary does not change the synthesized OpenCode chain and does not insert `codex` into either factory. Auth is `$HOME/.codex` on the retained auth volume, one login per ordinal, never a copied `auth.json` and never OpenCode's per-run config dir. An API key already in the parent env is accepted and not injected; shell policy keeps it out of the checkout's environment. Same-runner extra turns resume that thread; hops do not. Token usage comes from JSONL `turn.completed` under `source=codex`. A review that exits 0 with no `JUMI_REVIEW.md` is not success. Phoenix traces follow `AGENT_INSTANCE` and fail open. Secrets stay in env. Router does not require it |
| `OPENCODE_CONFIG` | `/app/.gitea/opencode-review.json` in the image | Reviewer OpenCode config: shell is allow-by-default; edit is allowed so the reviewer can write `JUMI_REVIEW.md`; `skill` is a blanket allow (image `/app/review-skills`, checkout and fleet skills; see [Reviewer skills](#reviewer-skills)); external_directory is last-match star deny then allow `/app/review-skills` and the fleet skill dirs under `~`; webfetch keeps one star allow in the JSON; the configured forge host and GitHub search are denied on **every** OpenCode spawn, worker included, by a per-spawn global policy a repository cannot lift (`src/forge_webfetch.ts`); subagent stays denied; xAI/OpenAI reviewer reasoning is pinned `high` |
| `OPENCODE_WELLKNOWN_URL` | `https://kirmanak.stream` | Remote OpenCode config origin. Override to **your** well-known host. Unset or empty still defaults to `https://kirmanak.stream`. Set `disabled` to turn well-known **off** (no `auth.json` seed, no fetch). Other non-URL values fail closed. `OPENCODE_MODEL` and `OPENCODE_API_KEY` still apply with well-known off. Otherwise the service seeds a `wellknown` auth entry (and rewrites it when key/token rotate) so OpenCode loads `/.well-known/opencode` before the local review policy |
| `OPENCODE_WELLKNOWN_KEY` | `OPENCODE_WELLKNOWN_TOKEN` | Logical key name recorded in OpenCode auth for the well-known provider |
| `OPENCODE_WELLKNOWN_TOKEN` | `unused` | Token placeholder for the public well-known config entry |
| `OPENCODE_API_KEY_FILE` | unset | Optional path to a file holding the OpenCode API key (Kubernetes Secret volume). Read fresh on every OpenCode spawn, so a rotated key applies to the next child with no pod restart. When set and readable with non-empty contents it wins over `OPENCODE_API_KEY`; otherwise the env var is the fallback. A missing, unreadable, or empty file with no env fallback fails the run as a provider-auth failure. Mount the Secret as files, not `subPath`, so kubelet updates it in place |
| `HOME` | `/data` in the image | Auth storage root (`OpenCode` under `HOME`; Claude Code uses `HOME` and `CLAUDE_CODE_OAUTH_TOKEN` from the parent env, `agy` uses `$HOME/.gemini/antigravity-cli/`, Codex uses `$HOME/.codex`; none of them use OpenCode’s per-run `XDG_CONFIG_HOME`) |
| `WORKDIR` | `/work` in the image | Workspace root. Review throwaways are removed after each run; a per-repo bare mirror stays under `_review-mirrors` |
| `QUEUE_CONCURRENCY` | `1` | Review worker concurrency |
| `MAX_FILES` | `100` | Max changed files sent to OpenCode |
| `MAX_PATCH_BYTES` | `500000` | Max patch bytes sent to OpenCode |
| `MAX_OUTPUT_BYTES` | `80000` | Max OpenCode stdout bytes and max `JUMI_REVIEW.md` bytes; oversized artifacts fail closed without a sticky |
| `MAX_WEBHOOK_BYTES` | `1048576` | Max accepted webhook payload bytes |
| `OPENCODE_TIMEOUT_MS` | `900000` | OpenCode run timeout (worker first-run default is 4h) |
| `FOLLOWUP_TIMEOUT_MS` | `3600000` | Follow-up OpenCode run timeout. Does not inherit `OPENCODE_TIMEOUT_MS` |
| `CONFLICT_TIMEOUT_MS` | `3600000` | Conflict OpenCode run timeout. Does not inherit `OPENCODE_TIMEOUT_MS` |
| `MAX_FOLLOWUP_ROUNDS` | `3` | Max follow-up OpenCode rounds per skip-latch generation |
| `MAX_CONFLICT_ROUNDS` | `3` | Max conflict OpenCode rounds per issue |
| `AGENT_INSTANCE` | `jumi` | Prometheus `agent_instance` label on `/metrics`. Phoenix project name for **both** OpenCode and Claude traces. Worker image sets `jumi-worker` |
| `PHOENIX_OTLP_ENDPOINT` | unset | In-cluster Phoenix OTLP HTTP base URL (app port, `/v1/traces`). Unset skips export. Use an in-cluster URL, not a public hostname. Also enables Claude tracing, which posts to `<base>/v1/projects/<AGENT_INSTANCE>/spans` — the parent strips the `/v1/traces` path rather than reusing it |
| `LEASE_MS` | `OPENCODE_TIMEOUT_MS + 10m` | Engine lease length before reclaim |
| `MAX_JOB_ATTEMPTS` | `2` | Reclaim requeues until this many attempts, then fails the job. SIGTERM/SIGINT on a reviewing engine or implementing worker aborts OpenCode and requeues the same job without consuming an attempt. Crash/OOM still uses reclaim. OpenCode spawn/auth/filesystem failures that never reach the model requeue with backoff without consuming an attempt; a per-process circuit breaker stops leasing after consecutive infra failures. Zen/Free quota on implement/follow-up/conflict (no different-provider fallback) requeues with a 1h–24h not-before and a 30h wall-clock budget, then `stuck: usage limit exceeded`. That wait is not infra’s 8-try/20min budget or circuit breaker |
| `MAX_INCOMPLETE_RETRIES` | `2` | Extra write-only OpenCode runs when a review exits 0 with no `JUMI_REVIEW.md`, then public stuck. Same session when possible. Unset is 2. Does not enqueue worker follow-up |
| `BOARD_PEER_URL` | unset | Internal URL of the other factory's board listener. Homelab only. Unset disables the hop. See [Operator board](#operator-board) |
| `BOARD_PEER_TOKEN` | unset | Bearer for that hop. Set the same value on both routers: the homelab router sends it, the `FORGE=github` router accepts it. Unset on either side means that forge is unavailable |

`deploy/contract.md` lists the GitOps keys. `JUMI_SECRETS_FILE` appears there only because the loaders read it: the image entrypoint writes it, GitOps does not set it. See [Security Model](#security-model).

## Review

The engine keeps a bare mirror of each repository on `WORKDIR` at `_review-mirrors/<owner>/<repo>.git` and borrows it with `git clone --reference` into a throwaway directory. The worker bare cache stays at `_cache` on the worker: the review child runs the pull request, and a worktree of that cache would share a writable object store with later implement clones. The clone is not shallow, so `git merge-base` and `git log` still see history. The throwaway checks out the pull-request head on `jumi/pr-<number>`. The base SHA is `jumi/target`. The throwaway is deleted after the review; the mirror stays until that volume is wiped, and its stored remote URL has no token. The child inspects that checkout plus forge metadata and the file patches. It does not apply the pull request: the review prompt tells the child not to run `helm upgrade`, `helm install`, or `kubectl apply`. This is an instruction, not a permission deny (bash is allow-by-default, and the image has no `kubectl`). The parent posts the sticky from `JUMI_REVIEW.md`, not from stdout.

A later review is one where the newest Jumi review on the pull names a reviewed commit that is an ancestor of the current head. Its prompt carries the previous finding lines (or a line saying there were none), the commits since that commit, and the patches of pull files those commits touched. It lists the whole pull's changed files without patches and leaves out the previous review essay; the checkout of the head still has the older files. A Jumi inline finding is carried unless Jumi resolved its thread itself; a thread someone else resolved is still carried. A resolved thread with no named resolver counts as Jumi's, because GitHub may not name an App resolver. A missing or non-ancestor reviewed commit gets a first review with the full pull patches, and so does a failed previous review with no finding lines (for example, one that could not finish).

It posts `jumi/opencode-review` on the PR head SHA from an explicit trailer in `JUMI_REVIEW.md` (`<!-- jumi-check: success -->` or `<!-- jumi-check: failure -->`), not from OpenCode stdout and not by grepping 🔴/🟡 in the prose:

- `pending` while the review is running
- `success` / `failure` from that trailer (❓ may still be `success`)
- `failure` if OpenCode crashes, returns empty output, or omits the trailer. Missing/empty `JUMI_REVIEW.md`, or a `failure` trailer with no published finding lines (a trailer reason is not a finding; dropped prose is not promoted), continues the same session with a write-only turn (see `MAX_INCOMPLETE_RETRIES`) then fails the check as `Incomplete review: no findings` and posts `stuck: incomplete review`; stdout/chat is never the artifact. A `success` trailer with no findings stays a clean review
- `warning` when a queued job is skipped after it already went pending (for example the PR head changed)

The engine inspects live non-jumi commit statuses / check-runs (and in-progress Actions jobs) before that pending status. Pending or red CI is a cheap skip with no model and no `jumi/opencode-review` status — not success for “waiting” or “CI failed”. Title-gated skips (`WIP:`) still post no status. Plan summaries stay the existing PR-thread comments (Tapio sticky) once the review actually starts.

Repo-specific review rules live in the reviewed repository, in `REVIEW.md` at the root of the pull request head (no base-branch fallback, no Copilot paths, no `applyTo` frontmatter). The parent reads it after checkout and pastes the sections that apply into the review prompt, so the reviewer never has to find the file. The reviewer treats the pasted sections as that repository's review rules and reports each violation as a finding. It is not `JUMI_REVIEW.md`: that file is the per-run artifact the parent posts and then removes. Do not put forge tokens or deploy hostnames in `REVIEW.md`. A `##` or deeper heading that is only a comma-separated list of gitignore-style globs (``## k3s/**, **/Chart.yaml``, ``## `*.ts` ``) is a path section: it is pasted only when a changed file matches one glob. A bare word is not a glob, so ``## Dockerfile`` is repo-wide; write ``## /Dockerfile`` or ``## **/Dockerfile`` to scope it. A single dotted word counts as a path section via the extension hint, so ``## Node.js`` is pasted only when a changed file matches it; use a prose heading to keep such rules repo-wide. Any other heading is repo-wide and is pasted on every review. A top-level `#` heading is the file's title and is always repo-wide, so `# REVIEW.md` does not scope the file. Subheadings stay with their section. The pasted text is capped (24 kB) and marked truncated past that. A pull request with no `REVIEW.md` gets no substitute checklist; the baked `gitops-apply-review` pack is no longer pasted.

The trailer is kept as the last non-empty line of the sticky comment so the worker can follow up on failure or leftover simplifications (`success; N suggestions`). Questions-only success does not enqueue.

### Independent review (opt-in)

Unset/disabled preserves today's behavior: the reviewer runs the configured chain in order, with synthesized `OPENCODE_MODEL` / `OPENCODE_FALLBACK_*` chains working as before. No factory chain is changed by this ticket; activation is a later explicit `JUMI_RUNNERS_FILE` decision.

To require a reviewer from a different model family than the writer, add `independentReview` to `JUMI_RUNNERS_FILE`:

```json
{
  "runners": {
    "opus-review": { "type": "claude", "model": "claude-opus-5", "effort": "high" },
    "grok-review": { "type": "opencode", "model": "xai/grok-4.6" }
  },
  "chain": ["opus-review", "grok-review"],
  "independentReview": {
    "enabled": true,
    "groups": {
      "opus": [
        { "type": "claude", "model": "claude-opus-5" },
        { "type": "opencode", "model": "anthropic/claude-opus-5" }
      ],
      "grok": [{ "type": "opencode", "model": "xai/grok-4.6" }]
    }
  }
}
```

Group mapping is explicit: the same family through different harnesses, providers, runner names, effort levels, or model versions stays one family only when every `{type, model}` identity is listed under that family. Effort/variant are ignored for family identity. Nothing is guessed from harness, provider prefix, or fuzzy model-name matching. A contradictory identity (same `{type, model}` in two families) fails process start; a known writer or chain candidate with no group fails the review closed. Old heads stay resolvable only while their recorded identities remain in `groups`; removing one fails closed instead of silently reinterpreting that head as today's primary.

When enabled, the parent resolves writer provenance for the exact expected PR head, keeps chain order, and excludes every known contributing writer family. Only runners already in the active reviewer chain are eligible: a `runners` catalog entry that is not in `chain` is dormant and never selected. Availability/auth/quota hops, same-model retries, artifact-extra rounds, lease reclaim, and review retries all stay inside the eligible set; an allowed hop never returns to an author family or a same-model cross-harness alias. Worker follow-up, conflict, CI-fix, and review-fix jobs on a PR with known Jumi provenance restart on the existing writer family (sticky), so random-start does not accumulate writers until no reviewer is eligible; first implementations and PRs with unknown provenance still use random-start, and a missing writer family falls back to random-start with a `runner_selection` diagnostic. Only runners that left worktree changes count as writers: a quota/auth/provider-unavailable hop with a verifiably clean worktree is excluded, while a runner that changed files before failing still counts and unknown worktree state stays conservative and counts.

Genuinely unknown external/legacy/untracked authorship follows the ordinary chain with a `provenance-unknown/independence-not-established` diagnostic. Pending/failed provenance for a known Jumi publication (including the publication race) and provenance-storage lookup failures fail closed with `Independent review unavailable: …` (failure status, no success verdict, no fabricated artifact). Mixed known authorship excludes all its families; independence is attested only for recorded Jumi writers and untracked contributions are disclosed, never inferred from PR prose, logins, trailers, or style. Recovery is the existing bounded retry/kick path: the refusal is terminal for that head, so push a new commit or kick the same commit after fixing groups/availability. The decision (head, policy, writers/groups, exclusions, chosen reviewer, refusal reason) is logged as `independent_review`; the post-hop runner stamp and trailer/status contract are unchanged. Both forges share this parent behavior.

### Runner distribution (opt-in random-start)

Unset preserves today's behavior: every fresh job starts at chain entry zero and hops forward in configured order, with synthesized `OPENCODE_MODEL` / `OPENCODE_FALLBACK_*` chains working as before.

To distribute fresh jobs across enabled subscription-backed runners instead of always starting at the first chain entry, add `selection` to `JUMI_RUNNERS_FILE` on reviewer and worker alike:

```json
{
  "runners": {
    "grok": { "type": "opencode", "model": "xai/grok-4.6" },
    "opus": { "type": "claude", "model": "claude-opus-5", "effort": "high" }
  },
  "chain": ["grok", "opus"],
  "selection": "random-start"
}
```

`selection` is `ordered` (default when absent) or `random-start`; any other value fails process start. For each fresh review, implement, follow-up, or conflict job that actually invokes a runner, the parent uniformly picks a start from that job's eligible enabled chain and rotates around it, preserving relative configured order and wrapping, except worker follow-up-style jobs on a PR with known Jumi provenance restart on the existing writer family instead of drawing a new start. First implementations and PRs with unknown provenance still draw uniformly; when the writer family is no longer in the worker chain the job falls back to an ordinary random-start draw with a `runner_selection` diagnostic. Availability hops can still reach entries that originally preceded the start, and a runner is never retried by cycling; a sticky availability hop that moves to a new family is an honest new writer but stays rare. Eligibility and independent-review exclusions apply before the draw; dormant catalog entries never become candidates. Continuations and same-session artifact-recovery calls stay on the already-selected runner, including after a hop. The selection mode, start, and effective order are logged as `runner_selection` with normal job correlation (sticky starts add `sticky=writer-family` plus writers/groups; clean-hop exclusions add a `provenance` narrowing diagnostic); stamps, metrics, errors, and provenance still name the runner that actually ran, and `chainIndex` is the position in the effective order. Single-runner chains behave as before. Random selection balances starting opportunities over time; it does not promise equal token spend or remaining quota. There is no quota-aware scheduler, round-robin coordinator, or parallel execution.

## Worker jobs

On Gitea (the default when `FORGE` is unset), work runs only when the issue or pull request is assigned to bot username `jumi` (`BOT_USERNAME`). Pull-request issues (`issue.pull_request` present) are ignored for first-run implement; assigning an already-open PR (any author, including Renovate) is follow-up on that PR's head ref instead, except a closer whose related issue is already open and assigned to the bot — that assign is skipped so the issue job owns the work.

First-run implement reads Gitea `GET …/issues/{n}/dependencies` before clone. Any unresolved blocker (open, or closed with an unmerged closer) comments `blocked on …` once and skips with no PR. Closing or reopening a blocker `GET`s `/blocks` and enqueues still-open issues assigned to the bot (fresh issue GET). That skip is not terminal. Do not parse issue prose for depends-on; unassign remains the kill switch.

When that graph is empty, first-run still injects a small candidate queue (open issues assigned to the bot in this repo and their open closers, plus open issues already cited in the task body, plus existing Gitea dependencies) into `JUMI_QUEUE.md`. The child may yield by writing `JUMI_BLOCKED.md` with `<!-- jumi-blocked-by: #N -->` using an id from that list, then stop (no commit, no push, no guess). Parent validates, `POST`s the Gitea dependency, comments `blocked on …` once, skips non-terminal with no PR, and deletes a pushed `jumi/issue-*` branch so the next first-run does not resume junk. Invalid / unknown / self id: one retry in the same lease (`blocked-by rejected, implement`). Second garbage → `stuck: blocked-by rejected`, no PR. Follow-up, conflict, and review must not yield. No detect/`plan` round; tickets with nothing to wait on do not pay an extra model call. Closed citations and invented numbers are not in the open list and must not stall forever. Cooperative stop only — do not parent-kill mid-run by polling the artifact.

When `DATABASE_URL` is set, webhooks only enqueue (202) into the shared Postgres envelope and the worker leases with `FOR UPDATE SKIP LOCKED` (distinct owner per process; never the same row twice). First-run keeps that job row after the PR opens. Unassign cancels queued and leased worker rows; the running worker aborts when its lease is gone. The router does not kill processes. Without `DATABASE_URL`, a PID/heartbeat file under `{HOME}/worker/jobs/{owner}/{repo}/{number}.json` claims the issue (live only while that PID is alive **and** the heartbeat is newer than two minutes). With Postgres, the lease is the identity.

The parent clones a bare cache and worktree from the default branch, writes `JUMI_TASK.md` (and `JUMI_QUEUE.md` when the candidate list is non-empty), and runs OpenCode with `.gitea/opencode-implement.json` (`skills` `/app/review-skills`, blanket `skill` allow, last-match `external_directory` so Read can load the pack). Implement / follow-up / conflict prompts tell the child to stay in this clone, start from the injected `JUMI_*.md` files (not `glob **/*` or this Gitea/forge), ignore `.jumi-tmp`, use ripgrep syntax, commit at each coherent logical step with a descriptive message (never a broken intermediate state, no `wip` / `fix lint` / `oops`), never push, and verify once at the end. After OpenCode, the **parent** reads `JUMI_PR.md` when present, commits leftovers, pushes once a `jumi/issue-{n}-{slug}` branch (never the default branch, never force-push), and opens a PR whose body always includes `Fixes #n`, wrapped in a `<!-- jumi-pr-body:start -->` / `<!-- jumi-pr-body:end -->` fence. That implement push, and the follow-up and conflict pushes, are refused when `HEAD` tracks `.jumi-tmp` or `.jumi-attachments`. Before a follow-up run the parent seeds that fenced text into `JUMI_PR.md`. After a follow-up that pushes, it PATCHes only the fenced region from the updated `JUMI_PR.md`, so the body describes the tip. It leaves unfenced bodies and missing/empty artifacts alone. First-run with a clean tree and no commits ahead of default is incomplete unless the child wrote a parent-owned `JUMI_SKIP.md` (regular file, non-empty; missing, empty, directory, or symlink does not count). Incomplete hops once from scratch to the next named runner; it does not stamp a terminal diary. A validated skip posts that artifact text (NUL-stripped, trimmed, capped like other parent-owned prose) plus the runner stamp, not a bare `no changes`. Only a validated skip or a branch with commits stops the chain. Follow-up and conflict may still no-op with a clean tree. A live Free/Zen quota abort still kills the child (no multi-hour `retry-after` sleep inside the lease). With no hop, the worker drops the worktree and requeues the same job until provider `retry-after` (else 1h, clamped 1h–24h, jittered). Other jobs on that instance do not spawn OpenCode until the same time. After 30h from the first hit, it posts `stuck: usage limit exceeded` and skips until unlabel/unassign. `Insufficient balance` and Go monthly-cap stay immediate stuck. Unlabel/unassign still cancels a job sitting in the wait. Review does not wait: it skips with a warning status.

A current-head `failure` trailer, or a `success` trailer with a suggestion count, enqueues re-implement. Missing trailer / stub / questions-only `success` is not a finding. Do not scrape 💡 markers out of review prose, and do not treat the Jumi review commit status as a trailer substitute. Follow-up does not open a second PR. It checks out the existing `pr.head.ref`, merges `origin/<default>` into that branch, writes `JUMI_TASK.md` plus `JUMI_FEEDBACK.md` (latest current-head Jumi review including success, leftover simplifications, and unanswered questions, plus writer text — not an empty `workflow_job`), and when the current head has a failed non-jumi check writes `JUMI_CI.md` (parent-injected log tail: last `##[error]` plus ~80 lines, 32–64 KiB, unpack noise dropped). A non-empty write-access comment or review on the PR always wakes follow-up; empty bodies do not. Phrase matching on comment text is not a skip. If that wake has neither review findings, writer text, nor a CI tail, follow-up is a no-op (no OpenCode, no commit). The worker child holds no forge credentials at all — no bot token, no `GIT_AUTH_TOKEN`, no `tea`, no Actions fetch; its git talks to a parent-held loopback proxy that injects the token only for the claimed repo's git paths (see Security Model). Timeout 60 minutes. Stickies go on the PR. Empty/missing/incomplete/stub artifacts do not count toward stuck. CI follow-up is one OpenCode per `{head SHA, failed check name}` unless the log hash changes. Known infra flakes (GitHub `140.82` checkout/cache timeout or unreachable, Helm remote-schema timeout/429, GARM `Invalid cross-device link` on dpkg, tofu S3 state lock, Docker Hub `toomanyrequests`) comment for a human and do not burn an OpenCode round. Unknown red → OpenCode. If the default-branch merge is stuck, follow-up does not run the feedback OpenCode that round.

Conflict jobs stay on the existing branch: `git merge --no-ff origin/<default>` (never rebase, never force-push, never a second PR). A clean merge of default is a no-op. Git (unmerged paths / conflict markers after merging default into the PR head) is the gate, not Gitea `mergeable`. OpenCode runs only if those remain after the merge and Chart.lock regen (`helm dependency update`). The conflict prompt tells the child to resolve only the paths listed in `JUMI_CONFLICT.md` unless one adjacent file is required. Success comments `Pushed merge of {default}.`; unresolved markers comment `stuck: cannot resolve conflicts` without unassigning.

A PR labeled `ignore-conflicts` (`IGNORE_CONFLICTS_LABEL`) is left to its author while Jumi has not committed to the branch: no `conflict` job runs, follow-up never merges the default branch, and a conflicted PR with nothing else to do skips as `conflicted, left to author (label \`ignore-conflicts\`)` without starting the engine. Red CI and review findings are still handled without that merge. After Jumi's first push the label no longer applies. Put it on Renovate PRs: Renovate rebases for free, and once a non-Renovate commit lands Renovate stops updating the branch.

If Jumi is assigned an issue that already has an open jumi closer, that first-run job collects existing human comments, live non-jumi commit statuses, and mergeable, and runs follow-up or conflict instead of skipping. A human-only closing PR still skips first-run and does not conflict-follow unless that PR itself is assigned to jumi. After the parent pushes, it GETs mergeable; `false` enqueues conflict on the same issue; omitted/`null` mergeable does not. Assigned foreign PRs (open, not draft/`WIP:`, not a fork; author and branch name do not matter) use the PR number as the job identity and never open a second PR or `jumi/issue-*` branch. On GitHub the same follow-up starts when a human adds label `jumi` (Apps cannot be assigned); later red CI, default-branch conflicts, and write-access comments wake that PR, and removing `jumi` cancels. They do not skip first-run on other assigned issues in the same repo. When that PR is merged, closed, or unassigned and no assigned foreign PR remains, the mailbox enqueues still-assigned issues (no human unassign/reassign). Green tip is a no-op. A new head SHA cancels queued predecessor follow-up/conflict for that PR. Only one implement/follow-up/conflict job is leased per issue at a time (they share a worktree). If HEAD moved under an in-flight follow-up, that job continues on the current head and still addresses the original review-failure sticky; a rejected push inserts a follow-up for the new head instead of dropping the round. Never amend someone else's commit, force-push, rebase, or merge the PR.

The worker image is built with `--target worker` and `CMD ["bun", "run", "src/worker_server.ts"]`. It copies a pinned Temurin 21 JDK (`JAVA_HOME=/opt/java/openjdk`). The sanitized OpenCode child gets `JAVA_HOME`, `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir` on the workspace under `/work` (HotSpot ignores `TMPDIR`; pod `/tmp` is a 256Mi memory emptyDir), `GRADLE_USER_HOME` on `/work` (not the HOME PVC), and `GRADLE_OPTS` with the daemon disabled. The reviewer image has no JVM.

## Webhook Setup

Create a Gitea webhook that can reach the repos you want driven. For one org, use an organization webhook. For the whole instance, use a **system webhook** (Site Administration → Webhooks):

| Setting | Value |
|---------|-------|
| Target URL | `https://<your-ingress>/webhooks/gitea` |
| HTTP Method | `POST` |
| POST Content Type | `application/json` |
| Secret | Same value as `GITEA_WEBHOOK_SECRET` |
| Trigger On | Pull request, Issues, Issue Assign, comments, push, workflow_job, status (see below) |
| Active | Checked |

Gitea 1.27 delivers assignment as a grouped issue event, not a GitHub-style top-level `assignee` field:

- Headers: `X-Gitea-Event: issues` and `X-Gitea-Event-Type: issue_assign` (also `X-GitHub-Event` / `X-GitHub-Event-Type`).
- Body: `IssuePayload` with `action`, `number`, `issue`, `repository`, `sender`. `issue.assignee` / `issue.assignees` are `User` objects with `login` (and compat `username`).
- The org/system hook must enable **both** `Issues` and `Issue Assign` (separate Gitea checkboxes). `Issues` alone will not fire on assign.

Event map (router mailbox):

- `issues` / `issue_assign` with `assigned` / `opened` / `reopened` (bot assigned) → enqueue first-run implement
- `unassigned` when the bot is no longer an assignee → cancel queued and leased worker jobs; heartbeat fail-closes and aborts its child (do not `kill` an unrelated process); comment `stopped`; delete claim/follow-up/conflict state files. Bot still among multiple assignees → no cancel
- `issue_comment` / `pull_request_comment` `created` on an open jumi closing PR or an assigned foreign PR (human sender, non-empty body, not a jumi sticky) → enqueue follow-up
- `pull_request_rejected` on an open jumi closing PR or assigned foreign PR → enqueue follow-up
- `push` on `refs/heads/<repository.default_branch>` → mechanical HTTP filter (list open managed jumi closers and assigned foreign PRs; no git, no OpenCode). Enqueue `mode: "conflict"`. Tags, deletes, and non-default branches skip
- `workflow_job` → wake only (202 immediately). Malformed / not-ours → 202 skip, never 400. Re-enqueues `review` for matching open non-WIP PRs (deduped per head SHA). Re-reads **live** commit statuses for `pr.head.sha` (Gitea) and GitHub Actions check-runs, ignores `jumi/opencode-review`, skips if any other context is `pending`, and on a non-jumi `failure` injects `JUMI_CI.md` then follow-up
- `status` (Gitea commit status; GitHub `status` and `check_run`) → same review wake when that sibling check finishes. Pending does not wake. `jumi/opencode-review` does not wake (it also fires for Jumi's own status). Does not enqueue follow-up
- `pull_request` / `pull_request_assign` `assigned` (bot still assigned) → enqueue follow-up keyed by the PR number, except when the PR closes a same-repo issue that is open and assigned to the bot: skip (202), live GET, fail closed on GET failure; the issue job owns the work. `unassigned` when the bot is no longer an assignee → cancel that PR. If that PR was an assigned foreign PR and no assigned foreign PR remains, enqueue first-run for other open issues still assigned to the bot (fresh GET). `closed` / `merged` of an assigned (or merged) foreign PR with no remaining assigned foreign PR does the same, and also `GET`s `/blocks` on the PR and on issues it closes. Unassign of the waiting issue remains the kill switch. Other `pull_request` actions: reviewer owns opened/synchronize; the rest `202` skip, never 400
- `ping` → `200 {"ok":true}`
- other events → `202` skip

Skip follow-up when the sender is the bot, the comment was `edited`/`deleted`, the body is empty or contains `<!-- jumi-worker:` / `<!-- jumi-check:`, the PR is a fork/draft/`WIP:`, the closing issue is not assigned to the bot, or a foreign PR is not assigned to the bot.

The service also exposes:

```text
GET /healthz
GET /metrics
```

`GET /healthz` is `200 {"ok":true}`. `GET /metrics` is Prometheus text. The operator board is a different port; see [Operator board](#operator-board). Scrape the **router** for totals: it exports Postgres-backed `jumi_review_jobs` (state and kind), oldest queued age by kind, `jumi_webhooks_total`, and the durable run/job series below. Engine/worker pods export exporter-health gauges only (`ai_token_exporter_*`, `ai_trace_exporter_errors`, `ai_quota_db_schema_errors`); they must not export the same counter names or totals double for anyone scraping every pod.

Durable usage lives in the ledger table `jumi_run_usage`, one row per runner spawn (runner, model, token counts, exit class, start time, end time). One job row can own many run rows because a job can hop runners. Each spawn writes its row before the job completes; a failed metric write never fails the job. A pod that dies outright writes no usage for the run it was in — those tokens are lost and the job is reclaimed. A lease-lost (aborted) run whose pod stays alive still writes its token/session cells with exit class `incomplete` and the measured wall-clock duration, because every harness records usage before its abort check; only a run with no token/session delta writes nothing. `jumi_jobs_completed_total` is derived from terminal `review_jobs` rows, so with no engine or worker running the router's `/metrics` still reports finished-job totals, and they survive a router restart.

Label notes: `agent_instance` is recorded at run time, so `jumi` and `jumi-worker` rows coexist; `profile` is always `default`; the `jumi_job_duration_seconds` `result` label carries the exit class (historical naming kept for dashboard compatibility).

After each OpenCode run Jumi reads the per-review session DB (even on non-zero exit), adds the token sums to the in-process counters and the ledger row, then deletes the workspace. In-process counters still reset on process restart; the ledger series do not. This is not a durable OpenCode DB on `HOME`.

When `PHOENIX_OTLP_ENDPOINT` is set, the same post-run window POSTs an OpenInference trace (OTLP HTTP protobuf) to in-cluster Phoenix: one `AGENT` root per job (`input.value` = this job's initial user prompt), `TOOL` children with full tool input, and `LLM` children with model/provider/token counts and this-turn `output.value` only (no conversation reprint, no `llm.input_messages`). Encoded body is capped at 4 MiB. Unset skips export. Timeout (15s), over-cap after shrinking, or an unreadable DB increments `ai_trace_exporter_errors` and does not fail the job. Phoenix **project** is `AGENT_INSTANCE`.

A `type: claude` child leaves no session DB for that exporter, so its spans come from the child instead: the same `PHOENIX_OTLP_ENDPOINT` makes the parent pass an image-local Claude Code hook plugin (`claude-plugins/claude-code-tracing`, vendored from [Arize-ai/arize-claude-code-plugin](https://github.com/Arize-ai/arize-claude-code-plugin); see its `UPSTREAM.md`) with `--plugin-dir`. Nothing is installed at run time. The plugin POSTs OpenInference spans to `<base>/v1/projects/<AGENT_INSTANCE>/spans` — the **same project** as that factory's OpenCode traces, not a `claude-code` harness dump. `LLM` turn spans carry model, token counts and this turn's `output.value`; `TOOL` spans carry tool name, arguments and result. Prompt text is off (`ARIZE_LOG_PROMPTS=false`), since the parent injects task, feedback and CI prose into it. Every span carries `job_id` / `session.id` = the Jumi job id plus `kind` / `owner` / `repo` / `sha` / `agent_instance`, so one Phoenix job lookup finds Claude and OpenCode runs alike. Fail-open throughout: no endpoint, a public Phoenix hostname, a missing plugin directory, or a Phoenix that is down or slow (2s per POST, then skip after 3 failures) leaves the child untraced and the job unaffected.

## Operator board

The router (not the engine, not the worker) serves an operator board on port `3001`. The webhook listener never serves these paths. Reach it through the auth proxy in front of that port. A direct-to-pod route lets a caller self-assert identity headers. The webhook secret is not board auth.

- `GET /` and `GET /board` are the page. `GET /api/board` is the same data as JSON.
- `POST /api/board/kick` (alias `POST /board/kick`) is a typed retry. It can requeue a failed or skipped review of the same commit, close-then-reopen a foreign or reuse pull without a push, queue an implement again after a no-changes latch, clear a stuck latch and queue follow-up on the open closer, or clear a kickable sitting row (this one queues no job). It does not push, does not create an empty commit, and does not rerun CI.

In-progress rows come from the job ledger. Sitting rows come from persisted refusals. The router stays a single replica.

Grok sign-in for one homelab engine or worker ordinal and Codex sign-in on the always-on control role live on the same page, one control per ordinal per provider. Each engine/worker pod runs an ordinal-local Grok listener on constant port `3010` (engine and worker only; the router never binds it). Control runs the same constant port for Codex only (`control:3010`, one replica, retained volume, no public ingress) with the same `HOME` the review/implement child and the Codex runner child use, so `opencode auth login xai --method "SuperGrok Subscription" --standalone` signs that pod in and Jumi copies the grant into its retained Grok auth file before reporting success, and `codex login --device-auth` writes that pod's retained Codex (`$HOME/.codex`) auth file as the container uid. The board polls it through `GET /api/board/device-login/status?ordinal=<host>&role=<engine|worker>&provider=<xai|codex>`, starts it through `POST /api/board/device-login/start`, and cancels through `POST /api/board/device-login/cancel` (never the kick route). The page shows the verification link (tappable), the user code (selectable), the expiry, and the state (`waiting`, `signed-in`, `expired`, `denied`, or `error`); it never shows a token. One in-flight login per ordinal: a second start while waiting returns the same code. A leased ordinal refuses. The Grok control appears only when that ordinal's chain includes an OpenCode xAI runner; the Codex control lives on control (always on, independent of engine/worker chains) and long-running per-ordinal Codex logins keep working until they move; the isolated GitHub factory has no control. The chart change that allows router->ordinal `:3010` lands separately; a refused connection until then is fine.

On the `FORGE=github` router the same listener has no page and no edge identity. `GET /`, `GET /board`, and `GET /api/board` all return the JSON, and those paths plus the kick paths authenticate with the `BOARD_PEER_TOKEN` bearer. With the token unset every board and kick request is `401`.

On the homelab forge (`FORGE` unset, empty, or `gitea`) the page can include the other factory. Set `BOARD_PEER_URL` on the homelab router to that factory's board listener, and set `BOARD_PEER_TOKEN` to the same value on both routers. The hop is one-way and server-side. Unset URL disables it. A token unset on either router means that forge is unavailable. The peer listener is internal-only (no public ingress) and trusts the bearer, not a forwarded identity header. The GitHub factory does not call back.

## Image

This repository’s image workflows publish `jumi-reviewer` and `jumi-worker` with tags `latest` and `vX.Y.Z`. Point GitOps at the registry **you** push to. Reviewer and worker share one immutable semver tag per merge to `main`. `deploy/contract.md` is the bump source of truth (unchanged → patch, new optional GitOps → minor, required GitOps change or `BREAKING` → major). The first release is `v1.0.0`. A GitHub Release on that tag has `## GitOps` / `## Breaking` / `## Changes`. Images carry `org.opencontainers.image.source`, `version` (`vX.Y.Z`), and `revision` (full SHA).

The reviewer (`.github/workflows/jumi-reviewer-image.yml`) publishes to GHCR with `GITHUB_TOKEN` (`packages: write`); it needs no extra secrets.

The worker (`.github/workflows/jumi-worker-image.yml`) publishes to GHCR with `GITHUB_TOKEN` (`packages: write`); it needs no extra secrets.

Required repository variables:

| Name | Description |
|------|-------------|
| `CONTAINER_REGISTRY_USER` | Only needed for manual `bash .gitea/scripts/build-*.sh` pushes |

Pull requests run the same lint/typecheck/test gate, run the queue/lease suite against a Postgres service container, and build the image without publishing it.

Claude's production flags are verified against the **installed `claude` binary**, not against the constants that built them: every image verification path — the `pull_request` reviewer and worker builds in `opencode-checks.yml`, both publish workflows, and the Gitea buildah scripts — runs `scripts/opencode/src/claude_flag_probe.ts`. It spawns the exact argv `claudeArgv()` emits (`-p --setting-sources user,project --permission-mode dontAsk --allowedTools … --disallowedTools … --output-format stream-json --verbose --model … --effort … --plugin-dir …`) with `ANTHROPIC_BASE_URL` pointed at a throwaway loopback endpoint, so nothing is billed and no request leaves the runner — `CLAUDE_CODE_OAUTH_TOKEN` is deliberately kept out of the child env. The run has to exit 0, report back the pinned `permission-mode` and the requested model in its `init` event, name every `--allowedTools` entry as a tool it has, and still produce the stream-json text and token usage the parent accounts from. Because `effort` is operator config rather than a constant, the run is repeated at *every* level a runners file may set (`CLAUDE_EFFORT_LEVELS` in `src/runners.ts`: `low`, `medium`, `high`, `xhigh`, `max`) and each must come back with clean stderr, so a runner on `xhigh` or `max` is covered too. That set is enforced both ways: the probe proves the binary still knows every level, and `JUMI_RUNNERS_FILE` refuses a `type: claude` runner whose `effort` is outside it, so a typo cannot silently downgrade every run of that runner where no check can see it. The same run carries a marker in the checkout's `AGENTS.md`, which must arrive in a model request, plus a fleet skill in `~/.claude/skills` and a checkout `.claude/skills` skill, which must both be in the `init` event's skill list. The stub then has the model load the checkout skill through the `Skill` tool. Then each flag value the binary can refuse (`--permission-mode`, `--setting-sources`, `--output-format`, `--effort`) is re-run as nonsense and must draw an objection, so a release that shrugs at a bad value cannot make the positive case vacuous. `--effort` counts as refused when it merely *warns* and falls back to the default: in production that is a silent downgrade of the whole run, and that negative control additionally has to be caught by the same anchored stderr matcher the positive run relies on, so the detector cannot quietly stop matching. Changing a pinned value to nonsense fails both the unit gate and the image job; `claude --version` alone never did.

OpenCode's quota handling reads the child's private session DB, and those reads treat every SQLite error as "no hit", because a poll can land on a locked or half-created DB. So the `pull_request` reviewer build, the reviewer publish workflow, and the Gitea reviewer build run `scripts/opencode/src/quota_probe.ts`, which drives the installed `opencode` at a loopback provider that answers with a quota 429 and requires the shipped read to see the sleep, its `retry-after`, and the sleep clearing when the child is stopped. At run time, each OpenCode run ends with a schema check that logs `event=opencode_quota_schema` and counts `ai_quota_db_schema_errors`.

## Review diagnostics

During each review the service emits single-line structured logs prefixed with `[diag]`:

- `event=review_files` — PR file/patch sizes after limits
- `event=review_delta` — whether this is a later review, the previous reviewed SHA, finding/commit/file counts
- `event=review_prompt` — final prompt byte size
- `event=opencode_start` — model, prompt size, parent RSS, cgroup, **per-review** OpenCode DB path/size
- `event=opencode_sample` — every ~5s while OpenCode runs: **child PID RSS**, peaks, cgroup
- `event=opencode_end` — exit code, duration, child/parent peaks, stdout/stderr byte totals, `quota` / `quota_class` / `retry_after_ms` when the child hit usage limits
- `event=opencode_quota_schema` — the session DB no longer has what the quota reads need (also counted in `ai_quota_db_schema_errors`), so a sleeping child runs to the job timeout instead of being aborted
- `event=opencode_quota_wait` — delayed Free/Zen requeue: count, next time, budget remaining
- Successful runs also emit `[opencode stderr]` with the **last** 64 KiB of OpenCode stderr (tool traces live at the end). `opencode run` is not given `--print-logs`
- `event=post_opencode` / `post_fetch_pr` / `post_find_sticky` / `post_sticky_result` / `post_comment_*` / `post_review_done` — **parent** RSS after OpenCode (sticky comment path)
- `event=workspace_remove_start` / `workspace_remove_end` — parent RSS around workspace cleanup

OpenCode session SQLite is forced to a temp path under the review workspace (`OPENCODE_DB=…/opencode-session.db`) so it does not accumulate on `HOME` across runs.

These are intentionally process-level so a cgroup OOM still leaves a trail of samples before death. Grep logs for `[diag]`.

## OpenCode Auth

Mount a volume at `/data` and seed OpenCode auth at:

```text
/data/.local/share/opencode/auth.json
```

Use an existing `auth.json`, or run `opencode auth login` with `HOME=/data` during setup. OpenCode 2 stores that login in `opencode.db` next to the file, and Jumi copies it into `auth.json` on the next start, so `auth.json` stays the one durable credential store. An entry is replaced only when the database row is newer than the file. The service relies on the persisted OAuth refresh/access state, not provider API keys in env vars.

On startup, unless `OPENCODE_WELLKNOWN_URL=disabled`, Jumi preserves the existing auth file, adds a well-known entry when it is missing, and rewrites that entry when `OPENCODE_WELLKNOWN_KEY` / `OPENCODE_WELLKNOWN_TOKEN` differ from disk (key = `OPENCODE_WELLKNOWN_URL`):

```json
{
  "https://<your-well-known-origin>": {
    "type": "wellknown",
    "key": "OPENCODE_WELLKNOWN_TOKEN",
    "token": "unused"
  }
}
```

That makes OpenCode load shared defaults from `<origin>/.well-known/opencode` before this repository's local review policy, without requiring deployment-specific init-container wiring. `disabled` skips that seed (and removes a leftover `disabled` well-known entry) so OpenCode does not fetch any `.well-known/opencode` URL.

### Rotating the OpenCode API key without a restart

Set `OPENCODE_API_KEY_FILE` to a file holding the key (a Kubernetes Secret mounted as a volume). The parent reads that file fresh on every OpenCode spawn, so an operator rotation applies to the next child with no pod restart. When the file is set and readable with non-empty contents it wins over `OPENCODE_API_KEY`; otherwise the env var is the fallback and existing deploys keep working unchanged. A missing, unreadable, or empty file with no env fallback fails the run as a provider-auth failure (hop and no-kick rules apply). The file contents are only copied into the child env: never logged, never written into the workdir, never posted to statuses or the board, and never added to the forge-secret scrub file. Mount the Secret as files, not `subPath`, so kubelet updates it in place (about a minute).

### The xAI refresh grant belongs to the long-lived process

A SuperGrok subscription is stored as an `xai` oauth entry (`access`, `refresh`, `expires`). Upstream OpenCode refreshes it from inside the child: it POSTs the refresh token, keeps the rotated pair in memory, and persists it best-effort with no flush on exit. A review that is killed — timeout, quota abort, unassign, pod restart — therefore rotates the grant and takes the new refresh token with it, and the next process reads one xAI no longer accepts (`Invalid or unknown refresh token`). Grok is then dead until a human runs `/connect`.

So the parent owns the grant instead (`src/xai_auth.ts`), and the child never holds it:

- **Refresh at job start, never in the background.** Before each OpenCode spawn, Jumi compares the access token's remaining life against that job's budget: the job's own timeout, plus the ~2 minutes OpenCode would refresh inside, plus a minute of clock margin. Remaining life is the **earlier** of the access token's own `exp` and the stored `expires`; neither present means refresh. A fresh 6-hour token covers a 4-hour worker job; one with three hours left does not.
- **At most one POST per attempt.** A rejected grant is latched for the process, so no later job re-presents a refresh token xAI already refused. If the POST succeeds but the file write fails, the rotated pair stays in memory and the next attempt retries **the write** — never a second POST.
- **Durable before the child starts.** The new pair is written to a sibling, fsynced, renamed, and read back; only a matching re-read lets the spawn proceed. On the homelab the auth path is a symlink onto a Retain volume, so the write follows the symlink onto the Retain file and leaves the link in place — a human login keeps reaching the same file. The refresh token is never removed from that file while a child runs.
- **The child cannot refresh.** Its isolated `auth.json` gets `{"type": "api", "key": "<access token>"}` for `xai`, which OpenCode 2 imports into the per-run database: OpenCode sends that as a bearer and never enters the refresh path. The child and the server are the same user, so this is not about hiding the parent file — the grant is safe because what the child holds cannot rotate it. Every image verification path runs `scripts/opencode/src/xai_child_auth_probe.ts` against the **installed** binary, so an `OPENCODE_VERSION` bump that hands refreshing back to the child fails the image job.
- **Fail closed.** No refresh token, a refused grant, a write that will not land, or a verified refresh that still does not cover the job: the job fails as a provider auth death rather than starting a review that will 401 with nothing to recover with. An auth directory that cannot take a new file is found before the POST: Jumi opens, writes, fsyncs and removes a throwaway sibling first, so that case fails closed with the grant on the file still live and a later job may try again. A spawn on another provider never touches the grant: it still gets a refresh-less child credential built from the file, and a dead grant cannot fail it.
- **On startup**, a sibling left by a completed write whose rename did not land is adopted when it holds a newer credential, before anything is refreshed.

Rotation does not revoke an access token already issued, so no lock is held for the length of a review: a later job may refresh while an earlier child is still working. The one accepted loss is a kill after xAI has answered and before the new file is durable (an unwritable directory is not that case — it is proven before the POST); there is no second refresher to heal that.

The child shape is `XAI_CHILD_AUTH_SHAPE` in `src/xai_auth.ts`, not operator env: the probe is what forces the decision, so an OpenCode release that stops accepting `api` fails the image build and the constant moves in the same change. The documented fallback is `oauth` — access and expiry with no refresh field. Measured against OpenCode 1.15.5 that shape is rejected before any request is made ("xAI API key is missing"), so it fails a review closed rather than presenting the parent's refresh token, but it is not the shape to reach for first.

The service runs OpenCode with a sanitized environment. Gitea tokens and webhook secrets are not passed to the OpenCode child process.
The container runtime process runs as non-root UID/GID `10001:10001`.

## Security Model

The service rejects requests that fail any of these checks:

| Check | Enforcement |
|-------|-------------|
| Method/path | Only `POST /webhooks/gitea` is accepted |
| Content type | Must include `application/json` |
| Signature | `X-Gitea-Signature` must match the raw body HMAC-SHA256 |
| Event | Router: org-hook events (`pull_request` review + assign/comment/CI/push worker kinds). Ping `200`. Unknown `202`-skip. Monolith: `pull_request` review actions. Engine: webhook disabled |
| Origin | Repository URLs must match `GITEA_URL` origin |
| Scope | Repository owner must be in `GITEA_ALLOWED_ORGS`, or that list must include `*` |
| Repo allowlist | `GITEA_ALLOWED_REPOS` is enforced when set |

OpenCode permissions live in `.gitea/opencode-review.json`. Edit is allowed so the reviewer can write `JUMI_REVIEW.md`. External directory access is last-match: star deny, then allow the baked `/app/review-skills` tree and the fleet skill dirs (`~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skill(s)`) so Read can load a skill's references. Every other external path stays denied. Subagents, todos, and questions stay denied. `websearch` names `exa` as its provider, because OpenCode 2 otherwise asks a person to pick one, and a run nobody can answer exits 1 after finishing, which discards the review. Skills are a blanket allow; the baked pack (Helm/K8s/`k3s/` first-apply pitfalls plus the shared `review-proof`/`worker-proof` checks) still loads from `/app/review-skills` via `skills` in that JSON — not `OPENCODE_CONFIG_DIR`, which would npm-install into a config directory. Documentation lookup is allowed through OpenCode web fetch/search, except the configured forge host and GitHub search URLs.

### Reviewer skills

Every reviewer runner may load any skill it can discover: the image pack, fleet or user skills under the child's `HOME`, and skills in the checkout, including ones the pull request author wrote. Nothing is pasted into the prompt for this; the model sees each skill's description and loads one if it chooses. The review rubric is unchanged. The checkout's own setup loads on every runner:

| Runner | Image | Fleet / user | Checkout | Hooks |
| --- | --- | --- | --- | --- |
| OpenCode | `skills` `/app/review-skills` (`review-proof` for review, `worker-proof` for implement) | `~/.claude/skills`, `~/.agents/skills`, and `skills` `~/.config/opencode/skill(s)` | `.claude/skills`, `.agents/skills`, and `.opencode/skills`, by OpenCode's own scan | The checkout's `opencode.json`, `.opencode` plugins, agents, and root `AGENTS.md` load |
| Claude | per-spawn `--plugin-dir` `shared:review-proof` for review, `shared:worker-proof` for implement | `~/.claude/skills` (user setting source) | `.claude/skills` (project setting source) | The project source loads the checkout's `.claude/settings.json`, so its hooks, env, and permission rules apply, and a skill's frontmatter hooks and inline shell run when it loads |
| Antigravity | per-spawn `.agents/skills/review-proof` for review, `.agents/skills/worker-proof` for implement, cleaned up before return | the CLI's global customization root under `HOME` | `skills/` of each `.agents` / `.agent` / `_agents` / `_agent` root | The rest of each root loads too: `hooks.json`, plugins, rules, workflows, and MCP config |
| Codex | per-spawn `.agents/skills/review-proof` for review, `.agents/skills/worker-proof` for implement, cleaned up before return | `~/.agents/skills` user skills, and `~/.codex/config.toml` | `.agents/skills` repo skills from the workdir | The checkout's `.codex` config, hooks, rules, and MCP servers load, with `--dangerously-bypass-hook-trust` because no one is there to approve a hook. Jumi's `-c` overrides outrank them, so web search and subagents stay off |


Claude is the only runner where a skill itself can carry a command. Checked by loading a skill with frontmatter `hooks:` and inline shell against a loopback model: OpenCode 2 returns the body verbatim from its `skill` tool and Antigravity 1.2.7 reads `SKILL.md` as a plain file, and neither ran anything.

The forge webfetch deny is not reviewer-only, and it is not prompt prose. `src/forge_webfetch.ts` is the single source of truth for the denied host, and every child that holds a write-capable git token gets it from the binary: OpenCode spawns (review, implement, follow-up, conflict) always get the rules in `OPENCODE_CONFIG_CONTENT`, merged last after `extraEnv` so neither a job nor the parent env can loosen it, plus a `policies` deny in a per-spawn global config, because a repository's agents outrank `permissions` from any source and its policies outrank inline ones, and Claude spawns get `--disallowedTools WebFetch(domain:<forge host>),WebFetch(domain:*.<forge host>)` — both rules, because Claude matches `domain:` against the hostname and `*.host` does not cover the apex. The denied host is **not** compiled in: it is the spawn's own `GIT_AUTH_HOST`, the host the git credential helper authenticates against, so the GitHub factory denies `github.com` / `api.github.com` (issues, PRs, Actions) instead of only the homelab Gitea host. Spawns that carry no `GIT_AUTH_HOST` (the reviewer) fall back to the compiled default. `WebFetch` stays on the Claude allow-list for public docs since a deny at any level beats every allow, the repository's own settings included. `src/webfetch_probe.ts`, `src/agy_webfetch_probe.ts`, and `src/claude_flag_probe.ts` run those denies against a repository that tries to lift them. Codex has no fetch tool, and `src/codex_probe.ts` proves its `web_search` override outranks a repository's `.codex/config.toml`. Worker git containment is by mechanism, not prompt: the child env carries no `GIT_AUTH_TOKEN` (and no equivalent secret) and no credential file in the workdir or `$HOME`; the parent holds the token in process memory and serves a loopback proxy (`src/child_git_proxy.ts`) for that one spawn. The child's git is rewritten (`url.<proxy>.insteadOf`) to that proxy, which injects `Authorization` only for the claimed `owner/repo` git smart-HTTP paths and returns 404 for `/api/v1/...`, `/attachments/...`, and other repos. A direct forge request built from anything the child can read has no credentials, so the forge itself answers 401/403/404. Prompt prose ("do not webfetch the forge, do not call the API") is a hint; the env without a token plus the binary webfetch denies above are the control. Bash stays allow-by-default, so the proxy allowlist — not a shell denylist — is what keeps `curl` from authenticating. Antigravity's knob is `permissions.deny`: every `agy` spawn merges `read_url(<forge host>)` into `$HOME/.gemini/antigravity-cli/settings.json` before exec, which the binary enforces even under `--dangerously-skip-permissions`. That deny is proven against the **installed `agy` binary** by `scripts/opencode/src/agy_webfetch_probe.ts` on every image verification path (reviewer and worker): a loopback Gemini endpoint emits `read_url_content`, an unrelated host is a real HTTP hit, and the forge host is refused. That deny is proven against the **installed OpenCode binary**, not a copy of its wildcard matcher: every reviewer image verification step — the `pull_request` build in `opencode-checks.yml`, the `main` publish workflow, and the Gitea buildah script — runs `scripts/opencode/src/webfetch_probe.ts`, which points `opencode run` at a throwaway loopback provider that emits one `webfetch` tool call per row of a small URL table, with `OPENCODE_CONFIG_CONTENT` carrying the exact rules production uses. The probe serves the fetch targets itself, so an allowed URL shows up as a real HTTP hit and a denied one as no hit at all; dropping the forge-host deny from the rules fails the image job. The same probe plants an `AGENTS.md` and fails the image job if its text does not reach the model. Bash is **allow-by-default** (no command allowlist / no dump denylist). The image `entrypoint.sh` copies `GITEA_BOT_TOKEN` / webhook secrets to a 0600 tmpfs file and exports that path as `JUMI_SECRETS_FILE` (entrypoint-owned, not a GitOps setting), unsets the secrets, and `exec`s bun so `/proc/<pid>/environ` is the cleaned execve image (`unsetenv` does **not** rewrite that file). `loadConfig` then reads the file and unlinks it; secrets stay in process memory only. The OpenCode child gets `XDG_CONFIG_HOME` under the ephemeral workspace so a review cannot persist a loosened `opencode.json` on the `/data` PVC. `/app` stays root-owned; only `/data` and `/work` are writable by uid 10001. Provider credentials stay in OpenCode `auth.json` on `/data` because the child needs them. Reviewer `reasoningEffort` is pinned `high` for grok-4.5, grok-4.6, and gpt-5.5. The image ships `git`, `ripgrep`, `jq`, `file`, `python3`, and pinned `helm` (no `kubectl`).

## Local Development

Install dependencies and run the local CI checks:

```bash
cd scripts/opencode
bun install --frozen-lockfile
bun run ci
```

`bun run ci` needs no database: `test/review_jobs_pg.test.ts` skips itself unless `JUMI_TEST_DATABASE_URL` is set. That suite runs the real `PgReviewJobStore` — worker leases racing on one issue, reclaim at the attempt cap, in-flight enqueue dedupe, and migrate-then-migrate-again — against a real server, because those invariants are partial unique indexes and `FOR UPDATE SKIP LOCKED`, not TypeScript. CI runs it in the `postgres-queue` job; to run it locally:

```bash
docker run --rm -d --name jumi-queue-pg -p 5432:5432 \
  -e POSTGRES_USER=jumi -e POSTGRES_PASSWORD=jumi -e POSTGRES_DB=jumi_queue_test \
  postgres:18-alpine
JUMI_TEST_DATABASE_URL=postgres://jumi:jumi@127.0.0.1:5432/jumi_queue_test bun run test:pg
```

The suite owns its schema: it drops and re-migrates `review_jobs` / `issue_skip_latches`, so point it at a throwaway database, never a live ledger.

Run the service locally:

```bash
GITEA_URL=https://gitea.example \
GITEA_BOT_TOKEN=... \
GITEA_WEBHOOK_SECRET=... \
GITEA_ALLOWED_ORGS=your-org \
OPENCODE_WELLKNOWN_URL=https://opencode.example \
OPENCODE_CONFIG=$PWD/../../.gitea/opencode-review.json \
HOME=/path/to/persisted/opencode-home \
WORKDIR=/tmp/jumi-reviewer \
bun run server
```

## Structure

```text
AGENTS.md                    # Agent facts for this checkout (keep docs current)
README.md                    # Human overview
REVIEW.md                    # This repository's review rules
.github/
  workflows/
    jumi-reviewer-image.yml  # Reviewer image build/push to GHCR
    jumi-worker-image.yml    # Worker image build/push to GHCR
    opencode-checks.yml      # PR lint/typecheck/test and image build checks
    jumi-release.yml         # Annotated vX.Y.Z git tag + GitHub Release
.gitea/
  opencode-review.json       # Hardened review-only OpenCode config
  opencode-implement.json    # Implement config (edit allow; skills /app/review-skills and checkout roots; blanket skill allow)
  tool-versions.env          # Pinned OpenCode/Claude/Bun/Helm/Temurin versions (agy is pinned with SHA-512 in the Dockerfile)
deploy/
  contract.md                # GitOps runtime contract (semver source of truth)
review-skills/
  gitops-apply-review/       # Baked reviewer skill (copied to /app/review-skills)
  gitea-pull-review/         # Baked worker skill: Gitea 1.27 pull-review API
  review-proof/              # Shared reviewer skill: prove or drop a finding (copied to /app/review-skills)
  worker-proof/              # Shared worker skill: observable checks and regression (copied to /app/review-skills)
scripts/
  opencode/
    src/                     # Bun/TypeScript control plane (router, engine, worker)
Dockerfile
renovate.json
```
