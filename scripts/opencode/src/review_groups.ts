import { isJumiWorkerBody } from "./followup_webhook.ts";
import type { InlineComment, PullReview } from "./ports.ts";
import { loginEquals } from "./util/login.ts";
import { parseCheckLine } from "./verdict.ts";

function lastTrailerForGroup(body: string): { state: "success" | "failure"; reason: string } | undefined {
  const lines = body.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    return parseCheckLine(line);
  }
  return undefined;
}

function groupReviewBody(review: PullReview): string {
  return review.body ?? review.content ?? "";
}

function groupReviewTime(review: PullReview): string {
  return review.submitted_at ?? review.updated_at ?? review.created_at ?? "";
}

function groupReviewCommit(review: PullReview): string {
  const body = groupReviewBody(review);
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*Reviewed commit:\s*`([0-9a-fA-F]+)`\s*$/.exec(line.trim());
    if (match?.[1]) return match[1].toLowerCase();
  }
  return (review.commit_id ?? "").toLowerCase();
}

function commitsMatchForGroup(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  return left.startsWith(right) || right.startsWith(left);
}

function isSummaryForGroup(review: PullReview, botUsername?: string): boolean {
  if (typeof botUsername === "string" && botUsername) {
    if (!loginEquals(review.user?.login, botUsername)) return false;
  }
  const body = groupReviewBody(review);
  if (!body.trim() || isJumiWorkerBody(body)) return false;
  return lastTrailerForGroup(body) !== undefined;
}

function isStrictlyBeforeForGroup(candidate: PullReview, summary: PullReview): boolean {
  const candidateTime = groupReviewTime(candidate);
  const summaryTime = groupReviewTime(summary);
  if (candidateTime && summaryTime) {
    if (candidateTime !== summaryTime) return candidateTime < summaryTime;
    return candidate.id < summary.id;
  }
  return candidate.id < summary.id;
}

/**
 * Review ids counted for a head's last summary review: the summary itself
 * plus every bot-owned empty-body Jumi review on the same commit posted
 * just before it, with no newer summary review in between. The reviewer
 * publishes inlines in a separate empty-body review ahead of the summary
 * body, so the release path must count the pair together.
 */
export function reviewGroupIds(summary: PullReview, allReviews: readonly PullReview[], botUsername?: string): number[] {
  const ids = new Set<number>([summary.id]);
  const summaryCommit = groupReviewCommit(summary);
  if (!summaryCommit) return [...ids];
  for (const review of allReviews) {
    if (review.id === summary.id) continue;
    if (typeof botUsername === "string" && botUsername) {
      if (!loginEquals(review.user?.login, botUsername)) continue;
    }
    if (groupReviewBody(review).trim() !== "") continue;
    if (!commitsMatchForGroup(groupReviewCommit(review), summaryCommit)) continue;
    if (!isStrictlyBeforeForGroup(review, summary)) continue;
    let blocked = false;
    for (const other of allReviews) {
      if (other.id === summary.id || other.id === review.id) continue;
      if (!isSummaryForGroup(other, botUsername)) continue;
      if (!commitsMatchForGroup(groupReviewCommit(other), summaryCommit)) continue;
      if (isStrictlyBeforeForGroup(review, other) && isStrictlyBeforeForGroup(other, summary)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) ids.add(review.id);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Inlines belonging to a summary review's publish pair: the summary's own
 * inlines plus open Jumi inlines from its empty-body companion review(s),
 * plus orphans without a review id (both forges normally set it, but an
 * orphan must not silently drop a blocking question).
 */
export function inlinesForReviewGroup(
  summary: PullReview,
  allReviews: readonly PullReview[],
  inlines: readonly InlineComment[],
  botUsername?: string
): InlineComment[] {
  const group = new Set(reviewGroupIds(summary, allReviews, botUsername));
  return inlines.filter((inline) => inline.pull_request_review_id == null || group.has(inline.pull_request_review_id));
}
