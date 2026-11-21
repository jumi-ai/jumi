import { AGY_RUNNER_TYPE, CLAUDE_RUNNER_TYPE, CODEX_RUNNER_TYPE, OPENCODE_RUNNER_TYPE } from "./runner_types.ts";

/**
 * Per-attempt verdict contract for one review runner spawn.
 *
 * - `required`: the structured verdict behind the parent-owned review MCP
 *   server is mandatory. A `JUMI_REVIEW.md` file in the worktree is stale by
 *   definition and never publishes; an absent or incomplete structured
 *   verdict is an incomplete review after the existing bounded retry policy.
 * - `legacy`: transition fallback for runners without structured-tool
 *   support. The parent publishes from the MCP store when it holds anything
 *   (store wins, as today) and otherwise falls back to the `JUMI_REVIEW.md`
 *   file artifact.
 *
 * Default: derived per attempt from that attempt's runner capability — every
 * pinned runner type (`opencode`, `claude`, `agy`, `codex`) wires the review
 * MCP server, so it requires the structured verdict; an unknown runner type
 * keeps the legacy file fallback. An explicitly selected mode wins over the
 * derivation for every attempt, so a compatible runner can still run the
 * legacy file path during the transition. There is deliberately no
 * repository setting for this: the selection comes from runner configuration
 * the parent already holds, never from pull content.
 */
export const REVIEW_VERDICT_CONTRACT_REQUIRED = "required" as const;
export const REVIEW_VERDICT_CONTRACT_LEGACY = "legacy" as const;

export type ReviewVerdictContract = typeof REVIEW_VERDICT_CONTRACT_REQUIRED | typeof REVIEW_VERDICT_CONTRACT_LEGACY;

/** Runner types the parent wires with the review MCP server. */
const STRUCTURED_VERDICT_RUNNER_TYPES: readonly string[] = [
  OPENCODE_RUNNER_TYPE,
  CLAUDE_RUNNER_TYPE,
  AGY_RUNNER_TYPE,
  CODEX_RUNNER_TYPE,
];

/** Whether this runner type records its verdict through the review MCP tools. */
export function supportsStructuredVerdict(runnerType: string | undefined | null): boolean {
  if (!runnerType) return true;
  return (STRUCTURED_VERDICT_RUNNER_TYPES as readonly string[]).includes(runnerType);
}

/**
 * Selection for one runner attempt, made before the spawn from that attempt's
 * runner. An explicitly selected mode wins; otherwise the runner's
 * capability decides. A failure (including an adapter setup failure) never
 * changes the selection: the attempt keeps the contract it started with.
 */
export function resolveReviewVerdictContract(input: {
  runnerType?: string | null;
  explicit?: ReviewVerdictContract | null;
}): ReviewVerdictContract {
  if (input.explicit === REVIEW_VERDICT_CONTRACT_REQUIRED || input.explicit === REVIEW_VERDICT_CONTRACT_LEGACY) {
    return input.explicit;
  }
  return supportsStructuredVerdict(input.runnerType ?? undefined)
    ? REVIEW_VERDICT_CONTRACT_REQUIRED
    : REVIEW_VERDICT_CONTRACT_LEGACY;
}

/** Whether the file artifact may publish when the store holds nothing. */
export function verdictContractAllowsFileArtifact(contract: ReviewVerdictContract): boolean {
  return contract === REVIEW_VERDICT_CONTRACT_LEGACY;
}
