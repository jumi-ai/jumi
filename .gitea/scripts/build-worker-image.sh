#!/usr/bin/env bash
# Build jumi-worker with Buildah on GARM (ubuntu-latest).
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
: "${TEMURIN_TAG:?TEMURIN_TAG is required}"

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
  --target worker \
  "${tag_args[@]}" \
  --build-arg "BUN_VERSION=${BUN_VERSION}" \
  --build-arg "OPENCODE_VERSION=${OPENCODE_VERSION}" \
      --build-arg "CLAUDE_VERSION=${CLAUDE_VERSION}" \
      --build-arg "HELM_VERSION=${HELM_VERSION}" \
      --build-arg "TEMURIN_TAG=${TEMURIN_TAG}" \
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

verify_worker_jdk() {
  local ctr java_home java_version
  ctr="$(buildah from "${primary_tag}")"
  if ! java_home="$(buildah run "${ctr}" -- printenv JAVA_HOME)"; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "JAVA_HOME missing in worker image" >&2
    exit 1
  fi
  if [ "${java_home}" != "/opt/java/openjdk" ]; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "Expected JAVA_HOME=/opt/java/openjdk, got ${java_home:-<empty>}" >&2
    exit 1
  fi
  if ! java_version="$(buildah run "${ctr}" -- java -version 2>&1)"; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "java missing in worker image" >&2
    exit 1
  fi
  if ! printf '%s\n' "${java_version}" | grep -E 'version "21(\.|$)' >/dev/null; then
    printf '%s\n' "${java_version}" >&2
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "worker image java is not JDK 21" >&2
    exit 1
  fi
  if ! printf '%s\n' "${java_version}" | grep -F Temurin >/dev/null; then
    printf '%s\n' "${java_version}" >&2
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "worker image java is not Temurin" >&2
    exit 1
  fi
  echo "Verified worker JDK: ${java_home}"
  printf '%s\n' "${java_version}"
  buildah rm "${ctr}" >/dev/null
}

verify_worker_jdk

verify_worker_skills() {
  local ctr config_json
  ctr="$(buildah from "${primary_tag}")"
  if ! buildah run "${ctr}" -- test -f /app/review-skills/gitea-pull-review/SKILL.md; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "gitea-pull-review skill missing in worker image" >&2
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
    echo "worker opencode debug config failed" >&2
    exit 1
  fi
  if ! printf '%s\n' "${config_json}" | grep -F '/app/review-skills' >/dev/null; then
    printf '%s\n' "${config_json}" >&2
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "worker opencode debug config did not load skills.paths /app/review-skills" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- claude --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "claude missing in worker image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- agy --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "agy missing in worker image" >&2
    exit 1
  fi
  if ! buildah run "${ctr}" -- codex --version; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "codex missing in worker image" >&2
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
    echo "codex exec --help failed in worker image" >&2
    exit 1
  fi
  for flag in --json --color --sandbox --skip-git-repo-check --ignore-rules --ignore-user-config --model --config; do
    if ! printf '%s\n' "${codex_exec_help}" | grep -E -- "${flag}([ ,=]|$)" >/dev/null; then
      buildah rm "${ctr}" >/dev/null 2>&1 || true
      echo "codex exec --help is missing ${flag} the codex runner spawns with" >&2
      exit 1
    fi
  done
  if ! codex_resume_help="$(buildah run "${ctr}" -- codex exec resume --help)"; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "codex exec resume --help failed in worker image" >&2
    exit 1
  fi
  for flag in --json --skip-git-repo-check --ignore-rules --ignore-user-config --model --config; do
    if ! printf '%s\n' "${codex_resume_help}" | grep -E -- "${flag}([ ,=]|$)" >/dev/null; then
      buildah rm "${ctr}" >/dev/null 2>&1 || true
      echo "codex exec resume --help is missing ${flag} the codex resume turn spawns with" >&2
      exit 1
    fi
  done
  # The worker holds the write-capable forge token. `--version` does not prove
  # the child is refused a fetch of that host.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 600 bun src/agy_webfetch_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "agy forge read_url deny probe failed against the installed agy binary" >&2
    exit 1
  fi
  # `--version` only proves the binary is there. Run the argv `claudeArgv()`
  # emits against a loopback stub endpoint (nothing billed, no token in the
  # child env) so a flag this Claude release rejects — or silently ignores —
  # fails the image job instead of every Claude spawn in production.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 600 bun src/claude_flag_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "claude production flags rejected by the installed claude binary" >&2
    exit 1
  fi
  # The worker holds the same xAI grant and runs the 4h jobs, so it needs the
  # same proof: the child credential is sent as a bearer and never refreshed.
  if ! buildah run "${ctr}" -- \
    sh -c 'cd /app/scripts/opencode && timeout 600 bun src/xai_child_auth_probe.ts'; then
    buildah rm "${ctr}" >/dev/null 2>&1 || true
    echo "xAI child credential is not usable by the installed opencode binary" >&2
    exit 1
  fi
  echo "Verified gitea-pull-review skill, claude flags, agy forge read_url deny, opencode debug config, and the xAI child credential"
  buildah rm "${ctr}" >/dev/null
}

verify_worker_skills

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
