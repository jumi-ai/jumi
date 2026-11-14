# Review sandbox: Landlock spike decision (jumi#531)

## Decision

Confine every command a **review** spawn's model executes with an **in-repo
Landlock wrapper** (`scripts/opencode/src/review_sandbox.py`, policy in
`src/review_sandbox.ts`). The harness spawns the agent binary through the
wrapper; the wrapper builds the Landlock ruleset, restricts itself, and execs
the agent. Everything the model then runs (tests, scripts, package installs)
inherits the domain.

- Read-write: the checkout, the per-spawn scratch dir (`TMPDIR`), the
  spawn's HOME, and the worktree's git dirs when they live outside the
  checkout (linked worktrees keep objects in a bare repo elsewhere: both the
  worktree gitdir and the common dir are allow-listed, since git needs HEAD
  from one and objects from the other).
- Read-only: `/usr /bin /sbin /lib /lib64 /opt /etc /proc /sys /tmp /app`,
  plus `/dev` with `/dev/null`-style writes (creation still denied, so no
  new device nodes appear).
- Denied: everything else — except the spawn's temp root, which is the
  known-open verdict channel (see below). Other checkouts, `/tmp` writes,
  the retained auth volume outside HOME, and the harness itself: with ABI ≥ 6
  the `SIGNAL` and `ABSTRACT_UNIX_SOCKET` scopes close signals/ptrace and
  abstract-socket connects outside the domain, so `/proc/<harness>/environ`,
  `/proc/<harness>/fd`, and `kill` of harness pids are denied.
- Environment: explicit allow-list. The per-runner builders already start
  from a minimal base; `findReviewEnvViolations` additionally fails a review
  spawn closed when the child env carries anything from the harness
  namespace (`JUMI_*`, except the six Phoenix tracing labels
  `JUMI_TRACE_KIND`/`JUMI_OWNER`/`JUMI_REPO`/`JUMI_SHA`/`JUMI_JOB_ID`/
  `JUMI_AGENT_INSTANCE`, which carry only job identity the model already
  knows), any forge/git credential, or anything matching
  `*MCP*TOKEN/KEY/SECRET`. Provider keys the child legitimately needs are
  allowlisted by exact name.
- Network: inherited from the pod. Reviewers may still shallow-clone public
  upstream tags under the scratch dir; the NetworkPolicy keeps doing hosts.

## Why not the other candidates

| Option | Verdict |
|---|---|
| `nono` (agent-aware proxy, per-tool sandbox) | Rejected for now: external service to pin and operate, and its license / API stability could not be verified from here (no network). Revisit if per-tool network policy becomes the requirement. |
| `landrun` (Landlock CLI) | Runner-up. Minimal and unprivileged, but a new third-party binary to pin (version + per-arch SHA in `.gitea/tool-versions.env` + `Dockerfile`), and its exact CLI flags could not be verified from here. The in-repo wrapper does the same syscall sequence with no supply chain. |
| `anthropics/sandbox-runtime`, Claude's built-in sandbox, Codex's Linux sandbox | Rejected: need user namespaces (`unshare -U` fails with EPERM under this cluster's `RuntimeDefault` seccomp), which is exactly what we cannot use. |
| `kubernetes-sigs/agent-sandbox` + gVisor/Kata | Strongest isolation, but every model command would cross pods. Reconsider only if Landlock cannot hold. |
| Small in-repo wrapper (Landlock syscalls directly) | **Chosen.** Most control, most to maintain — but it is ~150 lines of stdlib-only Python against stable UAPI, `python3` is already in the reviewer image, and there is nothing to pin, license-review, or fetch. |

License: our own code, no new license. Pinning: nothing to pin (stdlib +
libc syscalls, x86_64/aarch64 syscall numbers 444/445/446 shared).

## Verified here, still to verify in a job pod

- Landlock ABI **7** confirmed in this container via
  `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`;
  the issue reports ABI 7 on the Talos 6.18 job pods too. Yama
  `ptrace_scope` is 2 here as well.
- Prototyped enforcement in this container: `/proc/<outside>/environ`
  denied, `kill -0 <outside>` denied (`Operation not permitted`), writes
  outside the allow-list denied, writes inside scratch allowed, `node` and
  `git` (with the external gitdirs rule) run.
- `src/review_sandbox_probe.ts` repeats that red-team against the real
  wrapper in the image job; `review_sandbox.py --check` asserts ABI ≥ 6 and
  is the startup check. Neither has run in a job pod yet — the image job
  owns that confirmation.

## Per-runner wiring

One launcher prefix for all four runners (OpenCode, Claude, Codex,
Antigravity), applied at the agent spawn: Landlock is inherited, so it
covers every shell command the model runs with a single mechanism and no
per-runner hook. No runner needed refusing: all four spawn through the
wrapped path. This is the single-domain shape: the agent and every shell it
runs share one domain, which is why the verdict channel below stays open —
per-runner shell hooks (Claude's shell prefix / `PreToolUse` from Jumi's own
plugin, OpenCode's `tool.execute.before` plugin, Codex/Agy equivalents) are
the follow-up that would let the agent keep the token while its shells
cannot.

Two deliberate exceptions, both logged at spawn and both follow-up work,
plus one known-open channel documented here (not an exception that closes):

1. **HOME stays visible.** Review agents authenticate from HOME
   (`~/.codex`, `~/.gemini`, `~/.claude`, opencode auth seeding). Denying
   it today breaks logins, so the spawn's HOME is read-write for now.
   Narrowing it (per-runner auth seeding into a sandbox HOME, verified
   against each pinned binary) is the next hardening step after this lands.
2. **The review verdict channel stays open — #531's Done condition is
   unmet by this single-domain wrapper.** The per-spawn MCP bearer token
   lives in files under the spawn temp root (`<workdir>/.jumi-tmp/...`:
   Claude's `review-mcp.json`, OpenCode's `xdg-config/opencode/opencode.json`
   which also names the server URL), and the fallback artifact
   `JUMI_REVIEW.md` lives in the RW checkout. `reviewSandboxRules` grants
   read-write on the whole checkout, and Landlock `path_beneath` has no deny
   rules: any RW ancestor keeps every descendant readable, so RW on the
   checkout keeps `.jumi-tmp` and its token files readable to sandboxed pull
   code (`cat .jumi-tmp/*/review-mcp.json` yields both URL halves). The loopback
   MCP server (`http://127.0.0.1:<port>/mcp`) stays reachable from inside the
   domain (the wrapper requests no TCP handling), and the env gate audits
   names in the child env, never file contents — so a file-resident token
   passes it by construction. Concretely: pull code that reads the token from
   a file under `.jumi-tmp` and calls the review MCP can forge the posted
   status, and pull code that writes `JUMI_REVIEW.md` can forge the fallback
   for runners without MCP support. The parent's MCP-store-wins-over-file rule
   (`review.ts`: store holdings ignore the file) narrows but does not close
   this: a forged MCP call with the stolen token lands in the store itself.
   A finer RW list cannot fix it for the same reason (no deny of a
   subdirectory of an allowed ancestor). Closing it needs a different domain
   shape — wrap each model-executed shell command (not the whole agent), keep
   the agent unsandboxed so only it can read the token, and deny the temp
   root to the sandboxed shells (outside-checkout temp root, or traverse-only
   parents) — e.g. Claude's shell prefix / `PreToolUse` hook from Jumi's own
   plugin and OpenCode's `tool.execute.before` plugin, plus the Codex/Agy
   equivalents, or a per-tool proxy with credential injection. That is the
   follow-up; this change confines /proc, signals/abstract sockets, and
   outside-checkout writes only.

Fail-closed: if Landlock is unavailable or below ABI 6, review jobs fail
with one clear status (`review spawn refused: Landlock sandbox
unavailable ...`) instead of running unsandboxed. `JUMI_ALLOW_UNSANDBOXED_REVIEWS=1`
is the deployer escape hatch for rollout: off by default, logged loudly on
every bypassed spawn.

## For workers

Reusing the launcher for worker spawns is a separate change: workers need
write access to caches (`JUMI_CACHE_DIR`, Gradle/Maven/npm caches) and the
git token proxy already covers their forge writes, so the rule set differs
and the rollout risk (broken builds across every repository) is higher.
Land one review-only cycle first, then extend the rule builder with a
worker profile.
