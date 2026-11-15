import { type CiInspection, inspectCi, resolveRequiredCiContexts as resolveRequiredCiContextsImpl } from "./ci.ts";
import { type ConflictState, readConflictLatch } from "./conflict.ts";
import type { FollowUpState } from "./followup.ts";
import {
  briefInlines,
  collectFollowUpItems,
  type FollowUpItems,
  hasUnhandledFollowUpItems,
  onlyMaintainerQuestionsPending,
  pickLatestJumiFinding,
  reviewFindingMatchOptsForJob,
  triggerBodyFromItems,
  unresolvedJumiInlines,
} from "./followup.ts";
import {
  hasIgnoreConflictsLabel,
  ignoreConflictsAuthorsFromSnapshot,
  ignoreConflictsReason,
  isLeftToAuthor,
  leaveConflictsAuthorReason,
} from "./ignore_conflicts.ts";
import type { Comment, Pull } from "./ports.ts";
import {
  type CiGateWait,
  effectiveBlockingQuestionAuthors,
  effectiveCiGateWait,
  effectiveConflictRounds,
  effectiveFollowupIgnoreLogins,
  effectiveFollowupRounds,
  effectiveIgnoreConflictsLabel,
  effectiveTrustedSenderLogins,
  failOpenLoadFromSnapshot,
  isSuggestionFollowupEnabled,
  type SettingsSnapshot,
} from "./repo_settings.ts";
import type { SkipLatchKey, SkipLatchStore } from "./skip_latches.ts";
import {
  evaluateStuck,
  fingerprintCiChecks,
  fingerprintFindingIdentityFromParts,
  fingerprintFollowUpText,
  fingerprintPrDiffFromFiles,
  fingerprintSameFinding,
  isQuotaStuck,
  readStuckLatch,
  type StuckState,
} from "./stuck.ts";
import type { IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";

export const FOLLOWUP_CI_PENDING_RETRY_MS = 2000;

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function memoize<T>(fn: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) cached = fn();
    return cached;
  };
}

export interface PrSnapshotPr {
  number: number;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  mergeable: boolean | null | undefined;
  labels: Array<string | { name?: string }> | null | undefined;
  author: string | undefined | null;
}

export interface PrSnapshotTrigger {
  event?: string;
  commentId?: number;
  reviewId?: number;
}

export interface PrSnapshotPolicy {
  maxFollowupRounds: number;
  maxConflictRounds: number;
  followupOnSuggestions: boolean;
}

export interface PrSnapshotLists {
  blockingAuthors: string[];
  followupIgnore: string[];
  trusted: readonly string[] | undefined;
  ignoreLabel: string;
  ignoreAuthors: string[] | undefined;
}

export interface PrSnapshotDeployment {
  maxFollowupRounds: number;
  maxConflictRounds: number;
  blockingQuestionAuthors?: readonly string[] | undefined | null;
  followupIgnoreLogins?: readonly string[] | undefined | null;
  trustedSenderLogins?: readonly string[] | undefined | null;
  ignoreConflictsLabel?: string | undefined | null;
}

export interface PrSnapshotOpts {
  owner: string;
  repo: string;
  issueNumber: number;
  pr: Pull;
  job: IssueJob;
  botUsername: string;
  home: string;
  defaultBranch: string;
  deployment: PrSnapshotDeployment;
  /** Single pre-loaded settings read; when absent the builder loads once. */
  settings?: SettingsSnapshot;
  skipLatches: SkipLatchStore;
}

export interface PrSnapshotDeps {
  // biome-ignore lint/suspicious/noExplicitAny: forge fakes vary per test.
  api: any;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface PrSnapshot {
  pr: PrSnapshotPr;
  trigger: PrSnapshotTrigger | undefined;
  settings: SettingsSnapshot;
  policy: PrSnapshotPolicy;
  lists: PrSnapshotLists;
  ciGateWait: CiGateWait;
  latch: {
    followup: FollowUpState;
    conflict: ConflictState;
    stuck: StuckState;
  };
  items: FollowUpItems;
  /** `hasFeedback` after the maintainer-only filter, before the round-cap adjustment. */
  hasFeedback: boolean;
  pendingTriggerBody: string;
  pendingLastReview: Comment | undefined;
  requiredContexts: readonly string[] | undefined;
  ci: CiInspection;
  ciWake: boolean;
  reviewBodyForIdentity: string | undefined;
  findingIdentityHash: string | undefined;
  currentFingerprint: { kind: "action"; hash: string } | { kind: "ci"; hash: string } | undefined;
  /** Memoised thunks for the conditionally-fetched reads. */
  resolveRequiredCiContexts: () => Promise<readonly string[] | undefined>;
  /** Forge `listPullCommits` lookup; always evaluated even when `mergeable !== false`. */
  isLeftToAuthor: () => Promise<boolean>;
  getPrDiffHash: () => Promise<string | undefined>;
  /** Conflict latch read at today's `:1459` point. */
  getConflict: () => Promise<ConflictState>;
  /** `isLeftToAuthor` plus its pure derivations, at today's `:1472` point. */
  getLeftToAuthor: () => Promise<{
    leftToAuthor: boolean;
    leftViaAuthorOnly: boolean;
    leftReason: string;
    conflictedLeftToAuthor: boolean;
  }>;
  /** PR diff hash and same-finding fingerprint, at today's `:1577-1608` point. */
  getSameFinding: () => Promise<{
    prDiffHash: string | undefined;
    sameFindingCurrent: { kind: "finding"; hash: string } | undefined;
  }>;
  /** Stuck latch read at today's `:1613` point. */
  getStuck: () => Promise<StuckState>;
}

function prToSnapshotPr(pr: Pull): PrSnapshotPr {
  return {
    number: pr.number,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseSha: pr.base.sha,
    baseRef: pr.base.ref,
    mergeable: pr.mergeable,
    labels: pr.labels,
    author: pr.user?.login,
  };
}

function triggerToSnapshot(job: IssueJob): PrSnapshotTrigger | undefined {
  const trigger = job.trigger;
  if (!trigger) return undefined;
  return {
    ...(trigger.event ? { event: trigger.event } : {}),
    ...(trigger.commentId !== undefined ? { commentId: trigger.commentId } : {}),
    ...(trigger.reviewId !== undefined ? { reviewId: trigger.reviewId } : {}),
  };
}

/**
 * Gather the per-wake follow-up decision inputs once. The single
 * `.jumi.yml` read is `opts.settings` when provided (the `:1248` load in
 * `implementFollowUp`); otherwise exactly one `loadRepoSettings` happens
 * here. Eager steps run in today's order (items → required contexts → CI
 * with the `workflow_job` retry); the conditionally-fetched reads stay
 * memoised thunks evaluated at most once.
 */
export async function buildFollowUpSnapshot(opts: PrSnapshotOpts, deps: PrSnapshotDeps): Promise<PrSnapshot> {
  const log = deps.log;
  const sleepFn = deps.sleep ?? sleepDefault;
  const api = deps.api;
  const latchKey: SkipLatchKey = { owner: opts.owner, repo: opts.repo, issueNumber: opts.issueNumber };

  let settings = opts.settings;
  if (!settings) {
    const { loadSettingsSnapshot } = await import("./repo_settings.ts");
    settings = await loadSettingsSnapshot(api, opts.owner, opts.repo, opts.defaultBranch);
    if (settings.state === "loaded" && settings.load.state === "invalid") {
      log?.(`follow-up settings invalid for ${opts.owner}/${opts.repo}@${opts.defaultBranch}: ${settings.load.error}`);
    }
    if (settings.state === "threw") {
      log?.(
        `follow-up settings unreadable for ${opts.owner}/${opts.repo}@${opts.defaultBranch}: ${errorMessage(settings.error)}`
      );
    }
  }
  const failOpen = failOpenLoadFromSnapshot(settings);
  const policy: PrSnapshotPolicy = {
    maxFollowupRounds: effectiveFollowupRounds(opts.deployment.maxFollowupRounds, failOpen),
    maxConflictRounds: effectiveConflictRounds(opts.deployment.maxConflictRounds, failOpen),
    followupOnSuggestions: isSuggestionFollowupEnabled(failOpen),
  };
  const lists: PrSnapshotLists = {
    blockingAuthors: effectiveBlockingQuestionAuthors(opts.deployment.blockingQuestionAuthors, failOpen),
    followupIgnore: effectiveFollowupIgnoreLogins(opts.deployment.followupIgnoreLogins, failOpen),
    trusted: effectiveTrustedSenderLogins(opts.deployment.trustedSenderLogins, failOpen),
    ignoreLabel: effectiveIgnoreConflictsLabel(opts.deployment.ignoreConflictsLabel, failOpen),
    ignoreAuthors: ignoreConflictsAuthorsFromSnapshot(settings),
  };
  const ciGateWait = effectiveCiGateWait(failOpen);

  const { readFollowUpLatch } = await import("./followup.ts");
  const followupLatch = await readFollowUpLatch(opts.skipLatches, latchKey);

  const findingOpts = reviewFindingMatchOptsForJob(
    opts.job,
    opts.pr.head.sha,
    opts.pr.user?.login,
    lists.blockingAuthors,
    policy.followupOnSuggestions
  );
  const items = await collectFollowUpItems(
    api,
    opts.owner,
    opts.repo,
    opts.pr.number,
    opts.botUsername,
    opts.pr.head.sha,
    lists.followupIgnore,
    findingOpts,
    lists.trusted
  );
  const pendingTriggerBody = triggerBodyFromItems(opts.job.trigger, items);
  const pendingLastReview = pickLatestJumiFinding(items, opts.pr.head.sha);
  let hasFeedback = hasUnhandledFollowUpItems(items, followupLatch);
  if (hasFeedback && onlyMaintainerQuestionsPending(items, followupLatch, opts.botUsername)) {
    hasFeedback = false;
  }

  const resolveRequiredCiContexts = memoize(async (): Promise<readonly string[] | undefined> => {
    if (ciGateWait !== "all" && ciGateWait !== "none") {
      return await resolveRequiredCiContextsImpl(api, {
        owner: opts.owner,
        repo: opts.repo,
        issueNumber: opts.issueNumber,
        baseBranch: opts.pr.base.ref,
        log,
      });
    }
    return undefined;
  });
  // Resolve exactly where today's code calls it, in the same order.
  const requiredContexts = await resolveRequiredCiContexts();

  const inspectOpts = {
    api,
    owner: opts.owner,
    repo: opts.repo,
    sha: opts.pr.head.sha,
    home: opts.home,
    issueNumber: opts.issueNumber,
    skipLatches: opts.skipLatches,
    log,
    ...(requiredContexts ? { requiredContexts } : {}),
    ...(ciGateWait !== "required" ? { wait: ciGateWait } : {}),
  };
  let ci: CiInspection = {
    sha: opts.pr.head.sha,
    pending: false,
    failed: [],
    unhandled: [],
    empty: true,
    checks: [],
    pendingOptional: [],
  };
  try {
    ci = await inspectCi(inspectOpts);
  } catch (err) {
    log?.(`CI inspect failed for ${opts.owner}/${opts.repo}#${opts.issueNumber}: ${errorMessage(err)}`);
  }
  if (ci.pending && opts.job.trigger?.event === "workflow_job") {
    try {
      await sleepFn(FOLLOWUP_CI_PENDING_RETRY_MS);
      ci = await inspectCi(inspectOpts);
    } catch (err) {
      log?.(`CI inspect failed for ${opts.owner}/${opts.repo}#${opts.issueNumber}: ${errorMessage(err)}`);
    }
  }
  const ciWake = !ci.pending && ci.unhandled.length > 0;

  const conflictLatch = await readConflictLatch(opts.skipLatches, latchKey);
  const stuckLatch = await readStuckLatch(opts.skipLatches, latchKey);
  const getConflict = memoize(async (): Promise<ConflictState> => conflictLatch);
  const getStuck = memoize(async (): Promise<StuckState> => stuckLatch);

  const isLeftToAuthorThunk = memoize(async (): Promise<boolean> => {
    return await isLeftToAuthor(
      api,
      opts.owner,
      opts.repo,
      opts.pr,
      {
        botUsername: opts.botUsername,
        ignoreConflictsLabel: lists.ignoreLabel,
        ignoreConflictsAuthors: lists.ignoreAuthors,
        prAuthor: opts.pr.user?.login,
        defaultBranch: opts.defaultBranch,
      },
      log
    );
  });
  const getLeftToAuthor = memoize(async () => {
    // Evaluated even when `pr.mergeable !== false`; only the use is gated.
    const leftToAuthor = await isLeftToAuthorThunk();
    const prForLabel = { labels: opts.pr.labels };
    const leftViaAuthorOnly =
      leftToAuthor && !hasIgnoreConflictsLabel(prForLabel, lists.ignoreLabel) && (lists.ignoreAuthors?.length ?? 0) > 0;
    const leftReason = leftViaAuthorOnly
      ? leaveConflictsAuthorReason(opts.pr.user?.login)
      : ignoreConflictsReason(lists.ignoreLabel);
    const conflictedLeftToAuthor = opts.pr.mergeable === false && leftToAuthor;
    return { leftToAuthor, leftViaAuthorOnly, leftReason, conflictedLeftToAuthor };
  });

  const { buildFeedbackMarkdown: buildPreview } = await import("./followup.ts");
  const feedbackPreview = buildPreview({
    pr: opts.pr,
    trigger: opts.job.trigger,
    triggerBody: pendingTriggerBody,
    comments: items.comments,
    inlines: briefInlines(items),
    reviews: items.reviews,
    lastReview: pendingLastReview,
    currentInlines: unresolvedJumiInlines(items),
  });
  const findingHash = hasFeedback ? fingerprintFollowUpText(feedbackPreview.markdown) : undefined;
  const ciHash = hasFeedback ? undefined : fingerprintCiChecks(ci.unhandled);
  const currentFingerprint = findingHash
    ? { kind: "action" as const, hash: findingHash }
    : ciHash
      ? { kind: "ci" as const, hash: ciHash }
      : undefined;

  const reviewBodyForIdentity = pendingLastReview?.body ?? undefined;
  const jumiInlinesForIdentity = unresolvedJumiInlines(items);
  const findingIdentityHash = hasFeedback
    ? fingerprintFindingIdentityFromParts(reviewBodyForIdentity, jumiInlinesForIdentity)
    : undefined;

  const getPrDiffHash = memoize(async (): Promise<string | undefined> => {
    if (!findingIdentityHash) return undefined;
    try {
      const getFiles = (
        api as unknown as {
          getPRFiles?: (
            owner: string,
            repo: string,
            index: number
          ) => Promise<
            ReadonlyArray<{
              filename: string;
              patch?: string | null | undefined;
              status?: string | null | undefined;
              additions?: number | null | undefined;
              deletions?: number | null | undefined;
              changes?: number | null | undefined;
            }>
          >;
        }
      ).getPRFiles;
      if (typeof getFiles !== "function") return undefined;
      const files = await getFiles.call(api, opts.owner, opts.repo, opts.pr.number);
      return fingerprintPrDiffFromFiles(files);
    } catch (err) {
      log?.(`same-finding diff unavailable for ${opts.owner}/${opts.repo}#${opts.pr.number}: ${errorMessage(err)}`);
      return undefined;
    }
  });
  const getSameFinding = memoize(async () => {
    const prDiffHash = await getPrDiffHash();
    const sameFindingCurrent =
      findingIdentityHash && prDiffHash
        ? { kind: "finding" as const, hash: fingerprintSameFinding(findingIdentityHash, prDiffHash) }
        : undefined;
    return { prDiffHash, sameFindingCurrent };
  });
  // Touch the pure evaluators here so a behavior drift fails fast; the
  // if-chain re-evaluates them in order from the same snapshot fields.
  void isQuotaStuck(stuckLatch);
  if (currentFingerprint) void evaluateStuck(stuckLatch.fingerprints, currentFingerprint);

  return {
    pr: prToSnapshotPr(opts.pr),
    trigger: triggerToSnapshot(opts.job),
    settings,
    policy,
    lists,
    ciGateWait,
    latch: { followup: followupLatch, conflict: conflictLatch, stuck: stuckLatch },
    items,
    hasFeedback,
    pendingTriggerBody,
    pendingLastReview,
    requiredContexts,
    ci,
    ciWake,
    reviewBodyForIdentity,
    findingIdentityHash,
    currentFingerprint,
    resolveRequiredCiContexts,
    isLeftToAuthor: isLeftToAuthorThunk,
    getPrDiffHash,
    getConflict,
    getLeftToAuthor,
    getSameFinding,
    getStuck,
  };
}
