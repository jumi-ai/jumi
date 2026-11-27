import { isForbiddenError, isNotFoundError } from "./forge_errors.ts";
import type { InlineComment } from "./ports.ts";
import {
  classifyInlineText,
  type ResolvedReviewFacts,
  type ReviewTrustCtx,
  resolveReviewFacts,
} from "./review_facts.ts";
import { errorMessage } from "./util/error.ts";
import { loginEquals } from "./util/login.ts";

const REVIEW_MARKER = "<!-- jumi-review:";

/** Marker for the once-only permission note on the PR board. */
export function holdResolveNoteMarker(owner: string, repo: string, prNumber: number): string {
  return `<!-- jumi-hold-resolve:${owner}/${repo}#${prNumber} -->`;
}

function isUnresolvedInline(inline: InlineComment): boolean {
  return inline.resolved !== true && inline.resolver == null;
}

function isJumiOwnedOpenInline(inline: InlineComment, botUsername?: string): boolean {
  const body = inline.body ?? "";
  if (!body.includes(REVIEW_MARKER)) return false;
  if (typeof botUsername === "string" && botUsername) {
    if (!loginEquals(inline.user?.login, botUsername)) return false;
  }
  return isUnresolvedInline(inline);
}

function isBugLikeInline(inline: InlineComment): boolean {
  return classifyInlineText(inline.path, inline.body).bugLike;
}

function isRiskLikeInline(inline: InlineComment): boolean {
  return classifyInlineText(inline.path, inline.body).riskLike;
}

function isSuggestionLikeInline(inline: InlineComment): boolean {
  return classifyInlineText(inline.path, inline.body).suggestionLike;
}

/**
 * Whether a held-review inline is safe for the release to resolve: Jumi's own
 * open thread carrying an answered `❓ maintainer:` question or a consumed
 * `💡` suggestion, and never a still-open `🔴`/`🟡` finding. Threads a person
 * or another bot started never match (marker plus bot login).
 *
 * When group `resolved` facts (from `resolveReviewFacts` over the review
 * body plus its inline group) are provided and verified, severity comes from
 * the signed entries — a `💡` suggestion in a `🔴`-named file resolves, a
 * severity-less signed bug does not — matched by live comment id. Otherwise
 * the legacy text classifier decides.
 */
export function isResolvableHoldInline(
  inline: InlineComment,
  botUsername?: string,
  resolved?: ResolvedReviewFacts
): boolean {
  if (!isJumiOwnedOpenInline(inline, botUsername)) return false;
  const typed =
    resolved && resolved.source === "typed"
      ? resolved.facts.findings.find((finding) => finding.inlineId === inline.id)
      : undefined;
  if (typed) {
    if (typed.severity === "bug" || typed.severity === "risk") return false;
    return typed.severity === "suggestion" || typed.questionKind === "maintainer";
  }
  if (isBugLikeInline(inline)) return false;
  if (isRiskLikeInline(inline)) return false;
  if (classifyInlineText(inline.path, inline.body).maintainerQuestion) return true;
  if (isSuggestionLikeInline(inline)) return true;
  return false;
}

function isMissingResolveMethod(err: unknown): boolean {
  return err instanceof TypeError || /not a function|undefined/i.test(errorMessage(err));
}

/** 401/403 from either forge adapter: the token cannot resolve threads. */
function isResolvePermissionError(err: unknown): boolean {
  if (isForbiddenError(err)) return true;
  if (!(err instanceof Error)) return false;
  if (/→ 401\b/.test(err.message)) return true;
  // GitHub GraphQL surfaces permission denials as 200 + errors (no `→ 403`).
  return /GitHub GraphQL →.*(forbidden|not accessible|requires?.*permission|permission.*denied|unauthorized)/i.test(
    err.message
  );
}

interface HoldResolveApi {
  // biome-ignore lint/suspicious/noExplicitAny: forge fakes vary per test.
  resolvePullComment?: any;
  findStickyIssueComment?(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number; body?: string } | undefined>;
  createIssueComment?(owner: string, repo: string, index: number, body: string): Promise<unknown>;
}

async function noteResolvePermissionOnce(
  api: HoldResolveApi,
  owner: string,
  repo: string,
  prNumber: number,
  botUsername: string,
  log: (message: string) => void
): Promise<void> {
  try {
    if (typeof api.findStickyIssueComment !== "function" || typeof api.createIssueComment !== "function") {
      return;
    }
    const marker = holdResolveNoteMarker(owner, repo, prNumber);
    const existing = await api.findStickyIssueComment(owner, repo, prNumber, botUsername, marker);
    if (existing) return;
    await api.createIssueComment(
      owner,
      repo,
      prNumber,
      `${marker}\nJumi released the hold but could not resolve its answered review threads (the forge refused with a permission error). A maintainer with write access can resolve the answered threads.`
    );
  } catch (err) {
    if (!isMissingResolveMethod(err) && !isNotFoundError(err)) {
      log(`hold resolve note failed for ${owner}/${repo}#${prNumber}: ${errorMessage(err)}`);
    }
  }
}

/**
 * Resolve the settled threads of a held review group after the hold-release
 * `success` is posted. Never throws and never undoes the release: failures
 * only log, and the next wake re-lists the still-open threads and retries.
 * Permission failures also leave one board note on the PR.
 */
export async function resolveSettledHoldThreads(opts: {
  // biome-ignore lint/suspicious/noExplicitAny: forge fakes vary per test.
  api: any;
  owner: string;
  repo: string;
  prNumber: number;
  inlines: readonly InlineComment[];
  botUsername: string;
  log?: (message: string) => void;
  /** Review body carrying the signed block for this inline group, when the publisher wrote one. */
  reviewBody?: string | null | undefined;
  /** Signed-block verification coordinates for this resolve decision. */
  trust?: ReviewTrustCtx;
}): Promise<{ resolved: number; failed: number; permission: boolean }> {
  const log = opts.log ?? (() => undefined);
  let resolvedFacts: ResolvedReviewFacts | undefined;
  if (opts.reviewBody) {
    try {
      resolvedFacts = resolveReviewFacts({
        body: opts.reviewBody,
        inlines: opts.inlines,
        botUsername: opts.botUsername,
        ...(opts.trust ? { trust: opts.trust } : {}),
      });
    } catch {
      resolvedFacts = undefined;
    }
  }
  const targets = opts.inlines.filter((inline) => isResolvableHoldInline(inline, opts.botUsername, resolvedFacts));
  if (targets.length === 0) return { resolved: 0, failed: 0, permission: false };
  if (typeof opts.api?.resolvePullComment !== "function") {
    log(`hold resolve skipped for ${opts.owner}/${opts.repo}#${opts.prNumber}: resolvePullComment unavailable`);
    return { resolved: 0, failed: 0, permission: false };
  }
  let resolved = 0;
  let failed = 0;
  let permission = false;
  for (const inline of targets) {
    try {
      await opts.api.resolvePullComment(opts.owner, opts.repo, inline.id);
      resolved++;
    } catch (err) {
      failed++;
      log(
        `hold resolve failed for ${opts.owner}/${opts.repo}#${opts.prNumber} thread ${inline.id}: ${errorMessage(err)}`
      );
      if (isResolvePermissionError(err)) permission = true;
    }
  }
  if (permission) {
    await noteResolvePermissionOnce(opts.api, opts.owner, opts.repo, opts.prNumber, opts.botUsername, log);
  }
  return { resolved, failed, permission };
}
