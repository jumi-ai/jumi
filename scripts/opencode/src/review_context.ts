import { byteLength } from "./diagnostics.ts";
import type { Comment, InlineComment, PullReview, Task } from "./ports.ts";

export const DEFAULT_MAX_THREAD_BYTES = 200_000;
export const MAX_COMMENT_BODY_BYTES = 32_768;
export const MAX_LINKED_ISSUE_BODY_BYTES = 8_192;
const OMITTED_BODY = "[omitted; thread budget]";
const encoder = new TextEncoder();

export type ReviewCommentIntent = "product" | "discussion";

export interface ReviewComment {
  id: number;
  author: string;
  created_at: string;
  body: string;
  /** Raw forge permission, lowercased (`admin`/`write`/`maintain`/`read`/`triage`/`none`). */
  permission?: string;
  /** Product-intent labeling: writers are `product`, everyone else is `discussion`. */
  intent?: ReviewCommentIntent;
}

export interface ReviewLinkedIssue {
  number: number;
  state: string;
  author: string;
  html_url: string;
  title: string;
  body: string;
  comments: ReviewComment[];
}

/** A human pull-review body (REQUEST_CHANGES / APPROVED / COMMENT) as product context. */
export interface ReviewThreadPullReview {
  id: number;
  author: string;
  created_at: string;
  body: string;
  /** Raw forge review state/type, lowercased (e.g. `request_changes`, `approved`, `commented`). */
  state?: string;
  /** Dismissed reviews stay in context: dismissal is not a retraction. */
  dismissed?: boolean;
  commit_id?: string;
  /** Raw forge permission, lowercased. */
  permission?: string;
  /** Product-intent labeling: writers are `product`, everyone else is `discussion`. */
  intent?: ReviewCommentIntent;
}

/** A human inline (pull-review comment) as product context. */
export interface ReviewThreadInline {
  id: number;
  review_id?: number;
  author: string;
  created_at: string;
  body: string;
  path?: string;
  line?: number;
  commit_id?: string;
  resolved?: boolean;
  resolver?: string;
  /** State of the parent pull review, lowercased, when known. */
  review_state?: string;
  /** Raw forge permission, lowercased. */
  permission?: string;
  /** Product-intent labeling: writers are `product`, everyone else is `discussion`. */
  intent?: ReviewCommentIntent;
}

export interface ReviewThread {
  comments: ReviewComment[];
  linkedIssues: ReviewLinkedIssue[];
  pullReviews?: ReviewThreadPullReview[];
  reviewComments?: ReviewThreadInline[];
}

export interface FitReviewThreadResult {
  thread: ReviewThread;
  truncated: boolean;
  droppedCommentBodies: number;
  threadBytes: number;
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function intentForWriteAccess(hasWrite: boolean): ReviewCommentIntent {
  return hasWrite ? "product" : "discussion";
}

function lookupWriteAccess(permissions: ReadonlyMap<string, boolean> | undefined, author: string): boolean | undefined {
  if (!permissions) return undefined;
  const key = author.trim().toLowerCase();
  if (!key) return false;
  return permissions.get(key) === true;
}

function lookupPermissionDetail(
  permissionDetail: ReadonlyMap<string, string> | undefined,
  author: string,
  hasWrite: boolean
): string {
  const key = author.trim().toLowerCase();
  const detail = key ? permissionDetail?.get(key) : undefined;
  if (typeof detail === "string" && detail.trim()) return detail.trim().toLowerCase();
  return hasWrite ? "write" : "none";
}

export function mapReviewComment(
  comment: Comment,
  permissions?: ReadonlyMap<string, boolean>,
  permissionDetail?: ReadonlyMap<string, string>
): ReviewComment {
  const author = comment.user?.login ?? "";
  const base: ReviewComment = {
    id: comment.id,
    author,
    created_at: comment.created_at,
    body: comment.body ?? "",
  };
  const hasWrite = lookupWriteAccess(permissions, author);
  if (hasWrite === undefined) return base;
  const permission = lookupPermissionDetail(permissionDetail, author, hasWrite);
  return { ...base, permission, intent: intentForWriteAccess(hasWrite) };
}

function pullReviewBody(review: PullReview): string {
  return review.body ?? review.content ?? "";
}

function pullReviewCreatedAt(review: PullReview): string {
  return review.submitted_at ?? review.updated_at ?? review.created_at ?? "";
}

function normalizeReviewState(review: PullReview): string | undefined {
  const blob = `${review.state ?? ""} ${review.type ?? ""}`.trim().toLowerCase().replace(/\s+/g, "_");
  const cleaned = blob.replace(/^_+|_+$/g, "");
  return cleaned || undefined;
}

export function mapPullReview(
  review: PullReview,
  permissions?: ReadonlyMap<string, boolean>,
  permissionDetail?: ReadonlyMap<string, string>
): ReviewThreadPullReview {
  const author = review.user?.login ?? "";
  const base: ReviewThreadPullReview = {
    id: review.id,
    author,
    created_at: pullReviewCreatedAt(review),
    body: pullReviewBody(review),
    ...(normalizeReviewState(review) ? { state: normalizeReviewState(review) } : {}),
    ...(review.dismissed === true ? { dismissed: true } : {}),
    ...(review.commit_id ? { commit_id: review.commit_id } : {}),
  };
  const hasWrite = lookupWriteAccess(permissions, author);
  if (hasWrite === undefined) return base;
  const permission = lookupPermissionDetail(permissionDetail, author, hasWrite);
  return { ...base, permission, intent: intentForWriteAccess(hasWrite) };
}

export function mapReviewInline(
  comment: InlineComment,
  permissions?: ReadonlyMap<string, boolean>,
  permissionDetail?: ReadonlyMap<string, string>,
  reviewStateById?: ReadonlyMap<number, string>
): ReviewThreadInline {
  const author = comment.user?.login ?? "";
  const line = comment.new_position ?? undefined;
  const base: ReviewThreadInline = {
    id: comment.id,
    ...(comment.pull_request_review_id != null ? { review_id: comment.pull_request_review_id } : {}),
    author,
    created_at: comment.created_at,
    body: comment.body ?? "",
    ...(comment.path ? { path: comment.path } : {}),
    ...(line != null ? { line } : {}),
    ...(comment.commit_id ? { commit_id: comment.commit_id } : {}),
    ...(comment.resolved === true ? { resolved: true } : {}),
    ...(comment.resolver?.login ? { resolver: comment.resolver.login } : {}),
    ...(comment.pull_request_review_id != null && reviewStateById?.get(comment.pull_request_review_id)
      ? { review_state: reviewStateById.get(comment.pull_request_review_id) }
      : {}),
  };
  const hasWrite = lookupWriteAccess(permissions, author);
  if (hasWrite === undefined) return base;
  const permission = lookupPermissionDetail(permissionDetail, author, hasWrite);
  return { ...base, permission, intent: intentForWriteAccess(hasWrite) };
}

function byThreadTime(a: { created_at: string; id: number }, b: { created_at: string; id: number }): number {
  const byDate = a.created_at.localeCompare(b.created_at);
  if (byDate !== 0) return byDate;
  return a.id - b.id;
}

export function mapReviewThread(opts: {
  prComments: Comment[];
  linkedIssues: Array<{ issue: Task; comments: Comment[] }>;
  pullReviews?: PullReview[];
  reviewComments?: InlineComment[];
  permissions?: ReadonlyMap<string, boolean>;
  permissionDetail?: ReadonlyMap<string, string>;
}): ReviewThread {
  const reviewStateById = new Map<number, string>();
  for (const review of opts.pullReviews ?? []) {
    const state = normalizeReviewState(review);
    if (typeof review.id === "number" && state) reviewStateById.set(review.id, state);
  }
  // Empty review bodies carry no instruction; their inline comments still do.
  // Dismissed/stale reviews stay in context: dismissal is not a retraction.
  const pullReviews = (opts.pullReviews ?? [])
    .filter((review) => pullReviewBody(review).trim().length > 0)
    .map((review) => mapPullReview(review, opts.permissions, opts.permissionDetail))
    .sort(byThreadTime);
  const reviewComments = (opts.reviewComments ?? [])
    .filter((comment) => (comment.body ?? "").trim().length > 0)
    .map((comment) => mapReviewInline(comment, opts.permissions, opts.permissionDetail, reviewStateById))
    .sort(byThreadTime);
  return {
    comments: opts.prComments.map((comment) => mapReviewComment(comment, opts.permissions, opts.permissionDetail)),
    linkedIssues: opts.linkedIssues.map(({ issue, comments }) => ({
      number: issue.number,
      state: issue.state,
      author: issue.user?.login ?? "",
      html_url: issue.html_url,
      title: issue.title,
      body: issue.body ?? "",
      comments: comments.map((comment) => mapReviewComment(comment, opts.permissions, opts.permissionDetail)),
    })),
    pullReviews,
    reviewComments,
  };
}

function formatCommentXml(comment: ReviewComment, indent: string): string {
  const extra =
    comment.intent !== undefined || comment.permission !== undefined
      ? `${comment.permission !== undefined ? ` permission="${escapeXml(comment.permission)}"` : ""}${comment.intent !== undefined ? ` intent="${escapeXml(comment.intent)}"` : ""}`
      : "";
  return `${indent}<comment id="${comment.id}" author="${escapeXml(comment.author)}" created_at="${escapeXml(comment.created_at)}"${extra}>${escapeXml(comment.body)}</comment>`;
}

function formatCommentsXml(comments: ReviewComment[], indent: string): string {
  if (comments.length === 0) return "";
  const inner = `${indent}  `;
  const items = comments.map((comment) => formatCommentXml(comment, inner)).join("\n");
  return `${indent}<comments>\n${items}\n${indent}</comments>`;
}

export function formatPrCommentsXml(comments: ReviewComment[]): string {
  return formatCommentsXml(comments, "    ");
}

function formatLinkedIssueXml(issue: ReviewLinkedIssue): string {
  const commentsXml = formatCommentsXml(issue.comments, "      ");
  const commentsBlock = commentsXml ? `\n${commentsXml}` : "";
  return `    <issue number="${issue.number}" state="${escapeXml(issue.state)}" author="${escapeXml(issue.author)}" html_url="${escapeXml(issue.html_url)}">
      <title>${escapeXml(issue.title)}</title>
      <body>${escapeXml(issue.body)}</body>${commentsBlock}
    </issue>`;
}

export function formatLinkedIssuesXml(issues: ReviewLinkedIssue[]): string {
  if (issues.length === 0) return "";
  const items = issues.map(formatLinkedIssueXml).join("\n");
  return `  <linked_issues>\n${items}\n  </linked_issues>`;
}

function formatIntentExtra(permission?: string, intent?: ReviewCommentIntent): string {
  if (permission === undefined && intent === undefined) return "";
  return `${permission !== undefined ? ` permission="${escapeXml(permission)}"` : ""}${intent !== undefined ? ` intent="${escapeXml(intent)}"` : ""}`;
}

export function formatPullReviewsXml(reviews: ReviewThreadPullReview[]): string {
  if (reviews.length === 0) return "";
  const items = reviews
    .map((review) => {
      const extra = formatIntentExtra(review.permission, review.intent);
      const state = review.state !== undefined ? ` state="${escapeXml(review.state)}"` : "";
      const dismissed = review.dismissed === true ? ` dismissed="true"` : "";
      const commit = review.commit_id !== undefined ? ` commit_id="${escapeXml(review.commit_id)}"` : "";
      return `      <review id="${review.id}" author="${escapeXml(review.author)}" created_at="${escapeXml(review.created_at)}"${state}${dismissed}${commit}${extra}>${escapeXml(review.body)}</review>`;
    })
    .join("\n");
  return `  <pull_reviews>\n${items}\n  </pull_reviews>`;
}

export function formatReviewCommentsXml(comments: ReviewThreadInline[]): string {
  if (comments.length === 0) return "";
  const items = comments
    .map((comment) => {
      const extra = formatIntentExtra(comment.permission, comment.intent);
      const reviewId = comment.review_id !== undefined ? ` review_id="${comment.review_id}"` : "";
      const path = comment.path !== undefined ? ` path="${escapeXml(comment.path)}"` : "";
      const line = comment.line !== undefined ? ` line="${comment.line}"` : "";
      const commit = comment.commit_id !== undefined ? ` commit_id="${escapeXml(comment.commit_id)}"` : "";
      const resolved = comment.resolved === true ? ` resolved="true"` : "";
      const resolver = comment.resolver !== undefined ? ` resolver="${escapeXml(comment.resolver)}"` : "";
      const reviewState =
        comment.review_state !== undefined ? ` review_state="${escapeXml(comment.review_state)}"` : "";
      return `      <inline_comment id="${comment.id}"${reviewId} author="${escapeXml(comment.author)}" created_at="${escapeXml(comment.created_at)}"${path}${line}${commit}${resolved}${resolver}${reviewState}${extra}>${escapeXml(comment.body)}</inline_comment>`;
    })
    .join("\n");
  return `  <review_comments>\n${items}\n  </review_comments>`;
}

export function serializeReviewThread(thread: ReviewThread): string {
  const parts = [
    formatPrCommentsXml(thread.comments),
    formatPullReviewsXml(thread.pullReviews ?? []),
    formatReviewCommentsXml(thread.reviewComments ?? []),
    formatLinkedIssuesXml(thread.linkedIssues),
  ].filter((part) => part.length > 0);
  return parts.join("\n");
}

function cloneComment(comment: ReviewComment): ReviewComment {
  return { ...comment };
}

function cloneThread(thread: ReviewThread): ReviewThread {
  return {
    comments: thread.comments.map(cloneComment),
    linkedIssues: thread.linkedIssues.map((issue) => ({
      ...issue,
      comments: issue.comments.map(cloneComment),
    })),
    pullReviews: (thread.pullReviews ?? []).map((review) => ({ ...review })),
    reviewComments: (thread.reviewComments ?? []).map((comment) => ({ ...comment })),
  };
}

type ThreadBody = { body: string };

function allComments(thread: ReviewThread): ThreadBody[] {
  return [
    ...thread.comments,
    ...(thread.pullReviews ?? []),
    ...(thread.reviewComments ?? []),
    ...thread.linkedIssues.flatMap((issue) => issue.comments),
  ];
}

function omissionOrder(thread: ReviewThread): ThreadBody[] {
  const lists: ThreadBody[][] = [
    thread.comments,
    thread.pullReviews ?? [],
    thread.reviewComments ?? [],
    ...thread.linkedIssues.map((issue) => issue.comments),
  ].map((list) =>
    [...list].sort((a, b) => {
      const aAt = "created_at" in a ? (a as { created_at: string }).created_at : "";
      const bAt = "created_at" in b ? (b as { created_at: string }).created_at : "";
      const byDate = aAt.localeCompare(bAt);
      if (byDate !== 0) return byDate;
      return (a as { id: number }).id - (b as { id: number }).id;
    })
  );
  const order: ThreadBody[] = [];
  let index = 0;
  let added = true;
  while (added) {
    added = false;
    for (const list of lists) {
      const item = list[index];
      if (item) {
        order.push(item);
        added = true;
      }
    }
    index += 1;
  }
  return order;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function threadByteLength(thread: ReviewThread): number {
  return byteLength(serializeReviewThread(thread));
}

export function fitReviewThread(thread: ReviewThread, maxBytes: number): FitReviewThreadResult {
  const fitted = cloneThread(thread);
  const underCap = () => threadByteLength(fitted) <= maxBytes;

  if (underCap()) {
    return {
      thread: fitted,
      truncated: false,
      droppedCommentBodies: 0,
      threadBytes: threadByteLength(fitted),
    };
  }

  let truncated = false;
  let droppedCommentBodies = 0;

  for (const comment of allComments(fitted)) {
    if (byteLength(comment.body) > MAX_COMMENT_BODY_BYTES) {
      comment.body = `${truncateUtf8(comment.body, MAX_COMMENT_BODY_BYTES)}\n[truncated]`;
      truncated = true;
    }
  }

  if (!underCap()) {
    for (const comment of omissionOrder(fitted)) {
      if (underCap()) break;
      if (comment.body === OMITTED_BODY) continue;
      comment.body = OMITTED_BODY;
      droppedCommentBodies += 1;
      truncated = true;
    }
  }

  if (!underCap()) {
    for (const issue of fitted.linkedIssues) {
      if (byteLength(issue.body) > MAX_LINKED_ISSUE_BODY_BYTES) {
        issue.body = truncateUtf8(issue.body, MAX_LINKED_ISSUE_BODY_BYTES);
        truncated = true;
      }
    }
  }

  return {
    thread: fitted,
    truncated,
    droppedCommentBodies,
    threadBytes: threadByteLength(fitted),
  };
}
