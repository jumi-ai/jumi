import { type CiInspection, inspectCi, resolveRequiredCiContexts as resolveRequiredCiContextsImpl } from "./ci.ts";
import { inspectBaseCi } from "./ci_base.ts";
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
import { isEligibleWorkerPR } from "./gitea_issues.ts";
import {
  hasIgnoreConflictsLabel,
  hasJumiCommitOnPull,
  ignoreConflictsAuthorsFromSnapshot,
  ignoreConflictsReason,
  isIgnoreConflictsAuthor,
  isLeftToAuthor,
  leaveConflictsAuthorReason,
} from "./ignore_conflicts.ts";
import type { Comment, Pull } from "./ports.ts";
import type { CloserSnapshot, PrDecisionSnapshot } from "./pr_decision.ts";
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
  isRiskFollowupEnabled,
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

const FOLLOWUP_CI_PENDING_RETRY_MS = 2000;

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

interface PrSnapshotPr {
  number: number;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  mergeable: boolean | null | undefined;
  labels: Array<string | { name?: string }> | null | undefined;
  author: string | undefined | null;
}

interface PrSnapshotTrigger {
  event?: string;
  commentId?: number;
  reviewId?: number;
}

interface PrSnapshotPolicy {
  maxFollowupRounds: number;
  maxConflictRounds: number;
  followupOnSuggestions: boolean;
  followupOnRisks: boolean;
}

interface PrSnapshotLists {
  blockingAuthors: string[];
  followupIgnore: string[];
  trusted: readonly string[] | undefined;
  ignoreLabel: string;
  ignoreAuthors: string[] | undefined;
}

interface PrSnapshotDeployment {
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
    followupOnRisks: isRiskFollowupEnabled(failOpen),
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
    policy.followupOnSuggestions,
    policy.followupOnRisks
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
  // Base-branch evidence for the worker: once the head's CI has settled red,
  // resolve the same checks on the base commit so JUMI_CI.md shows "green on
  // base" directly. Fail-open: a missing base SHA or lookup failure leaves `ci`
  // without base fields and today's handling applies.
  if (!ci.pending && ci.unhandled.length > 0 && (opts.pr.base.sha ?? "").trim()) {
    try {
      const base = await inspectBaseCi({
        api,
        owner: opts.owner,
        repo: opts.repo,
        baseSha: opts.pr.base.sha,
        log,
      });
      if (base) {
        ci = {
          ...ci,
          baseSha: base.sha,
          baseResults: base.results,
          ...(base.lookupFailed ? { baseLookupFailed: true as const } : {}),
        };
      }
    } catch (err) {
      log?.(`base CI inspect failed for ${opts.owner}/${opts.repo}#${opts.issueNumber}: ${errorMessage(err)}`);
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

export interface CloserSnapshotOpts {
  owner: string;
  repo: string;
  pr: Pull;
  issueNumber: number;
  botUsername: string;
  home: string;
  maxFollowupRounds?: number;
  maxConflictRounds?: number;
  followupIgnoreLogins?: readonly string[];
  trustedSenderLogins?: readonly string[];
  blockingQuestionAuthors?: readonly string[];
  skipLatches?: SkipLatchStore;
  ignoreConflictsLabel?: string;
  ignoreConflictsAuthors?: readonly string[];
  defaultBranch?: string;
  settings?: SettingsSnapshot;
}

export interface CloserSnapshotDeps {
  // biome-ignore lint/suspicious/noExplicitAny: forge fakes vary per test.
  api: any;
  log?: (message: string) => void;
}

export interface CloserSnapshotBuild {
  snapshot: CloserSnapshot;
  ignoreAuthorsUnreadable: boolean;
  settings: SettingsSnapshot;
}

/**
 * Single-load closer snapshot for `classifyCloserWork`. One `.jumi.yml`
 * read (via `opts.settings` when provided, otherwise one
 * `loadSettingsSnapshot`); every lane derives from that load. Lane order is
 * follow-up → CI → conflict so an earlier lane's throw still aborts before
 * later forge reads. The CI lane fail-closes to "no work" and the conflict
 * latch is read only after the eligibility and `mergeable` gates, matching
 * the three wrappers' conditional fetches.
 */
export async function buildCloserSnapshot(
  opts: CloserSnapshotOpts,
  deps: CloserSnapshotDeps
): Promise<CloserSnapshotBuild> {
  const api = deps.api;
  const log = deps.log;
  const deploymentMaxFollowup = opts.maxFollowupRounds ?? 3;
  const deploymentMaxConflict = opts.maxConflictRounds ?? 3;

  let settings = opts.settings;
  if (!settings) {
    let settingsBranch = opts.defaultBranch?.trim() ? opts.defaultBranch.trim() : "";
    if (!settingsBranch && typeof api?.getRepo === "function") {
      try {
        const repoInfo = await api.getRepo(opts.owner, opts.repo);
        settingsBranch = repoInfo?.default_branch?.trim() ? repoInfo.default_branch.trim() : "";
      } catch {
        settingsBranch = "";
      }
    }
    if (!settingsBranch) {
      settings = { state: "no-branch" };
    } else {
      const { loadSettingsSnapshot } = await import("./repo_settings.ts");
      settings = await loadSettingsSnapshot(api, opts.owner, opts.repo, settingsBranch);
    }
  }
  const failOpen = failOpenLoadFromSnapshot(settings);
  const maxFollowupRounds = effectiveFollowupRounds(deploymentMaxFollowup, failOpen);
  const maxConflictRounds = effectiveConflictRounds(deploymentMaxConflict, failOpen);
  const blockingAuthors = effectiveBlockingQuestionAuthors(opts.blockingQuestionAuthors, failOpen);
  const followupIgnore = effectiveFollowupIgnoreLogins(opts.followupIgnoreLogins, failOpen);
  const trusted = effectiveTrustedSenderLogins(opts.trustedSenderLogins, failOpen);
  const ignoreLabel = effectiveIgnoreConflictsLabel(opts.ignoreConflictsLabel, failOpen);
  const followupOnSuggestions = isSuggestionFollowupEnabled(failOpen);
  const followupOnRisks = isRiskFollowupEnabled(failOpen);
  const ciGateWait = effectiveCiGateWait(failOpen);
  const ignoreAuthors = opts.ignoreConflictsAuthors ?? ignoreConflictsAuthorsFromSnapshot(settings);
  const ignoreAuthorsUnreadable = ignoreAuthors === undefined;
  if (ignoreAuthorsUnreadable) {
    const snapshot: CloserSnapshot = {
      followupRound: 0,
      maxFollowupRounds,
      hasUnhandledFeedback: false,
      maintainerOnlyPending: true,
      ciPending: true,
      ciUnhandledCount: 0,
      prEligible: false,
      mergeable: undefined,
      hasJumiCommit: undefined,
      labeledOrAuthorListed: false,
      conflictRound: 0,
      maxConflictRounds,
      conflictSameHeadBase: true,
    };
    return { snapshot, ignoreAuthorsUnreadable, settings };
  }

  const { readFollowUpLatch } = await import("./followup.ts");
  const { skipLatchesFor } = await import("./skip_latches.ts");
  const latchStore = skipLatchesFor(opts);
  const followupLatch = await readFollowUpLatch(latchStore, {
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: opts.issueNumber,
  });

  let hasUnhandledFeedback = false;
  let maintainerOnlyPending = false;
  if (followupLatch.round < maxFollowupRounds) {
    const { collectFollowUpItems, hasUnhandledFollowUpItems, onlyMaintainerQuestionsPending } = await import(
      "./followup.ts"
    );
    const items = await collectFollowUpItems(
      api,
      opts.owner,
      opts.repo,
      opts.pr.number,
      opts.botUsername,
      opts.pr.head.sha,
      followupIgnore,
      {
        prAuthor: opts.pr.user?.login,
        ...(blockingAuthors ? { blockingQuestionAuthors: blockingAuthors } : {}),
        ...(followupOnSuggestions ? {} : { followupOnSuggestions: false as const }),
        ...(followupOnRisks ? {} : { followupOnRisks: false as const }),
      },
      trusted
    );
    hasUnhandledFeedback = hasUnhandledFollowUpItems(items, followupLatch);
    if (hasUnhandledFeedback) {
      maintainerOnlyPending = onlyMaintainerQuestionsPending(items, followupLatch, opts.botUsername);
    }
  }
  const followUp = followupLatch.round < maxFollowupRounds && hasUnhandledFeedback && !maintainerOnlyPending;

  let ciPending = false;
  let ciUnhandledCount = 0;
  try {
    let requiredContexts: readonly string[] | undefined;
    if (ciGateWait !== "all" && ciGateWait !== "none") {
      requiredContexts = await resolveRequiredCiContextsImpl(api, {
        owner: opts.owner,
        repo: opts.repo,
        issueNumber: opts.issueNumber,
        baseBranch: opts.pr.base.ref,
        log,
      });
    }
    const inspection = await inspectCi({
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
    });
    ciPending = inspection.pending;
    ciUnhandledCount = inspection.unhandled.length;
  } catch {
    ciPending = false;
    ciUnhandledCount = 0;
  }
  const ci = !ciPending && ciUnhandledCount > 0;

  const prEligible = isEligibleWorkerPR(opts.pr, opts.owner, opts.repo);
  const mergeable = opts.pr.mergeable;
  const labeledOrAuthorListed =
    hasIgnoreConflictsLabel(opts.pr, ignoreLabel) || isIgnoreConflictsAuthor(opts.pr.user?.login, ignoreAuthors);
  let hasJumiCommit: boolean | undefined;
  let conflictRound = 0;
  let conflictSameHeadBase = false;
  if (prEligible && mergeable === false) {
    let gated = false;
    if (!followUp && !ci && labeledOrAuthorListed) {
      hasJumiCommit = await hasJumiCommitOnPull(api, opts.owner, opts.repo, opts.pr.number, {
        botUsername: opts.botUsername,
      });
      if (hasJumiCommit === false) {
        gated = true;
      }
    }
    if (!gated) {
      const conflictLatch = await readConflictLatch(latchStore, {
        owner: opts.owner,
        repo: opts.repo,
        issueNumber: opts.issueNumber,
      });
      conflictRound = conflictLatch.round;
      conflictSameHeadBase = Boolean(
        conflictLatch.lastHeadSha &&
          conflictLatch.lastBaseSha &&
          conflictLatch.lastHeadSha === opts.pr.head.sha &&
          conflictLatch.lastBaseSha === opts.pr.base.sha
      );
    }
  }

  const snapshot: CloserSnapshot = {
    followupRound: followupLatch.round,
    maxFollowupRounds,
    hasUnhandledFeedback,
    maintainerOnlyPending,
    ciPending,
    ciUnhandledCount,
    prEligible,
    mergeable,
    hasJumiCommit,
    labeledOrAuthorListed,
    conflictRound,
    maxConflictRounds,
    conflictSameHeadBase,
  };
  return { snapshot, ignoreAuthorsUnreadable, settings };
}

export interface ConflictDecisionOpts {
  owner: string;
  repo: string;
  pr: Pull;
  job: IssueJob;
  botUsername: string;
  home: string;
  defaultBranch?: string;
  maxConflictRounds?: number;
  maxFollowupRounds?: number;
  ignoreConflictsLabel?: string;
  skipLatches?: SkipLatchStore;
  settings?: SettingsSnapshot;
}

export interface ConflictDecisionDeps {
  // biome-ignore lint/suspicious/noExplicitAny: forge fakes vary per test.
  api: any;
  log?: (message: string) => void;
}

export interface ConflictDecisionBuild {
  base: PrDecisionSnapshot;
  getLeftToAuthor: () => Promise<{
    leftToAuthor: boolean;
    leftViaAuthorOnly: boolean;
    leftReason: string;
    conflictedLeftToAuthor: boolean;
  }>;
  conflictLatch: ConflictState;
  settings: SettingsSnapshot;
  maxConflictRounds: number;
}

/**
 * Single-load decision snapshot for `implementConflict`. One `.jumi.yml`
 * read (via `opts.settings` when provided, otherwise one
 * `loadSettingsSnapshot`); the left-to-author forge read stays behind the
 * `getLeftToAuthor` thunk so `decide(..., "conflict")` drives it through the
 * `need` protocol.
 */
export async function buildConflictDecisionSnapshot(
  opts: ConflictDecisionOpts,
  deps: ConflictDecisionDeps
): Promise<ConflictDecisionBuild> {
  const api = deps.api;
  const log = deps.log;
  let settings = opts.settings;
  if (!settings) {
    const ref = opts.defaultBranch?.trim() ? opts.defaultBranch.trim() : "";
    if (!ref) {
      settings = { state: "no-branch" };
    } else {
      const { loadSettingsSnapshot } = await import("./repo_settings.ts");
      settings = await loadSettingsSnapshot(api, opts.owner, opts.repo, ref);
      if (settings.state === "loaded" && settings.load.state === "invalid") {
        log?.(`conflict settings invalid for ${opts.owner}/${opts.repo}@${ref}: ${settings.load.error}`);
      }
      if (settings.state === "threw") {
        const { errorMessage } = await import("./util/error.ts");
        log?.(`conflict settings unreadable for ${opts.owner}/${opts.repo}@${ref}: ${errorMessage(settings.error)}`);
      }
    }
  }
  const failOpen = failOpenLoadFromSnapshot(settings);
  const maxConflictRounds = effectiveConflictRounds(opts.maxConflictRounds ?? 3, failOpen);
  const ignoreLabel = effectiveIgnoreConflictsLabel(opts.ignoreConflictsLabel, failOpen);
  const ignoreAuthors = ignoreConflictsAuthorsFromSnapshot(settings);
  const { skipLatchesFor } = await import("./skip_latches.ts");
  const store = skipLatchesFor({ home: opts.home, skipLatches: opts.skipLatches });
  const latchKey = { owner: opts.owner, repo: opts.repo, issueNumber: opts.job.issueNumber };
  const conflictLatch = await readConflictLatch(store, latchKey);
  const stuckLatch = await readStuckLatch(store, latchKey);
  const { quotaStuckReasonForText } = await import("./quota.ts");
  const quotaStuck = isQuotaStuck(stuckLatch);
  const base: PrDecisionSnapshot = {
    branchIsDefault: !opts.pr.head.ref || opts.pr.head.ref === opts.job.defaultBranch,
    handledCommentIds: [],
    handledReviewIds: [],
    ciWake: false,
    ignoreAuthors: ignoreAuthors ?? undefined,
    mergeable: opts.pr.mergeable,
    conflictRound: conflictLatch.round,
    maxConflictRounds,
    leftToAuthor: undefined,
    hasFeedback: false,
    stateRound: 0,
    maxFollowupRounds: 0,
    ciPending: false,
    ciUnhandled: [],
    stuckFingerprints: stuckLatch.fingerprints,
    quotaStuck,
    quotaReason: quotaStuck ? quotaStuckReasonForText(stuckLatch.quota?.reason) : "",
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.pr.number,
  };
  const getLeftToAuthor = memoize(async () => {
    const leftToAuthor = await isLeftToAuthor(
      api,
      opts.owner,
      opts.repo,
      opts.pr,
      {
        botUsername: opts.botUsername,
        ignoreConflictsLabel: ignoreLabel,
        ignoreConflictsAuthors: ignoreAuthors ?? undefined,
        prAuthor: opts.pr.user?.login,
        defaultBranch: opts.defaultBranch,
      },
      log
    );
    const prForLabel = { labels: opts.pr.labels };
    const leftViaAuthorOnly =
      leftToAuthor && !hasIgnoreConflictsLabel(prForLabel, ignoreLabel) && (ignoreAuthors?.length ?? 0) > 0;
    const leftReason = leftViaAuthorOnly
      ? leaveConflictsAuthorReason(opts.pr.user?.login)
      : ignoreConflictsReason(ignoreLabel);
    const conflictedLeftToAuthor = opts.pr.mergeable === false && leftToAuthor;
    return { leftToAuthor, leftViaAuthorOnly, leftReason, conflictedLeftToAuthor };
  });
  return { base, getLeftToAuthor, conflictLatch, settings, maxConflictRounds };
}
