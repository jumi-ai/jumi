/**
 * Shared shell-child helpers for the repository `setup` and `verify` steps.
 *
 * Both steps run a repository-chosen shell script from the worktree root with
 * `sh -e` in a credential-free child, capture stdout and stderr together,
 * and redact the output before it reaches the log, the prompt, or the PR
 * body. One copy so timeout-kill races and redaction shapes cannot drift.
 */

import { childScratchDir } from "./engine_scratch.ts";
import { errorMessage } from "./util/error.ts";
import { redactGitSecrets } from "./workspace.ts";

/** Last bytes of child output kept for the log and the prompt. */
export const REPO_SCRIPT_OUTPUT_TAIL_BYTES = 4 * 1024;

/** Total child output kept in memory (tail-kept, size-capped). */
const REPO_SCRIPT_OUTPUT_MAX_BYTES = 64 * 1024;

export interface RepoChildScriptResult {
  status: "ok" | "failed" | "timeout";
  exitCode?: number | null;
  /** Combined stdout+stderr, redacted and size-capped. */
  output: string;
  durationMs: number;
}

/** Escape `<`, `>`, `&` for prompt blocks. */
export function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Credential shapes the caller did not pass in: other PATs, JWTs, query
 * secrets, userinfo. Same shapes `forge_errors.ts` scrubs from forge text, so
 * a token-shaped string in child output never reaches the log or the prompt.
 */
function scrubRepoScriptCredentialShapes(text: string): string {
  return text
    .replace(/(:\/\/[^/@\s]+:)[^/@\s]+@/g, "$1***@")
    .replace(
      /((?:^|[?&#\s])(?:access_token|refresh_token|id_token|x-amz-security-token|x-amz-signature|x-amz-credential|client_secret|api_token|api_key|apikey|password|passwd|signature|secret|token|auth|authorization|jwt|sig)=)[^&#\s"'<>]*/gi,
      "$1***"
    )
    .replace(
      /("(?:access_token|refresh_token|id_token|password|client_secret|api_key|api_token|secret|token|jwt)"\s*:\s*")[^"]*/gi,
      "$1***"
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, "$1 ***")
    .replace(/\btoken\s+[A-Za-z0-9._~+/=-]{20,}/g, "token ***")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "***")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, "***");
}

/** Redact child output the way engine output already is, plus token shapes. */
export function redactRepoScriptOutput(text: string, secrets: readonly (string | undefined)[] = []): string {
  return scrubRepoScriptCredentialShapes(redactGitSecrets(text, secrets));
}

/** Last `maxBytes` of `text` by UTF-8 bytes. */
export function tailBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  // Slice on bytes, then decode with fatal off: a split multi-byte sequence
  // decodes with replacement chars rather than throwing.
  return new TextDecoder().decode(bytes.slice(bytes.byteLength - maxBytes));
}

async function readStreamTail(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ text: string; totalBytes: number }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let kept = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      kept += value.byteLength;
      while (kept > maxBytes && chunks.length > 0) {
        const overflow = kept - maxBytes;
        const first = chunks[0];
        if (!first) break;
        if (first.byteLength <= overflow) {
          chunks.shift();
          kept -= first.byteLength;
        } else {
          chunks[0] = first.slice(overflow);
          kept -= overflow;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), totalBytes: total };
}

/**
 * Run `run` as a shell script from `workdir` with `sh -e`. Captures stdout
 * and stderr together, redacted and size-capped. Spawns in its own process
 * group (via `setsid` when available) and kills the group on timeout.
 */
export async function runRepoChildScript(opts: {
  workdir: string;
  run: string;
  timeoutMs: number;
  env: Record<string, string>;
}): Promise<RepoChildScriptResult> {
  const { mkdir } = await import("node:fs/promises");
  const scratch = opts.env.TMPDIR ?? childScratchDir(opts.workdir);
  await mkdir(scratch, { recursive: true }).catch(() => undefined);
  const startedAt = Date.now();
  const useSetsid =
    typeof (Bun as unknown as { which?: (cmd: string) => string | null }).which === "function"
      ? Boolean((Bun as unknown as { which: (cmd: string) => string | null }).which("setsid"))
      : false;
  const args = useSetsid ? ["setsid", "sh", "-e", "-c", opts.run] : ["sh", "-e", "-c", opts.run];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, {
      cwd: opts.workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env,
    });
  } catch (err) {
    return {
      status: "failed",
      exitCode: null,
      output: redactRepoScriptOutput(errorMessage(err)),
      durationMs: Date.now() - startedAt,
    };
  }
  const pid = proc.pid;
  let timedOut = false;
  const timer =
    opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          // Kill the whole process group first (the child runs under
          // `setsid`), then the direct child as a fallback.
          if (useSetsid) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {}
          }
          try {
            proc.kill();
          } catch {}
          // SIGKILL fallback for a group kill that did not land.
          if (useSetsid) {
            try {
              proc.kill(9 as unknown as undefined);
            } catch {}
          }
        }, opts.timeoutMs)
      : undefined;
  let stdout = { text: "", totalBytes: 0 };
  let stderr = { text: "", totalBytes: 0 };
  let exitCode: number | null = null;
  try {
    const stdoutStream = proc.stdout as unknown as ReadableStream<Uint8Array>;
    const stderrStream = proc.stderr as unknown as ReadableStream<Uint8Array>;
    [stdout, stderr, exitCode] = await Promise.all([
      readStreamTail(stdoutStream, REPO_SCRIPT_OUTPUT_MAX_BYTES),
      readStreamTail(stderrStream, REPO_SCRIPT_OUTPUT_MAX_BYTES),
      proc.exited,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Belt and suspenders: a timed-out group kill that raced the exit leaves
    // no orphan behind.
    if (timedOut && useSetsid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  }
  const durationMs = Date.now() - startedAt;
  // The OpenCode CLI maps 130 to 143; a shell killed by SIGTERM reads
  // the same way.
  if (exitCode === 130) exitCode = 143;
  const combined = [stdout.text, stderr.text].filter(Boolean).join("\n");
  const output = redactRepoScriptOutput(combined);
  if (timedOut) return { status: "timeout", exitCode, output, durationMs };
  if (exitCode !== 0) return { status: "failed", exitCode, output, durationMs };
  return { status: "ok", exitCode, output, durationMs };
}
