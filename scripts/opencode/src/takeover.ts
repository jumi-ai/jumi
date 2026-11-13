import { isWipOrDraft } from "./gitea_issues.ts";
import { isListedLogin, senderCanSteer } from "./permissions.ts";
import { loadRepoSettings } from "./repo_settings.ts";
import { upsertStickyComment } from "./sticky_comment.ts";

export const TAKEOVER_NOTE_MARKER = "<!-- jumi-takeover -->";
export const TAKEOVER_REFUSED_REASON = "takeover author not admitted";

export function isTakeoverAuthor(
  login: string | undefined | null,
  authors: readonly string[] | undefined | null
): boolean {
  return isListedLogin(login, authors ?? undefined);
}

/**
 * Whether a pull request meets the same bar a handed-over pull meets today:
 * open, not a draft, not `WIP:`, and not from a fork. Fork detection needs
 * the base `owner/repo`; without a head repo record the pull is ineligible.
 */
export function isTakeoverEligiblePull(
  pr: {
    state?: string;
    merged?: boolean;
    title?: string;
    draft?: boolean;
    user?: { login?: string } | null;
    head?: { repo?: { full_name?: string } | null } | null;
  },
  owner: string,
  repo: string
): boolean {
  if (pr.state !== undefined && pr.state !== "open") return false;
  if (pr.merged === true) return false;
  if (isWipOrDraft({ title: pr.title ?? "", draft: pr.draft })) return false;
  const headFull = pr.head?.repo?.full_name;
  if (typeof headFull !== "string" || !headFull) return false;
  if (headFull.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return false;
  if (typeof pr.user?.login !== "string" || !pr.user.login.trim()) return false;
  return true;
}

export function takeoverRefusedNote(authorLogin: string, detail: string): string {
  const who = authorLogin.trim() || "listed author";
  return (
    `Jumi did not take over this pull request: \`${who}\` is listed in the repository settings ` +
    `but ${detail} A person can still hand the pull request over by assigning Jumi (Gitea) or adding the \`jumi\` label (GitHub).`
  );
}

export type TakeoverFileApi = {
  getRepoFile?: (
    owner: string,
    repo: string,
    path: string,
    ref: string
  ) => Promise<{ found: boolean; content?: string }>;
};

export type TakeoverTrustApi = {
  getCollaboratorPermission(
    owner: string,
    repo: string,
    username: string
  ): Promise<import("./ports.ts").CollaboratorPermission>;
};

export type TakeoverMarkerApi = {
  addIssueLabel?(owner: string, repo: string, index: number, label: string): Promise<unknown>;
  addIssueAssignees?(owner: string, repo: string, index: number, assignees: string[]): Promise<unknown>;
  findStickyIssueComment?(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined>;
  createIssueComment?(owner: string, repo: string, index: number, body: string): Promise<unknown>;
  updateIssueComment?(owner: string, repo: string, commentId: number, body: string): Promise<unknown>;
};

/**
 * Best-effort load of the `takeover_authors` list from the default-branch
 * settings file. Missing, invalid, unreadable, or file-API-less resolves to
 * an empty list (no takeover): an invalid file never takes anything over.
 */
export async function loadTakeoverAuthors(
  api: TakeoverFileApi | undefined,
  owner: string,
  repo: string,
  defaultBranch: string | undefined | null,
  logger?: (message: string) => void
): Promise<string[]> {
  try {
    if (!api || typeof api.getRepoFile !== "function") return [];
    if (typeof defaultBranch !== "string" || !defaultBranch.trim()) return [];
    const loaded = await loadRepoSettings(api, owner, repo, defaultBranch.trim());
    if (loaded.state !== "valid") return [];
    return [...(loaded.takeoverAuthors ?? [])];
  } catch (err) {
    logger?.(`takeover authors unreadable for ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function postTakeoverNoteOnce(
  api: TakeoverMarkerApi,
  owner: string,
  repo: string,
  prNumber: number,
  botUsername: string,
  body: string
): Promise<void> {
  try {
    await upsertStickyComment(
      api as Parameters<typeof upsertStickyComment>[0],
      owner,
      repo,
      prNumber,
      botUsername,
      TAKEOVER_NOTE_MARKER,
      body
    );
  } catch {
    // A failed takeover note must never fail the webhook.
  }
}

export interface TakeoverInput {
  api: TakeoverFileApi & TakeoverTrustApi & TakeoverMarkerApi;
  forgeKind: string;
  owner: string;
  repo: string;
  prNumber: number;
  prAuthorLogin: string | undefined | null;
  defaultBranch: string | undefined | null;
  botUsername: string;
  trustedSenderLogins?: readonly string[];
  /** Pre-loaded list; when absent the default-branch file is read. */
  takeoverAuthors?: readonly string[] | undefined;
  hasTrustedSenders?: (logins: readonly string[] | undefined) => boolean;
  log?: (message: string) => void;
}

export type TakeoverOutcome =
  | { takeover: false; refused: false }
  | { takeover: false; refused: true }
  | { takeover: true; refused: false };

export interface TakeoverOpenedInput {
  api: TakeoverFileApi & TakeoverTrustApi & TakeoverMarkerApi;
  forgeKind: string;
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prDraft?: boolean;
  prState?: string;
  prMerged?: boolean;
  prAuthorLogin: string | undefined | null;
  prHeadRef: string;
  prHeadSha: string;
  prHeadRepoFullName: string | undefined | null;
  defaultBranch: string | undefined | null;
  cloneUrl: string;
  htmlUrl: string;
  updatedAt: string;
  prBody?: string | null;
  botUsername: string;
  trustedSenderLogins?: readonly string[];
  takeoverAuthors?: readonly string[] | undefined;
  log?: (message: string) => void;
}

export type TakeoverOpenedDecision =
  | { type: "enqueue"; job: Omit<import("./types.ts").IssueJob, "delivery" | "receivedAt"> }
  | { type: "skip"; reason: string };

/**
 * Decide a takeover for a freshly opened pull request. Only `opened`
 * takes over, so removing the marker never retakes: later pushes,
 * synchronizes, and reopen actions stay quiet. Eligibility mirrors the
 * handed-over bar (open, not draft/`WIP:`, not a fork). A listed author who
 * fails the sender check gets one sticky note and no enqueue.
 */
export async function shouldEnqueueTakeoverForOpenedPull(
  input: TakeoverOpenedInput & { action: string }
): Promise<TakeoverOpenedDecision> {
  if (input.action !== "opened") return { type: "skip", reason: `unsupported action ${input.action}` };
  if (
    !isTakeoverEligiblePull(
      {
        state: input.prState,
        merged: input.prMerged,
        title: input.prTitle,
        draft: input.prDraft,
        user: input.prAuthorLogin ? { login: input.prAuthorLogin } : null,
        head: { repo: input.prHeadRepoFullName ? { full_name: input.prHeadRepoFullName } : null },
      },
      input.owner,
      input.repo
    )
  ) {
    return { type: "skip", reason: "not eligible for takeover" };
  }
  const outcome = await maybeTakeoverPr({
    api: input.api,
    forgeKind: input.forgeKind,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    prAuthorLogin: input.prAuthorLogin,
    defaultBranch: input.defaultBranch,
    botUsername: input.botUsername,
    trustedSenderLogins: input.trustedSenderLogins,
    takeoverAuthors: input.takeoverAuthors,
    log: input.log,
  });
  if (outcome.refused) return { type: "skip", reason: TAKEOVER_REFUSED_REASON };
  if (!outcome.takeover) return { type: "skip", reason: "author not listed for takeover" };
  const author = typeof input.prAuthorLogin === "string" ? input.prAuthorLogin.trim() : "takeover";
  return {
    type: "enqueue",
    job: {
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.prNumber,
      action: "takeover",
      title: input.prTitle,
      body: input.prBody ?? "",
      htmlUrl: input.htmlUrl,
      issueUpdatedAt: input.updatedAt,
      defaultBranch: input.defaultBranch ?? "",
      cloneUrl: input.cloneUrl,
      mode: "follow-up",
      prNumber: input.prNumber,
      headSha: input.prHeadSha || undefined,
      trigger: { event: "takeover", sender: author },
    },
  };
}

/**
 * Take over a pull request opened by a listed author. The listed author is
 * taken over only when that author would pass the same sender check a
 * manual handover needs (`senderCanSteer`): the trusted-sender list when it
 * is set, write-level access otherwise. A refused author gets one sticky
 * note; an admitted author gets the same marker a manual handover leaves
 * (assignee on Gitea, `jumi` label on GitHub). Never throws: failures mean
 * no takeover.
 */
export async function maybeTakeoverPr(input: TakeoverInput): Promise<TakeoverOutcome> {
  const log = input.log ?? (() => undefined);
  const author = typeof input.prAuthorLogin === "string" ? input.prAuthorLogin.trim() : "";
  if (!author) return { takeover: false, refused: false };
  let authors = input.takeoverAuthors;
  if (authors === undefined) {
    authors = await loadTakeoverAuthors(input.api, input.owner, input.repo, input.defaultBranch, log);
  }
  if (!isTakeoverAuthor(author, authors)) return { takeover: false, refused: false };
  let admitted = false;
  try {
    admitted = await senderCanSteer(input.api, input.owner, input.repo, author, input.trustedSenderLogins);
  } catch (err) {
    log(
      `takeover sender check failed for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    return { takeover: false, refused: false };
  }
  if (!admitted) {
    const { hasTrustedSenders } = await import("./permissions.ts");
    const trusted = (input.hasTrustedSenders ?? hasTrustedSenders)(input.trustedSenderLogins);
    const detail = trusted
      ? "that author is not on the deployer's trusted-sender list."
      : "that author has no write-level access to this repository.";
    await postTakeoverNoteOnce(
      input.api,
      input.owner,
      input.repo,
      input.prNumber,
      input.botUsername,
      takeoverRefusedNote(author, detail)
    );
    return { takeover: false, refused: true };
  }
  try {
    if (input.forgeKind === "github") {
      const label = input.api.addIssueLabel;
      if (typeof label === "function") {
        await label.call(input.api, input.owner, input.repo, input.prNumber, "jumi");
      }
    } else {
      const assign = input.api.addIssueAssignees;
      if (typeof assign === "function") {
        await assign.call(input.api, input.owner, input.repo, input.prNumber, [input.botUsername]);
      }
    }
  } catch (err) {
    log(
      `takeover marker failed for ${input.owner}/${input.repo}#${input.prNumber}: ${err instanceof Error ? err.message : String(err)}`
    );
    // The marker is best-effort: the enqueue below still hands the pull over.
  }
  return { takeover: true, refused: false };
}
