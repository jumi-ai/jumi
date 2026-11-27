import { hasLabel, isIssuePickedUp, type PickupPolicy } from "./assignee.ts";
import { MAX_CONFLICT_ROUNDS } from "./conflict.ts";
import { MAX_FOLLOWUP_ROUNDS, readFollowUpLatch } from "./followup.ts";
import { extractWorkingIssueNumber, isAssignedForeignPR, isJumiPrIdentity } from "./gitea_issues.ts";
import type { Pull, Repo, ReviewApi, Task } from "./ports.ts";
import { TOO_MANY_FOLLOWUP_ROUNDS_REASON } from "./pr_decision.ts";
import type { EnqueueResult } from "./queue.ts";
import { resolveRepoPolicy } from "./repo_policy.ts";
import {
  effectivePickupLabel,
  isHeadSettingsFailureReason,
  isMaintainerQuestionsHoldEnabled,
  type RepoSettingsLoad,
  repoMode,
} from "./repo_settings.ts";
import type { ReviewResult } from "./review.ts";
import { handoverWakesFromFacts, type ReviewTrustCtx, resolveReviewFacts } from "./review_facts.ts";
import type { ReviewJobRecord, ReviewJobStore } from "./review_jobs.ts";
import type { ReviewRecord } from "./review_verdict_store.ts";
import { rememberSitBestEffort } from "./router_sits.ts";
import { upsertStuckText } from "./stuck.ts";
import { postSuggestionHoldSuccess, readSuggestionHold, suggestionHoldSkippedDescription } from "./suggestion_hold.ts";
import type { IssueJob } from "./types.ts";
import { errorMessage } from "./util/error.ts";

export const TOO_MANY_FOLLOWUP_ROUNDS: string = TOO_MANY_FOLLOWUP_ROUNDS_REASON;

/** Skip reason (and sit text) when the only open item needs a maintainer. */
export const WAITING_ON_MAINTAINER_REASON = "waiting on maintainer";

/**
 * A review whose only open item is a maintainer-only `❓`: a complete
 * success trailer, at least one question, every question marked
 * `❓ maintainer:`, and no leftover suggestions. Failures and suggestion
 * trailers still hand over; a mixed review (maintainer plus worker-answerable
 * questions) also still hands over.
 */
export function isMaintainerOnlyTrailer(
  markdown: string | null | undefined,
  record?: ReviewRecord | null,
  trust?: ReviewTrustCtx
): boolean {
  return resolveReviewFacts({ body: markdown, record, ...(trust ? { trust } : {}) }).facts.viewIsMaintainerOnly;
}

function isCurrentHeadFailureTrailer(
  markdown: string | null | undefined,
  record?: ReviewRecord | null,
  trust?: ReviewTrustCtx
): boolean {
  const facts = resolveReviewFacts({ body: markdown, record, ...(trust ? { trust } : {}) }).facts;
  return !facts.viewIncomplete && facts.viewState === "failure";
}

function isLeftoverSimplificationTrailer(
  markdown: string | null | undefined,
  record?: ReviewRecord | null,
  trust?: ReviewTrustCtx
): boolean {
  const facts = resolveReviewFacts({ body: markdown, record, ...(trust ? { trust } : {}) }).facts;
  return !facts.viewIncomplete && facts.viewState === "success" && facts.viewSuggestionCount > 0;
}

function isBlockingQuestionTrailer(
  markdown: string | null | undefined,
  prAuthorLogin: string | undefined | null,
  blockingAuthors: readonly string[] | undefined | null,
  record?: ReviewRecord | null,
  trust?: ReviewTrustCtx
): boolean {
  return (
    resolveReviewFacts({ body: markdown, record, prAuthorLogin, blockingAuthors, ...(trust ? { trust } : {}) }).facts
      .viewBlockingQuestionCount > 0
  );
}

export function shouldHandoverFollowUp(opts: {
  published: ReviewResult;
  markdown?: string | null;
  record?: ReviewRecord | null;
  prAuthor?: string | undefined | null;
  blockingQuestionAuthors?: readonly string[] | undefined | null;
  /** Signed-block verification coordinates for this handover decision. */
  trust?: ReviewTrustCtx;
}): boolean {
  if (opts.published.status !== "posted" && opts.published.status !== "updated") return false;
  const facts = resolveReviewFacts({
    body: opts.markdown,
    record: opts.record,
    prAuthorLogin: opts.prAuthor,
    blockingAuthors: opts.blockingQuestionAuthors,
    ...(opts.trust ? { trust: opts.trust } : {}),
  }).facts;
  // A maintainer-only ❓ never starts a worker round on its own: the worker
  // has no way to file/close another issue, change labels or assignment, or
  // decide scope. Mixed reviews still hand over for the worker-answerable part.
  if (facts.viewIsMaintainerOnly) return false;
  return handoverWakesFromFacts(facts);
}

function persistInsertSkipReason(
  markdown: string | null | undefined,
  prAuthorLogin?: string | undefined | null,
  blockingAuthors?: readonly string[] | undefined | null,
  record?: ReviewRecord | null,
  trust?: ReviewTrustCtx
): string | undefined {
  if (!markdown && !record) return "incomplete";
  const facts = resolveReviewFacts({
    body: markdown,
    record,
    prAuthorLogin,
    blockingAuthors,
    ...(trust ? { trust } : {}),
  }).facts;
  if (facts.viewIncomplete) return "incomplete";
  if (facts.viewState === "failure") return undefined;
  if (facts.viewState === "success") {
    if (facts.viewSuggestionCount > 0) return undefined;
    if (facts.viewBlockingQuestionCount > 0) return undefined;
    // A success review that names non-blocking 🟡 risks still needs the
    // follow-up decision below (which reads `followup_on_risks`); the cheap
    // gate must not skip it as a plain success trailer.
    if (!facts.incomplete && facts.trailerNonBlockingRiskCount > 0) {
      return undefined;
    }
    return "success trailer";
  }
  return "incomplete";
}

function followUpJobFrom(
  owner: string,
  repo: string,
  issue: Pick<Task, "number" | "title" | "body" | "html_url" | "updated_at">,
  pr: Pull,
  repository: Pick<Repo, "default_branch" | "clone_url">,
  delivery: string,
  triggerEvent: "review-failure" | "review-suggestions"
): IssueJob {
  return {
    delivery,
    owner,
    repo,
    issueNumber: issue.number,
    action: triggerEvent,
    title: issue.title,
    body: issue.body ?? "",
    htmlUrl: issue.html_url,
    issueUpdatedAt: issue.updated_at,
    defaultBranch: repository.default_branch,
    cloneUrl: repository.clone_url,
    receivedAt: new Date().toISOString(),
    mode: "follow-up",
    prNumber: pr.number,
    headSha: pr.head.sha,
    trigger: { event: triggerEvent, sender: "jumi" },
  };
}

/**
 * Resolve a held suggestion `pending` to `success` when the follow-up cannot
 * run. The review posted `pending` and consumed the one-hold flag; every
 * handover skip that leaves no follow-up job must flip the held head back to
 * `success` with a note, or the merge would wait forever. A success review
 * that still asks an open `❓ maintainer:` question keeps the pending instead:
 * the maintainer hold owns it, not the suggestion lifecycle. Never throws.
 */
async function resolveHeldSuggestion(
  store: ReviewJobStore,
  api: Pick<ReviewApi, "createCommitStatus">,
  owner: string,
  repo: string,
  issueNumber: number,
  headSha: string,
  markdown: string | null | undefined,
  reason: string,
  targetUrl?: string,
  record?: ReviewRecord | null,
  maintainerHoldEnabled = true,
  trust?: ReviewTrustCtx
): Promise<void> {
  try {
    const hold = await readSuggestionHold(store.skipLatches, { owner, repo, issueNumber });
    if (!hold.consumed) return;
    const sha =
      hold.headSha && hold.headSha.toLowerCase() === headSha.toLowerCase() ? headSha : (hold.headSha ?? headSha);
    let count = hold.count ?? 0;
    const facts = resolveReviewFacts({ body: markdown, record, ...(trust ? { trust } : {}) }).facts;
    if (!count) {
      if (!facts.viewIncomplete && facts.viewState === "success") {
        count = facts.viewSuggestionCount;
      }
    }
    if (!count) return;
    // A maintainer hold owns the pending: a success review that still asks a
    // `❓ maintainer:` question keeps the check pending even when the
    // suggestion lifecycle ends. The typed verdict decides first; legacy rows
    // without a record fall back to the markdown parser via the same view.
    if (
      maintainerHoldEnabled &&
      !facts.viewIncomplete &&
      facts.viewState === "success" &&
      facts.viewMaintainerQuestionCount > 0
    ) {
      return;
    }
    await postSuggestionHoldSuccess(api, owner, repo, sha, suggestionHoldSkippedDescription(count, reason), targetUrl);
  } catch {
    // Best-effort: never fail handover on a status post.
  }
}

export async function enqueueFollowUpFromReview(
  opts: {
    store: ReviewJobStore;
    api: Pick<
      ReviewApi,
      | "getPR"
      | "getIssue"
      | "getRepo"
      | "getRepoFile"
      | "findStickyIssueComment"
      | "createIssueComment"
      | "updateIssueComment"
      | "createCommitStatus"
    >;
    row: ReviewJobRecord;
    published: ReviewResult;
    markdown?: string | null;
    maxFollowupRounds?: number;
    maxConflictRounds?: number;
    blockingQuestionAuthors?: readonly string[];
    logger?: (message: string) => void;
    /** Signed-block verification coordinates for this handover decision. */
    trust?: ReviewTrustCtx;
  } & PickupPolicy
): Promise<EnqueueResult | undefined> {
  const logSkip = (reason: string): undefined => {
    opts.logger?.(`persist-insert skipped: ${reason}`);
    return undefined;
  };

  // Invalid head settings still fail the review check, but on a pull Jumi
  // works on the failure is unhandled feedback for follow-up, not a terminal
  // skip. A pull Jumi does not work on keeps today's behavior: a failing
  // status with no follow-up.
  if (opts.published.status === "skipped" && isHeadSettingsFailureReason(opts.published.reason)) {
    return enqueueFollowUpFromHeadSettings({
      store: opts.store,
      api: opts.api,
      row: opts.row,
      failure: (opts.published.reason ?? "").trim(),
      botUsername: opts.botUsername,
      maxFollowupRounds: opts.maxFollowupRounds,
      maxConflictRounds: opts.maxConflictRounds,
      blockingQuestionAuthors: opts.blockingQuestionAuthors,
      logger: opts.logger,
      ...(opts.isPickedUp ? { isPickedUp: opts.isPickedUp } : {}),
    });
  }

  if (opts.published.status !== "posted" && opts.published.status !== "updated") return undefined;

  // The row's typed verdict when the persisted markdown is byte-identical to
  // the store's `toMarkdown()`; absent for old rows and modified markdown.
  const record = opts.row.resultJson ?? null;
  // Verification coordinates for every handover decision below. Absent
  // unless the caller opted in: unwired callers stay on the silent legacy
  // path exactly as today.
  const handoverTrust: ReviewTrustCtx | undefined = opts.trust
    ? {
        ...opts.trust,
        owner: opts.trust.owner ?? opts.row.owner,
        repo: opts.trust.repo ?? opts.row.repo,
        prNumber: opts.trust.prNumber ?? opts.row.prNumber,
        headSha: opts.trust.headSha ?? opts.row.headSha,
        log: opts.logger,
      }
    : undefined;

  // Maintainer-only ❓: the worker cannot file/close another issue, change
  // labels or assignment, or decide scope, so no round starts. The board
  // keeps the PR visible as waiting on a maintainer answer instead.
  if (isMaintainerOnlyTrailer(opts.markdown, record, handoverTrust)) {
    await rememberSitBestEffort(
      opts.store.sits,
      opts.row.owner,
      opts.row.repo,
      opts.row.prNumber,
      WAITING_ON_MAINTAINER_REASON,
      opts.logger
    );
    return logSkip(WAITING_ON_MAINTAINER_REASON);
  }

  // Cheap trailer gate first: incomplete skips without any fetch, and a
  // failure or leftover-simplification success enqueues. Only a plain success
  // trailer needs the PR author plus the effective blocking list (deployer
  // plus the repository's default-branch file) to decide whether opt-in
  // blocking questions keep the follow-up alive.
  const earlySkip = persistInsertSkipReason(opts.markdown, undefined, undefined, record, handoverTrust);
  if (earlySkip && earlySkip !== "success trailer") return logSkip(earlySkip);

  // One default-branch read covers the restricted-mode gate, the follow-up
  // policy, and the success-trailer blocking list below. Missing, invalid,
  // or unreadable behaves as today (mode `full`, deployment caps,
  // suggestions on, deployer blocking list). The worker start gate is the
  // backstop for jobs queued before the mode changed.
  const repo = await opts.api.getRepo(opts.row.owner, opts.row.repo);
  let repoSettings: RepoSettingsLoad = { state: "missing" };
  let effectiveBlocking: readonly string[] | undefined = opts.blockingQuestionAuthors;
  let policy = {
    followupOnSuggestions: true,
    followupOnRisks: true,
    blockingRisks: true,
    maxFollowupRounds: opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS,
    maxConflictRounds: opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS,
  };
  try {
    const defaultBranch = repo.default_branch?.trim() ? repo.default_branch : "";
    if (defaultBranch) {
      const repoPolicy = await resolveRepoPolicy(
        { api: opts.api, owner: opts.row.owner, repo: opts.row.repo, ref: defaultBranch },
        {
          trustedSenderLogins: undefined,
          followupIgnoreLogins: undefined,
          ignoreConflictsLabel: undefined,
          blockingQuestionAuthors: opts.blockingQuestionAuthors,
          maxFollowupRounds: opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS,
          maxConflictRounds: opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS,
        },
        { onUnreadable: "throw" }
      );
      repoSettings = repoPolicy.load;
      if (repoPolicy.status === "invalid") {
        opts.logger?.(
          `repo settings invalid for ${opts.row.owner}/${opts.row.repo}@${defaultBranch}: ${repoPolicy.error}`
        );
      } else {
        policy = {
          followupOnSuggestions: repoPolicy.followupOnSuggestions,
          followupOnRisks: repoPolicy.followupOnRisks,
          blockingRisks: repoPolicy.blockingRisks,
          maxFollowupRounds: repoPolicy.maxFollowupRounds,
          maxConflictRounds: repoPolicy.maxConflictRounds,
        };
      }
      effectiveBlocking = repoPolicy.blockingQuestionAuthors;
    }
  } catch (err) {
    opts.logger?.(`repo settings unreadable for ${opts.row.owner}/${opts.row.repo}: ${errorMessage(err)}`);
    repoSettings = { state: "missing" };
  }
  // GitHub pickup label from the same default-branch read: Gitea keeps using
  // assignment and ignores the key. Missing, invalid, or unreadable falls back
  // to `jumi` via the loader default (`repoSettings` is `missing` there).
  const effectivePickup =
    repoSettings.state === "valid" && repoSettings.pickupLabel
      ? repoSettings.pickupLabel
      : effectivePickupLabel(repoSettings);
  const usesGithubPickup = Boolean(opts.isPickedUp);
  const effectivePickupPolicy: PickupPolicy = usesGithubPickup
    ? { botUsername: opts.botUsername, isPickedUp: (issue) => hasLabel(issue, effectivePickup) }
    : { botUsername: opts.botUsername };
  // The suggestion cleanup never clears a maintainer hold: when the typed
  // verdict (or the legacy markdown) still asks a `❓ maintainer:` question on
  // a success review, the pending stays pending. Default on, matching
  // publication; an explicit opt-out still lets the suggestion cleanup post.
  const maintainerHoldEnabled = isMaintainerQuestionsHoldEnabled(repoSettings);

  const pr = await opts.api.getPR(opts.row.owner, opts.row.repo, opts.row.prNumber);
  // The held `pending` lives on the reviewed head: when the head moved, or
  // when restricted mode means no follow-up will run, the hold must resolve
  // to `success` here — no follow-up job exists afterwards to clear it.
  const holdKey = extractWorkingIssueNumber(pr) ?? pr.number;
  if (pr.head.sha !== opts.row.headSha) {
    await resolveHeldSuggestion(
      opts.store,
      opts.api,
      opts.row.owner,
      opts.row.repo,
      holdKey,
      opts.row.headSha,
      opts.markdown,
      "head moved",
      pr.html_url,
      record,
      maintainerHoldEnabled,
      handoverTrust
    );
    return logSkip("head moved");
  }
  if (repoMode(repoSettings) !== "full") {
    await resolveHeldSuggestion(
      opts.store,
      opts.api,
      opts.row.owner,
      opts.row.repo,
      holdKey,
      opts.row.headSha,
      opts.markdown,
      "mode restricted",
      pr.html_url,
      record,
      maintainerHoldEnabled,
      handoverTrust
    );
    return logSkip("repository mode is restricted");
  }

  if (earlySkip === "success trailer") {
    const trailerSkip = persistInsertSkipReason(
      opts.markdown,
      pr.user?.login,
      effectiveBlocking,
      record,
      handoverTrust
    );
    if (trailerSkip) {
      // A consumed hold must never outlive the handover: the review posted
      // `pending` and consumed the one-hold flag, and no follow-up job is
      // left to clear it. Resolve the held head to `success` with a note,
      // the same way every other skip branch after the hold does.
      await resolveHeldSuggestion(
        opts.store,
        opts.api,
        opts.row.owner,
        opts.row.repo,
        extractWorkingIssueNumber(pr) ?? pr.number,
        opts.row.headSha,
        opts.markdown,
        trailerSkip,
        pr.html_url,
        record,
        maintainerHoldEnabled,
        handoverTrust
      );
      return logSkip(trailerSkip);
    }
  }

  const closer = extractWorkingIssueNumber(pr);
  const foreign =
    closer === undefined &&
    isAssignedForeignPR(pr, opts.row.owner, opts.row.repo, opts.botUsername, effectivePickupPolicy) &&
    !isJumiPrIdentity(pr, opts.botUsername);
  if (closer === undefined && !foreign) {
    await rememberSitBestEffort(
      opts.store.sits,
      opts.row.owner,
      opts.row.repo,
      opts.row.prNumber,
      "no closing issue",
      opts.logger
    );
    await resolveHeldSuggestion(
      opts.store,
      opts.api,
      opts.row.owner,
      opts.row.repo,
      pr.number,
      opts.row.headSha,
      opts.markdown,
      "unassigned",
      pr.html_url,
      record,
      maintainerHoldEnabled,
      handoverTrust
    );
    return logSkip("no closer");
  }

  const issueNumber = closer ?? pr.number;
  const issue = foreign ? pr : await opts.api.getIssue(opts.row.owner, opts.row.repo, issueNumber);
  if (!foreign && (issue.state !== "open" || !isIssuePickedUp(issue, effectivePickupPolicy))) {
    await resolveHeldSuggestion(
      opts.store,
      opts.api,
      opts.row.owner,
      opts.row.repo,
      issueNumber,
      opts.row.headSha,
      opts.markdown,
      "unassigned",
      pr.html_url,
      record,
      maintainerHoldEnabled,
      handoverTrust
    );
    return logSkip("unassigned");
  }

  // Policy and effective blocking were loaded once above from the same
  // file read; the gate below sees the same list `needsFollowUp` sees.
  // Suggestion follow-up off: a `success` review with suggestions starts no
  // follow-up in that repository. Failures, blocking questions, red CI, and
  // conflicts run as today; a person asking still follows via the webhook
  // path, which never reaches this handover.
  if (
    isLeftoverSimplificationTrailer(opts.markdown, record, handoverTrust) &&
    !isCurrentHeadFailureTrailer(opts.markdown, record, handoverTrust) &&
    !isBlockingQuestionTrailer(opts.markdown, pr.user?.login, effectiveBlocking, record, handoverTrust) &&
    !policy.followupOnSuggestions
  ) {
    await resolveHeldSuggestion(
      opts.store,
      opts.api,
      opts.row.owner,
      opts.row.repo,
      issueNumber,
      opts.row.headSha,
      opts.markdown,
      "suggestions disabled",
      pr.html_url,
      record,
      maintainerHoldEnabled,
      handoverTrust
    );
    return logSkip("suggestions disabled");
  }
  // Risk follow-up off: a `success` review whose only wake reason is
  // non-blocking 🟡 starts no follow-up. Failures (🔴, blocking 🟡),
  // blocking questions, and enabled suggestions still run as today: a
  // `failure` trailer names blocking work, so it must still hand over even
  // when its body also publishes 🟡 findings.
  if (!policy.followupOnRisks) {
    try {
      const facts = resolveReviewFacts({ body: opts.markdown, record, trust: handoverTrust }).facts;
      if (!facts.incomplete && facts.state === "success") {
        const bugs = facts.bugCount;
        const advisoryRisks = facts.trailerNonBlockingRiskCount;
        const blockingQs = isBlockingQuestionTrailer(
          opts.markdown,
          pr.user?.login,
          effectiveBlocking,
          record,
          handoverTrust
        );
        const suggestionWake =
          isLeftoverSimplificationTrailer(opts.markdown, record, handoverTrust) && policy.followupOnSuggestions;
        if (bugs === 0 && advisoryRisks > 0 && !blockingQs && !suggestionWake) {
          await resolveHeldSuggestion(
            opts.store,
            opts.api,
            opts.row.owner,
            opts.row.repo,
            issueNumber,
            opts.row.headSha,
            opts.markdown,
            "risks disabled",
            pr.html_url,
            record,
            maintainerHoldEnabled,
            handoverTrust
          );
          return logSkip("risks disabled");
        }
      }
    } catch {
      // Fall through to the normal handover.
    }
  }

  const followUpLatch = await readFollowUpLatch(opts.store.skipLatches, {
    owner: opts.row.owner,
    repo: opts.row.repo,
    issueNumber,
  });
  if (followUpLatch.round >= policy.maxFollowupRounds) {
    await upsertStuckText(
      opts.api,
      opts.row.owner,
      opts.row.repo,
      pr.number,
      opts.botUsername,
      TOO_MANY_FOLLOWUP_ROUNDS
    );
    await resolveHeldSuggestion(
      opts.store,
      opts.api,
      opts.row.owner,
      opts.row.repo,
      issueNumber,
      opts.row.headSha,
      opts.markdown,
      "round cap",
      pr.html_url,
      record,
      maintainerHoldEnabled,
      handoverTrust
    );
    return logSkip("round cap");
  }

  const triggerEvent = isLeftoverSimplificationTrailer(opts.markdown, record, handoverTrust)
    ? "review-suggestions"
    : "review-failure";
  return opts.store.enqueueIssue(
    followUpJobFrom(opts.row.owner, opts.row.repo, issue, pr, repo, `${triggerEvent}-${opts.row.id}`, triggerEvent)
  );
}

/**
 * Follow-up for a head that leaves `.jumi.yml` invalid. The strict check
 * stays: the review already failed with the parser error. On a pull Jumi
 * works on (its own closer, or a handed-over / taken-over pull) that failure
 * is unhandled feedback, so a follow-up is queued with the parser error plus
 * the merge-off guidance. A pull Jumi does not work on keeps today's
 * behavior: a failing status and no follow-up. Round caps and stuck handling
 * apply unchanged.
 */
async function enqueueFollowUpFromHeadSettings(
  opts: {
    store: ReviewJobStore;
    api: Pick<
      ReviewApi,
      | "getPR"
      | "getIssue"
      | "getRepo"
      | "getRepoFile"
      | "findStickyIssueComment"
      | "createIssueComment"
      | "updateIssueComment"
      | "createCommitStatus"
    >;
    row: ReviewJobRecord;
    failure: string;
    botUsername: string;
    maxFollowupRounds?: number;
    maxConflictRounds?: number;
    blockingQuestionAuthors?: readonly string[];
    logger?: (message: string) => void;
  } & PickupPolicy
): Promise<EnqueueResult | undefined> {
  const logSkip = (reason: string): undefined => {
    opts.logger?.(`persist-insert skipped: ${reason}`);
    return undefined;
  };
  const repo = await opts.api.getRepo(opts.row.owner, opts.row.repo);
  let repoSettings: RepoSettingsLoad = { state: "missing" };
  let maxFollowupRounds = opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS;
  let maxConflictRounds = opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS;
  try {
    const defaultBranch = repo.default_branch?.trim() ? repo.default_branch : "";
    if (defaultBranch) {
      const repoPolicy = await resolveRepoPolicy(
        { api: opts.api, owner: opts.row.owner, repo: opts.row.repo, ref: defaultBranch },
        {
          trustedSenderLogins: undefined,
          followupIgnoreLogins: undefined,
          ignoreConflictsLabel: undefined,
          blockingQuestionAuthors: opts.blockingQuestionAuthors,
          maxFollowupRounds: opts.maxFollowupRounds ?? MAX_FOLLOWUP_ROUNDS,
          maxConflictRounds: opts.maxConflictRounds ?? MAX_CONFLICT_ROUNDS,
        },
        { onUnreadable: "throw" }
      );
      repoSettings = repoPolicy.load;
      if (repoPolicy.status !== "invalid") {
        maxFollowupRounds = repoPolicy.maxFollowupRounds;
        maxConflictRounds = repoPolicy.maxConflictRounds;
      }
    }
  } catch (err) {
    opts.logger?.(`repo settings unreadable for ${opts.row.owner}/${opts.row.repo}: ${errorMessage(err)}`);
  }
  if (repoMode(repoSettings) !== "full") return logSkip("repository mode is restricted");
  const pr = await opts.api.getPR(opts.row.owner, opts.row.repo, opts.row.prNumber);
  if (pr.head.sha !== opts.row.headSha) return logSkip("head moved");
  const effectivePickup =
    repoSettings.state === "valid" && repoSettings.pickupLabel
      ? repoSettings.pickupLabel
      : effectivePickupLabel(repoSettings);
  const usesGithubPickup = Boolean(opts.isPickedUp);
  const effectivePickupPolicy: PickupPolicy = usesGithubPickup
    ? { botUsername: opts.botUsername, isPickedUp: (issue) => hasLabel(issue, effectivePickup) }
    : { botUsername: opts.botUsername };
  const closer = extractWorkingIssueNumber(pr);
  const foreign =
    closer === undefined &&
    isAssignedForeignPR(pr, opts.row.owner, opts.row.repo, opts.botUsername, effectivePickupPolicy) &&
    !isJumiPrIdentity(pr, opts.botUsername);
  if (closer === undefined && !foreign) {
    await rememberSitBestEffort(
      opts.store.sits,
      opts.row.owner,
      opts.row.repo,
      opts.row.prNumber,
      "no closing issue",
      opts.logger
    );
    return logSkip("no closer");
  }
  const issueNumber = closer ?? pr.number;
  const issue = foreign ? pr : await opts.api.getIssue(opts.row.owner, opts.row.repo, issueNumber);
  if (!foreign && (issue.state !== "open" || !isIssuePickedUp(issue, effectivePickupPolicy))) {
    return logSkip("unassigned");
  }
  const followUpLatch = await readFollowUpLatch(opts.store.skipLatches, {
    owner: opts.row.owner,
    repo: opts.row.repo,
    issueNumber,
  });
  if (followUpLatch.round >= maxFollowupRounds) {
    await upsertStuckText(
      opts.api,
      opts.row.owner,
      opts.row.repo,
      pr.number,
      opts.botUsername,
      TOO_MANY_FOLLOWUP_ROUNDS
    );
    return logSkip("round cap");
  }
  return opts.store.enqueueIssue(
    followUpJobFrom(opts.row.owner, opts.row.repo, issue, pr, repo, `review-failure-${opts.row.id}`, "review-failure")
  );
}
