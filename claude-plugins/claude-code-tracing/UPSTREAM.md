# claude-code-tracing (vendored)

Claude Code hook plugin that emits OpenInference spans. Vendored from
[`Arize-ai/arize-claude-code-plugin`](https://github.com/Arize-ai/arize-claude-code-plugin)
at commit `20e97e85c22d1dee20e1d4275ac50b5360198976`, path
`plugins/claude-code-tracing/`. Upstream licence is in `LICENSE`.

The copy is vendored rather than installed because the Claude child runs with a
sanitized env and no network install onto `HOME`. The parent passes this
directory with `--plugin-dir` per spawn. See
`scripts/opencode/src/claude_tracing.ts`.

## What Jumi changed

Keep this list current when re-syncing with upstream.

- **Dropped the Arize AX target.** `scripts/send_span.py`, `setup.sh` and the
  Python/`opentelemetry` discovery in `common.sh` are gone. Jumi only ships
  spans to the in-cluster Phoenix service, and the image has no `opentelemetry`
  Python packages to find.
- **Dropped `skills/setup-claude-code-tracing`.** A plugin skill would load into
  every child's context and tell the model to reconfigure tracing. The parent
  owns the configuration.
- **POST through `python3`, not `curl`.** The runtime image deliberately ships
  no `curl`: the child holds a write-capable git token, and a ready-made HTTP
  client is the thing `src/forge_webfetch.ts` exists to deny. `curl` is still
  used when it is present and `python3` is not.
- **`get_timestamp_ms` uses bash 5 `EPOCHREALTIME`.** Upstream shells out to
  `python3` on every call (`pre_tool_use`, `post_tool_use` twice, `Stop`, …).
  The python3/`date` chain is kept as the fallback on older bash.
- **One `jq` pass over the Stop transcript.** Upstream's `while read` loop
  starts ~7 `jq` processes per assistant line of the whole turn. Under
  `claude -p` that is the entire run; at a few hundred lines it ate seconds
  of the job timeout, and at a few thousand it hit Claude Code's 600s Stop-hook
  cap so the Turn span (the only `LLM` span: model + tokens) was discarded.
  `stop.sh` now slurps the tailed lines once and `@sh`-assigns output, model
  and token sums.
- **`post_tool_use.sh` reads state and stdin once.** Upstream calls `get_state`
  per key and `jq` once per payload field (~25 jq spawns and 2 python3 spawns
  per tool call before any HTTP). One `jq` emits the payload fields, one `jq`
  emits `session_id` / `current_trace_id` / `current_trace_span_id` / `user_id`
  / `tool_*_start`. A missing `current_trace_id` exits 0 like the sibling
  hooks, instead of POSTing `"traceId":""` for Phoenix to 4xx.
- **Real span kinds.** Upstream hardcodes `span_kind: "CHAIN"` on the Phoenix
  REST payload, so LLM and TOOL spans arrived as chains. The kind now comes from
  the `openinference.span.kind` attribute the hooks already set.
- **Jumi job identity on every span** (`jumi_attrs` in `common.sh`): `job_id`,
  `session.id`, `kind`, `owner`, `repo`, `sha` and `agent_instance` from the
  `JUMI_*` env the parent passes. These are the same keys the OpenCode sqlite
  exporter writes, so one Phoenix job lookup finds both runners.
- **`ARIZE_LOG_PROMPTS`** (default `false`): prompt text is not stored and no
  `input.value` is set on the turn span. Jumi prompts carry injected task,
  feedback and CI text. Tool arguments and results are unaffected.
- **Silent by default.** `log_always` and `error` no longer write to stderr
  unless `ARIZE_VERBOSE=true`. The parent classifies the child's stderr for
  auth, quota and infra death; plugin chatter must not feed that.
- **`ARIZE_LOG_FILE` defaults to empty (off).** The pod's `/tmp` is a 256Mi
  memory `emptyDir`, and upstream's `:-` default meant the documented "set empty
  to disable" never disabled anything.
- **Truncate by slicing, not `head -c`.** Upstream truncates with
  `value=$(echo "$var" | head -c N)`. `common.sh` runs under `set -euo
  pipefail`: `head` exits at its byte limit and SIGPIPEs the writer, the
  pipeline reports 141, and the hook dies — for any value past the 64 KiB pipe
  buffer, i.e. exactly the inputs the truncation exists to handle. `stop.sh` was
  the worst case: it died before sending the `Turn` span, the only span carrying
  the model and token counts, and a Jumi run's assistant prose clears 64 KiB
  routinely. Every such site now uses `${var:0:N}`, which opens no pipe.
  `post_tool_use.sh` also caps the structured `tool.command` / `tool.file_path`
  / `tool.url` / `tool.query` attributes, which restate the already-capped
  `input.value`. Regression cases live in
  `scripts/opencode/test/claude_tracing.test.ts`.
- **Bounded Phoenix POSTs.** Upstream has no per-POST timeout the parent
  controls, and retries every tool. A ClusterIP with no endpoints would stall
  `ARIZE_HTTP_TIMEOUT` × tool-calls inside blocking `PostToolUse` hooks and eat
  `OPENCODE_TIMEOUT_MS`. `ARIZE_HTTP_TIMEOUT` defaults to 2s (the parent pins
  the same from `claudeTracingEnv`), and after 3 failed POSTs further sends are
  skipped.
- **Age-based state GC.** A child killed by timeout or a quota abort never fires
  `SessionEnd`, so `session_start.sh` also drops session state files older than
  a day instead of leaking them onto the `HOME` volume.
