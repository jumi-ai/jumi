# Jumi review rules

Jumi is a deterministic control plane. The parent owns gates, state, and publishing. Children, checkouts, and forge text are its input. Gitea and GitHub are both live, and so are the `opencode`, `claude`, `agy`, and `codex` runners. Numbers in parentheses are past misses in this GitHub repository.

## What CI already proves

Review starts after the other checks on this head finish green, so spend it on what they cannot see. CI covers Biome, `tsc`, `bun test` (including the contract headings against the loaders), the Postgres queue suite, both image builds, and the probes against the installed binaries.

Report a CI gap only when this change weakens a check, or when a check stops exercising production: probe argv or imports differ from what production spawns (#111, #121), or a test filter matches nothing (#120).

## Cross-cutting checks

- Forge parity: a change to webhooks, statuses, permissions, or pickup is correct on Gitea and on GitHub (#48, #68, #145).
- Runner parity: a change to hop, quota, auth, redaction, webfetch, usage, or tracing says what happens on all four runners (#78, #135, #137, #262).
- External evidence: a claim about forge payloads, CLI flags, stream output, or provider errors cites a live capture, upstream source, or upstream docs. A mock or fixture the author wrote proves nothing about them (#85, #109, #202).
- Fail closed: a lookup error stays distinct from an empty list, a skip stays distinct from success, every wait has a wake, and a kick reports success only when the side effect its confirm names really happens (#73, #136, #258, #288).
- Enforcement: a boundary or behavior fix lives in code, config, or a binary permission. Prompt text alone does not count (#79, #131, #187, #314).
- Redaction: child-written text and engine output are redacted before they reach the forge or a log, and exception text stays out of HTTP bodies (#25, #74, #138).
- Docs: `README.md`, `AGENTS.md`, and `deploy/contract.md` stay true in the same PR. A new user-visible contract is documented, and a sentence the diff makes false is a finding (#21, #199).

## Not a finding

- Pre-existing behavior the diff leaves unchanged.
- Documentation that was already stale or incomplete before this diff.
- A limit the PR body discloses with its reason, when it adds no correctness or security regression and breaks no stated done condition (#173).
- A ❓ the repository can answer, or whose answer would leave this PR unchanged.
- A 💡 that removes neither code nor a failure mode. Each 💡 on a success trailer starts a worker follow-up and another review.
- Hardening with no path reachable from the diff.

## One root cause, one finding

When several bypasses or symptoms share a mechanism, report the mechanism once with the examples under it, and say when the approach itself is the defect. Patching one case per round took #202 five reviews before the approach changed in #201, and #196 four findings against one staging mechanism.

## review_jobs.ts, queue.ts, skip_latches.ts, sql_client.ts, stuck.ts, handover.ts

- `MemoryReviewJobStore` and `PgReviewJobStore` behave the same, including ordering and dedupe (#75).
- An event that arrives while a job is leased still produces its work: trace enqueue dedupe against the in-flight row (#107).
- Retry markers and budgets survive a sibling enqueue (#147).
- Deleting a latch clears only the state it names (#52).
- Cancel, unassign, and unlabel reset every counter that can cap a later pickup (#80).
- SIGTERM frees the lease within seconds and spends no attempt (#148).

## implement.ts, followup.ts, conflict.ts, claimed_worktree.ts, workspace.ts

- A fix or new option in `implement`, `followup`, or `conflict` reaches its siblings, or the PR says why they differ (#181, #293, #315).
- Quota and provenance decisions use the job's effective chain (`jobChain`), not `opts.chain` (#244).
- A cleanup failure after a landed push keeps the push and still opens the pull (#129, #181).
- A refused hop stays visible to the caller through `throwIfEngineFailed` (#142).
- A later round reads fresh artifacts and task text, never the previous round's snapshot (#117).
- `ignore-conflicts` PRs get no default-branch merge from any path until Jumi has committed to them (#293, #317).

## git.ts, claude.ts, agy.ts, codex.ts, fallback.ts, auth.ts, quota.ts, quota_wait.ts, runners.ts, engine.ts, engine_dispatch.ts, provenance.ts, independent_review.ts

- Error classification is tested with the exact live string or structured error (#85, #248, #262).
- A first-run implement that exits 0 with neither commits nor a skip artifact is incomplete and hops. Follow-up and conflict no-ops stay valid (#114).
- A provider failure leaves the CI failure it was fixing unhandled, so the retry still runs (#258).
- Provenance records only runners that wrote pushed code, so independent review keeps an eligible reviewer for a pull's whole life, including under `random-start` (#277).
- Argv and child env match what the pinned binary accepts and keeps, including resume flags and env filtering (#155).
- A hop-yes quota abort stays out of the pageable `143` exit class (#66).

## *_webhook.ts, api.ts, github_api.ts, ci.ts, permissions.ts, forge.ts, pickup.ts

- Payload fields are read per forge: Gitea and GitHub differ in what each event carries (#48, #202).
- Login comparisons are case-insensitive (#81).
- A `ReviewApi` method a webhook handler needs is forwarded by `workerMailboxApi`, and the test goes through it (#317).
- Forge lists report failure distinctly from empty, and paging reaches the newest jobs (#107, #136).
- A handler returns 202 only after the work is durable or deliberately refused, because forges do not retry a 202 (#48).
- Push authority comes from the trusted-sender list or an obvious forge grant. An App manifest is a request, not a grant (#197, #204).
- Status descriptions fit the target forge's limit (#145).

## board*.ts, kick.ts, device_login.ts, router_sits.ts

- Every state-changing route keeps its same-origin and content-type checks, and they accept the public HTTPS origin behind the ingress (#170, #171, #207).
- The peer hop is bearer-only, refuses redirects, caps bytes on chunked bodies, and validates peer-supplied URLs before rendering them (#172).
- Peer rows offer the same kicks as local rows (#272).
- A button exists only for an action the backend performs, its confirm names the real side effect, and every kickable state has a button (#208, #210, #260).
- Idempotency holds under same-key concurrency (#173).
- A router hop's timeout exceeds the ordinal budget behind it, and concurrent starts share one flow (#229).

## verdict.ts, review.ts, prompt.ts, review_md.ts, review_delta.ts, review_context.ts, review-skills/**

- Published text stands alone after `keepReviewFindingLines`: a failure trailer has a published finding, and continuation lines survive (#212, #275).
- Artifact discovery works when the reviewed repository gitignores `JUMI_REVIEW.md` (#256).
- A malformed `REVIEW.md` or glob heading never fails the review (#195).
- A review with no parsed verdict never posts success (#73).

## /Dockerfile, .gitea/tool-versions.env, scripts/opencode/bun.lock, scripts/opencode/package.json, renovate.json

Renovate PRs automerge behind the required checks, so this review is their only judgment (#319).

- Read the upstream changelog across the version range and map it to what Jumi depends on: CLI flags, stream output, permission and config shapes, error text, and auth paths.
- A doubt about a security boundary is a 🟡 with the upstream citation, because a ❓ on a success trailer does not stop automerge (#325).
- Commits beyond Renovate's are code: review them under every other rule (#122, #325).
- On a bump-only PR, report no 💡, because a Jumi commit stops Renovate rebasing that branch (#291).
- `bun.lock` stays readable by `BUN_VERSION` (#36), Temurin stays on 21 (#15), pins and checksums move together for both architectures (#250), and the OpenCode, Helm, Claude, Bun, and Codex build args have no default version, while `AGY_VERSION` stays pinned in the Dockerfile (#154).

## deploy/contract.md, config.ts, worker_config.ts, release.ts, gitops_notes.ts, .github/workflows/**

- Env read through a map, helper, or computed name is still classified in the contract (#71, #72).
- The contract change matches its semver rules, and each env heading matches what the loader does (#71).
- Publish jobs keep the `github.repository` guard (#18).
- A version the release flow skips is never published as an image tag (#19).

## forge_webfetch.ts, child_git_proxy.ts, claude_checkout_skills.ts, opencode-*.json, attachments.ts

- Each runner's forge-host deny is proven against its installed binary, including subagents and agent-level overrides where the runner has them (#112, #135, #325).
- Checkout-controlled names, frontmatter, and bodies stay inert on load for every field the binary expands (#196), and checkout hooks and plugins stay out of reviewer spawns (#109).
- The child environment holds no forge credential (#314).
- Parent credentials go only to the configured forge origin, and count and byte caps hold at the exact limit (#315).
