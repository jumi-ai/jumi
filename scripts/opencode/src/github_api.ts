import { GITHUB_API_URL, GITHUB_GIT_USERNAME, type GithubTokenTarget } from "./github_auth.ts";
import type {
  ActionJob,
  Check,
  CheckPayload,
  CheckState,
  CollaboratorPermission,
  Comment,
  CreatePullReviewComment,
  CreatePullReviewOptions,
  InlineComment,
  LinkedIssue,
  Pull,
  PullFile,
  PullReview,
  Repo,
  Task,
} from "./ports.ts";
import {
  GITHUB_STATUS_DESCRIPTION_MAX_CHARS,
  omitOpenCodeStderr,
  truncateStatusDescription,
} from "./status_description.ts";

export type GithubAuth = {
  getInstallationToken(target?: GithubTokenTarget): Promise<string>;
  refreshInstallationToken?(target?: GithubTokenTarget): Promise<string>;
  rememberInstallation?(installationId: string, owner?: string, repo?: string): void;
};

export type GithubGitCredentials = {
  username: string;
  token: string;
  embedTokenInUrl: true;
  authorName: string;
  authorEmail: string;
};

export type GithubAPIOptions = {
  token?: string;
  auth?: GithubAuth;
  apiUrl?: string;
};

type GithubUser = { login?: string };

type GithubRepo = {
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  owner?: GithubUser;
};

type GithubIssue = {
  id?: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url: string;
  repository_url?: string;
  user?: GithubUser;
  assignee?: GithubUser;
  assignees?: GithubUser[] | null;
  updated_at: string;
  created_at?: string;
  pull_request?: unknown;
  labels?: Array<{ name?: string } | string> | null;
  repository?: {
    full_name?: string;
    name?: string;
    owner?: GithubUser | string;
  };
};

type GithubPR = {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url: string;
  user?: GithubUser;
  head: {
    ref: string;
    sha: string;
    repo?: { full_name: string; clone_url?: string } | null;
  };
  base: { ref: string; sha: string };
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  mergeable?: boolean | null;
  assignee?: GithubUser;
  assignees?: GithubUser[] | null;
  labels?: Array<{ name?: string } | string> | null;
  created_at: string;
  updated_at: string;
};

type GithubComment = {
  id: number;
  body?: string | null;
  user?: GithubUser;
  created_at?: string;
  updated_at?: string;
};

type GithubReviewComment = GithubComment & {
  path?: string;
  commit_id?: string;
  line?: number | null;
  original_line?: number | null;
  position?: number | null;
  pull_request_review_id?: number;
  html_url?: string;
  pull_request_url?: string;
};

type GithubReview = {
  id: number;
  body?: string | null;
  user?: GithubUser;
  state?: string;
  commit_id?: string;
  submitted_at?: string;
  html_url?: string;
};

type GithubFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};

type GithubStatus = {
  id?: number;
  context?: string;
  state?: CheckState;
  description?: string;
  target_url?: string;
  created_at?: string;
  updated_at?: string;
  url?: string;
};

type GithubJob = {
  id: number;
  name: string;
  status?: string;
  conclusion?: string;
  head_sha?: string;
  html_url?: string;
  run_id?: number;
};

type GithubCheckRun = {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  details_url?: string;
  started_at?: string;
  completed_at?: string;
  output?: { title?: string | null; summary?: string | null };
};

type GithubWorkflowRun = {
  id: number;
  head_branch?: string;
  head_sha?: string;
};

type ReviewThreadNode = {
  id?: string;
  isResolved?: boolean;
  resolvedBy?: { login?: string } | null;
  comments?: { nodes?: { databaseId?: number }[] };
};

type ReviewThreadConn = { nodes?: ReviewThreadNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } };

type GraphqlError = { message?: string };

const PAGE_SIZE = 50;
const MAX_PAGES = 40;
const LOG_MAX_BYTES = 1_048_576;

function actor(user: GithubUser | null | undefined): { login: string } {
  return { login: user?.login ?? "" };
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /→ 404\b/.test(err.message);
}

function isActionsDisabledError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/rate limit/i.test(err.message)) return false;
  return /→ (403|404)\b/.test(err.message);
}

function ownerRepoFromUrl(url: string | undefined): { owner: string; repo: string } | undefined {
  if (typeof url !== "string") return undefined;
  const repos = url.match(/\/repos\/([^/?#]+)\/([^/?#]+)/);
  if (repos?.[1] && repos[2]) return { owner: repos[1], repo: repos[2] };
  const html = url.match(/\/([^/?#]+)\/([^/?#]+)\/(?:issues|pull)\//);
  if (html?.[1] && html[2]) return { owner: html[1], repo: html[2] };
  return undefined;
}

function ownerRepoOf(issue: GithubIssue, fallbackOwner: string, fallbackRepo: string): { owner: string; repo: string } {
  const meta = issue.repository;
  if (meta && typeof meta.full_name === "string") {
    const [owner, repo] = meta.full_name.split("/");
    if (owner && repo) return { owner, repo };
  }
  const name = meta && typeof meta.name === "string" ? meta.name : undefined;
  const ownerField = meta?.owner;
  const ownerLogin =
    typeof ownerField === "string"
      ? ownerField
      : ownerField && typeof ownerField === "object" && typeof ownerField.login === "string"
        ? ownerField.login
        : undefined;
  if (ownerLogin && name) return { owner: ownerLogin, repo: name };
  return (
    ownerRepoFromUrl(issue.repository_url) ??
    ownerRepoFromUrl(issue.html_url) ?? { owner: fallbackOwner, repo: fallbackRepo }
  );
}

export function toRepo(repo: GithubRepo): Repo {
  return {
    name: repo.name,
    full_name: repo.full_name,
    html_url: repo.html_url,
    clone_url: repo.clone_url,
    default_branch: repo.default_branch,
    owner: actor(repo.owner),
  };
}

export function toTask(issue: GithubIssue): Task {
  return {
    trackerRef: String(issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    html_url: issue.html_url,
    user: actor(issue.user),
    assignee: issue.assignee ? actor(issue.assignee) : (issue.assignee ?? null),
    assignees: issue.assignees == null ? issue.assignees : issue.assignees.map(actor),
    updated_at: issue.updated_at,
    created_at: issue.created_at ?? issue.updated_at,
    pull_request: issue.pull_request,
    is_pull: issue.pull_request != null,
    labels: issue.labels,
  };
}

export function toLinkedIssue(issue: GithubIssue, fallbackOwner: string, fallbackRepo: string): LinkedIssue {
  const { owner, repo } = ownerRepoOf(issue, fallbackOwner, fallbackRepo);
  return {
    owner,
    repo,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    html_url: issue.html_url,
    body: issue.body ?? null,
    assignee: issue.assignee ? actor(issue.assignee) : (issue.assignee ?? null),
    assignees: issue.assignees == null ? issue.assignees : issue.assignees.map(actor),
    updated_at: issue.updated_at,
    pull_request: issue.pull_request,
    is_pull: issue.pull_request != null,
  };
}

export function toPull(pr: GithubPR): Pull {
  return {
    forgeRef: String(pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state,
    html_url: pr.html_url,
    user: actor(pr.user),
    head: {
      ref: pr.head.ref,
      sha: pr.head.sha,
      repo: pr.head.repo ? { full_name: pr.head.repo.full_name, clone_url: pr.head.repo.clone_url } : null,
    },
    base: { ref: pr.base.ref, sha: pr.base.sha },
    merged: pr.merged === true || Boolean(pr.merged_at),
    draft: pr.draft,
    mergeable: pr.mergeable,
    assignee: pr.assignee ? actor(pr.assignee) : (pr.assignee ?? null),
    assignees: pr.assignees == null ? pr.assignees : pr.assignees.map(actor),
    labels: pr.labels,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  };
}

export function toComment(comment: GithubComment): Comment {
  return {
    id: comment.id,
    body: comment.body ?? "",
    user: actor(comment.user),
    created_at: comment.created_at ?? "",
    updated_at: comment.updated_at ?? "",
  };
}

function fileStatus(status: string | undefined): PullFile["status"] {
  if (status === "removed") return "deleted";
  if (
    status === "added" ||
    status === "modified" ||
    status === "changed" ||
    status === "deleted" ||
    status === "renamed"
  ) {
    return status;
  }
  return "modified";
}

export function toPullFile(file: GithubFile): PullFile {
  return {
    filename: file.filename,
    status: fileStatus(file.status),
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    changes: file.changes ?? 0,
    patch: file.patch,
  };
}

export function checkRunState(status?: string, conclusion?: string | null): CheckState {
  const runStatus = (status ?? "").toLowerCase();
  if (runStatus && runStatus !== "completed") return "pending";
  switch ((conclusion ?? "").toLowerCase()) {
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failure";
    case "action_required":
      return "pending";
    default:
      return "success";
  }
}

export function toCheck(status: GithubStatus): Check {
  return {
    id: status.id,
    context: status.context,
    state: status.state,
    status: status.state,
    description: status.description,
    target_url: status.target_url,
    created_at: status.created_at,
    updated_at: status.updated_at,
    url: status.url,
  };
}

export function toCheckFromCheckRun(run: GithubCheckRun): Check {
  const state = checkRunState(run.status, run.conclusion);
  return {
    id: run.id,
    context: run.name,
    state,
    status: state,
    description: run.output?.title ?? run.output?.summary ?? run.conclusion ?? "",
    target_url: run.html_url ?? run.details_url,
    created_at: run.started_at,
    updated_at: run.completed_at ?? run.started_at,
    url: run.html_url,
    jobId: run.id,
  };
}

function toCheckFromActionJob(job: GithubJob): Check {
  const state = checkRunState(job.status, job.conclusion);
  return {
    id: job.id,
    context: job.name,
    state,
    status: state,
    description: job.conclusion ?? job.status ?? "",
    target_url: job.html_url,
    jobId: job.id,
  };
}

export function toCheckPayload(status: GithubStatus | CheckPayload): CheckPayload {
  return {
    state: status.state as CheckState,
    context: status.context,
    description: status.description,
    target_url: status.target_url,
  };
}

export function toGiteaReviewState(state: string | undefined): string | undefined {
  switch (state?.toUpperCase()) {
    case "CHANGES_REQUESTED":
      return "REQUEST_CHANGES";
    case "COMMENTED":
      return "COMMENT";
    default:
      return state;
  }
}

export function toPullReview(review: GithubReview): PullReview {
  const state = toGiteaReviewState(review.state);
  return {
    id: review.id,
    body: review.body,
    user: review.user ? actor(review.user) : undefined,
    state,
    dismissed: review.state?.toUpperCase() === "DISMISSED",
    commit_id: review.commit_id,
    submitted_at: review.submitted_at,
  };
}

export function toInlineComment(comment: GithubReviewComment, resolved = false, resolver?: string): InlineComment {
  return {
    ...toComment(comment),
    path: comment.path,
    commit_id: comment.commit_id,
    new_position: comment.line ?? comment.original_line ?? comment.position ?? undefined,
    pull_request_review_id: comment.pull_request_review_id,
    html_url: comment.html_url,
    resolved,
    ...(resolved && resolver ? { resolver: { login: resolver } } : {}),
  };
}

export function toActionJob(job: GithubJob, headBranch?: string): ActionJob {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    head_sha: job.head_sha,
    head_branch: headBranch,
    html_url: job.html_url,
    run_id: job.run_id,
  };
}

export function toGithubReviewEvent(event: string | undefined): string | undefined {
  if (event === "APPROVED") return "APPROVE";
  return event;
}

function loginEquals(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

function toGithubReviewComments(comments: CreatePullReviewComment[] | undefined): unknown[] | undefined {
  if (!comments) return undefined;
  return comments.map((comment) => {
    const line = comment.new_position ?? comment.old_position;
    return {
      path: comment.path,
      body: comment.body,
      ...(line != null
        ? { line, ...(comment.new_position == null && comment.old_position != null ? { side: "LEFT" } : {}) }
        : {}),
    };
  });
}

function decodeTail(buf: Uint8Array, maxBytes: number): string {
  const slice = buf.byteLength > maxBytes ? buf.subarray(buf.byteLength - maxBytes) : buf;
  return new TextDecoder().decode(slice);
}

function repoTargetFromPath(path: string): GithubTokenTarget | undefined {
  const match = path.match(/^\/repos\/([^/?#]+)\/([^/?#]+)/);
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]) };
}

function tokenTargetFromGraphql(variables?: Record<string, unknown>): GithubTokenTarget | undefined {
  const owner = typeof variables?.owner === "string" ? variables.owner : undefined;
  const repo =
    typeof variables?.name === "string"
      ? variables.name
      : typeof variables?.repo === "string"
        ? variables.repo
        : undefined;
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

function pullNumberFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const match = url.match(/\/pulls\/(\d+)(?:\?|$)/);
  if (!match) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

function needsSelfReviewGuard(event: string | undefined): boolean {
  const mapped = toGithubReviewEvent(event);
  return mapped === "APPROVE" || mapped === "REQUEST_CHANGES";
}

export class GithubAPI {
  private readonly staticToken: string | undefined;
  private readonly auth: GithubAuth | undefined;
  private readonly base: string;
  private viewerLogin: string | undefined;
  private viewerDatabaseId: number | undefined;

  constructor(opts: GithubAPIOptions) {
    const token = opts.token?.trim();
    if (!opts.auth && !token) throw new Error("Missing GitHub token");
    this.staticToken = token;
    this.auth = opts.auth;
    this.base = (opts.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, "");
  }

  rememberInstallation(installationId: string, owner?: string, repo?: string): void {
    this.auth?.rememberInstallation?.(installationId, owner, repo);
  }

  async gitAccessToken(opts?: { refresh?: boolean } & GithubTokenTarget): Promise<string> {
    if (this.auth) {
      const target: GithubTokenTarget = {
        ...(opts?.owner ? { owner: opts.owner } : {}),
        ...(opts?.repo ? { repo: opts.repo } : {}),
        ...(opts?.installationId ? { installationId: opts.installationId } : {}),
      };
      if (opts?.refresh && this.auth.refreshInstallationToken) return this.auth.refreshInstallationToken(target);
      return this.auth.getInstallationToken(target);
    }
    return this.staticToken as string;
  }

  private async accessToken(target?: GithubTokenTarget): Promise<string> {
    return this.gitAccessToken(target);
  }

  private async headers(target?: GithubTokenTarget): Promise<Record<string, string>> {
    const token = await this.accessToken(target);
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jumi",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, target?: GithubTokenTarget): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      headers: await this.headers(target ?? repoTargetFromPath(path)),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API ${method} ${url} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async requestText(path: string, maxBytes = LOG_MAX_BYTES): Promise<string> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: await this.headers(repoTargetFromPath(path)),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location");
      if (!location) throw new Error(`GitHub API GET ${url} → ${res.status}: missing Location`);
      const signed = await fetch(new URL(location, url).toString(), { method: "GET" });
      if (!signed.ok) {
        const text = await signed.text().catch(() => "");
        throw new Error(`GitHub API GET ${url} → ${signed.status}: ${text}`);
      }
      return decodeTail(new Uint8Array(await signed.arrayBuffer()), maxBytes);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API GET ${url} → ${res.status}: ${text}`);
    }
    return decodeTail(new Uint8Array(await res.arrayBuffer()), maxBytes);
  }

  private get<T>(path: string, target?: GithubTokenTarget) {
    return this.request<T>("GET", path, undefined, target);
  }
  private post<T>(path: string, body: unknown, target?: GithubTokenTarget) {
    return this.request<T>("POST", path, body, target);
  }
  private patch<T>(path: string, body: unknown, target?: GithubTokenTarget) {
    return this.request<T>("PATCH", path, body, target);
  }
  private put<T>(path: string, body: unknown, target?: GithubTokenTarget) {
    return this.request<T>("PUT", path, body, target);
  }

  private repoPath(owner: string, repo: string): string {
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private async getPages<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.get<T[]>(`${path}${sep}per_page=${PAGE_SIZE}&page=${page}`);
      results.push(...batch);
      if (batch.length !== PAGE_SIZE) break;
      page += 1;
    }
    return results;
  }

  private async getPagesOrEmptyOn404<T>(path: string): Promise<T[]> {
    try {
      return await this.getPages<T>(path);
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>, target?: GithubTokenTarget): Promise<T> {
    const payload = await this.post<{ data?: T; errors?: GraphqlError[] }>(
      "/graphql",
      {
        query,
        ...(variables ? { variables } : {}),
      },
      target ?? tokenTargetFromGraphql(variables)
    );
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL → ${payload.errors[0]?.message ?? "error"}`);
    }
    if (payload.data == null) throw new Error("GitHub GraphQL → empty data");
    return payload.data;
  }

  private async loadViewer(target?: GithubTokenTarget): Promise<{ login?: string; databaseId?: number }> {
    if (this.viewerLogin && this.viewerDatabaseId != null) {
      return { login: this.viewerLogin, databaseId: this.viewerDatabaseId };
    }
    const data = await this.graphql<{ viewer?: { login?: string; databaseId?: number } }>(
      "query { viewer { login databaseId } }",
      undefined,
      target
    );
    const login = data.viewer?.login;
    const databaseId = data.viewer?.databaseId;
    if (login) this.viewerLogin = login;
    if (typeof databaseId === "number") this.viewerDatabaseId = databaseId;
    return { login: this.viewerLogin, databaseId: this.viewerDatabaseId };
  }

  private async getViewerLogin(target?: GithubTokenTarget): Promise<string | undefined> {
    if (this.viewerLogin) return this.viewerLogin;
    return (await this.loadViewer(target)).login;
  }

  async gitIdentity(target?: GithubTokenTarget): Promise<{ name: string; email: string }> {
    const viewer = await this.loadViewer(target);
    if (!viewer.login || viewer.databaseId == null) throw new Error("GitHub viewer identity is missing");
    return {
      name: viewer.login,
      email: `${viewer.databaseId}+${viewer.login}@users.noreply.github.com`,
    };
  }

  async resolveGitCredentials(target?: GithubTokenTarget): Promise<GithubGitCredentials> {
    const token = await this.gitAccessToken({ refresh: true, ...target });
    const identity = await this.gitIdentity(target);
    return {
      username: GITHUB_GIT_USERNAME,
      token,
      embedTokenInUrl: true,
      authorName: identity.name,
      authorEmail: identity.email,
    };
  }

  async getRepo(owner: string, repo: string): Promise<Repo> {
    return toRepo(await this.get<GithubRepo>(`/repos/${this.repoPath(owner, repo)}`));
  }

  async getCollaboratorPermission(owner: string, repo: string, username: string): Promise<CollaboratorPermission> {
    const info = await this.get<{ permission: string; role_name?: string }>(
      `/repos/${this.repoPath(owner, repo)}/collaborators/${encodeURIComponent(username)}/permission`
    );
    return { permission: info.permission, role_name: info.role_name };
  }

  async getAppPermissions(slug: string): Promise<Record<string, string> | undefined> {
    const app = await this.get<{ permissions?: Record<string, string> }>(`/apps/${encodeURIComponent(slug)}`);
    return app.permissions;
  }

  async getPR(owner: string, repo: string, index: number): Promise<Pull> {
    return toPull(await this.get<GithubPR>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}`));
  }

  async listOpenPulls(owner: string, repo: string): Promise<Pull[]> {
    const pulls = await this.getPages<GithubPR>(`/repos/${this.repoPath(owner, repo)}/pulls?state=open`);
    return pulls.map(toPull);
  }

  async createPullRequest(
    owner: string,
    repo: string,
    pull: { title: string; body: string; head: string; base: string }
  ): Promise<Pull> {
    return toPull(await this.post<GithubPR>(`/repos/${this.repoPath(owner, repo)}/pulls`, pull));
  }

  async closePullRequest(owner: string, repo: string, index: number): Promise<Pull> {
    return toPull(
      await this.patch<GithubPR>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}`, { state: "closed" })
    );
  }

  async reopenPullRequest(owner: string, repo: string, index: number): Promise<Pull> {
    return toPull(await this.patch<GithubPR>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}`, { state: "open" }));
  }

  async updatePullRequestBody(owner: string, repo: string, index: number, body: string): Promise<Pull> {
    return toPull(await this.patch<GithubPR>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}`, { body }));
  }

  async getIssue(owner: string, repo: string, index: number): Promise<Task> {
    return toTask(await this.get<GithubIssue>(`/repos/${this.repoPath(owner, repo)}/issues/${index}`));
  }

  async addIssueLabel(owner: string, repo: string, index: number, label: string): Promise<unknown> {
    return this.post(`/repos/${this.repoPath(owner, repo)}/issues/${index}/labels`, { labels: [label] });
  }

  async listIssueDependencies(owner: string, repo: string, index: number): Promise<LinkedIssue[]> {
    const issues = await this.getPagesOrEmptyOn404<GithubIssue>(
      `/repos/${this.repoPath(owner, repo)}/issues/${index}/dependencies/blocked_by`
    );
    return issues.map((issue) => toLinkedIssue(issue, owner, repo));
  }

  async listIssueBlocks(owner: string, repo: string, index: number): Promise<LinkedIssue[]> {
    const issues = await this.getPagesOrEmptyOn404<GithubIssue>(
      `/repos/${this.repoPath(owner, repo)}/issues/${index}/dependencies/blocking`
    );
    return issues.map((issue) => toLinkedIssue(issue, owner, repo));
  }

  async listRepoIssues(
    owner: string,
    repo: string,
    opts?: { state?: "open" | "closed" | "all"; type?: "issues" | "pulls"; assignedBy?: string }
  ): Promise<LinkedIssue[]> {
    const params = new URLSearchParams();
    if (opts?.state) params.set("state", opts.state);
    if (opts?.assignedBy) params.set("assignee", opts.assignedBy);
    params.set("per_page", String(PAGE_SIZE));
    const matched: GithubIssue[] = [];
    let page = 1;
    while (page <= MAX_PAGES && matched.length < PAGE_SIZE) {
      params.set("page", String(page));
      const issues = await this.get<GithubIssue[]>(`/repos/${this.repoPath(owner, repo)}/issues?${params.toString()}`);
      for (const issue of issues) {
        const isPull = issue.pull_request != null;
        if (opts?.type === "issues" && isPull) continue;
        if (opts?.type === "pulls" && !isPull) continue;
        matched.push(issue);
        if (matched.length >= PAGE_SIZE) break;
      }
      if (issues.length !== PAGE_SIZE) break;
      page += 1;
    }
    return matched.map((issue) => toLinkedIssue(issue, owner, repo));
  }

  async createIssueDependency(
    owner: string,
    repo: string,
    index: number,
    dependency: { owner: string; repo: string; number: number }
  ): Promise<void> {
    const target = await this.get<GithubIssue>(
      `/repos/${this.repoPath(dependency.owner, dependency.repo)}/issues/${dependency.number}`
    );
    if (typeof target.id !== "number") {
      throw new Error("GitHub issue is missing global id");
    }
    await this.post(`/repos/${this.repoPath(owner, repo)}/issues/${index}/dependencies/blocked_by`, {
      issue_id: target.id,
    });
  }

  async getPRFiles(owner: string, repo: string, index: number): Promise<PullFile[]> {
    const files = await this.getPages<GithubFile>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/files`);
    return files.map(toPullFile);
  }

  async createIssueComment(owner: string, repo: string, index: number, body: string): Promise<Comment> {
    return toComment(
      await this.post<GithubComment>(`/repos/${this.repoPath(owner, repo)}/issues/${index}/comments`, { body })
    );
  }

  async findStickyIssueComment(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined> {
    const path = `/repos/${this.repoPath(owner, repo)}/issues/${index}/comments`;
    let page = 1;
    while (page <= MAX_PAGES) {
      const batch = await this.get<GithubComment[]>(`${path}?per_page=${PAGE_SIZE}&page=${page}`);
      for (const comment of batch) {
        if (
          loginEquals(comment.user?.login, botUsername) &&
          typeof comment.body === "string" &&
          comment.body.includes(marker)
        ) {
          return { id: comment.id };
        }
      }
      if (batch.length !== PAGE_SIZE) break;
      page += 1;
    }
    return undefined;
  }

  async updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<Comment> {
    return toComment(
      await this.patch<GithubComment>(`/repos/${this.repoPath(owner, repo)}/issues/comments/${commentId}`, { body })
    );
  }

  async listIssueComments(owner: string, repo: string, index: number): Promise<Comment[]> {
    const comments = await this.getPages<GithubComment>(
      `/repos/${this.repoPath(owner, repo)}/issues/${index}/comments`
    );
    return comments.map(toComment);
  }

  async listPullReviewComments(owner: string, repo: string, index: number): Promise<InlineComment[]> {
    const comments = await this.getPages<GithubReviewComment>(
      `/repos/${this.repoPath(owner, repo)}/pulls/${index}/comments`
    );
    if (comments.length === 0) return [];
    // Resolved comment id → who resolved the thread ("" when GitHub does not say).
    const resolvedBy = new Map<number, string>();
    for (const thread of await this.listReviewThreads(owner, repo, index)) {
      if (thread.isResolved !== true) continue;
      for (const node of thread.comments?.nodes ?? []) {
        if (typeof node.databaseId === "number") resolvedBy.set(node.databaseId, thread.resolvedBy?.login ?? "");
      }
    }
    return comments.map((comment) => toInlineComment(comment, resolvedBy.has(comment.id), resolvedBy.get(comment.id)));
  }

  async listPullReviews(owner: string, repo: string, index: number): Promise<PullReview[]> {
    const reviews = await this.getPages<GithubReview>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews`);
    return reviews.map(toPullReview);
  }

  async createPullReview(
    owner: string,
    repo: string,
    index: number,
    review: CreatePullReviewOptions
  ): Promise<PullReview> {
    let event = toGithubReviewEvent(review.event);
    let body = review.body;
    if (needsSelfReviewGuard(event)) {
      const [pr, me] = await Promise.all([this.getPR(owner, repo, index), this.getViewerLogin({ owner, repo })]);
      if (!me || loginEquals(pr.user?.login, me)) {
        event = "COMMENT";
      }
    }
    if (event === "COMMENT" || event === "REQUEST_CHANGES") {
      body = body ?? "";
    }
    return toPullReview(
      await this.post<GithubReview>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews`, {
        commit_id: review.commit_id,
        ...(body != null ? { body } : {}),
        ...(event != null ? { event } : {}),
        ...(review.comments?.length ? { comments: toGithubReviewComments(review.comments) } : {}),
      })
    );
  }

  async submitPullReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    body?: string
  ): Promise<PullReview> {
    return toPullReview(
      await this.post<GithubReview>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews/${reviewId}/events`, {
        ...(body != null ? { body } : {}),
        event: "COMMENT",
      })
    );
  }

  async resolvePullComment(owner: string, repo: string, commentId: number): Promise<void> {
    const threadId = await this.reviewThreadId(owner, repo, commentId);
    await this.graphql(
      "mutation ($id: ID!) { resolveReviewThread(input: {threadId: $id}) { clientMutationId } }",
      {
        id: threadId,
      },
      { owner, repo }
    );
  }

  async unresolvePullComment(owner: string, repo: string, commentId: number): Promise<void> {
    const threadId = await this.reviewThreadId(owner, repo, commentId);
    await this.graphql(
      "mutation ($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { clientMutationId } }",
      {
        id: threadId,
      },
      { owner, repo }
    );
  }

  async dismissPullReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    opts?: { message?: string; priors?: boolean }
  ): Promise<PullReview> {
    return toPullReview(
      await this.put<GithubReview>(
        `/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews/${reviewId}/dismissals`,
        {
          message: opts?.message ?? "superseded",
        }
      )
    );
  }

  async createCommitStatus(owner: string, repo: string, sha: string, status: CheckPayload): Promise<CheckPayload> {
    const description =
      typeof status.description === "string"
        ? truncateStatusDescription(omitOpenCodeStderr(status.description), {
            maxChars: GITHUB_STATUS_DESCRIPTION_MAX_CHARS,
          })
        : status.description;
    return toCheckPayload(
      await this.post<GithubStatus>(`/repos/${this.repoPath(owner, repo)}/statuses/${encodeURIComponent(sha)}`, {
        ...status,
        description,
        // GitHub statuses have no "warning". Only skipped reviews (no parsed verdict) use it; posting
        // "success" would let a skip satisfy a required check, and "pending" can wedge the PR forever.
        state: status.state === "warning" ? "failure" : status.state,
      })
    );
  }

  async listCommitStatuses(owner: string, repo: string, sha: string): Promise<Check[]> {
    const statuses = await this.getPages<GithubStatus>(
      `/repos/${this.repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/statuses`
    );
    return statuses.map(toCheck);
  }

  async listCheckRuns(owner: string, repo: string, sha: string): Promise<Check[]> {
    try {
      return await this.listGithubCheckRuns(owner, repo, sha);
    } catch {
      return this.checkRunsFromActionJobs(owner, repo, sha);
    }
  }

  private async listGithubCheckRuns(owner: string, repo: string, sha: string): Promise<Check[]> {
    const results: Check[] = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      const body = await this.get<{ check_runs?: GithubCheckRun[] }>(
        `/repos/${this.repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`
      );
      const batch = Array.isArray(body?.check_runs) ? body.check_runs : [];
      results.push(...batch.map(toCheckFromCheckRun));
      if (batch.length !== PAGE_SIZE) break;
      page += 1;
    }
    return results;
  }

  private async checkRunsFromActionJobs(owner: string, repo: string, sha: string): Promise<Check[]> {
    const body = await this.get<{ workflow_runs?: GithubWorkflowRun[] }>(
      `/repos/${this.repoPath(owner, repo)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=${PAGE_SIZE}&page=1`
    );
    const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    const checks: Check[] = [];
    for (const run of runs) {
      const page = await this.get<{ jobs?: GithubJob[] }>(
        `/repos/${this.repoPath(owner, repo)}/actions/runs/${run.id}/jobs?per_page=100`
      );
      const batch = Array.isArray(page?.jobs) ? page.jobs : [];
      for (const job of batch) {
        checks.push(toCheckFromActionJob(job));
      }
    }
    return checks;
  }

  async listActionJobs(
    owner: string,
    repo: string,
    opts?: { status?: string; headSha?: string }
  ): Promise<ActionJob[]> {
    const statusQ = opts?.status ? `&status=${encodeURIComponent(opts.status)}` : "";
    const shaQ = opts?.headSha ? `&head_sha=${encodeURIComponent(opts.headSha)}` : "";
    let body: { workflow_runs?: GithubWorkflowRun[] };
    try {
      body = await this.get<{ workflow_runs?: GithubWorkflowRun[] }>(
        `/repos/${this.repoPath(owner, repo)}/actions/runs?per_page=${PAGE_SIZE}&page=1${statusQ}${shaQ}`
      );
    } catch (err) {
      if (isActionsDisabledError(err)) return [];
      throw err;
    }
    const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    const jobs: ActionJob[] = [];
    for (const run of runs) {
      const page = await this.get<{ jobs?: GithubJob[] }>(
        `/repos/${this.repoPath(owner, repo)}/actions/runs/${run.id}/jobs?per_page=100`
      );
      const batch = Array.isArray(page?.jobs) ? page.jobs : [];
      for (const job of batch) {
        if (opts?.status && job.status !== opts.status && job.conclusion !== opts.status) continue;
        jobs.push(toActionJob(job, run.head_branch));
      }
    }
    return jobs;
  }

  async getActionJobLogs(owner: string, repo: string, jobId: number): Promise<string> {
    return this.requestText(`/repos/${this.repoPath(owner, repo)}/actions/jobs/${jobId}/logs`);
  }

  private async listReviewThreads(owner: string, repo: string, number: number): Promise<ReviewThreadNode[]> {
    const threads: ReviewThreadNode[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.graphql<{
        repository?: { pullRequest?: { reviewThreads?: ReviewThreadConn } };
      }>(
        `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  resolvedBy { login }
                  comments(first: 100) { nodes { databaseId } }
                }
              }
            }
          }
        }`,
        { owner, name: repo, number, after: cursor ?? null }
      );
      const conn = data.repository?.pullRequest?.reviewThreads;
      threads.push(...(conn?.nodes ?? []));
      if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
      cursor = conn.pageInfo.endCursor;
    }
    return threads;
  }

  private async reviewThreadId(owner: string, repo: string, commentId: number): Promise<string> {
    const comment = await this.get<GithubReviewComment>(
      `/repos/${this.repoPath(owner, repo)}/pulls/comments/${commentId}`
    );
    const number = pullNumberFromUrl(comment.pull_request_url);
    if (number == null) throw new Error(`GitHub pull comment ${commentId} is missing pull_request_url`);
    for (const thread of await this.listReviewThreads(owner, repo, number)) {
      if (thread.comments?.nodes?.some((node) => node.databaseId === commentId) && thread.id) {
        return thread.id;
      }
    }
    throw new Error(`GitHub review thread not found for comment ${commentId}`);
  }
}
