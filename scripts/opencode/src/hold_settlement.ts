import { JUMI_REVIEW_CONTEXT } from "./ci.ts";
import { isJumiWorkerBody } from "./followup_webhook.ts";
import { senderCanSteer } from "./permissions.ts";
import type { Comment, InlineComment, Pull, PullReview } from "./ports.ts";
import {
  effectiveBlockingQuestionAuthors,
  effectiveFollowupIgnoreLogins,
  effectiveTrustedSenderLogins,
  failOpenLoadFromSnapshot,
  isMaintainerQuestionsHoldEnabled,
  loadSettingsSnapshot,
} from "./repo_settings.ts";
import { inlinesForReviewGroup, reviewGroupIds } from "./review_groups.ts";
import type { SkipLatchKey, SkipLatchStore } from "./skip_latches.ts";
import {
  postSuggestionHoldSuccess,
  readSuggestionHold,
  suggestionHoldCompletedDescription,
  suggestionHoldSkippedDescription,
} from "./suggestion_hold.ts";
import { errorMessage } from "./util/error.ts";
import { loginEquals } from "./util/login.ts";
import {
  blockingOpenQuestionCount,
  countBugFindings,
  countMaintainerQuestionFindings,
  countRiskFindings,
  countSuggestionFindings,
  describeSuggestionsReason,
  isBlockingQuestionAuthor,
  isBugFindingFirstLine,
  isMaintainerQuestionInline,
  isQuestionInline,
  isRiskFindingFirstLine,
  parseCheckLine,
  parseReviewOutput,
} from "./verdict.ts";

/**
 * Pure hold-settlement decision for follow-up cleanup.
 *
 * The follow-up consumes a one-shot suggestion hold and later resolves the
 * held `pending` without a fresh review. When the held review also carries an
 * open `❓ maintainer:` question the maintainer hold owns the pending, so an
 * automatic suggestion wake must not clear it. This decision is the single
 * gate for both the suggestion cleanup and the no-change trusted-reply
 * release: it performs no I/O and only says "post success with this
 * description" or "keep" with a typed reason.
 *
 * The forge cannot compare-and-set a status, so the read-to-write window
 * between the fresh reads and the post still exists; this gate only narrows
 * it.
 */

interface HoldSettlementHold {
  consumed?: boolean;
  headSha?: string;
  count?: number;
}

export type HoldSettlementEvidence =
  | { kind: "unknown"; reason: string }
  | {
      kind: "known";
      /** `Reviewed commit` of the latest Jumi-authored review on the head. */
      reviewHeadSha: string;
      /** True when that review is Jumi-authored (bot owner). */
      reviewOwnerOk: boolean;
      completeSuccess: boolean;
      openBugs: number;
      openRisks: number;
      openBlockingQuestions: number;
      openMaintainers: number;
      openSuggestions: number;
    };

export type HoldSettlementStatus =
  | { kind: "unknown"; reason: string }
  | { kind: "known"; state: string | undefined; description?: string | undefined };

type HoldSettlementIntent = { kind: "completed" } | { kind: "skipped"; reason: string };

type HoldSettlementKeepReason =
  | "no-hold"
  | "zero-count"
  | "head-mismatch"
  | "not-pending"
  | "other-hold"
  | "unknown-status"
  | "unknown-evidence"
  | "not-jumi-review"
  | "review-head-mismatch"
  | "not-complete-success"
  | "blocking-findings"
  | "risk-findings"
  | "blocking-questions"
  | "maintainer-questions-pending"
  | "no-authorized-reply";

export type HoldSettlementDecision =
  | { action: "post-success"; description: string }
  | { action: "keep"; reason: HoldSettlementKeepReason };

export interface HoldSettlementInput {
  hold: HoldSettlementHold | undefined;
  currentHeadSha: string;
  status: HoldSettlementStatus;
  /** Effective maintainer-hold policy (`maintainer_questions_hold_merge`). */
  holdEnabled: boolean;
  evidence: HoldSettlementEvidence;
  /** True only for a positively authorized reply to the obligation. */
  authorizedReply: boolean;
  intent: HoldSettlementIntent;
}

function headsMatch(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length < b.length ? b.startsWith(a) : a.startsWith(b);
}

function isSuggestionHoldPendingDescription(description: string | undefined): boolean {
  return typeof description === "string" && /suggestions? waiting for follow-up/i.test(description);
}

function isMaintainerHoldPendingDescription(description: string | undefined): boolean {
  return typeof description === "string" && /waiting on maintainer/i.test(description);
}

export function decideHoldSettlement(input: HoldSettlementInput): HoldSettlementDecision {
  const hold = input.hold;
  const count = hold?.count ?? 0;

  const currentHead = (input.currentHeadSha ?? "").trim();
  if (!currentHead) return { action: "keep", reason: "unknown-evidence" };

  if (input.status.kind === "unknown") return { action: "keep", reason: "unknown-status" };
  const state = (input.status.state ?? "").toLowerCase();
  // No Jumi status recorded (fakes, pre-hold rows): fail open like the legacy
  // unconditional post. A recorded non-pending means someone already settled
  // it, so there is nothing to clear.
  if (state && state !== "pending" && state !== "missing") return { action: "keep", reason: "not-pending" };
  if (state === "pending") {
    const description = input.status.description;
    // A status description may only turn evidence into keep; it never
    // authorises success. An unrelated pending (another tool) stays pending.
    if (
      description !== undefined &&
      description.trim() !== "" &&
      !isSuggestionHoldPendingDescription(description) &&
      !isMaintainerHoldPendingDescription(description)
    ) {
      return { action: "keep", reason: "other-hold" };
    }
  }

  if (input.evidence.kind === "unknown") return { action: "keep", reason: "unknown-evidence" };
  const evidence = input.evidence;
  if (!evidence.reviewOwnerOk) return { action: "keep", reason: "not-jumi-review" };
  if (!evidence.reviewHeadSha || !headsMatch(evidence.reviewHeadSha, currentHead)) {
    return { action: "keep", reason: "review-head-mismatch" };
  }
  if (!evidence.completeSuccess) return { action: "keep", reason: "not-complete-success" };
  if (evidence.openBugs > 0) return { action: "keep", reason: "blocking-findings" };
  if (evidence.openRisks > 0) return { action: "keep", reason: "risk-findings" };
  if (evidence.openBlockingQuestions > 0) return { action: "keep", reason: "blocking-questions" };

  const maintainerObligation = input.holdEnabled && evidence.openMaintainers > 0;
  if (maintainerObligation) {
    // An effective maintainer obligation needs a genuine authorized reply; an
    // automatic CI/suggestion wake is not such a reply. Skipped/cancelled
    // rounds never release the maintainer hold: the trusted-reply release and
    // the next review remain the ways it settles.
    if (hold?.headSha && hold.headSha.toLowerCase() !== currentHead.toLowerCase()) {
      return { action: "keep", reason: "head-mismatch" };
    }
    if (input.intent.kind !== "completed") return { action: "keep", reason: "maintainer-questions-pending" };
    if (!input.authorizedReply) return { action: "keep", reason: "no-authorized-reply" };
    const description =
      evidence.openSuggestions > 0 ? describeSuggestionsReason(evidence.openSuggestions) : "No blocking issues";
    return { action: "post-success", description };
  }

  // No effective maintainer obligation: maintainer questions are informational
  // when the hold is disabled, and absent for suggestion-only reviews. Ordinary
  // blocking findings/questions above still gate the release. Suggestion cleanup
  // needs the consumed one-shot hold; without it there is nothing to clear.
  if (!hold?.consumed) return { action: "keep", reason: "no-hold" };
  if (!Number.isSafeInteger(count) || count <= 0) return { action: "keep", reason: "zero-count" };
  if (hold.headSha && hold.headSha.toLowerCase() !== currentHead.toLowerCase()) {
    return { action: "keep", reason: "head-mismatch" };
  }
  if (input.intent.kind === "completed") {
    return { action: "post-success", description: suggestionHoldCompletedDescription(count) };
  }
  return {
    action: "post-success",
    description: suggestionHoldSkippedDescription(count, input.intent.reason || "follow-up skipped"),
  };
}

const REVIEW_MARKER = "<!-- jumi-review:";
const REVIEWED_COMMIT_RE = /^Reviewed commit:\s*`([0-9a-fA-F]+)`\s*$/i;

function lastCheckTrailerLocal(body: string): { state: "success" | "failure"; reason: string } | undefined {
  const lines = body.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    return parseCheckLine(line);
  }
  return undefined;
}

function parseReviewedCommitShaLocal(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = REVIEWED_COMMIT_RE.exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

function commitMatchesHeadLocal(stickySha: string, headSha: string): boolean {
  const sticky = stickySha.toLowerCase();
  const head = headSha.toLowerCase();
  if (!sticky || !head) return false;
  if (sticky === head) return true;
  return sticky.length < head.length && head.startsWith(sticky);
}

function isJumiReviewStickyLocal(
  comment: { body?: string | null; user?: { login?: string } },
  botUsername?: string
): boolean {
  const body = comment.body ?? "";
  if (!body.trim()) return false;
  if (!body.includes(REVIEW_MARKER)) return false;
  if (isJumiWorkerBody(body)) return false;
  if (typeof botUsername === "string" && botUsername) {
    if (!loginEquals(comment.user?.login, botUsername)) return false;
  }
  return Boolean(parseReviewedCommitShaLocal(body));
}

function pullReviewBodyLocal(review: PullReview): string {
  return review.body ?? review.content ?? "";
}

function pullReviewFindingShaLocal(review: PullReview): string | undefined {
  return parseReviewedCommitShaLocal(pullReviewBodyLocal(review)) ?? (review.commit_id || undefined);
}

function isEmptySuccessReviewLocal(body: string | null | undefined): boolean {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return true;
  return /^No blocking issues\.?$/i.test(trimmed);
}

function isJumiPullReviewWriteupLocal(review: PullReview, botUsername: string): boolean {
  if (!loginEquals(review.user?.login, botUsername)) return false;
  const body = pullReviewBodyLocal(review);
  if (!body.trim() || isJumiWorkerBody(body) || isEmptySuccessReviewLocal(body)) return false;
  return lastCheckTrailerLocal(body) !== undefined;
}

function isOpenJumiInlineLocal(inline: InlineComment, botUsername?: string): boolean {
  const body = inline.body ?? "";
  if (!body.includes(REVIEW_MARKER)) return false;
  if (typeof botUsername === "string" && botUsername) {
    if (!loginEquals(inline.user?.login, botUsername)) return false;
  }
  return inline.resolved !== true && inline.resolver == null;
}

function isBlockingQuestionInlineLocal(inline: InlineComment, botUsername?: string): boolean {
  if (!isOpenJumiInlineLocal(inline, botUsername)) return false;
  return isQuestionInline(inline.path, inline.body ?? "");
}

function isBugInlineLocal(inline: InlineComment, botUsername?: string): boolean {
  if (!isOpenJumiInlineLocal(inline, botUsername)) return false;
  if (typeof inline.path === "string" && inline.path.trim() && isBugFindingFirstLine(inline.path)) return true;
  const body = inline.body ?? "";
  return body.trim() !== "" && countBugFindings(body) > 0;
}

function isRiskInlineLocal(inline: InlineComment, botUsername?: string): boolean {
  if (!isOpenJumiInlineLocal(inline, botUsername)) return false;
  if (typeof inline.path === "string" && inline.path.trim() && isRiskFindingFirstLine(inline.path)) return true;
  const body = inline.body ?? "";
  return body.trim() !== "" && countRiskFindings(body) > 0;
}

function isMaintainerInlineLocal(inline: InlineComment, botUsername?: string): boolean {
  if (!isBlockingQuestionInlineLocal(inline, botUsername)) return false;
  return isMaintainerQuestionInline(inline.path, inline.body ?? "");
}

function openBugsForEvidence(body: string, inlines: readonly InlineComment[], botUsername?: string): number {
  const parsed = parseReviewOutput(body ?? "");
  let inlineCount = 0;
  for (const inline of inlines) {
    if (isBugInlineLocal(inline, botUsername)) inlineCount++;
  }
  return countBugFindings(parsed.comment) + inlineCount;
}

function openRisksForEvidence(body: string, inlines: readonly InlineComment[], botUsername?: string): number {
  const parsed = parseReviewOutput(body ?? "");
  let inlineCount = 0;
  for (const inline of inlines) {
    if (isRiskInlineLocal(inline, botUsername)) inlineCount++;
  }
  return countRiskFindings(parsed.comment) + inlineCount;
}

function openMaintainersForEvidence(body: string, inlines: readonly InlineComment[], botUsername?: string): number {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return 0;
  if (lastCheckTrailerLocal(body)?.state !== "success") return 0;
  const parsed = parseReviewOutput(body);
  if (parsed.verdict.incomplete || parsed.verdict.state !== "success") return 0;
  let inlineCount = 0;
  for (const inline of inlines) {
    if (isMaintainerInlineLocal(inline, botUsername)) inlineCount++;
  }
  return countMaintainerQuestionFindings(parsed.comment) + inlineCount;
}

function openBlockingForEvidence(
  body: string,
  inlines: readonly InlineComment[],
  prAuthorLogin: string | undefined | null,
  blockingAuthors: readonly string[] | undefined | null,
  botUsername?: string
): number {
  if (!isBlockingQuestionAuthor(prAuthorLogin, blockingAuthors)) return 0;
  if (lastCheckTrailerLocal(body)?.state !== "success") return 0;
  const bodyCount = blockingOpenQuestionCount(body, prAuthorLogin, blockingAuthors);
  let inlineCount = 0;
  for (const inline of inlines) {
    if (isBlockingQuestionInlineLocal(inline, botUsername)) inlineCount++;
  }
  return bodyCount + inlineCount;
}

export interface SettleFollowUpHoldOpts {
  // biome-ignore lint/suspicious/noExplicitAny: forge fakes vary per test.
  api: any;
  owner: string;
  repo: string;
  prNumber: number;
  latches: SkipLatchStore;
  latchKey: SkipLatchKey;
  intent: HoldSettlementIntent;
  trigger?: { event?: string; commentId?: number; reviewId?: number; sender?: string };
  botUsername: string;
  defaultBranch: string;
  deploymentTrusted?: readonly string[];
  deploymentIgnore?: readonly string[];
  deploymentBlocking?: readonly string[];
  log?: (message: string) => void;
  targetUrl?: string;
}

/**
 * Fresh settlement effect for follow-up cleanup. Reads the current PR head,
 * the effective policy, the latest Jumi-authored review on that head with its
 * inline group (summary plus empty-body companion), and the held head's
 * current review-context status immediately before deciding; reuses the
 * verdict parsers and inline grouping. Posts `success` only on fresh positive
 * evidence, otherwise keeps with one log line naming the reason. Never throws.
 */
export async function settleFollowUpHold(opts: SettleFollowUpHoldOpts): Promise<void> {
  const log = opts.log ?? (() => undefined);
  try {
    let hold: { consumed?: boolean; headSha?: string; count?: number } | undefined;
    try {
      hold = await readSuggestionHold(opts.latches, opts.latchKey);
    } catch (err) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (hold unreadable: ${errorMessage(err)})`
      );
      return;
    }
    let livePr: Pull | undefined;
    let liveTargetUrl: string | undefined;
    try {
      // Fresh head immediately before the effect, not the round's earlier
      // snapshot. Re-resolve through the open-pull listing the worker used,
      // falling back to a direct pull fetch; both are fresh forge reads.
      if (typeof opts.api?.listOpenPulls === "function") {
        const open = await opts.api.listOpenPulls(opts.owner, opts.repo);
        const found = (Array.isArray(open) ? open : []).find(
          (entry) => typeof entry?.number === "number" && entry.number === opts.prNumber
        );
        if (found) {
          livePr = found as Pull;
          liveTargetUrl = (found as Pull).html_url ?? undefined;
        }
      }
      if (!livePr) {
        if (typeof opts.api?.getPR !== "function") {
          log(`hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (getPR unavailable)`);
          return;
        }
        const fresh = (await opts.api.getPR(opts.owner, opts.repo, opts.prNumber)) as Pull;
        livePr = fresh;
        liveTargetUrl = fresh?.html_url ?? undefined;
      }
    } catch (err) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (failed to load pull request: ${errorMessage(err)})`
      );
      return;
    }
    if (!livePr) {
      log(`hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (missing pull request)`);
      return;
    }
    const currentHeadSha = livePr.head?.sha ?? "";
    if (!currentHeadSha) {
      log(`hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (missing head)`);
      return;
    }
    if (hold?.headSha && hold.headSha.toLowerCase() !== currentHeadSha.toLowerCase()) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: head-mismatch (held ${hold.headSha} vs ${currentHeadSha})`
      );
      return;
    }

    let holdEnabled = true;
    let blockingAuthors: readonly string[] | undefined;
    let effectiveTrusted: readonly string[] | undefined;
    let effectiveIgnore: readonly string[] | undefined;
    try {
      const snapshot = await loadSettingsSnapshot(opts.api, opts.owner, opts.repo, opts.defaultBranch ?? null);
      const load = failOpenLoadFromSnapshot(snapshot);
      holdEnabled = isMaintainerQuestionsHoldEnabled(load);
      blockingAuthors = effectiveBlockingQuestionAuthors(opts.deploymentBlocking, load);
      effectiveTrusted = effectiveTrustedSenderLogins(opts.deploymentTrusted, load);
      effectiveIgnore = effectiveFollowupIgnoreLogins(opts.deploymentIgnore, load);
    } catch (err) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (settings unreadable: ${errorMessage(err)})`
      );
      return;
    }

    let rawReviews: PullReview[];
    let rawComments: Comment[];
    let rawInlines: InlineComment[];
    try {
      if (typeof opts.api?.listPullReviews !== "function") {
        log(
          `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (listPullReviews unavailable)`
        );
        return;
      }
      rawReviews = await opts.api.listPullReviews(opts.owner, opts.repo, opts.prNumber);
    } catch (err) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (failed to load pull reviews: ${errorMessage(err)})`
      );
      return;
    }
    try {
      if (typeof opts.api?.listIssueComments !== "function") {
        log(
          `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (listIssueComments unavailable)`
        );
        return;
      }
      rawComments = await opts.api.listIssueComments(opts.owner, opts.repo, opts.prNumber);
    } catch (err) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (failed to load comments: ${errorMessage(err)})`
      );
      return;
    }
    try {
      if (typeof opts.api?.listPullReviewComments !== "function") {
        log(
          `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (listPullReviewComments unavailable)`
        );
        return;
      }
      rawInlines = await opts.api.listPullReviewComments(opts.owner, opts.repo, opts.prNumber, rawReviews);
    } catch (err) {
      if (!(err instanceof Error) || !/→ 404\b/.test(err.message)) {
        log(
          `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (failed to load inlines: ${errorMessage(err)})`
        );
        return;
      }
      rawInlines = [];
    }

    const jumiReviews = rawReviews.filter((review) => isJumiPullReviewWriteupLocal(review, opts.botUsername));
    const jumiStickies = rawComments.filter((comment) => isJumiReviewStickyLocal(comment, opts.botUsername));
    const candidates: Array<{
      at: string;
      body: string;
      id: number;
      sha: string | undefined;
      summary: PullReview | undefined;
    }> = [];
    for (const review of jumiReviews) {
      const body = pullReviewBodyLocal(review);
      const sha = pullReviewFindingShaLocal(review);
      if (!sha || !commitMatchesHeadLocal(sha, currentHeadSha)) continue;
      candidates.push({
        at: review.submitted_at ?? review.updated_at ?? review.created_at ?? "",
        body,
        id: review.id,
        sha,
        summary: review,
      });
    }
    for (const comment of jumiStickies) {
      const body = comment.body ?? "";
      const sha = parseReviewedCommitShaLocal(body);
      if (!sha || !commitMatchesHeadLocal(sha, currentHeadSha)) continue;
      candidates.push({ at: comment.created_at ?? "", body, id: comment.id, sha, summary: undefined });
    }
    if (candidates.length === 0) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (no review found on ${currentHeadSha})`
      );
      return;
    }
    candidates.sort((a, b) => a.at.localeCompare(b.at));
    const latest = candidates[candidates.length - 1]!;
    const reviewBody = latest.body ?? "";
    const reviewSha = latest.sha ?? parseReviewedCommitShaLocal(reviewBody);
    if (!reviewSha) {
      log(`hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (unparseable review)`);
      return;
    }
    const summaryReview = latest.summary;
    const reviewInlines =
      summaryReview != null ? inlinesForReviewGroup(summaryReview, rawReviews, rawInlines, opts.botUsername) : [];
    const groupIds = summaryReview != null ? reviewGroupIds(summaryReview, rawReviews, opts.botUsername) : [];

    const parsed = parseReviewOutput(reviewBody);
    const completeSuccess = !parsed.verdict.incomplete && parsed.verdict.state === "success";
    const openBugs = openBugsForEvidence(reviewBody, reviewInlines, opts.botUsername);
    const openRisks = openRisksForEvidence(reviewBody, reviewInlines, opts.botUsername);
    const openBlockingQuestions = openBlockingForEvidence(
      reviewBody,
      reviewInlines,
      livePr.user?.login,
      blockingAuthors,
      opts.botUsername
    );
    const openMaintainers = openMaintainersForEvidence(reviewBody, reviewInlines, opts.botUsername);
    const openSuggestions = countSuggestionFindings(parsed.comment);

    let statusInput: HoldSettlementStatus;
    try {
      if (typeof opts.api?.listCommitStatuses !== "function") {
        log(
          `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (listCommitStatuses unavailable)`
        );
        return;
      }
      const shaForStatus = hold.headSha ?? currentHeadSha;
      const statuses = await opts.api.listCommitStatuses(opts.owner, opts.repo, shaForStatus);
      const ours = (Array.isArray(statuses) ? statuses : []).filter(
        (status) => (status.context ?? "") === JUMI_REVIEW_CONTEXT
      );
      if (ours.length === 0) {
        statusInput = { kind: "known", state: "missing" };
      } else {
        const pendings = ours.filter((status) => (status.state ?? status.status) === "pending");
        if (pendings.length === 0) {
          const first = ours[0]!;
          statusInput = {
            kind: "known",
            state: (first.state ?? first.status ?? "unknown") as string,
            description: first.description,
          };
        } else {
          const matching =
            pendings.find((status) => isMaintainerHoldPendingDescription(status.description)) ??
            pendings.find((status) => isSuggestionHoldPendingDescription(status.description));
          if (!matching) {
            const first = pendings[0]!;
            statusInput = { kind: "known", state: "pending", description: first.description };
          } else {
            statusInput = { kind: "known", state: "pending", description: matching.description };
          }
        }
      }
    } catch (err) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (failed to load status: ${errorMessage(err)})`
      );
      return;
    }

    let authorizedReply = false;
    const trigger = opts.trigger;
    if (trigger != null && (trigger.commentId !== undefined || trigger.reviewId !== undefined)) {
      try {
        if (trigger.commentId !== undefined) {
          const found = rawComments.find((comment) => comment.id === trigger.commentId);
          const login = found?.user?.login;
          if (
            found &&
            (found.body ?? "").trim() &&
            !loginEquals(login, opts.botUsername) &&
            !(effectiveIgnore ?? []).some((entry) => loginEquals(login, entry))
          ) {
            authorizedReply = await senderCanSteer(opts.api, opts.owner, opts.repo, login, effectiveTrusted);
          }
        } else if (trigger.reviewId !== undefined) {
          const found = rawReviews.find((review) => review.id === trigger.reviewId);
          const login = found?.user?.login;
          const body = found != null ? (found.body ?? found.content ?? "") : "";
          if (
            found &&
            body.trim() &&
            !loginEquals(login, opts.botUsername) &&
            !(effectiveIgnore ?? []).some((entry) => loginEquals(login, entry))
          ) {
            authorizedReply = await senderCanSteer(opts.api, opts.owner, opts.repo, login, effectiveTrusted);
          }
        }
      } catch {
        authorizedReply = false;
      }
    }

    const decision = decideHoldSettlement({
      hold,
      currentHeadSha,
      status: statusInput,
      holdEnabled,
      evidence: {
        kind: "known",
        reviewHeadSha: reviewSha,
        reviewOwnerOk: true,
        completeSuccess,
        openBugs,
        openRisks,
        openBlockingQuestions,
        openMaintainers,
        openSuggestions,
      },
      authorizedReply,
      intent: opts.intent,
    });
    if (decision.action === "post-success") {
      const sha = hold?.headSha ?? currentHeadSha;
      await postSuggestionHoldSuccess(
        opts.api,
        opts.owner,
        opts.repo,
        sha,
        decision.description,
        liveTargetUrl ?? opts.targetUrl
      );
      if (holdEnabled && openMaintainers > 0) {
        log(`maintainer hold released for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${openMaintainers} answered`);
      }
      return;
    }
    if (decision.reason === "no-hold" || decision.reason === "zero-count") return;
    if (decision.reason === "unknown-status" || decision.reason === "unknown-evidence") {
      log(`hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (${decision.reason})`);
      return;
    }
    // Preserve the historical `maintainer hold kept` line for open maintainer
    // questions so existing dashboards and tests keep matching; other keeps use
    // the settlement prefix. Both name the typed reason in one line.
    const prefix = openMaintainers > 0 ? "maintainer hold kept" : "hold settlement kept";
    log(
      `${prefix} for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${decision.reason} ` +
        `(maintainers=${openMaintainers} bugs=${openBugs} risks=${openRisks} ` +
        `blocking=${openBlockingQuestions} completeSuccess=${completeSuccess} ` +
        `reviews=[${groupIds.join(",")}])`
    );
  } catch (err) {
    log(`hold settlement kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: unknown (${errorMessage(err)})`);
  }
}
