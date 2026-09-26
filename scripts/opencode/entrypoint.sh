#!/bin/sh
# Copy forge secrets to a 0600 tmpfs file, drop them from the environment, then
# exec the server so /proc/self/environ is the cleaned execve image.
# Linux does not rewrite /proc/<pid>/environ on unsetenv(3).
set -eu

if [ "${JUMI_ENV_SCRUBBED:-}" = "1" ]; then
  exec "$@"
fi

tmp_root="${TMPDIR:-/tmp}"
file=$(mktemp "${tmp_root}/jumi-secrets.XXXXXX")
chmod 600 "$file"

export JUMI_SECRETS_FILE="$file"
bun --eval '
const keys = ["GITEA_BOT_TOKEN", "GITEA_WEBHOOK_SECRET", "GITEA_WEBHOOK_AUTH_TOKEN", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "BOARD_PEER_TOKEN"];
const out = {};
for (const key of keys) {
  const value = process.env[key];
  if (value) out[key] = value;
}
const dest = process.env.JUMI_SECRETS_FILE;
if (!dest) throw new Error("JUMI_SECRETS_FILE is required");
await Bun.write(dest, JSON.stringify(out));
'
export JUMI_ENV_SCRUBBED=1
unset GITEA_BOT_TOKEN GITEA_WEBHOOK_SECRET GITEA_WEBHOOK_AUTH_TOKEN GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET BOARD_PEER_TOKEN
exec "$@"
