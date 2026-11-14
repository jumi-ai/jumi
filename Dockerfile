ARG BUN_VERSION
ARG HELM_VERSION
ARG CODEX_VERSION
ARG CODEX_SHA256_AMD64
ARG CODEX_SHA256_ARM64
ARG YQ_VERSION
ARG YQ_SHA256_AMD64
ARG YQ_SHA256_ARM64
ARG UV_VERSION
ARG UV_SHA256_AMD64
ARG UV_SHA256_ARM64
ARG PROMTOOL_VERSION
ARG PROMTOOL_SHA256_AMD64
ARG PROMTOOL_SHA256_ARM64
ARG TOFU_VERSION
ARG TOFU_SHA256_AMD64
ARG TOFU_SHA256_ARM64
ARG KUBECONFORM_VERSION
ARG KUBECONFORM_SHA256_AMD64
ARG KUBECONFORM_SHA256_ARM64
ARG KUBECTL_VERSION
ARG KUBECTL_SHA256_AMD64
ARG KUBECTL_SHA256_ARM64
ARG TEMURIN_TAG=21.0.12_8-jdk@sha256:92a2a4d7a928d057e7bd999c418d66c26a34eb9a0442f3ab67721c3f88110b2d

FROM docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS tools

ARG BUN_VERSION
ARG OPENCODE_VERSION
ARG CLAUDE_VERSION
# Official Antigravity CLI (glibc build; the runtime is Debian, not Alpine).
# Pinned from the installer manifests at
# https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_{amd64,arm64}.json
ARG AGY_VERSION=1.2.7-6731160148115456
ARG AGY_SHA512_AMD64=fec769d611c4afdf0ae72d38bdb2652c8e2c8e71e4f6de97a27b80dda3c50429160d9e03776a36a59b8857c20e76783c4a49cb0feb8b2f5c3bf925b0cc03bb77
ARG AGY_SHA512_ARM64=d39f939ffc80776bfd2dc10db7b9a1a1b58650f08115fa21065c11d10882c71210f368c2e6060f26966d1a33d6b2dd2bc19bfd641062305af6546c51d494511a
# Official Linux Codex CLI (musl package the stock installer ships). The
# effective pin lives in .gitea/tool-versions.env (CODEX_VERSION plus both
# CODEX_SHA256_* archive pins) and arrives as build-args; there is no holiday
# default here so a missing wire fails closed instead of baking a stale CLI.
# Pinning this binary must not change the synthesized OpenCode chain.
ARG CODEX_VERSION
ARG CODEX_SHA256_AMD64
ARG CODEX_SHA256_ARM64
ARG HELM_VERSION
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar unzip \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) platform="linux-x64" ;; \
      arm64) platform="linux-arm64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${platform}.tar.gz" -o "${tmp_dir}/opencode.tar.gz"; \
    tar -xzf "${tmp_dir}/opencode.tar.gz" -C "${tmp_dir}"; \
    install -m 755 "${tmp_dir}/opencode" /usr/local/bin/opencode; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) platform="linux-x64" ;; \
      arm64) platform="linux-arm64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${platform}/claude" -o "${tmp_dir}/claude"; \
    install -m 755 "${tmp_dir}/claude" /usr/local/bin/claude; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) agy_path="linux-x64/cli_linux_x64.tar.gz"; agy_sha512="${AGY_SHA512_AMD64}" ;; \
      arm64) agy_path="linux-arm/cli_linux_arm64.tar.gz"; agy_sha512="${AGY_SHA512_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}/${agy_path}" -o "${tmp_dir}/agy.tar.gz"; \
    echo "${agy_sha512}  ${tmp_dir}/agy.tar.gz" | sha512sum -c -; \
    tar -xzf "${tmp_dir}/agy.tar.gz" -C "${tmp_dir}" antigravity; \
    install -m 755 "${tmp_dir}/antigravity" /usr/local/bin/agy; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    : "${CODEX_VERSION:?CODEX_VERSION build-arg is required}"; \
    : "${CODEX_SHA256_AMD64:?CODEX_SHA256_AMD64 build-arg is required}"; \
    : "${CODEX_SHA256_ARM64:?CODEX_SHA256_ARM64 build-arg is required}"; \
    case "${TARGETARCH:-amd64}" in \
      amd64) codex_target="x86_64-unknown-linux-musl"; codex_sha256="${CODEX_SHA256_AMD64}" ;; \
      arm64) codex_target="aarch64-unknown-linux-musl"; codex_sha256="${CODEX_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    case "${codex_sha256}" in \
      *[!0-9a-f]*|"") echo "Codex sha256 pin is not 64 lowercase hex"; exit 1 ;; \
    esac; \
    if [ "${#codex_sha256}" -ne 64 ]; then echo "Codex sha256 pin must be 64 hex chars"; exit 1; fi; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package-${codex_target}.tar.gz" -o "${tmp_dir}/codex.tar.gz"; \
    echo "${codex_sha256}  ${tmp_dir}/codex.tar.gz" | sha256sum -c -; \
    mkdir -p /usr/local/lib/codex; \
    tar -xzf "${tmp_dir}/codex.tar.gz" -C /usr/local/lib/codex; \
    test -x /usr/local/lib/codex/bin/codex; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) helm_arch="amd64" ;; \
      arm64) helm_arch="arm64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${helm_arch}.tar.gz" -o "${tmp_dir}/helm.tar.gz"; \
    tar -xzf "${tmp_dir}/helm.tar.gz" -C "${tmp_dir}"; \
    install -m 755 "${tmp_dir}/linux-${helm_arch}/helm" /usr/local/bin/helm; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) bun_platform="linux-x64" ;; \
      arm64) bun_platform="linux-aarch64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${bun_platform}.zip" -o "${tmp_dir}/bun.zip"; \
    unzip -q "${tmp_dir}/bun.zip" -d "${tmp_dir}"; \
    install -m 755 "${tmp_dir}/bun-${bun_platform}/bun" /usr/local/bin/bun; \
    rm -rf "${tmp_dir}"

FROM tools AS build

WORKDIR /app/scripts/opencode
COPY scripts/opencode/package.json scripts/opencode/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY scripts/opencode/tsconfig.json ./
COPY scripts/opencode/src ./src
COPY .gitea/opencode-review.json /app/.gitea/opencode-review.json
COPY .gitea/opencode-implement.json /app/.gitea/opencode-implement.json

FROM docker.io/library/debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS runtime

ARG VERSION=dev
ARG REVISION=unknown
ARG YQ_VERSION
ARG YQ_SHA256_AMD64
ARG YQ_SHA256_ARM64
ARG UV_VERSION
ARG UV_SHA256_AMD64
ARG UV_SHA256_ARM64
ARG PROMTOOL_VERSION
ARG PROMTOOL_SHA256_AMD64
ARG PROMTOOL_SHA256_ARM64
ARG TOFU_VERSION
ARG TOFU_SHA256_AMD64
ARG TOFU_SHA256_ARM64
ARG KUBECONFORM_VERSION
ARG KUBECONFORM_SHA256_AMD64
ARG KUBECONFORM_SHA256_ARM64
ARG KUBECTL_VERSION
ARG KUBECTL_SHA256_AMD64
ARG KUBECTL_SHA256_ARM64
ARG TARGETARCH

LABEL org.opencontainers.image.source="https://gitea.kirmanak.stream/personal/jumi" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl file findutils git jq libstdc++6 procps python3 python-is-python3 python3-yaml ripgrep shellcheck unzip \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    : "${YQ_VERSION:?YQ_VERSION build-arg is required}"; \
    : "${YQ_SHA256_AMD64:?YQ_SHA256_AMD64 build-arg is required}"; \
    : "${YQ_SHA256_ARM64:?YQ_SHA256_ARM64 build-arg is required}"; \
    case "${TARGETARCH:-amd64}" in \
      amd64) yq_bin="yq_linux_amd64"; yq_sha256="${YQ_SHA256_AMD64}" ;; \
      arm64) yq_bin="yq_linux_arm64"; yq_sha256="${YQ_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    case "${yq_sha256}" in \
      *[!0-9a-f]*|"") echo "yq sha256 pin is not 64 lowercase hex"; exit 1 ;; \
    esac; \
    if [ "${#yq_sha256}" -ne 64 ]; then echo "yq sha256 pin must be 64 hex chars"; exit 1; fi; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/${yq_bin}" -o "${tmp_dir}/yq"; \
    echo "${yq_sha256}  ${tmp_dir}/yq" | sha256sum -c -; \
    install -m 755 "${tmp_dir}/yq" /usr/local/bin/yq; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    : "${UV_VERSION:?UV_VERSION build-arg is required}"; \
    : "${UV_SHA256_AMD64:?UV_SHA256_AMD64 build-arg is required}"; \
    : "${UV_SHA256_ARM64:?UV_SHA256_ARM64 build-arg is required}"; \
    case "${TARGETARCH:-amd64}" in \
      amd64) uv_target="x86_64-unknown-linux-gnu"; uv_sha256="${UV_SHA256_AMD64}" ;; \
      arm64) uv_target="aarch64-unknown-linux-gnu"; uv_sha256="${UV_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    case "${uv_sha256}" in \
      *[!0-9a-f]*|"") echo "uv sha256 pin is not 64 lowercase hex"; exit 1 ;; \
    esac; \
    if [ "${#uv_sha256}" -ne 64 ]; then echo "uv sha256 pin must be 64 hex chars"; exit 1; fi; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_target}.tar.gz" -o "${tmp_dir}/uv.tar.gz"; \
    echo "${uv_sha256}  ${tmp_dir}/uv.tar.gz" | sha256sum -c -; \
    tar -xzf "${tmp_dir}/uv.tar.gz" -C "${tmp_dir}"; \
    install -m 755 "${tmp_dir}/uv-${uv_target}/uv" /usr/local/bin/uv; \
    install -m 755 "${tmp_dir}/uv-${uv_target}/uvx" /usr/local/bin/uvx; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    : "${PROMTOOL_VERSION:?PROMTOOL_VERSION build-arg is required}"; \
    : "${PROMTOOL_SHA256_AMD64:?PROMTOOL_SHA256_AMD64 build-arg is required}"; \
    : "${PROMTOOL_SHA256_ARM64:?PROMTOOL_SHA256_ARM64 build-arg is required}"; \
    case "${TARGETARCH:-amd64}" in \
      amd64) prom_arch="amd64"; prom_sha256="${PROMTOOL_SHA256_AMD64}" ;; \
      arm64) prom_arch="arm64"; prom_sha256="${PROMTOOL_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    case "${prom_sha256}" in \
      *[!0-9a-f]*|"") echo "promtool sha256 pin is not 64 lowercase hex"; exit 1 ;; \
    esac; \
    if [ "${#prom_sha256}" -ne 64 ]; then echo "promtool sha256 pin must be 64 hex chars"; exit 1; fi; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://github.com/prometheus/prometheus/releases/download/v${PROMTOOL_VERSION}/prometheus-${PROMTOOL_VERSION}.linux-${prom_arch}.tar.gz" -o "${tmp_dir}/prometheus.tar.gz"; \
    echo "${prom_sha256}  ${tmp_dir}/prometheus.tar.gz" | sha256sum -c -; \
    tar -xzf "${tmp_dir}/prometheus.tar.gz" -C "${tmp_dir}"; \
    install -m 755 "${tmp_dir}/prometheus-${PROMTOOL_VERSION}.linux-${prom_arch}/promtool" /usr/local/bin/promtool; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    : "${TOFU_VERSION:?TOFU_VERSION build-arg is required}"; \
    : "${TOFU_SHA256_AMD64:?TOFU_SHA256_AMD64 build-arg is required}"; \
    : "${TOFU_SHA256_ARM64:?TOFU_SHA256_ARM64 build-arg is required}"; \
    case "${TARGETARCH:-amd64}" in \
      amd64) tofu_arch="amd64"; tofu_sha256="${TOFU_SHA256_AMD64}" ;; \
      arm64) tofu_arch="arm64"; tofu_sha256="${TOFU_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    case "${tofu_sha256}" in \
      *[!0-9a-f]*|"") echo "tofu sha256 pin is not 64 lowercase hex"; exit 1 ;; \
    esac; \
    if [ "${#tofu_sha256}" -ne 64 ]; then echo "tofu sha256 pin must be 64 hex chars"; exit 1; fi; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${tofu_arch}.zip" -o "${tmp_dir}/tofu.zip"; \
    echo "${tofu_sha256}  ${tmp_dir}/tofu.zip" | sha256sum -c -; \
    unzip -q "${tmp_dir}/tofu.zip" -d "${tmp_dir}"; \
    install -m 755 "${tmp_dir}/tofu" /usr/local/bin/tofu; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    : "${KUBECONFORM_VERSION:?KUBECONFORM_VERSION build-arg is required}"; \
    : "${KUBECONFORM_SHA256_AMD64:?KUBECONFORM_SHA256_AMD64 build-arg is required}"; \
    : "${KUBECONFORM_SHA256_ARM64:?KUBECONFORM_SHA256_ARM64 build-arg is required}"; \
    case "${TARGETARCH:-amd64}" in \
      amd64) kubeconform_arch="amd64"; kubeconform_sha256="${KUBECONFORM_SHA256_AMD64}" ;; \
      arm64) kubeconform_arch="arm64"; kubeconform_sha256="${KUBECONFORM_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    case "${kubeconform_sha256}" in \
      *[!0-9a-f]*|"") echo "kubeconform sha256 pin is not 64 lowercase hex"; exit 1 ;; \
    esac; \
    if [ "${#kubeconform_sha256}" -ne 64 ]; then echo "kubeconform sha256 pin must be 64 hex chars"; exit 1; fi; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://github.com/yannh/kubeconform/releases/download/v${KUBECONFORM_VERSION}/kubeconform-linux-${kubeconform_arch}.tar.gz" -o "${tmp_dir}/kubeconform.tar.gz"; \
    echo "${kubeconform_sha256}  ${tmp_dir}/kubeconform.tar.gz" | sha256sum -c -; \
    tar -xzf "${tmp_dir}/kubeconform.tar.gz" -C "${tmp_dir}"; \
    install -m 755 "${tmp_dir}/kubeconform" /usr/local/bin/kubeconform; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    : "${KUBECTL_VERSION:?KUBECTL_VERSION build-arg is required}"; \
    : "${KUBECTL_SHA256_AMD64:?KUBECTL_SHA256_AMD64 build-arg is required}"; \
    : "${KUBECTL_SHA256_ARM64:?KUBECTL_SHA256_ARM64 build-arg is required}"; \
    case "${TARGETARCH:-amd64}" in \
      amd64) kubectl_arch="amd64"; kubectl_sha256="${KUBECTL_SHA256_AMD64}" ;; \
      arm64) kubectl_arch="arm64"; kubectl_sha256="${KUBECTL_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    case "${kubectl_sha256}" in \
      *[!0-9a-f]*|"") echo "kubectl sha256 pin is not 64 lowercase hex"; exit 1 ;; \
    esac; \
    if [ "${#kubectl_sha256}" -ne 64 ]; then echo "kubectl sha256 pin must be 64 hex chars"; exit 1; fi; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL --retry 40 --retry-delay 15 --retry-all-errors "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${kubectl_arch}/kubectl" -o "${tmp_dir}/kubectl"; \
    echo "${kubectl_sha256}  ${tmp_dir}/kubectl" | sha256sum -c -; \
    install -m 755 "${tmp_dir}/kubectl" /usr/local/bin/kubectl; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    export UV_PYTHON_INSTALL_DIR=/opt/cpython; \
    /usr/local/bin/uv python install 3.13 --install-dir /opt/cpython --no-bin; \
    case "${TARGETARCH:-amd64}" in \
      amd64) py_bin="/opt/cpython/cpython-3.13-linux-x86_64-gnu/bin/python3.13" ;; \
      arm64) py_bin="/opt/cpython/cpython-3.13-linux-aarch64-gnu/bin/python3.13" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    if [ ! -x "${py_bin}" ]; then py_bin="$(echo /opt/cpython/cpython-3.13-*/bin/python3.13)"; fi; \
    test -x "${py_bin}"; \
    ln -sfn "${py_bin}" /usr/local/bin/python3.13; \
    /usr/local/bin/python3.13 --version
COPY --from=tools /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tools /usr/local/bin/opencode /usr/local/bin/opencode
COPY --from=tools /usr/local/bin/claude /usr/local/bin/claude
COPY --from=tools /usr/local/bin/agy /usr/local/bin/agy
COPY --from=tools /usr/local/lib/codex /usr/local/lib/codex
COPY --from=tools /usr/local/bin/helm /usr/local/bin/helm
RUN ln -sfn /usr/local/lib/codex/bin/codex /usr/local/bin/codex
RUN git --version \
  && rg --version \
  && jq --version \
  && file --version \
  && python3 --version \
  && helm version --short \
  && bun --version \
  && /usr/local/bin/opencode --version \
  && /usr/local/bin/claude --version \
  && /usr/local/bin/agy --version \
  && /usr/local/bin/codex --version \
  && curl --version \
  && yq --version \
  && uv --version \
  && promtool --version \
  && kubeconform -v \
  && tofu version \
  && kubectl version --client \
  && ps --version \
  && unzip -v \
  && shellcheck --version \
  && python --version \
  && python3 -c 'import yaml' \
  && UV_OFFLINE=1 uv run --no-project --python 3.13 python -V

WORKDIR /app/scripts/opencode
COPY --from=build /app/scripts/opencode ./
COPY --from=build /app/.gitea /app/.gitea
COPY review-skills /app/review-skills
# Claude children have no session sqlite for the parent to export, so their
# Phoenix spans come from this vendored hook plugin, passed per spawn with
# `--plugin-dir`. Vendored, not installed: the child never writes to HOME and
# never reaches a registry. It needs jq and python3, both already above.
COPY claude-plugins /app/claude-plugins
RUN set -eu; \
    jq empty /app/claude-plugins/claude-code-tracing/.claude-plugin/plugin.json; \
    for hook in /app/claude-plugins/claude-code-tracing/hooks/*.sh; do bash -n "${hook}"; done
COPY scripts/opencode/entrypoint.sh /app/scripts/opencode/entrypoint.sh
RUN chmod 755 /app/scripts/opencode/entrypoint.sh

RUN groupadd --gid 10001 jumi \
  && useradd --uid 10001 --gid 10001 --home-dir /data --create-home --shell /usr/sbin/nologin jumi \
  && mkdir -p /data /work \
  && chown -R jumi:jumi /data /work

USER 10001:10001

ENV HOME=/data \
    WORKDIR=/work \
    HOST=0.0.0.0 \
    PORT=3000 \
    OPENCODE_CONFIG=/app/.gitea/opencode-review.json \
    OPENCODE_MODEL=openai/gpt-5.5

EXPOSE 3000 3001 3010
ENTRYPOINT ["/app/scripts/opencode/entrypoint.sh"]
CMD ["bun", "run", "src/server.ts"]

ARG TEMURIN_TAG
FROM docker.io/library/eclipse-temurin:${TEMURIN_TAG} AS jdk

FROM runtime AS worker
USER root
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY .gitea/opencode-implement.json /app/.gitea/opencode-implement.json
USER 10001:10001
ENV JAVA_HOME=/opt/java/openjdk \
    OPENCODE_CONFIG=/app/.gitea/opencode-implement.json \
    AGENT_INSTANCE=jumi-worker
ENV PATH="${JAVA_HOME}/bin:${PATH}"
CMD ["bun", "run", "src/worker_server.ts"]
