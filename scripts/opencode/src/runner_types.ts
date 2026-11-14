/**
 * Runner harness type strings, one per engine (`opencode`, `claude`, `agy`,
 * `codex`). Kept in this leaf module so `searxng.ts` can name runner types
 * without importing `runners.ts`, which re-exports from `git.ts` (and would
 * close an import cycle through the worker prompt builders).
 */
export const OPENCODE_RUNNER_TYPE = "opencode";
export const CLAUDE_RUNNER_TYPE = "claude";
export const AGY_RUNNER_TYPE = "agy";
export const CODEX_RUNNER_TYPE = "codex";
