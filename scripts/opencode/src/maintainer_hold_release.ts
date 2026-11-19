import {
  assessMaintainerHoldRelease,
  commitMatchesHead,
  inlinesForPullReview,
  isJumiPullReviewWriteup,
  isJumiReviewSticky,
  lastCheckTrailer,
  parseReviewedCommitSha,
  pickLatestJumiFinding,
} from "./followup.ts";
import { loginInList } from "./followup_webhook.ts";
import { hasTrustedSenders, type PermissionApi, senderCanSteer } from "./permissions.ts";
import type { Comment, InlineComment, Pull, PullReview } from "./ports.ts";
import {
  effectiveBlockingQuestionAuthors,
  failOpenLoadFromSnapshot,
  isMaintainerQuestionsHoldEnabled,
  loadSettingsSnapshot,
} from "./repo_settings.ts";
import { type HoldStatusPort, postSuggestionHoldSuccess } from "./suggestion_hold.ts";
import { loginEquals } from "./util/login.ts";

export type MaintainerHoldReleaseApi = Pick<
  HoldStatusPort & PermissionApi,
  "createCommitStatus" | "getCollaboratorPermission"
> &
  Partial<Pick<PermissionApi, "getAppPermissions">> &
  Pick<
    import("./gitea_issues.ts").IssueApi,
    "getPR" | "listIssueComments" | "listPullReviews" | "listPullReviewComments" | "getRepoFile"
  >;

export type MaintainerHoldReleaseOutcome =
  | { outcome: "released"; prNumber: number; headSha: string; openMaintainers: number }
  | { outcome: "skip"; reason: string };

/** Skip reasons from the scope gate that may still hold a maintainer release. */
const RELEASE_CANDIDATE_PREFIXES = ["not labeled"];
const RELEASE_CANDIDATE_REASONS = new Set(["not a jumi pull request", "no closing issue", "not assigned to bot"]);

export function isReleaseCandidateSkipReason(reason: string): boolean {
  if (RELEASE_CANDIDATE_REASONS.has(reason)) return true;
  return RELEASE_CANDIDATE_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

function isBotOrIgnored(
  sender: string | undefined,
  botUsername: string,
  ignoreLogins: readonly string[] | undefined
): "sender is bot" | "sender ignored" | undefined {
  if (loginEquals(sender, botUsername)) return "sender is bot";
  if (loginInList(sender, ignoreLogins)) return "sender ignored";
  return undefined;
}

/**
 * Router-side release-only path for `❓ maintainer:` holds on PRs Jumi did
 * not author. Trusted maintainer comments/reviews on any in-scope PR whose
 * latest Jumi review on the current head holds the merge release the hold
 * without starting a worker, checkout, model run, or commit. Reuses
 * `assessMaintainerHoldRelease` so the release conditions cannot drift from
 * the follow-up path. Never throws: every failure is a specific skip reason.
 */
export async function tryReleaseMaintainerHold(opts: {
  api: MaintainerHoldReleaseApi | undefined;
  owner: string;
  repo: string;
  prNumber: number;
  senderLogin: string | undefined;
  botUsername: string;
  trustedSenderLogins?: readonly string[];
  followupIgnoreLogins?: readonly string[];
  defaultBranch?: string | null;
  logger?: (message: string) => void;
}): Promise<MaintainerHoldReleaseOutcome> {
  const log = opts.logger ?? (() => undefined);
  const botSender = isBotOrIgnored(opts.senderLogin, opts.botUsername, opts.followupIgnoreLogins);
  if (botSender) return { outcome: "skip", reason: botSender };

  const api = opts.api;
  if (!api || typeof api.getPR !== "function") return { outcome: "skip", reason: "not a jumi pull request" };

  const trusted = await senderCanSteer(api, opts.owner, opts.repo, opts.senderLogin, opts.trustedSenderLogins);
  if (!trusted) {
    return {
      outcome: "skip",
      reason: hasTrustedSenders(opts.trustedSenderLogins) ? "sender not on trusted list" : "sender lacks write access",
    };
  }

  let pr: Pull;
  try {
    pr = await api.getPR(opts.owner, opts.repo, opts.prNumber);
  } catch {
    return { outcome: "skip", reason: "failed to load pull request" };
  }
  if (pr.state !== "open" || pr.merged) return { outcome: "skip", reason: "pull request not open" };
  if (pr.title.trim().toLowerCase().startsWith("wip:") || pr.draft === true) {
    return { outcome: "skip", reason: "draft or WIP pull request" };
  }
  if (pr.head?.repo && pr.head.repo.full_name !== `${opts.owner}/${opts.repo}`) {
    return { outcome: "skip", reason: "fork pull request" };
  }

  const snapshot = await loadSettingsSnapshot(api, opts.owner, opts.repo, opts.defaultBranch ?? null).catch(
    (): { state: "no-branch" } => ({ state: "no-branch" })
  );
  const load = failOpenLoadFromSnapshot(snapshot);
  const holdEnabled = isMaintainerQuestionsHoldEnabled(load);
  if (!holdEnabled) {
    log(`maintainer hold skipped for ${opts.owner}/${opts.repo}#${opts.prNumber}: hold disabled`);
    return { outcome: "skip", reason: "maintainer hold disabled" };
  }
  const blockingAuthors = effectiveBlockingQuestionAuthors(undefined, load);

  let rawReviews: PullReview[];
  let rawComments: Comment[];
  let rawInlines: InlineComment[];
  try {
    rawReviews =
      typeof api.listPullReviews === "function" ? await api.listPullReviews(opts.owner, opts.repo, opts.prNumber) : [];
  } catch {
    return { outcome: "skip", reason: "failed to load pull request" };
  }
  try {
    rawComments =
      typeof api.listIssueComments === "function"
        ? await api.listIssueComments(opts.owner, opts.repo, opts.prNumber)
        : [];
  } catch {
    return { outcome: "skip", reason: "failed to load pull request" };
  }
  try {
    rawInlines =
      typeof api.listPullReviewComments === "function"
        ? await api.listPullReviewComments(opts.owner, opts.repo, opts.prNumber)
        : [];
  } catch (err) {
    if (!(err instanceof Error) || !/→ 404\b/.test(err.message)) {
      return { outcome: "skip", reason: "failed to load pull request" };
    }
    rawInlines = [];
  }

  const headSha = pr.head?.sha ?? "";
  const jumiReviews = rawReviews.filter((review) => isJumiPullReviewWriteup(review, opts.botUsername));
  const jumiStickies = rawComments.filter((comment) => isJumiReviewSticky(comment, opts.botUsername));
  const latest = pickLatestJumiFinding(
    {
      comments: [],
      inlines: [],
      reviews: [],
      jumiStickies,
      jumiInlines: [],
      jumiReviews,
      jumiFindingReviews: [],
    },
    headSha
  );
  if (!latest?.body) {
    log(`maintainer hold skipped for ${opts.owner}/${opts.repo}#${opts.prNumber}: no held maintainer review`);
    return { outcome: "skip", reason: "no held maintainer review" };
  }
  const reviewBody = latest.body ?? "";
  const reviewSha = parseReviewedCommitSha(reviewBody);
  if (!reviewSha || !commitMatchesHead(reviewSha, headSha)) {
    const from = reviewSha ?? "unknown";
    const to = headSha || "unknown";
    log(
      `maintainer hold skipped for ${opts.owner}/${opts.repo}#${opts.prNumber}: PR head changed from ${from} to ${to}`
    );
    return { outcome: "skip", reason: `PR head changed from ${from} to ${to}` };
  }
  const isPullReview = jumiReviews.some((entry) => entry.id === latest.id);
  const reviewInlines = isPullReview ? inlinesForPullReview(latest.id, rawInlines) : [];
  const assessment = assessMaintainerHoldRelease({
    reviewBody,
    inlines: reviewInlines,
    prAuthorLogin: pr.user?.login,
    blockingAuthors,
    botUsername: opts.botUsername,
    holdEnabled,
  });
  if (assessment.releasable) {
    const targetUrl = pr.html_url || undefined;
    await postSuggestionHoldSuccess(api, opts.owner, opts.repo, headSha, assessment.description, targetUrl);
    log(
      `maintainer hold released for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${assessment.openMaintainers} answered`
    );
    return { outcome: "released", prNumber: opts.prNumber, headSha, openMaintainers: assessment.openMaintainers };
  }
  if (assessment.keepReason === "hold disabled") {
    log(`maintainer hold skipped for ${opts.owner}/${opts.repo}#${opts.prNumber}: hold disabled`);
    return { outcome: "skip", reason: "maintainer hold disabled" };
  }
  if (
    !assessment.completeSuccess ||
    (assessment.openMaintainers === 0 && !lastCheckTrailer(reviewBody)?.reason.toLowerCase().includes("maintainer"))
  ) {
    log(`maintainer hold skipped for ${opts.owner}/${opts.repo}#${opts.prNumber}: no held maintainer review`);
    return { outcome: "skip", reason: "no held maintainer review" };
  }
  const keepReason = assessment.keepReason ?? "no open maintainer questions";
  log(
    `maintainer hold kept for ${opts.owner}/${opts.repo}#${opts.prNumber}: ${keepReason} ` +
      `(maintainers=${assessment.openMaintainers} bugs=${assessment.openBugs} risks=${assessment.openRisks} ` +
      `blocking=${assessment.openBlockingQuestions} completeSuccess=${assessment.completeSuccess})`
  );
  return { outcome: "skip", reason: `maintainer hold kept: ${keepReason}` };
}
