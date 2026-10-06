ARG BUN_VERSION
ARG HELM_VERSION
ARG TEMURIN_TAG=21.0.12_8-jdk@sha256:92a2a4d7a928d057e7bd999c418d66c26a34eb9a0442f3ab67721c3f88110b2d

FROM docker.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS tools

ARG BUN_VERSION
ARG OPENCODE_VERSION
ARG CLAUDE_VERSION
# Official Antigravity CLI (glibc build; the runtime is Debian, not Alpine).
# Pinned from the installer manifests at
# https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_{amd64,arm64}.json
ARG AGY_VERSION=1.2.7-6731160148115456
ARG AGY_SHA512_AMD64=fec769d611c4afdf0ae72d38bdb2652c8e2c8e71e4f6de97a27b80dda3c50429160d9e03776a36a59b8857c20e76783c4a49cb0feb8b2f5c3bf925b0cc03bb77
ARG AGY_SHA512_ARM64=d39f939ffc80776bfd2dc10db7b9a1a1b58650f08115fa21065c11d10882c71210f368c2e6060f26966d1a33d6b2dd2bc19bfd641062305af6546c51d494511a
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
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${platform}.tar.gz" -o "${tmp_dir}/opencode.tar.gz"; \
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
    curl -fsSL "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${platform}/claude" -o "${tmp_dir}/claude"; \
    install -m 755 "${tmp_dir}/claude" /usr/local/bin/claude; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) agy_path="linux-x64/cli_linux_x64.tar.gz"; agy_sha512="${AGY_SHA512_AMD64}" ;; \
      arm64) agy_path="linux-arm/cli_linux_arm64.tar.gz"; agy_sha512="${AGY_SHA512_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_VERSION}/${agy_path}" -o "${tmp_dir}/agy.tar.gz"; \
    echo "${agy_sha512}  ${tmp_dir}/agy.tar.gz" | sha512sum -c -; \
    tar -xzf "${tmp_dir}/agy.tar.gz" -C "${tmp_dir}" antigravity; \
    install -m 755 "${tmp_dir}/antigravity" /usr/local/bin/agy; \
    rm -rf "${tmp_dir}"
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) helm_arch="amd64" ;; \
      arm64) helm_arch="arm64" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${helm_arch}.tar.gz" -o "${tmp_dir}/helm.tar.gz"; \
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
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${bun_platform}.zip" -o "${tmp_dir}/bun.zip"; \
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

FROM docker.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.source="https://gitea.kirmanak.stream/personal/jumi" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep jq file findutils libstdc++6 python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=tools /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tools /usr/local/bin/opencode /usr/local/bin/opencode
COPY --from=tools /usr/local/bin/claude /usr/local/bin/claude
COPY --from=tools /usr/local/bin/agy /usr/local/bin/agy
COPY --from=tools /usr/local/bin/helm /usr/local/bin/helm
RUN git --version \
  && rg --version \
  && jq --version \
  && file --version \
  && python3 --version \
  && helm version --short \
  && bun --version \
  && /usr/local/bin/opencode version \
  && /usr/local/bin/claude --version \
  && /usr/local/bin/agy --version

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

EXPOSE 3000 3001
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
