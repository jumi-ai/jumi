import { runAgy } from "./agy.ts";
import { runClaude } from "./claude.ts";
import { runCodex } from "./codex.ts";
import { type Engine, EngineFailedError, type EngineResult, type EngineRunOptions } from "./engine.ts";
import { runOpenCode } from "./git.ts";
import { AGY_RUNNER_TYPE, CLAUDE_RUNNER_TYPE, CODEX_RUNNER_TYPE, OPENCODE_RUNNER_TYPE } from "./runners.ts";

export async function runRegisteredEngine(opts: EngineRunOptions): Promise<EngineResult> {
  const type = opts.type ?? OPENCODE_RUNNER_TYPE;
  if (type === CLAUDE_RUNNER_TYPE) return runClaude(opts);
  if (type === AGY_RUNNER_TYPE) return runAgy(opts);
  if (type === CODEX_RUNNER_TYPE) return runCodex(opts);
  if (type === OPENCODE_RUNNER_TYPE) return runOpenCode(opts);
  throw new EngineFailedError(`Unknown runner type: ${type}`, false);
}

export const registeredEngine: Engine = runRegisteredEngine;
