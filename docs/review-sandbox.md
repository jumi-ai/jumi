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
- `src/webfetch_probe.ts` (review section) registers the production OpenCode
  review plugin dir in a scratch global config and drives the installed
  `opencode` binary through it: `shell` (the 2.3.2 shell-tool name, hash
  unverified — the image installs the release tarball without a checksum, so
  only the version is pinned; a `bash` call aliases to it before hooks run)
  must come back wrapped (HOME is the sandbox home), `read`/`list` of the
  harness token must come back blocked. The stub retries the shell call
  (bounded) until HOME comes back wrapped — the plugin loads asynchronously
  with the first run, so the first calls can race registration — and the
  plugin's setup writes a ready marker the probe asserts, so a binary that
  never loads the plugin or drops either hook fails the case instead of
  running unwrapped.

## First-call trace (offline diagnostic, not CI)

`src/review_first_shell_probe.ts` records, per scenario, the ordered trace of
plugin setup, the first model request, and the first shell call against the
installed binary, and prints SAFE, UNSAFE, or UNKNOWN. Rerun offline from
`scripts/opencode` with `bun src/review_first_shell_probe.ts` (loopback stubs
only, scratch HOME/XDG, no provider or forge credentials, no real auth
directory; the plugin is registered only through the config `plugins` key
outside the auto-discovered plugin directories, so a missing or broken plugin
cannot be rescued by discovery). Tool dispatch is detected with a harmless
`touch` file the stubbed shell command creates.

Observed against `opencode v2.3.2` (hash unverified, same install as above),
isolated HOME/XDG, single local runs — not CI — 3 runs per scenario:

| Scenario | Observed |
|---|---|
| `delayed-setup` (4 s sleep before the shell hook) | SAFE 3/3: the first model request arrived only after setup finished, and the first shell result was wrapped. |
| `throw-after-one-hook` (setup throws after one hook, before the shell hook) | UNSAFE 3/3: the shell ran unwrapped, exit 0, no error. |
| `missing-dir` (config `plugins` key points at a nonexistent directory) | UNSAFE 3/3: the shell ran unwrapped, exit 0, no error. |
| `invalid-file` (syntactically broken plugin file) | UNSAFE 3/3: the shell ran unwrapped, exit 0, no error. |
| `healthy` (control) | SAFE 3/3: the first shell result was wrapped. |

This records fail-open behavior in those specific failure fixtures, not an
exploited production installation: production registers the healthy plugin,
and the image probe above asserts the ready marker plus the wrapped shell and
blocked reads, so these fixtures fail that probe instead of passing
unwrapped. SAFE is scoped to that scenario and binary build, not a universal
containment guarantee.

Scope note for the follow-on work (jumi#831, implemented): the parent now
refuses before spawn when the generated plugin file is missing, when the
global config's `plugins` list does not reference it, or when its contents do
not parse (transpile check) — and the plugin's own bootstrap never throws,
never resolves on failure, and never permits model/tool dispatch: a caught
import/hook/marker failure writes the per-spawn startup-failed marker
(`review-shell-plugin.startup-failed` in the harness temp root) and then
awaits a promise that never settles, while the parent watches for that marker
(local-file check, 100 ms, cleared on every exit) and kills the owned child as
an engine failure. That closes the bootstrap slice only — a missing
directory, an invalid file, or a mid-setup throw no longer falls through when
the bootstrap runs, but a binary-side rejection of a syntactically valid
plugin before its factory runs produces no failure marker and is not covered
by this slice. Neither the existing eventual-wrapping image probe nor these
selected local scenarios proves that every such rejection fails closed.

## Per-runner wiring

All wiring is Jumi-owned (never from the checkout). The agent spawns
unsandboxed; its shells are wrapped separately:

- OpenCode: Jumi-owned V2 plugin (plain `{ id, setup }` default export, no
  static `@opencode/plugin` import; `setup` dynamically imports the plugin API
  inside a non-throwing bootstrap, with `ctx.tool.hook("execute.before")`
  denying reads plus `ctx.shell.hook("create.before")` wrapping every shell
  creation,
  generated per spawn as `<outside-temp>/xdg-config/opencode/plugin/jumi-review-shell-sandbox/index.js`
  and registered as a directory under the V2 `plugins` key of the Jumi-owned
  global `opencode.json`). The tool hook denies reads of the harness temp /
  credential files
  (`read`/`edit`/`write`/`grep`/`glob`/`list` — reads, writes, search, and
  listing, so `list /tmp` cannot reveal the harness temp either). Candidates
  are normalized (relative paths resolve against the checkout, `..`/`.`/extra
  slashes collapse) and denied bidirectionally: a path inside a denied prefix
  *or* an ancestor of one is denied. The shell hook rewraps every shell
  creation (exactly once — the tool hook never rewrites shell commands, since
  a second wrap would exec the wrapper inside its own Landlock domain) and pins
  HOME/XDG/TMPDIR at scratch while scrubbing provider keys. The plugin's
  setup writes a ready marker after both registrations so the image probe can
  prove the load instead of running half-wrapped. A caught import/hook/marker
  failure instead writes the per-spawn startup-failed marker
  (`review-shell-plugin.startup-failed` in the harness temp root) and awaits a
  promise that never settles, so the child stays parked before its first model
  request; the parent refuses before spawn when the plugin file is missing,
  unregistered, or unparsable, watches for the startup-failed marker while the
  child runs (100 ms poll, cleared on every exit, skipped only under
  `JUMI_ALLOW_UNSANDBOXED_REVIEWS=1`), and kills the owned child as an engine
  failure on sight. A binary-side rejection of a syntactically valid plugin
  before its factory runs produces no failure marker and is not covered by
  this slice.
- Claude: Jumi-owned `PreToolUse` hook (`updatedInput` rewrite) in a
  `--plugin-dir` plugin under the outside harness temp. Same rewrite, and the
  deny covers `Read`/`Edit`/`Write`/`Grep`/`Glob` so the token is not reachable
  through file-search tools.
- Codex: `PreToolUse` hook in `hooks.json` under the review-only `CODEX_HOME`
  (outside harness temp), plus the review MCP server in the same
  `CODEX_HOME/config.toml`. Same rewrite shape. Review spawns keep
  `--dangerously-bypass-hook-trust`: the hook file is fresh every spawn so its
  hash is never pre-trusted, and non-interactive `codex exec` would otherwise
  skip it silently; the review home marks the workdir untrusted so the head's
  project hooks never load either way.
- Agy: `PreToolUse` hook in the global `~/.gemini/config/hooks.json`
  (Jumi-owned `jumi-review-shell-sandbox` key, restored after the spawn) with
  `overwrite.CommandLine`, plus the review MCP server in the global
  `mcp_config.json` (same restore). The matcher covers `run_command` plus the
  file/dir tools (`view_file`, `list_dir`, `find_by_name`, `grep_search` and
  the write tools), so the token-bearing `mcp_config.json` is not readable
  through `view_file`. Same rewrite shape.

A runner with no Jumi-owned hook refuses instead of running unsandboxed
(`assertReviewRunnerSandboxable`: one clear line, `review spawn refused:
<runner> runner cannot be sandboxed ...`). All four pinned runners have hooks;
unknown types refuse.

Repository setup for reviews runs in the same sandbox: `setup.run` with
`kind === "review"` executes through the shell wrapper with the shell policy
(checkout plus scratch read-write, system paths read-only, no agent HOME) and
a scratch `HOME`/XDG/`TMPDIR` created before spawn. Its git goes through the
loopback credential proxy in read-only mode (fetch/clone served with the
parent-held credential, every push endpoint refused with 404 without contacting
the forge; the sandbox is filesystem-only, so the loopback proxy stays
reachable), and a review setup without a credential, or whose read-only proxy
cannot start, ends `failed` under the repository's `onFailure` policy instead
of falling back to read-write, direct credentials, or no auth. Worker setup
kinds keep today's env and spawn. Fail-closed matches the spawn gate below: an
unavailable sandbox yields a setup `failed` outcome under the repository's
`onFailure` policy, never an unwrapped run, unless
`JUMI_ALLOW_UNSANDBOXED_REVIEWS=1` is set (logged).

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
