/**
 * Shared skip-reason texts. Leaf module: no imports, so `pr_decision.ts` can
 * import these constants while `stuck.ts`, `quota.ts`, `conflict.ts` and the
 * other producers import them back without forming a cycle.
 *
 * Every string below is frozen stored text (`skip_reason`, ledger
 * `result_reason`, sticky comments, status descriptions). Do not reword any
 * of them: the parser in `pr_decision.ts` and several stored rows depend on
 * the exact bytes.
 */

/** Issue-wide latch when a closer used up its follow-up rounds. */
export const TOO_MANY_FOLLOWUP_ROUNDS_REASON = "stuck: too many follow-up rounds";

/** Bare same-finding latch text, without the human display suffix. */
export const SAME_FINDING_STUCK_TEXT = "stuck: same finding repeated";

/** Dependency graph has a cycle (or hit the graph cap). */
export const DEPENDENCY_CYCLE_REASON = "stuck: dependency cycle";

/** A `JUMI_BLOCKED.md` yield pointed at an unknown id. */
export const BLOCKED_BY_REJECTED_STUCK = "stuck: blocked-by rejected";

/** Plan-limit quota exhaustion. */
export const QUOTA_STUCK_TEXT = "stuck: usage limit exceeded";

/** Monthly-credit exhaustion. Distinct so the operator sees the credit ran out. */
export const CREDIT_STUCK_TEXT = "stuck: credit balance is too low";

/** Reviewer-side incomplete review latch. */
export const INCOMPLETE_REVIEW_STUCK = "stuck: incomplete review";

/** Bare merge-default failure, without the counted `(round/max)` suffix. */
export const MERGE_DEFAULT_STUCK_TEXT = "stuck: cannot resolve conflicts";

/** Counted conflict-cap prefix: `stuck: cannot resolve conflicts (R/M conflict rounds)`. */
export const CONFLICT_CAP_PREFIX = "stuck: cannot resolve conflicts";

/** Legacy conflict-latch prefix, covering older `stuck: conflict ...` variants. */
export const CONFLICT_LEGACY_PREFIX = "stuck: conflict";

/** Ignore-conflicts leave prefix, shared by the label and author reason builders. */
export const IGNORE_CONFLICTS_PREFIX = "conflicted, left to author";

/** Hold/short text for a round-capped follow-up. Never a sit. */
export const ROUND_CAP_HOLD_TEXT = "round cap";

/** Family prefix for infra-flake skips: `CI infra flake: <reasons>`. */
export const FLAKE_PREFIX = "CI infra flake:";

/** Placeholder canonical text for the `stuck-other` catch-all row. Never emitted by `decide()`. */
export const STUCK_OTHER_TEXT = "stuck: other";
