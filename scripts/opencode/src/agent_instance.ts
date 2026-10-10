/**
 * Identity of the factory source this process belongs to.
 *
 * It is the Prometheus `agent_instance` label on `/metrics` and the Phoenix
 * project every trace from this pod lands in. The engine image leaves it at
 * `jumi`; the worker image sets `jumi-worker`.
 *
 * Every runner must resolve it the same way, so there is exactly one reader:
 * OpenCode traces (`phoenix.ts`), Claude traces (`claude_tracing.ts`), Codex
 * traces (`codex_tracing.ts`) and token metrics (`token_metrics.ts`) all land
 * under the same project name rather than a per-harness dump.
 */
export function agentInstance(): string {
  return process.env.AGENT_INSTANCE?.trim() || "jumi";
}
