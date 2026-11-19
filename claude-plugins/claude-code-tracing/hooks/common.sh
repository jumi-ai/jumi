#!/bin/bash
# Common utilities for Claude Code tracing hooks.
# Vendored from Arize-ai/arize-claude-code-plugin; see ../UPSTREAM.md for the
# commit and for every deviation from upstream.

set -euo pipefail

# --- Config ---
STATE_DIR="${HOME}/.arize-claude-code"

# Derive Claude Code's PID (grandparent) for per-session state isolation
_CLAUDE_PID=$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ') || true
STATE_FILE="${STATE_DIR}/state_${_CLAUDE_PID:-$$}.json"

PHOENIX_ENDPOINT="${PHOENIX_ENDPOINT:-}"
PHOENIX_API_KEY="${PHOENIX_API_KEY:-}"
ARIZE_PROJECT_NAME="${ARIZE_PROJECT_NAME:-}"
ARIZE_USER_ID="${ARIZE_USER_ID:-}"
ARIZE_TRACE_ENABLED="${ARIZE_TRACE_ENABLED:-true}"
ARIZE_DRY_RUN="${ARIZE_DRY_RUN:-false}"
ARIZE_VERBOSE="${ARIZE_VERBOSE:-false}"
# Jumi: prompt text is off unless asked for. The parent injects task, feedback
# and CI prose into the prompt, so it is not span material. Tool arguments and
# results are unaffected.
ARIZE_LOG_PROMPTS="${ARIZE_LOG_PROMPTS:-false}"
# Jumi: file logging is off by default. `-` not `:-`, so an explicitly empty
# value disables it as documented; the pod's /tmp is a small memory emptyDir.
ARIZE_LOG_FILE="${ARIZE_LOG_FILE-}"
# Jumi: seconds any single span POST may take. The parent pins this to 2s
# (same-cluster ClusterIP); 2s is also the fallback so a spawn that lost the
# env cannot stall 10s × tool-calls. After this many failed POSTs, further
# sends are skipped — Claude Code waits for PostToolUse before the next model
# step, so a ClusterIP with no endpoints would otherwise eat OPENCODE_TIMEOUT_MS.
ARIZE_HTTP_TIMEOUT="${ARIZE_HTTP_TIMEOUT:-2}"
PHOENIX_POST_FAILURE_LIMIT=3

# --- Logging ---
# Jumi: the parent reads the child's stderr to classify auth, quota and infra
# death, so the plugin stays off that stream unless verbose is asked for.
_log_to_file() { [[ -n "$ARIZE_LOG_FILE" ]] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$ARIZE_LOG_FILE" || true; }
_log_to_stderr() { [[ "$ARIZE_VERBOSE" == "true" ]] && echo "[arize] $*" >&2 || true; }
log_always() { _log_to_stderr "$*"; _log_to_file "$*"; }
log() { [[ "$ARIZE_VERBOSE" == "true" ]] && log_always "$*" || true; }
error() { _log_to_stderr "ERROR: $*"; _log_to_file "ERROR: $*"; }

# --- Utilities ---
generate_uuid() {
  uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || \
    cat /proc/sys/kernel/random/uuid 2>/dev/null || \
    od -x /dev/urandom | head -1 | awk '{print $2$3"-"$4"-4"substr($5,2)"-a"substr($6,2)"-"$7$8$9}'
}

get_timestamp_ms() {
  # Jumi: bash 5 has EPOCHREALTIME; skip a python3 process per call. python3/date
  # stay as the fallback on older bash.
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    local t=${EPOCHREALTIME/./}
    echo $(( ${t:0:16} / 1000 ))
    return
  fi
  python3 -c "import time; print(int(time.time() * 1000))" 2>/dev/null || \
    date +%s%3N 2>/dev/null || date +%s000
}

# --- State (per-session JSON file with mkdir-based locking) ---
init_state() {
  mkdir -p "$STATE_DIR"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo '{}' > "$STATE_FILE"
  else
    jq empty "$STATE_FILE" 2>/dev/null || echo '{}' > "$STATE_FILE"
  fi
}

_LOCK_DIR="${STATE_DIR}/.lock_${_CLAUDE_PID:-$$}"

_lock_state() {
  local attempts=0
  while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [[ $attempts -gt 30 ]]; then
      # Stale lock recovery after ~3s
      rm -rf "$_LOCK_DIR"
      mkdir "$_LOCK_DIR" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
}

_unlock_state() {
  rmdir "$_LOCK_DIR" 2>/dev/null || true
}

get_state() {
  jq -r ".[\"$1\"] // empty" "$STATE_FILE" 2>/dev/null || echo ""
}

set_state() {
  _lock_state
  local tmp="${STATE_FILE}.tmp.$$"
  jq --arg k "$1" --arg v "$2" '. + {($k): $v}' "$STATE_FILE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE_FILE" || rm -f "$tmp"
  _unlock_state
}

del_state() {
  _lock_state
  local tmp="${STATE_FILE}.tmp.$$"
  jq "del(.[\"$1\"])" "$STATE_FILE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE_FILE" || rm -f "$tmp"
  _unlock_state
}

inc_state() {
  _lock_state
  local val
  val=$(jq -r ".[\"$1\"] // \"0\"" "$STATE_FILE" 2>/dev/null)
  local tmp="${STATE_FILE}.tmp.$$"
  jq --arg k "$1" --arg v "$((${val:-0} + 1))" '. + {($k): $v}' "$STATE_FILE" > "$tmp" 2>/dev/null && mv "$tmp" "$STATE_FILE" || rm -f "$tmp"
  _unlock_state
}

# --- Target Detection ---
# Jumi: Phoenix is the only target. The Arize AX path and its Python
# `opentelemetry` dependency are not vendored.
get_target() {
  if [[ -n "$PHOENIX_ENDPOINT" ]]; then echo "phoenix"
  else echo "none"
  fi
}

# --- HTTP ---
# Jumi: post through python3. The runtime image deliberately ships no curl: the child
# holds a write-capable git token, and a ready-made HTTP client is exactly what
# `src/forge_webfetch.ts` exists to keep away from it. curl is still used when
# it is the only one present.
#
# A failed POST is a log-file line, never output: the client's own diagnostics
# (a Python traceback, a curl message) must not reach the hook's stdout, which
# Claude Code folds into the model's context, nor its stderr, which the parent
# classifies for auth, quota and infra death.
_http_post_json() {
  local url="$1" body_file="$2"
  local err_file rc=0
  err_file=$(mktemp 2>/dev/null) || err_file=/dev/null

  if command -v python3 >/dev/null 2>&1; then
    PHOENIX_POST_URL="$url" \
    PHOENIX_POST_BODY="$body_file" \
    PHOENIX_POST_AUTH="$PHOENIX_API_KEY" \
    PHOENIX_POST_TIMEOUT="$ARIZE_HTTP_TIMEOUT" \
    python3 -c '
import os, urllib.request
with open(os.environ["PHOENIX_POST_BODY"], "rb") as fh:
    body = fh.read()
req = urllib.request.Request(os.environ["PHOENIX_POST_URL"], data=body, method="POST")
req.add_header("Content-Type", "application/json")
auth = os.environ.get("PHOENIX_POST_AUTH", "")
if auth:
    req.add_header("Authorization", "Bearer " + auth)
with urllib.request.urlopen(req, timeout=float(os.environ["PHOENIX_POST_TIMEOUT"])) as resp:
    resp.read()
' >/dev/null 2>"$err_file" || rc=$?
  elif command -v curl >/dev/null 2>&1; then
    local curl_cmd=(curl -sf --max-time "$ARIZE_HTTP_TIMEOUT" -X POST "$url" -H "Content-Type: application/json")
    [[ -n "$PHOENIX_API_KEY" ]] && curl_cmd+=(-H "Authorization: Bearer ${PHOENIX_API_KEY}")
    curl_cmd+=(--data-binary "@${body_file}")
    "${curl_cmd[@]}" >/dev/null 2>"$err_file" || rc=$?
  else
    error "no python3 or curl to send spans"
    rc=1
  fi

  if [[ "$rc" -ne 0 && -s "$err_file" ]]; then
    _log_to_file "span POST failed (exit $rc): $(head -c 500 "$err_file" | tr '\n' ' ')"
  fi
  if [[ "$err_file" != "/dev/null" ]]; then rm -f "$err_file" 2>/dev/null || true; fi
  return "$rc"
}

# --- Send to Phoenix (REST API) ---
send_to_phoenix() {
  local span_json="$1"
  local project="${ARIZE_PROJECT_NAME:-claude-code}"

  # Jumi: `span_kind` comes from the OpenInference attribute the hooks already
  # set. Upstream hardcodes CHAIN, which lands LLM and TOOL spans as chains.
  local payload
  payload=$(echo "$span_json" | jq '{
    data: [.resourceSpans[].scopeSpans[].spans[] | {
      name: .name,
      context: { trace_id: .traceId, span_id: .spanId },
      parent_id: .parentSpanId,
      start_time: ((.startTimeUnixNano | tonumber) / 1e9 | strftime("%Y-%m-%dT%H:%M:%SZ")),
      end_time: ((.endTimeUnixNano | tonumber) / 1e9 | strftime("%Y-%m-%dT%H:%M:%SZ")),
      status_code: "OK",
      attributes: (reduce .attributes[] as $a ({}; . + {($a.key): ($a.value.stringValue // $a.value.intValue // "")}))
    } | .span_kind = (.attributes["openinference.span.kind"] // "CHAIN" | ascii_upcase)]
  }')

  local body_file
  body_file=$(mktemp) || return 1
  printf '%s' "$payload" > "$body_file"
  local rc=0
  _http_post_json "${PHOENIX_ENDPOINT%/}/v1/projects/${project}/spans" "$body_file" || rc=$?
  rm -f "$body_file"
  return "$rc"
}

# --- Main send function ---
send_span() {
  local span_json="$1"
  local target
  target=$(get_target)

  if [[ "$ARIZE_DRY_RUN" == "true" ]]; then
    log_always "DRY RUN: $(echo "$span_json" | jq -c '.resourceSpans[].scopeSpans[].spans[].name')"
    return 0
  fi

  [[ "$ARIZE_VERBOSE" == "true" ]] && echo "$span_json" | jq -c . >&2

  case "$target" in
    phoenix)
      local failures
      failures=$(get_state "phoenix_post_failures")
      if [[ "${failures:-0}" -ge "$PHOENIX_POST_FAILURE_LIMIT" ]]; then
        log "skipping span POST after ${failures} Phoenix failures"
        return 0
      fi
      if ! send_to_phoenix "$span_json"; then
        inc_state "phoenix_post_failures"
        return 0
      fi
      ;;
    *) error "No target. Set PHOENIX_ENDPOINT"; return 1 ;;
  esac

  local span_name
  span_name=$(echo "$span_json" | jq -r '.resourceSpans[0].scopeSpans[0].spans[0].name // "unknown"' 2>/dev/null)
  log "Sent span: $span_name ($target)"
}

# --- Jumi job identity ---
# Every span carries the job id under the same keys the OpenCode sqlite exporter
# writes (`src/phoenix.ts`), so one Phoenix lookup finds a Claude run and an
# OpenCode run of the same job. `session.id` is the job id for the same reason.
jumi_attrs() {
  jq -nc \
    --arg job "${JUMI_JOB_ID:-}" \
    --arg kind "${JUMI_TRACE_KIND:-}" \
    --arg owner "${JUMI_OWNER:-}" \
    --arg repo "${JUMI_REPO:-}" \
    --arg sha "${JUMI_SHA:-}" \
    --arg agent "${JUMI_AGENT_INSTANCE:-}" \
    '(if $job != "" then {"job_id":$job,"session.id":$job} else {} end)
   + (if $kind != "" then {"kind":$kind} else {} end)
   + (if $owner != "" then {"owner":$owner} else {} end)
   + (if $repo != "" then {"repo":$repo} else {} end)
   + (if $sha != "" then {"sha":$sha} else {} end)
   + (if $agent != "" then {"agent_instance":$agent} else {} end)'
}

# --- Build OTLP span ---
build_span() {
  local name="$1" kind="$2" span_id="$3" trace_id="$4"
  local parent="${5:-}"
  local start="$6"
  # Jumi: `end` defaults to `$6` via the `start` local above, not the caller's
  # `$start` (SC2318). `kind` is part of the upstream argv but Jumi derives the
  # span kind from attributes, so reference it to mark the intentional unused.
  local end="${7:-$start}"
  local attrs="${8:-"{}"}"
  : "$kind"
  attrs=$(echo "$attrs" | jq -c --argjson jumi "$(jumi_attrs)" '. + $jumi')

  local parent_json=""
  [[ -n "$parent" ]] && parent_json="\"parentSpanId\": \"$parent\","

  cat <<EOF
{"resourceSpans":[{"resource":{"attributes":[
  {"key":"service.name","value":{"stringValue":"${JUMI_AGENT_INSTANCE:-claude-code}"}}
]},"scopeSpans":[{"scope":{"name":"arize-claude-plugin"},"spans":[{
  "traceId":"$trace_id","spanId":"$span_id",$parent_json
  "name":"$name","kind":1,
  "startTimeUnixNano":"${start}000000","endTimeUnixNano":"${end}000000",
  "attributes":$(echo "$attrs" | jq -c '[to_entries[]|{"key":.key,"value":(if (.value|type)=="number" then (if ((.value|floor) == .value) then {"intValue":.value} else {"doubleValue":.value} end) else {"stringValue":(.value|tostring)} end)}]'),
  "status":{"code":1}
}]}]}]}
EOF
}

# --- Session Resolution (for Agent SDK compatibility) ---

# Resolve session state file using session_id from hook input JSON.
# Call after reading stdin in each hook. Falls back to PID-based key if no session_id.
resolve_session() {
  local input="${1:-'{}'}"
  local sid
  sid=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null || echo "")

  if [[ -n "$sid" ]]; then
    _SESSION_KEY="$sid"
  elif [[ -n "${CLAUDE_SESSION_KEY:-}" ]]; then
    _SESSION_KEY="$CLAUDE_SESSION_KEY"
  else
    # Fall back to current PID-based derivation (already set at source time)
    return 0
  fi

  STATE_FILE="${STATE_DIR}/state_${_SESSION_KEY}.json"
  _LOCK_DIR="${STATE_DIR}/.lock_${_SESSION_KEY}"
  init_state
}

# Idempotent session initialization. If session_id is already in state, returns immediately.
# Used by SessionStart directly and as lazy init fallback in UserPromptSubmit
# (for environments like the Python Agent SDK where SessionStart doesn't fire).
ensure_session_initialized() {
  local input="${1:-'{}'}"

  # Skip if session already initialized
  local existing_sid
  existing_sid=$(get_state "session_id")
  if [[ -n "$existing_sid" ]]; then
    return 0
  fi

  local session_id
  session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null || echo "")
  [[ -z "$session_id" ]] && session_id=$(generate_uuid)

  local project_name="${ARIZE_PROJECT_NAME:-}"
  if [[ -z "$project_name" ]]; then
    local cwd
    cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null || echo "")
    project_name=$(basename "${cwd:-$(pwd)}")
  fi

  set_state "session_id" "$session_id"
  set_state "session_start_time" "$(get_timestamp_ms)"
  set_state "project_name" "$project_name"
  set_state "trace_count" "0"
  set_state "tool_count" "0"

  # Store user ID if provided via env var or hook input
  local user_id="${ARIZE_USER_ID:-}"
  if [[ -z "$user_id" ]]; then
    user_id=$(echo "$input" | jq -r '.user_id // empty' 2>/dev/null || echo "")
  fi
  [[ -n "$user_id" ]] && set_state "user_id" "$user_id"

  log "Session initialized: $session_id"
}

# Garbage-collect orphaned state files.
# Numeric (PID-based) keys go as soon as the PID is gone. Jumi: session-keyed
# files are normally removed by SessionEnd, but a child killed by a timeout or a
# quota abort never fires it, so stale ones are dropped by age instead of
# leaking onto the HOME volume.
gc_stale_state_files() {
  local file_key
  for f in "${STATE_DIR}"/state_*.json; do
    [[ -f "$f" ]] || continue
    file_key=$(basename "$f" | sed 's/state_//;s/\.json//')
    # Only GC numeric (PID-based) keys; skip non-numeric session keys
    if [[ "$file_key" =~ ^[0-9]+$ ]] && ! kill -0 "$file_key" 2>/dev/null; then
      rm -f "$f"
      rm -rf "${STATE_DIR}/.lock_${file_key}"
    fi
  done
  find "$STATE_DIR" -maxdepth 1 -name 'state_*.json' -mtime +1 -delete 2>/dev/null || true
  find "$STATE_DIR" -maxdepth 1 -type d -name '.lock_*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true
}

# --- Init ---
check_requirements() {
  [[ "$ARIZE_TRACE_ENABLED" != "true" ]] && exit 0
  command -v jq &>/dev/null || { error "jq required to send spans"; exit 0; }
  init_state
}
