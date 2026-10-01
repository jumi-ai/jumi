export type CheckState = "pending" | "success" | "error" | "failure" | "warning";

export interface Actor {
  login: string;
}

export interface Repo {
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  owner: Actor;
}

export interface Task {
  trackerRef?: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: Actor;
  assignee?: Actor | null;
  assignees?: Actor[] | null;
  updated_at: string;
  created_at: string;
  pull_request?: unknown;
  is_pull?: boolean;
  labels?: Array<string | { name?: string }> | null;
}

/** Gitea issue dependency / blocks row, possibly in another repo. */
export interface LinkedIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  body: string | null;
  assignee?: Actor | null;
  assignees?: Actor[] | null;
  updated_at: string;
  pull_request?: unknown;
  is_pull?: boolean;
}

export interface PullHead {
  ref: string;
  sha: string;
  repo: { full_name: string; clone_url?: string } | null;
}

export interface Pull {
  forgeRef?: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  html_url: string;
  user: Actor;
  head: PullHead;
  base: { ref: string; sha: string };
  merged: boolean;
  draft?: boolean;
  mergeable?: boolean | null;
  assignee?: Actor | null;
  assignees?: Actor[] | null;
  labels?: Array<string | { name?: string }> | null;
  created_at: string;
  updated_at: string;
}

export interface PullFile {
  filename: string;
  status: "added" | "modified" | "changed" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface Comment {
  id: number;
  body: string;
  user: Actor;
  created_at: string;
  updated_at: string;
}

export interface PullReview {
  id: number;
  body?: string | null;
  content?: string;
  user?: Actor;
  state?: string;
  type?: string;
  dismissed?: boolean;
  commit_id?: string;
  submitted_at?: string;
  updated_at?: string;
  created_at?: string;
}

export interface CreatePullReviewComment {
  body: string;
  path: string;
  new_position?: number;
  old_position?: number;
}

export interface CreatePullReviewOptions {
  body?: string;
  commit_id: string;
  comments?: CreatePullReviewComment[];
  event?: string;
}

export interface InlineComment extends Comment {
  path?: string;
  commit_id?: string;
  new_position?: number;
  pull_request_review_id?: number;
  html_url?: string;
  resolved?: boolean;
  resolver?: Actor;
}

export interface Check {
  id?: number;
  context?: string;
  state?: CheckState;
  status?: CheckState;
  description?: string;
  target_url?: string;
  created_at?: string;
  updated_at?: string;
  url?: string;
  jobId?: number;
}

export interface CheckPayload {
  state: CheckState;
  context?: string;
  description?: string;
  target_url?: string;
}

export interface ActionJob {
  id: number;
  name: string;
  status?: string;
  conclusion?: string;
  head_sha?: string;
  head_branch?: string;
  html_url?: string;
  run_id?: number;
}

/** Tracker: brief + pickup + outcome (issue/task identity). */
export interface Tracker {
  getIssue(owner: string, repo: string, index: number): Promise<Task>;
  listIssueComments(owner: string, repo: string, index: number): Promise<Comment[]>;
  findStickyIssueComment(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined>;
  createIssueComment(owner: string, repo: string, index: number, body: string): Promise<Comment>;
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<Comment>;
  listIssueDependencies(owner: string, repo: string, index: number): Promise<LinkedIssue[]>;
  listIssueBlocks(owner: string, repo: string, index: number): Promise<LinkedIssue[]>;
  listRepoIssues(
    owner: string,
    repo: string,
    opts?: { state?: "open" | "closed" | "all"; type?: "issues" | "pulls"; assignedBy?: string }
  ): Promise<LinkedIssue[]>;
  createIssueDependency(
    owner: string,
    repo: string,
    index: number,
    dependency: { owner: string; repo: string; number: number }
  ): Promise<void>;
}

export interface CollaboratorPermission {
  permission: string;
  role_name?: string;
  /**
   * The check the forge itself uses to allow a push. GitHub returns the
   * sender's effective grant here (`user.permissions.push`), which reflects
   * team grants even when the legacy flat `permission` is `read`/`none`.
   */
  user?: { permissions?: { pull?: boolean; triage?: boolean; push?: boolean; maintain?: boolean; admin?: boolean } };
}

/** Repo-scoped installation grant (GitHub): `permissions.contents == "write"` is push. */
export interface RepoInstallation {
  permissions?: Record<string, string>;
}

/** Forge: clone + PR + sticky + status (git host identity). */
export interface Forge {
  getRepo(owner: string, repo: string): Promise<Repo>;
  getPR(owner: string, repo: string, index: number): Promise<Pull>;
  listOpenPulls(owner: string, repo: string): Promise<Pull[]>;
  getCollaboratorPermission(owner: string, repo: string, username: string): Promise<CollaboratorPermission>;
  /** GitHub only: repo-scoped installation grant, e.g. `{ contents: "write" }`. */
  getRepoInstallation?(owner: string, repo: string): Promise<RepoInstallation | undefined>;
  createPullRequest(
    owner: string,
    repo: string,
    pull: { title: string; body: string; head: string; base: string }
  ): Promise<Pull>;
  closePullRequest(owner: string, repo: string, index: number): Promise<Pull>;
  reopenPullRequest(owner: string, repo: string, index: number): Promise<Pull>;
  updatePullRequestBody(owner: string, repo: string, index: number, body: string): Promise<Pull>;
  getPRFiles(owner: string, repo: string, index: number): Promise<PullFile[]>;
  listIssueComments(owner: string, repo: string, index: number): Promise<Comment[]>;
  findStickyIssueComment(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined>;
  createIssueComment(owner: string, repo: string, index: number, body: string): Promise<Comment>;
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<Comment>;
  listPullReviewComments(owner: string, repo: string, index: number): Promise<InlineComment[]>;
  listPullReviews(owner: string, repo: string, index: number): Promise<PullReview[]>;
  createPullReview(owner: string, repo: string, index: number, review: CreatePullReviewOptions): Promise<PullReview>;
  submitPullReview(owner: string, repo: string, index: number, reviewId: number, body?: string): Promise<PullReview>;
  resolvePullComment(owner: string, repo: string, commentId: number): Promise<void>;
  unresolvePullComment(owner: string, repo: string, commentId: number): Promise<void>;
  dismissPullReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    opts?: { message?: string; priors?: boolean }
  ): Promise<PullReview>;
  createCommitStatus(owner: string, repo: string, sha: string, status: CheckPayload): Promise<CheckPayload>;
  listCommitStatuses(owner: string, repo: string, sha: string): Promise<Check[]>;
  listCheckRuns(owner: string, repo: string, sha: string): Promise<Check[]>;
  listActionJobs(owner: string, repo: string, opts?: { status?: string; headSha?: string }): Promise<ActionJob[]>;
  getActionJobLogs(owner: string, repo: string, jobId: number): Promise<string>;
}

export type ReviewApi = Pick<
  Forge,
  | "getRepo"
  | "getPR"
  | "getPRFiles"
  | "listIssueComments"
  | "findStickyIssueComment"
  | "createIssueComment"
  | "updateIssueComment"
  | "listPullReviewComments"
  | "listPullReviews"
  | "createPullReview"
  | "submitPullReview"
  | "resolvePullComment"
  | "unresolvePullComment"
  | "dismissPullReview"
  | "createCommitStatus"
  | "listCommitStatuses"
  | "listCheckRuns"
  | "listActionJobs"
  | "getActionJobLogs"
  | "getCollaboratorPermission"
  | "getRepoInstallation"
> &
  Pick<Tracker, "getIssue">;

export type IssueApi = Tracker &
  Pick<
    Forge,
    | "getRepo"
    | "getPR"
    | "listOpenPulls"
    | "createPullRequest"
    | "closePullRequest"
    | "updatePullRequestBody"
    | "listPullReviewComments"
    | "listPullReviews"
    | "listCommitStatuses"
    | "listCheckRuns"
    | "listActionJobs"
    | "getActionJobLogs"
    | "getCollaboratorPermission"
    | "getRepoInstallation"
  >;

export function trackerRefOf(task: { trackerRef?: string; number: number }): string {
  return task.trackerRef ?? String(task.number);
}

export function forgeRefOf(pull: { forgeRef?: string; number: number }): string {
  return pull.forgeRef ?? String(pull.number);
}
