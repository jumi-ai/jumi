#!/usr/bin/env bash
# Build jumi-reviewer with Buildah on GARM (ubuntu-latest).
# Env: BUN_VERSION, OPENCODE_VERSION, CLAUDE_VERSION required.
#      PUSH_IMAGE=true enables registry push (needs REGISTRY + CONTAINER_REGISTRY_*).
# Isolation defaults: BUILDAH_ISOLATION=chroot, STORAGE_DRIVER=vfs (no --layers).
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <image-tag> [image-tag...]" >&2
  exit 2
fi

: "${BUN_VERSION:?BUN_VERSION is required}"
: "${OPENCODE_VERSION:?OPENCODE_VERSION is required}"
: "${CLAUDE_VERSION:?CLAUDE_VERSION is required}"
: "${HELM_VERSION:?HELM_VERSION is required}"
: "${CODEX_VERSION:?CODEX_VERSION is required}"
: "${CODEX_SHA256_AMD64:?CODEX_SHA256_AMD64 is required}"
: "${CODEX_SHA256_ARM64:?CODEX_SHA256_ARM64 is required}"
: "${YQ_VERSION:?YQ_VERSION is required}"
: "${YQ_SHA256_AMD64:?YQ_SHA256_AMD64 is required}"
: "${YQ_SHA256_ARM64:?YQ_SHA256_ARM64 is required}"
: "${UV_VERSION:?UV_VERSION is required}"
: "${UV_SHA256_AMD64:?UV_SHA256_AMD64 is required}"
: "${UV_SHA256_ARM64:?UV_SHA256_ARM64 is required}"
: "${PROMTOOL_VERSION:?PROMTOOL_VERSION is required}"
: "${PROMTOOL_SHA256_AMD64:?PROMTOOL_SHA256_AMD64 is required}"
: "${PROMTOOL_SHA256_ARM64:?PROMTOOL_SHA256_ARM64 is required}"
: "${TOFU_VERSION:?TOFU_VERSION is required}"
: "${TOFU_SHA256_AMD64:?TOFU_SHA256_AMD64 is required}"
: "${TOFU_SHA256_ARM64:?TOFU_SHA256_ARM64 is required}"
: "${KUBECONFORM_VERSION:?KUBECONFORM_VERSION is required}"
: "${KUBECONFORM_SHA256_AMD64:?KUBECONFORM_SHA256_AMD64 is required}"
: "${KUBECONFORM_SHA256_ARM64:?KUBECONFORM_SHA256_ARM64 is required}"
: "${KUBECTL_VERSION:?KUBECTL_VERSION is required}"
: "${KUBECTL_SHA256_AMD64:?KUBECTL_SHA256_AMD64 is required}"
: "${KUBECTL_SHA256_ARM64:?KUBECTL_SHA256_ARM64 is required}"
: "${NODE_VERSION:?NODE_VERSION is required}"
: "${NODE_SHA256_AMD64:?NODE_SHA256_AMD64 is required}"
: "${NODE_SHA256_ARM64:?NODE_SHA256_ARM64 is required}"

primary_tag="$1"
shift
extra_tags=("$@")

VERSION="${VERSION:-dev}"
REVISION="${REVISION:-${COMMIT_SHA:-unknown}}"

export BUILDAH_ISOLATION="${BUILDAH_ISOLATION:-chroot}"
export STORAGE_DRIVER="${STORAGE_DRIVER:-vfs}"

if ! command -v buildah >/dev/null 2>&1; then
  echo "buildah not found on PATH (expected on garm-act-runner / ubuntu-latest)" >&2
  exit 1
fi

buildah --version
buildah info

# No --layers: vfs full-copies the tree per layer and can fill ephemeral runner disk.
# Multi-tag via repeated -t; push is gated separately.
tag_args=(-t "${primary_tag}")
for tag in "${extra_tags[@]}"; do
  tag_args+=(-t "${tag}")
done

buildah bud \
  --format docker \
  --target runtime \
  "${tag_args[@]}" \
  --build-arg "BUN_VERSION=${BUN_VERSION}" \
  --build-arg "OPENCODE_VERSION=${OPENCODE_VERSION}" \
  --build-arg "CLAUDE_VERSION=${CLAUDE_VERSION}" \
  --build-arg "HELM_VERSION=${HELM_VERSION}" \
  --build-arg "CODEX_VERSION=${CODEX_VERSION}" \
  --build-arg "CODEX_SHA256_AMD64=${CODEX_SHA256_AMD64}" \
  --build-arg "CODEX_SHA256_ARM64=${CODEX_SHA256_ARM64}" \
  --build-arg "YQ_VERSION=${YQ_VERSION}" \
  --build-arg "YQ_SHA256_AMD64=${YQ_SHA256_AMD64}" \
  --build-arg "YQ_SHA256_ARM64=${YQ_SHA256_ARM64}" \
  --build-arg "UV_VERSION=${UV_VERSION}" \
  --build-arg "UV_SHA256_AMD64=${UV_SHA256_AMD64}" \
  --build-arg "UV_SHA256_ARM64=${UV_SHA256_ARM64}" \
  --build-arg "PROMTOOL_VERSION=${PROMTOOL_VERSION}" \
  --build-arg "PROMTOOL_SHA256_AMD64=${PROMTOOL_SHA256_AMD64}" \
  --build-arg "PROMTOOL_SHA256_ARM64=${PROMTOOL_SHA256_ARM64}" \
  --build-arg "TOFU_VERSION=${TOFU_VERSION}" \
  --build-arg "TOFU_SHA256_AMD64=${TOFU_SHA256_AMD64}" \
  --build-arg "TOFU_SHA256_ARM64=${TOFU_SHA256_ARM64}" \
  --build-arg "KUBECONFORM_VERSION=${KUBECONFORM_VERSION}" \
  --build-arg "KUBECONFORM_SHA256_AMD64=${KUBECONFORM_SHA256_AMD64}" \
  --build-arg "KUBECONFORM_SHA256_ARM64=${KUBECONFORM_SHA256_ARM64}" \
  --build-arg "KUBECTL_VERSION=${KUBECTL_VERSION}" \
  --build-arg "KUBECTL_SHA256_AMD64=${KUBECTL_SHA256_AMD64}" \
  --build-arg "KUBECTL_SHA256_ARM64=${KUBECTL_SHA256_ARM64}" \
  --build-arg "NODE_VERSION=${NODE_VERSION}" \
  --build-arg "NODE_SHA256_AMD64=${NODE_SHA256_AMD64}" \
  --build-arg "NODE_SHA256_ARM64=${NODE_SHA256_ARM64}" \
  --build-arg "VERSION=${VERSION}" \
  --build-arg "REVISION=${REVISION}" \
  -f Dockerfile \
  .

verify_rootless_user() {
  local actual_user
  # Prefer config.user; fall back to OCIv1 User field shapes.
  actual_user="$(
    buildah inspect --type image --format '{{.Docker.Config.User}}' "${primary_tag}" 2>/dev/null \
      || true
  )"
  if [ -z "${actual_user}" ] || [ "${actual_user}" = "<no value>" ]; then
    actual_user="$(
      buildah inspect --type image --format '{{.OCIv1.Config.User}}' "${primary_tag}" 2>/dev/null \
        || true
    )"
  fi
  if [ "${actual_user}" != "10001:10001" ]; then
    echo "Expected image user 10001:10001, got ${actual_user:-<empty>}" >&2
    exit 1
  fi
  echo "Verified image user: ${actual_user}"
}

verify_rootless_user

verify_reviewer_runtime() {
  local ctr config_json
  ctr="$(buildah from "${primary_tag}")"
  if buildah run "${ctr}" -- sh -c 'command -v java >/dev/null 2>&1'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "reviewer image must not ship a JVM" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- python3 -c 'import sys; assert sys.version_info[:2] == (3, 13)'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "python3 is not CPython 3.13 in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- python -c 'import sys; assert sys.version_info[:2] == (3, 13)'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "python is not CPython 3.13 in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- python3 -m pytest --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "pytest missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- python3 -c 'import yaml, pytest'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "python3-yaml or pytest not importable in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- python3 -c 'import os, tarfile, tempfile; d=tempfile.mkdtemp(); s=os.path.join(d, "s.txt"); open(s, "w").write("x"); a=os.path.join(d, "a.tar"); t=tarfile.open(a, "w"); t.add(s, arcname="s.txt"); t.close(); o=tempfile.mkdtemp(); tarfile.open(a).extractall(o, filter="data")'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "tarfile filter=data missing in reviewer image python" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- helm version --short; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "helm missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- curl --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "curl missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- yq --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "yq missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- uv --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "uv missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- promtool --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "promtool missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- kubeconform -v; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "kubeconform missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- tofu version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "tofu missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- kubectl version --client; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "kubectl missing in reviewer image" >&2
    exit 1
  fi
  node_version="$(buildah run "${ctr}" -- node --version)" || {
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "node missing in reviewer image" >&2
    exit 1
  }
  if [ "${node_version}" != "v${NODE_VERSION}" ]; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "node version ${node_version} does not match pinned v${NODE_VERSION}" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- sh -c 'test "$(node -p "process.versions.bun === undefined")" = "true"'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "node is the Bun shim, not real Node, in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- npm --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "npm missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- npx --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "npx missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- bun --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "bun missing in reviewer image" >&2
    exit 1
  fi
  if buildah run "${ctr}" -- sh -c 'command -v node | grep -q "/tmp/bun-node"'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "node resolves to the Bun shim in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- ps --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "procps (ps) missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- unzip -v; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "unzip missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- shellcheck --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "shellcheck missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- python3.13 --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "python3.13 missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- sh -c 'UV_OFFLINE=1 uv run --no-project --python 3.13 python -V'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "pre-installed CPython 3.13 not usable offline via uv in reviewer image" >&2
    exit 1
  fi
  # Tracing hooks are bash (set -euo pipefail, [[ ]]); exercise the POST path under the new interpreter.
  if ! buildah run "${ctr}" -- bash -c 'HOME=$(mktemp -d); . /app/claude-plugins/claude-code-tracing/hooks/common.sh; echo {} > /tmp/jumi-post.json; _http_post_json http://127.0.0.1:9 /tmp/jumi-post.json || true'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "tracing hook POST path failed under python3 in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- test -f /app/review-skills/review-proof/SKILL.md; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "review-proof skill missing in reviewer image" >&2
    exit 1
  fi
  if ! config_json="$(
    buildah run \
      --env OPENCODE_DISABLE_PROJECT_CONFIG=1 \
      --env OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
      "${ctr}" -- \
      timeout 120 sh -c 'cd /work && git init -q && opencode debug config'
  )"; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "opencode debug config failed" >&2
    exit 1
  fi
  if ! printf '%s\n' "${config_json}" | grep -F '/app/review-skills' >/dev/null; then
    printf '%s\n' "${config_json}" >&2
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "opencode debug config did not load skills /app/review-skills" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- claude --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "claude missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- agy --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "agy missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- codex --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "codex missing in reviewer image" >&2
    exit 1
  fi
  # `--version` proves the binary is there, not that it still accepts the argv
  # `codexArgv()` spawns. These no-auth `--help` probes fail the image job
  # when a CODEX_VERSION bump renames or drops a flag the fresh spawn or the
  # `exec resume` extra turn depends on, instead of failing every Codex run in
  # production. `--help` can only prove flag presence: pre/post-`resume`
  # ordering (`--color` is not global, `-c` is) is pinned by unit tests in
  # test/codex.test.ts, which is why `--color` is asserted on `exec` only.
  if ! codex_exec_help="$(buildah run "${ctr}" -- codex exec --help)"; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "codex exec --help failed in reviewer image" >&2
    exit 1
  fi
  for flag in --json --color --sandbox --skip-git-repo-check --dangerously-bypass-hook-trust --model --config; do
    if ! printf '%s\n' "${codex_exec_help}" | grep -E -- "${flag}([ ,=]|$)" >/dev/null; then
      buildah rm "${ctr}" >/dev/null 2>&1 || true
      echo "codex exec --help is missing ${flag} the codex runner spawns with" >&2
      exit 1
    fi
  done
  if ! codex_resume_help="$(buildah run "${ctr}" -- codex exec resume --help)"; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "codex exec resume --help failed in reviewer image" >&2
    exit 1
  fi
  for flag in --json --skip-git-repo-check --dangerously-bypass-hook-trust --model --config; do
    if ! printf '%s\n' "${codex_resume_help}" | grep -E -- "${flag}([ ,=]|$)" >/dev/null; then
      buildah rm "${ctr}" >/dev/null 2>&1 || true
      echo "codex exec resume --help is missing ${flag} the codex resume turn spawns with" >&2
      exit 1
    fi
  done
  # Drive the installed opencode binary over a loopback provider and make it
  # resolve the reviewer webfetch map for a table of URLs. Proves the forge-host
  # deny against the real matcher, not a copy of it.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 600 bun src/webfetch_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "reviewer webfetch permission probe failed against the installed opencode binary" >&2
    exit 1
  fi
  # The quota reads swallow SQLite errors, so an opencode bump that changes the
  # session DB would otherwise show up only as sleeping children timing out.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 300 bun src/quota_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "quota probe failed against the installed opencode binary" >&2
    exit 1
  fi
  # Same idea for Antigravity: `--version` says nothing about whether a child
  # can fetch the forge host. The probe installs the production read_url deny
  # and drives the installed binary at a loopback Gemini endpoint.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 600 bun src/agy_webfetch_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "agy forge read_url deny probe failed against the installed agy binary" >&2
    exit 1
  fi
  # The pinned agy either honors per-spawn MCP servers or it does not. The
  # probe registers the production searxng server the way runAgy does and has
  # the installed binary read it back, so an AGY bump that drops MCP support
  # fails here instead of silently leaving agy without search.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 300 bun src/agy_mcp_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "agy MCP probe failed against the installed agy binary" >&2
    exit 1
  fi
  # Jumi loads a repository's `.codex` config on purpose. What keeps web search
  # off is that `-c` outranks it, and only the binary can prove that.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 300 bun src/codex_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "codex override probe failed against the installed codex binary" >&2
    exit 1
  fi
  # Job pods hold no refresh token: control publishes a token-only auth.json
  # with `refresh_token: ""`. Only the binary can prove it runs from that file
  # without refreshing, recovers from a rotated Secret volume after a 401, and
  # still reports refresh failures in the text the runner hops on.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 600 bun src/codex_token_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "codex token-only auth probe failed against the installed codex binary" >&2
    exit 1
  fi
  # Same idea for Claude: `--version` says nothing about the flags Jumi spawns
  # with. Run the production argv against a loopback stub endpoint (nothing
  # billed, no token in the child env) so a rejected or silently ignored flag
  # fails the image job, not every Claude run.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 600 bun src/claude_flag_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "claude production flags rejected by the installed claude binary" >&2
    exit 1
  fi
  # The child gets an xAI credential that cannot refresh, so a killed review
  # cannot burn the refresh grant. That only holds while OpenCode sends that
  # shape as a bearer instead of refreshing it, which only the real binary can
  # answer.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 600 bun src/xai_child_auth_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "xAI child credential is not usable by the installed opencode binary" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- test -f /app/installed-tools.txt; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "installed-tools manifest missing in reviewer image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- sh -c 'set -eu; while IFS= read -r line; do [ -n "$line" ] || continue; tool=${line%% *}; command -v "$tool" >/dev/null 2>&1 || { echo "manifest tool missing from PATH: $tool ($line)" >&2; exit 1; }; done < /app/installed-tools.txt'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "installed-tools manifest lists a tool missing from PATH in reviewer image" >&2
    exit 1
  fi
  echo "Verified python3.13 (python3/python), pytest, yaml, tarfile filter, helm, curl/yq/uv/promtool/kubeconform/tofu/kubectl/ps/unzip/shellcheck/offline-3.13, tracing POST path, claude flags, agy forge read_url deny, review-proof skill, opencode debug config, webfetch denies, installed-tools manifest, and the xAI child credential"
  buildah rm "${ctr}" >/dev/null
}

verify_reviewer_runtime

if [ "${PUSH_IMAGE:-false}" = "true" ]; then
  : "${REGISTRY:?REGISTRY is required when PUSH_IMAGE=true}"
  : "${CONTAINER_REGISTRY_USER:?CONTAINER_REGISTRY_USER is required when PUSH_IMAGE=true}"
  : "${CONTAINER_REGISTRY_PASS:?CONTAINER_REGISTRY_PASS is required when PUSH_IMAGE=true}"

  # Never put the password on argv (visible in /proc/*/cmdline).
  printf '%s\n' "${CONTAINER_REGISTRY_PASS}" | buildah login \
    -u "${CONTAINER_REGISTRY_USER}" \
    --password-stdin \
    "${REGISTRY}"

  all_tags=("${primary_tag}" "${extra_tags[@]}")
  for tag in "${all_tags[@]}"; do
    buildah push "${tag}" "docker://${tag}"
  done

  buildah logout "${REGISTRY}"
fi
