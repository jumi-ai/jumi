# Review sandbox: per-shell Landlock (jumi#531, part 2 jumi#550)

## Decision

The **agent stays outside the sandbox**. Every shell or command a **review**
spawn's model executes runs in its own **Landlock domain** that cannot see
the agent's secrets. Same in-repo wrapper (`scripts/opencode/src/review_sandbox.py`,
policy in `src/review_sandbox.ts`), same fail-closed gate — only the policy
and the wiring changed from part 1.

- Harness temp root (prompt file, MCP token configs, XDG dirs, session DB)
  lives **outside the checkout** (`/tmp/jumi-review-*`, created per spawn by
  `makeReviewHarnessTempRoot`). Simpler than traverse-only parents: the shell
  policy just omits it, so it is denied. Only the agent (unsandboxed) reads it.
- Shell RW: the checkout, the per-spawn scratch dir (`TMPDIR`, still
  `<checkout>/.jumi-tmp/scratch`), and the worktree's git dirs when they live
  outside the checkout. Shell RO: `/usr /bin /sbin /lib /lib64 /opt /etc
  /proc /sys /app` plus `/dev` with `/dev/null`-style writes — **without
  `/tmp`**, so the outside harness temp under the shared tmpdir stays
  unreachable. No HOME: shells get their own HOME/XDG dirs under scratch
  (`sandbox-home`), so tools needing a writable HOME still work.
- Denied: everything else, including the harness temp, the agent's HOME
  configs (`~/.codex/auth.json`, `~/.claude/.credentials.json`,
  `~/.local/share/opencode/auth.json`, `~/.gemini`), other checkouts, and the
  harness itself. With ABI ≥ 6 the `SIGNAL` and `ABSTRACT_UNIX_SOCKET` scopes
  close signals/ptrace and abstract-socket connects, so
  `/proc/<harness>/environ`, `/proc/<harness>/fd`, and `kill` of harness pids
  are denied.
- Environment: the agent env keeps its allow-list (`findReviewEnvViolations`
  fails a review spawn closed on harness/forge/MCP-token shapes; provider keys
  the agent needs stay). Shells additionally scrub provider keys
  (`OPENCODE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `CODEX_API_KEY`, `XAI_API_KEY`) via the `env -u` prefix in
  `reviewShellWrapperPrefix`, so a `printenv` in pull code learns nothing.
- Verdict channel: closed. The MCP token lives only in the outside harness
  temp, which shells cannot read; without the token the loopback MCP
  (`http://127.0.0.1:<port>/mcp`, still reachable — the wrapper requests no
  TCP handling) rejects every call. `JUMI_REVIEW.md` stays RW in the checkout
  (diffs must be readable, tests must run), but the parent's
  MCP-store-wins-over-file rule (`review.ts`) means a shell that writes the
  file without the token cannot change the posted status. Codex and Agy are
  wired to the same review MCP, so the file fallback is ignored whenever the
  store holds anything there too.
- Network: inherited from the pod. Reviewers may still shallow-clone public
  upstream tags into scratch; the NetworkPolicy keeps doing hosts.

## Why not the other candidates

| Option | Verdict |
|---|---|
| `nono` (agent-aware proxy, per-tool sandbox) | Rejected for now: external service to pin and operate, and its license / API stability could not be verified from here (no network). Revisit if per-tool network policy becomes the requirement. |
| `landrun` (Landlock CLI) | Runner-up. Minimal and unprivileged, but a new third-party binary to pin (version + per-arch SHA in `.gitea/tool-versions.env` + `Dockerfile`), and its exact CLI flags could not be verified from here. The in-repo wrapper does the same syscall sequence with no supply chain. |
| `anthropics/sandbox-runtime`, Claude's built-in sandbox, Codex's Linux sandbox | Rejected: need user namespaces (`unshare -U` fails with EPERM under this cluster's `RuntimeDefault` seccomp), which is exactly what we cannot use. |
| `kubernetes-sigs/agent-sandbox` + gVisor/Kata | Strongest isolation, but every model command would cross pods. Reconsider only if Landlock cannot hold. |
| Small in-repo wrapper (Landlock syscalls directly) | **Chosen.** Most control, most to maintain — but it is ~150 lines of stdlib-only Python against stable UAPI, `python3` is already in the reviewer image, and there is nothing to pin, license-review, or fetch. Reused for shells in part 2 with a stricter policy. |

License: our own code, no new license. Pinning: nothing to pin (stdlib +
libc syscalls, x86_64/aarch64 syscall numbers 444/445/446 shared).

## Verified here, still to verify in a job pod

- Landlock ABI **7** confirmed in this container via
  `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`;
  the issue reports ABI 7 on the Talos 6.18 job pods too. Yama
  `ptrace_scope` is 2 here as well.
- Prototyped enforcement in this container: `/proc/<outside>/environ`
  denied, `kill -0 <outside>` denied (`Operation not permitted`), outside
  harness temp and HOME secrets denied, writes outside the allow-list denied,
  writes inside scratch allowed, `node`, `git` (with the external gitdirs
  rule), and shallow `git clone` into scratch run.
- `src/review_sandbox_probe.ts` repeats that red-team against the real
  wrapper in the image job (outside harness temp, HOME secret, `/proc`,
  signals, plus benign `node`/`git`/`clone`); `review_sandbox.py --check`
  asserts ABI ≥ 6 and is the startup check. Unit tests repeat the same shape
  with a fake runner (`test/review_sandbox.test.ts`). Neither probe has run
  in a job pod yet — the image job owns that confirmation.

## Per-runner wiring

All wiring is Jumi-owned (never from the checkout). The agent spawns
unsandboxed; its shells are wrapped separately:

- OpenCode: Jumi-owned `tool.execute.before` plugin for `bash` (generated per
  spawn under the outside harness temp, registered in the Jumi-owned global
  `opencode.json`). Rewrites `output.args.command` through the shell wrapper
  prefix and denies reads of the harness temp / credential files.
- Claude: Jumi-owned `PreToolUse` hook (`updatedInput` rewrite) in a
  `--plugin-dir` plugin under the outside harness temp. Same rewrite + deny
  shape as OpenCode.
- Codex: `PreToolUse` hook in `hooks.json` under the review-only `CODEX_HOME`
  (outside harness temp), plus the review MCP server in the same
  `CODEX_HOME/config.toml`. Same rewrite shape.
- Agy: `PreToolUse` hook in the global `~/.gemini/config/hooks.json`
  (Jumi-owned `jumi-review-shell-sandbox` key, restored after the spawn) with
  `overwrite.CommandLine`, plus the review MCP server in the global
  `mcp_config.json` (same restore). Same rewrite shape.

A runner with no Jumi-owned hook refuses instead of running unsandboxed
(`assertReviewRunnerSandboxable`: one clear line, `review spawn refused:
<runner> runner cannot be sandboxed ...`). All four pinned runners have hooks;
unknown types refuse.

Fail-closed: if Landlock is unavailable or below ABI 6, review jobs fail
with one clear status (`review spawn refused: Landlock sandbox
unavailable ...`) instead of running unsandboxed. `JUMI_ALLOW_UNSANDBOXED_REVIEWS=1`
is the deployer escape hatch for rollout: off by default, logged loudly on
every bypassed spawn.

## What stays open

- The checkout stays RW for shells (diffs must be readable, `bun test` must
  run), so a shell *can* write `JUMI_REVIEW.md`. It cannot change the posted
  status: without the MCP token it cannot touch the verdict store, and the
  store wins over the file.
- The loopback MCP stays reachable (no TCP handling in the wrapper), but every
  call without the bearer token is rejected.
- The agent itself is unsandboxed by design (it holds the login and the
  token); its `Read`/`Edit` of sensitive paths is denied by the same
  Jumi-owned hooks, not by Landlock.

## For workers

Reusing the shell hooks for worker spawns is a separate change: workers need
write access to caches (`JUMI_CACHE_DIR`, Gradle/Maven/npm caches) and the
git token proxy already covers their forge writes, so the rule set differs
and the rollout risk (broken builds across every repository) is higher.
Land one review-only cycle first, then extend the rule builder with a
worker profile.
