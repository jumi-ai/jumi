# Deploy contract

GitOps runtime contract for `jumi-reviewer`, `jumi-worker`, `control` (reviewer image, `JUMI_ROLE=control`), and one-shot Jobs. Not the application API.

This file is the semver source of truth. Unchanged vs the last `vX.Y.Z` tag → patch. New optional GitOps (env/port/volume) → minor. Required GitOps change (new or removed required or gitops env, required constraint, UID, probe, command, port, or image target), or a `BREAKING` heading/marker → major. Reviewer, worker, control, and one-shot Jobs share one version. Adding the one-shot `bun run src/job.ts` command, its required `JUMI_JOB_ID` row id, and its xAI OAuth runner constraint is a major bump; refusing Antigravity (`type: agy`) runners in one-shot Jobs is a major bump.

Env headings: `required env` fails process start when unset. `gitops env` must be set by GitOps/chart, but process start tolerates unset (local/dev only, or a `FORGE` that does not use the key). `optional env` has a default. CI checks these headings against the loaders (`requireEnv` / `requirePem` → required env; the same call reached only under `FORGE=github` → gitops env; any other read → gitops or optional env). The scanner resolves constant env names and constant maps (`GITHUB_ENV.appId`), reads the shared `loadForgeBind` for both images, treats both `if (forge === "github") { … }` and `forge === "github" ? … : …` as forge-conditional (braces, colons, and quotes inside strings, comments, and regexes do not move those ranges), and fails the check on any unlisted key. A name handed to `requireEnv` / `requirePem` that is neither a literal nor a constant fails the check as well, instead of being skipped: a variable cannot hide behind an identifier or a computed key. Required constraints (heading `required constraints`, not env keys) fail process start when violated. Adding or removing one is a required GitOps change, so a later removal is a major bump.

Notes (not keys): `JUMI_ROLE` is required (`router`, `engine`, or `control`; unset, empty, or unknown fails process start). `GITEA_WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET` is not required when `JUMI_ROLE=engine`. Reviewer `DATABASE_URL` is required: router and engine fail process start without it. Control reads `DATABASE_URL` only when dispatch is enabled for either role (`CONTROL_DISPATCH_ENGINE` / `CONTROL_DISPATCH_WORKER`); then it is required and the process fails without it, opening job-mode (no migrate, fail clearly when the router has not migrated yet). With dispatch off control stays diskless apart from the Codex grant: it owns the Codex login, refreshes the grant, and publishes a token-only Secret; the router stays diskless and holds no Codex credentials. Worker `DATABASE_URL` is gitops env: the chart must set it (the worker then leases jobs from the shared ledger); without it the worker still starts for local/dev with an in-process queue and no ledger tick, and logs `ledger=none`. Do not 202 org-hook jobs into that RAM queue. `FORGE` is optional (`gitea` or `github`; unset or empty = gitea). With `FORGE=github` the GitHub keys under `gitops env` fail process start when unset (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` as PEM, `FORGE_URL`, `GITHUB_ALLOWED_ORGS`, and `GITHUB_WEBHOOK_SECRET` outside `JUMI_ROLE=engine`); with `FORGE` unset, empty, or `gitea` they are never read and the `GITEA_*` keys apply instead. `GITHUB_APP_INSTALLATION_ID` and `GITHUB_ALLOWED_REPOS` stay optional under either forge. `GITEA_URL` / `GITEA_BOT_TOKEN` / `GITEA_WEBHOOK_SECRET` stay required env because `FORGE` defaults to gitea. `JUMI_SECRETS_FILE` is written by the image entrypoint (tmpfs, 0600, unlinked on read), not by GitOps; it is listed only because the loaders read it. Router is the org-hook mailbox (assign/comment/CI/push write the shared ledger; worker HTTP is unused for correctness). Worker `workflow_job` wake uses the existing webhook port/secret (no new env). `OPENCODE_WELLKNOWN_URL=disabled` turns well-known off (no seed, no fetch); unset or empty still defaults to `https://kirmanak.stream`; other non-URL values fail closed. `JUMI_RUNNERS_FILE` may name `type: claude` runners (`model`, optional `effort` — one of `low`, `medium`, `high`, `xhigh`, `max`, since claude only *warns* about a level it does not know and then runs at the default; anything else fails process start; spawn `--setting-sources user,project`). Unset still synthesizes an OpenCode-only chain from `OPENCODE_*`. Do not bake Claude model ids into the image. `CLAUDE_CODE_OAUTH_TOKEN` stays in the parent env, not this file. `JUMI_RUNNERS_FILE` may also name `type: agy` runners (official Antigravity CLI `agy -p`; `model`, optional `effort`) only when `FORGE=github` (the isolated GitHub factory). With `FORGE` unset, empty, or `gitea`, a runners file that names `type: agy` (in the chain or only under `runners`) fails process start with `AntigravityRefusedError` (`Antigravity refused unless FORGE=github`). The default synthesized chain never selects it. Do not bake `agy` model ids into the image. `agy` auth is the operator's own login under `$HOME/.gemini/antigravity-cli/` (inside `/data`); keep that tree on the retained auth volume like `$HOME/.claude`, one login per ordinal, never a shared or CI-minted token. Every `agy` spawn merges `read_url(<GIT_AUTH_HOST>)` into that directory's `settings.json` `permissions.deny` and does not spawn if the rule cannot be installed. OpenCode provider auth stays at `$HOME/.local/share/opencode/auth.json`; the xAI refresh grant is owned by the long-lived process, which refreshes it there at job start and hands the child a credential that cannot refresh. That file must be durable: when the path is a symlink onto a Retain volume, Jumi follows it and writes the Retain file, so init may keep recreating the symlink but must not point it at ephemeral storage. One grant per ordinal; never copy one ordinal's auth file onto another. `JUMI_RUNNERS_FILE` may also name `type: codex` runners (official Codex CLI `codex exec`; `model`, `effort` defaulting to `high`, `ultra` refused). Unset still synthesizes an OpenCode-only chain; pinning the Codex binary does not insert `codex` into either factory. Auth is the operator's ChatGPT login under `$HOME/.codex` on the retained auth volume, one login per ordinal, never a copied `auth.json`. When `CODEX_AUTH_FILE` names a published token-only file, every Codex spawn (including resume) symlinks `$HOME/.codex/auth.json` at it first: `$HOME/.codex` stays writable for sessions and sqlite and only the file is read-only, Codex re-reads that path after a 401 so a rotated token reaches a running job, the token's `exp` must cover the run budget plus the 5-minute refresh skew plus clock margin (missing, malformed, expired, too short, or carrying a refresh token fails as auth so the chain hops), and a refresh token in the published file is never run. Do not require or inject an API key. Claude Phoenix tracing needs no new key: it reuses `PHOENIX_OTLP_ENDPOINT` (in-cluster base URL; the parent strips the `/v1/traces` path the OpenCode exporter wants) and `AGENT_INSTANCE` as the Phoenix project, and the hook plugin is vendored in the image. `JUMI_RUNNERS_FILE` may set top-level `selection` to `ordered` (default when absent) or `random-start` on reviewer and worker alike; any other value fails process start. Unset keeps ordered starts and synthesized `OPENCODE_*` behavior.

## GitOps

### reviewer

#### required env
- `GITEA_URL`
- `GITEA_BOT_TOKEN`
- `GITEA_WEBHOOK_SECRET`
- `JUMI_ROLE`
- `DATABASE_URL`

#### gitops env
- `FORGE_URL`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_ALLOWED_ORGS`
- `GITHUB_WEBHOOK_SECRET`

#### optional env
- `HOST`
- `PORT`
- `FORGE`
- `GITEA_WEBHOOK_AUTH_TOKEN`
- `GITEA_ALLOWED_ORGS`
- `GITEA_ALLOWED_REPOS`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_ALLOWED_REPOS`
- `JUMI_SECRETS_FILE`
- `JUMI_SECRETS_DIR`
- `BOT_USERNAME`
- `FOLLOWUP_IGNORE_LOGINS`
- `TRUSTED_SENDER_LOGINS`
- `IGNORE_CONFLICTS_LABEL`
- `REVIEW_BLOCKING_QUESTION_AUTHORS`
- `OPENCODE_MODEL`
- `OPENCODE_VARIANT`
- `OPENCODE_FALLBACK_MODEL`
- `OPENCODE_FALLBACK_VARIANT`
- `JUMI_RUNNERS_FILE`
- `OPENCODE_CONFIG`
- `OPENCODE_WELLKNOWN_URL`
- `OPENCODE_WELLKNOWN_KEY`
- `OPENCODE_WELLKNOWN_TOKEN`
- `CODEX_AUTH_FILE`
- `HOME`
- `WORKDIR`
- `QUEUE_CONCURRENCY`
- `MAX_FILES`
- `MAX_PATCH_BYTES`
- `MAX_OUTPUT_BYTES`
- `MAX_WEBHOOK_BYTES`
- `OPENCODE_TIMEOUT_MS`
- `LEASE_MS`
- `MAX_JOB_ATTEMPTS`
- `MAX_FOLLOWUP_ROUNDS`
- `MAX_INCOMPLETE_RETRIES`
- `PHOENIX_OTLP_ENDPOINT`
- `BOARD_PEER_URL`
- `BOARD_PEER_TOKEN`

#### required constraints
- `Antigravity refused unless FORGE=github`

#### ports
- `3000`
- `3001`
- `3010`

`3010` is engine-only; the router never binds it. Ordinal-local Grok device login; the chart allows router->ordinal:3010.

#### runAs
- `10001:10001`

#### probes
- `GET /healthz port 3000`

#### command
- `bun run src/server.ts`

#### image target
- `runtime`

#### volumes
- `/data`
- `/work`

### worker

#### required env
- `GITEA_URL`
- `GITEA_BOT_TOKEN`
- `GITEA_WEBHOOK_SECRET`

#### gitops env
- `DATABASE_URL`
- `FORGE_URL`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_ALLOWED_ORGS`
- `GITHUB_WEBHOOK_SECRET`

#### optional env
- `HOST`
- `PORT`
- `FORGE`
- `GITEA_WEBHOOK_AUTH_TOKEN`
- `GITEA_ALLOWED_ORGS`
- `GITEA_ALLOWED_REPOS`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_ALLOWED_REPOS`
- `JUMI_SECRETS_FILE`
- `JUMI_SECRETS_DIR`
- `BOT_USERNAME`
- `FOLLOWUP_IGNORE_LOGINS`
- `TRUSTED_SENDER_LOGINS`
- `IGNORE_CONFLICTS_LABEL`
- `REVIEW_BLOCKING_QUESTION_AUTHORS`
- `OPENCODE_MODEL`
- `OPENCODE_VARIANT`
- `OPENCODE_FALLBACK_MODEL`
- `OPENCODE_FALLBACK_VARIANT`
- `JUMI_RUNNERS_FILE`
- `OPENCODE_CONFIG`
- `OPENCODE_WELLKNOWN_URL`
- `OPENCODE_WELLKNOWN_KEY`
- `OPENCODE_WELLKNOWN_TOKEN`
- `CODEX_AUTH_FILE`
- `HOME`
- `WORKDIR`
- `GRADLE_SEED_HOME`
- `QUEUE_CONCURRENCY`
- `MAX_OUTPUT_BYTES`
- `MAX_WEBHOOK_BYTES`
- `OPENCODE_TIMEOUT_MS`
- `FOLLOWUP_TIMEOUT_MS`
- `CONFLICT_TIMEOUT_MS`
- `MAX_FOLLOWUP_ROUNDS`
- `MAX_CONFLICT_ROUNDS`
- `LEASE_MS`
- `MAX_JOB_ATTEMPTS`
- `PHOENIX_OTLP_ENDPOINT`

#### required constraints
- `Antigravity refused unless FORGE=github`

#### ports
- `3000`
- `3010`

`3010` is ordinal-local Grok device login; the chart allows router->ordinal:3010.

#### runAs
- `10001:10001`

#### probes
- `GET /healthz port 3000`

#### command
- `bun run src/worker_server.ts`

#### image target
- `worker`

#### volumes
- `/data`
- `/work`
- `/gradle-seed`

`/gradle-seed` is the read-only Gradle seed mounted only when `GRADLE_SEED_HOME` is set (see `GRADLE_SEED_HOME`); without it the worker runs cold.

### control

#### required env
- `JUMI_ROLE`

#### gitops env
- `CONTROL_SECRET_NAME`
- `CONTROL_SECRET_NAMESPACE`
- `DATABASE_URL`
- `CONTROL_ENGINE_MAX_JOBS`
- `CONTROL_WORKER_MAX_JOBS`
- `CONTROL_ENGINE_JOB_TEMPLATE_FILE`
- `CONTROL_WORKER_JOB_TEMPLATE_FILE`

#### optional env
- `HOST`
- `PORT`
- `HOME`
- `JUMI_SECRETS_FILE`
- `JUMI_SECRETS_DIR`
- `CODEX_REFRESH_TOKEN_URL_OVERRIDE`
- `CONTROL_K8S_API_URL`
- `CONTROL_K8S_TOKEN_FILE`
- `CONTROL_K8S_CA_FILE`
- `CONTROL_POLL_MS`
- `CONTROL_DISPATCH_ENGINE`
- `CONTROL_DISPATCH_WORKER`
- `CONTROL_JOB_NAMESPACE`
- `CONTROL_JOB_STARTUP_TIMEOUT_MS`
- `CONTROL_DISPATCH_POLL_MS`
- `KUBERNETES_SERVICE_HOST`
- `KUBERNETES_SERVICE_PORT`

#### ports
- `3000`
- `3010`

`3010` is control-only device login; the router proxies the board Codex control to `control:3010`. No public ingress; one replica with one retained volume.

#### runAs
- `10001:10001`

#### probes
- `GET /healthz port 3000`

#### command
- `bun run src/control.ts`

#### image target
- `runtime`

#### volumes
- `/data`

The Job template files (`CONTROL_ENGINE_JOB_TEMPLATE_FILE`, `CONTROL_WORKER_JOB_TEMPLATE_FILE`) are GitOps-mounted files (for example a ConfigMap at `/etc/jumi/job-engine.json`); the paths above stay configurable via env, so no extra fixed volume is listed.

#### dispatch (one-shot Jobs, `#359`)

`control` turns runnable ledger rows into one Kubernetes Job per row (`engine` rows use the reviewer image, `worker` rows use the worker image; each Job runs `bun run src/job.ts` with `JUMI_JOB_ID`). Dispatch peeks with the same conditions as `lease` (not the `queued` count, which includes backoff rows and same-issue-held rows), oldest row first, and starts nothing for a role while its cooldown/breaker (`#354`) is active. Each enabled role has its own pod cap (`CONTROL_ENGINE_MAX_JOBS` / `CONTROL_WORKER_MAX_JOBS`); the cap is required when dispatch is enabled for that role and there is no unlimited default. `CONTROL_DISPATCH_ENGINE` / `CONTROL_DISPATCH_WORKER` enable each role independently.

The deployment supplies one Job template per role as a mounted JSON file. `control` fills in only `metadata.name` and the `JUMI_JOB_ID` container env; image, service account, security context, volumes, and labels stay in GitOps, and any `ownerReferences` are stripped (never point one at anything that rolls). The name is deterministic (`jumi-<role>-<row id>-g<generation>-a<attempt>`) so a repeated create returns `AlreadyExists`. All Kubernetes calls are plain authenticated HTTP with the service-account bearer token; no client library. Deleting a Job passes `propagationPolicy=Background`, or its pods are orphaned. The template must set `backoffLimit: 0` and `restartPolicy: Never`; `activeDeadlineSeconds` must exceed `LEASE_MS` (`leaseAllowsHop` needs the lease to cover the run timeout, or runner hops are silently declined — do not shorten `LEASE_MS` to speed recovery). A failed Job (its pod died, `#356` exit codes) expires the lease at once so the row moves within seconds instead of waiting for `LEASE_MS`; this counts as one attempt and `MAX_JOB_ATTEMPTS` still applies. A Job whose pod has not started within `CONTROL_JOB_STARTUP_TIMEOUT_MS` (default 10 minutes) is deleted; the row stays queued with no attempt used. Cancelling a running job goes through the ledger (`#361`), never through deleting its Job.

Required RBAC on the Job namespace: `jobs` create, get, list, watch, delete; `pods` get, list, watch. This access effectively reaches the namespace's Secrets, so pair it with an admission policy that only admits Jobs from `control`'s service account when they match the mounted template (image, service account, security context, volumes, labels). Jumi does not ship that policy.

### job

One-shot Job per ledger row (`#359` creates the Jobs, `#361` replaces the unassign path). `bun run src/job.ts` takes one `JUMI_JOB_ID` row id, leases that row with the same conditions as the queue (not-before time, per-issue serialization, shared role gates from `#354`), runs it, and exits. Requires `DATABASE_URL`; there is no in-process queue path. Serves no HTTP (`HOST`/`PORT` unused, no `:3000`, no `:3010`, no probes). Does not migrate and does not run reclaim; the router still migrates and reclaims. Long-running `server.ts` / `worker_server.ts` stay as they are for local use. Exit 0 whenever the row reached a state the ledger understands (including a failed job or a requeue); non-zero only when the process itself could not finish (ledger unreachable, bad config, xAI OAuth or Antigravity refusal). SIGTERM aborts, waits for the child to stop, then releases the lease, then exits 0. Skips xAI grant adoption and file sibling cleanup (`HOME` is empty). Refuses to start when anything the job could run needs xAI OAuth (chain runner, `independentReview` group, or an OpenCode `small_model`/`compaction` pinning `xai/*` including the remote well-known config); static keys such as `OPENCODE_API_KEY_FILE` keep working. Refuses to start when anything the job could run is `type: agy` (chain runner or `independentReview` group): Antigravity auth is one interactive login per ordinal under `$HOME/.gemini/antigravity-cli/` (`antigravity-oauth-token` holding OAuth access, refresh, and `expiry` of about an hour plus `id_token`, refreshed by the CLI itself on load), and job pods start with an empty `HOME` holding no grant. A token-only copy without the refresh grant authenticates while unexpired, but the hour-long token cannot cover multi-hour jobs and the CLI has no documented control-side refresh, so a job-mode chain must lead with a runner that has a static or published credential, such as an OpenCode runner with a static key (which itself must not use an xAI OAuth model for `small_model` or compaction). Every job starts empty and does a full clone with no shared cache; clone time is recorded in the per-run `jumi_run_usage` data.

#### required env
- `GITEA_URL`
- `GITEA_BOT_TOKEN`
- `DATABASE_URL`
- `JUMI_JOB_ID`

#### gitops env
- `FORGE_URL`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_ALLOWED_ORGS`

#### optional env
- `FORGE`
- `GITEA_ALLOWED_ORGS`
- `GITEA_ALLOWED_REPOS`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_ALLOWED_REPOS`
- `JUMI_SECRETS_FILE`
- `JUMI_SECRETS_DIR`
- `BOT_USERNAME`
- `FOLLOWUP_IGNORE_LOGINS`
- `TRUSTED_SENDER_LOGINS`
- `IGNORE_CONFLICTS_LABEL`
- `REVIEW_BLOCKING_QUESTION_AUTHORS`
- `OPENCODE_MODEL`
- `OPENCODE_VARIANT`
- `OPENCODE_FALLBACK_MODEL`
- `OPENCODE_FALLBACK_VARIANT`
- `JUMI_RUNNERS_FILE`
- `OPENCODE_CONFIG`
- `OPENCODE_WELLKNOWN_URL`
- `OPENCODE_WELLKNOWN_KEY`
- `OPENCODE_WELLKNOWN_TOKEN`
- `CODEX_AUTH_FILE`
- `HOME`
- `WORKDIR`
- `GRADLE_SEED_HOME`
- `MAX_OUTPUT_BYTES`
- `OPENCODE_TIMEOUT_MS`
- `FOLLOWUP_TIMEOUT_MS`
- `CONFLICT_TIMEOUT_MS`
- `MAX_FOLLOWUP_ROUNDS`
- `MAX_CONFLICT_ROUNDS`
- `MAX_INCOMPLETE_RETRIES`
- `LEASE_MS`
- `MAX_JOB_ATTEMPTS`
- `PHOENIX_OTLP_ENDPOINT`

#### required constraints
- `Antigravity refused unless FORGE=github`
- `Antigravity refused in one-shot jobs`
- `xAI OAuth refused in one-shot jobs`

#### ports
- none (serves no HTTP)

#### runAs
- `10001:10001`

#### probes
- none (serves no HTTP)

#### command
- `bun run src/job.ts`

#### image target
- `runtime` (review rows) and `worker` (implement rows)

#### volumes
- `/work`
- `/gradle-seed`

`HOME` is an emptyDir (empty `HOME`, no xAI or Antigravity grant adoption). No shared cache across Jobs; each Job clones full history into its own emptyDir. `/data` is not mounted. `/gradle-seed` is the read-only Gradle seed mounted only when `GRADLE_SEED_HOME` is set; without it the job runs cold.

## Metrics

No new env, ports, or volumes. `GET /metrics` sources:

- Router: `jumi_review_jobs*`, `jumi_webhooks_total`, plus ledger-backed `ai_tokens_total`, `ai_tokens`, `ai_sessions`, `jumi_jobs_completed_total`, `jumi_job_duration_seconds_*`, and `jumi_opencode_exits_total` (from `jumi_run_usage` per-run rows and terminal `review_jobs` rows). Scrape the router for these names.
- Control: `codex_access_token_seconds_remaining`, `codex_access_token_lifetime_seconds`, `codex_last_refresh_timestamp_seconds`, `codex_login_dead`, `codex_publish_failures_total`, `codex_last_publish_timestamp_seconds`, plus dispatch `jumi_dispatch_jobs_created_total`, `jumi_dispatch_active_jobs{role}`, `jumi_dispatch_never_started_total{role}`, and `jumi_dispatch_errors_total{role,op}`, so a stopped dispatcher is told apart from an idle queue. Alerts use the remaining fraction, not fixed days.
- Engine/worker: exporter-health gauges only (`ai_token_exporter_*`, `ai_trace_exporter_errors`, `ai_quota_db_schema_errors`). They must not export the same counter names or totals double.
