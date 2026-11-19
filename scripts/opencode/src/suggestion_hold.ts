import { JUMI_REVIEW_CONTEXT } from "./ci.ts";
import type { IssueApi } from "./ports.ts";
import type { SkipLatchKey, SkipLatchStore } from "./skip_latches.ts";
import {
  GITEA_STATUS_DESCRIPTION_MAX_BYTES,
  omitOpenCodeStderr,
  truncateStatusDescription,
} from "./status_description.ts";

export interface SuggestionHold {
  consumed?: boolean;
  headSha?: string;
  count?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

/** Read the one-hold flag from the `followup` latch cell. Missing means no hold yet. */
export async function readSuggestionHold(store: SkipLatchStore, key: SkipLatchKey): Promise<SuggestionHold> {
  const rec = await store.get(key);
  const hold = asRecord(asRecord(rec.followup).suggestionHold);
  return {
    ...(hold.consumed === true ? { consumed: true as const } : {}),
    ...(typeof hold.headSha === "string" && hold.headSha ? { headSha: hold.headSha as string } : {}),
    ...(typeof hold.count === "number" && Number.isSafeInteger(hold.count) && (hold.count as number) > 0
      ? { count: hold.count as number }
      : {}),
  };
}

/** Mark the one hold consumed for this skip-latch generation. Never clears until the generation bumps. */
export async function markSuggestionHoldConsumed(
  store: SkipLatchStore,
  key: SkipLatchKey,
  headSha: string,
  count: number
): Promise<void> {
  const rec = await store.get(key);
  const followup = asRecord(rec.followup);
  await store.put(key, {
    followup: {
      ...followup,
      suggestionHold: { consumed: true, headSha: headSha.toLowerCase(), count },
    },
  });
}

export function suggestionHoldPendingDescription(count: number): string {
  return `${count} suggestion${count === 1 ? "" : "s"} waiting for follow-up`;
}

export function suggestionHoldCompletedDescription(count: number): string {
  return `${count} suggestion${count === 1 ? "" : "s"} (follow-up completed)`;
}

export function suggestionHoldSkippedDescription(count: number, reason: string): string {
  const clean = reason.trim() || "follow-up skipped";
  return `${count} suggestion${count === 1 ? "" : "s"} (follow-up skipped: ${clean})`;
}

function holdStatusDescription(description: string): string {
  return truncateStatusDescription(omitOpenCodeStderr(description), {
    maxBytes: GITEA_STATUS_DESCRIPTION_MAX_BYTES,
  });
}

export interface HoldStatusApi {
  createCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    status: {
      state: "success" | "pending" | "failure" | "error" | "warning";
      context?: string;
      description?: string;
      target_url?: string;
    }
  ): Promise<unknown>;
}

/**
 * Narrow port for the one status write the hold needs. The extra optional
 * `getIssue` exists only so `IssueApi` holders satisfy the weak-type check
 * (an `IssueApi` has no `createCommitStatus`); it is never read here. Both
 * adapters and the shared forge fake satisfy it, and a missing
 * `createCommitStatus` is an explicit no-op with the same runtime result as
 * the old `try/catch` around a missing method.
 */
export type HoldStatusPort = Partial<HoldStatusApi> & Partial<Pick<IssueApi, "getIssue">>;

/** Resolve a held `pending` to `success` with a note. Throws on failure. */
export async function postSuggestionHoldSuccessOrThrow(
  api: HoldStatusPort,
  owner: string,
  repo: string,
  headSha: string,
  description: string,
  targetUrl?: string
): Promise<void> {
  const create = api.createCommitStatus;
  if (typeof create !== "function") throw new Error("missing createCommitStatus");
  await create.call(api, owner, repo, headSha, {
    state: "success",
    context: JUMI_REVIEW_CONTEXT,
    description: holdStatusDescription(description),
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}

/** Resolve a held `pending` to `success` with a note. Never throws. */
export async function postSuggestionHoldSuccess(
  api: HoldStatusPort,
  owner: string,
  repo: string,
  headSha: string,
  description: string,
  targetUrl?: string
): Promise<void> {
  try {
    const create = api.createCommitStatus;
    if (typeof create !== "function") return;
    await create.call(api, owner, repo, headSha, {
      state: "success",
      context: JUMI_REVIEW_CONTEXT,
      description: holdStatusDescription(description),
      ...(targetUrl ? { target_url: targetUrl } : {}),
    });
  } catch {
    // Best-effort: never fail the job on a status post.
  }
}
