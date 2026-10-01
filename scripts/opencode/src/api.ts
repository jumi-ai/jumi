import type {
  ActionJob,
  Check,
  CheckPayload,
  CollaboratorPermission,
  Comment,
  CreatePullReviewOptions,
  InlineComment,
  LinkedIssue,
  Pull,
  PullFile,
  PullReview,
  Repo,
  Task,
} from "./ports.ts";
import type {
  GiteaActionJob,
  GiteaComment,
  GiteaCommitStatus,
  GiteaCommitStatusPayload,
  GiteaIssue,
  GiteaPR,
  GiteaPRFile,
  GiteaPullReview,
  GiteaPullReviewComment,
  GiteaRepo,
  GiteaUser,
} from "./types.ts";

function actor(user: GiteaUser | { login?: string } | null | undefined): { login: string } {
  return { login: user?.login ?? "" };
}

function loginEquals(login: string | undefined, botUsername: string): boolean {
  return typeof login === "string" && login.toLowerCase() === botUsername.toLowerCase();
}

export function toRepo(repo: GiteaRepo): Repo {
  return {
    name: repo.name,
    full_name: repo.full_name,
    html_url: repo.html_url,
    clone_url: repo.clone_url,
    default_branch: repo.default_branch,
    owner: actor(repo.owner),
  };
}

export function toTask(issue: GiteaIssue): Task {
  return {
    trackerRef: String(issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    html_url: issue.html_url,
    user: actor(issue.user),
    assignee: issue.assignee ? actor(issue.assignee) : issue.assignee,
    assignees: issue.assignees?.map(actor) ?? issue.assignees,
    updated_at: issue.updated_at,
    created_at: issue.created_at,
    pull_request: issue.pull_request,
    is_pull: issue.is_pull,
  };
}

function ownerRepoOf(issue: GiteaIssue, fallbackOwner: string, fallbackRepo: string): { owner: string; repo: string } {
  const meta = issue.repository;
  if (meta && typeof meta.full_name === "string") {
    const [owner, repo] = meta.full_name.split("/");
    if (owner && repo) return { owner, repo };
  }
  const name = meta && "name" in meta && typeof meta.name === "string" ? meta.name : undefined;
  const ownerField = meta && "owner" in meta ? meta.owner : undefined;
  const ownerLogin =
    typeof ownerField === "string"
      ? ownerField
      : ownerField && typeof ownerField === "object" && typeof ownerField.login === "string"
        ? ownerField.login
        : undefined;
  if (ownerLogin && name) return { owner: ownerLogin, repo: name };
  return { owner: fallbackOwner, repo: fallbackRepo };
}

export function toLinkedIssue(issue: GiteaIssue, fallbackOwner: string, fallbackRepo: string): LinkedIssue {
  const { owner, repo } = ownerRepoOf(issue, fallbackOwner, fallbackRepo);
  return {
    owner,
    repo,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    html_url: issue.html_url,
    body: issue.body,
    assignee: issue.assignee ? actor(issue.assignee) : issue.assignee,
    assignees: issue.assignees?.map(actor) ?? issue.assignees,
    updated_at: issue.updated_at,
    pull_request: issue.pull_request,
    is_pull: issue.is_pull,
  };
}

export function toPull(pr: GiteaPR): Pull {
  return {
    forgeRef: String(pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    html_url: pr.html_url,
    user: actor(pr.user),
    head: {
      ref: pr.head.ref,
      sha: pr.head.sha,
      repo: pr.head.repo ? { full_name: pr.head.repo.full_name, clone_url: pr.head.repo.clone_url } : pr.head.repo,
    },
    base: { ref: pr.base.ref, sha: pr.base.sha },
    merged: pr.merged,
    draft: pr.draft,
    mergeable: pr.mergeable,
    assignee: pr.assignee ? actor(pr.assignee) : pr.assignee,
    assignees: pr.assignees?.map(actor) ?? pr.assignees,
    labels: pr.labels,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  };
}

export function toComment(comment: GiteaComment): Comment {
  return {
    id: comment.id,
    body: comment.body,
    user: actor(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

export function toPullFile(file: GiteaPRFile): PullFile {
  return {
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch,
  };
}

export function toCheck(status: GiteaCommitStatus): Check {
  return {
    id: status.id,
    context: status.context,
    state: status.state,
    status: status.status,
    description: status.description,
    target_url: status.target_url,
    created_at: status.created_at,
    updated_at: status.updated_at,
    url: status.url,
  };
}

export function toCheckPayload(status: GiteaCommitStatusPayload): CheckPayload {
  return {
    state: status.state,
    context: status.context,
    description: status.description,
    target_url: status.target_url,
  };
}

export function toPullReview(review: GiteaPullReview): PullReview {
  return {
    id: review.id,
    body: review.body,
    content: review.content,
    user: review.user ? actor(review.user) : review.user,
    state: review.state,
    type: review.type,
    dismissed: review.dismissed === true,
    commit_id: review.commit_id,
    submitted_at: review.submitted_at,
    updated_at: review.updated_at,
    created_at: review.created_at,
  };
}

export function toInlineComment(comment: GiteaPullReviewComment): InlineComment {
  return {
    ...toComment(comment),
    path: comment.path,
    commit_id: comment.commit_id,
    new_position: comment.new_position ?? comment.line ?? comment.position,
    pull_request_review_id: comment.pull_request_review_id,
    html_url: comment.html_url,
    resolved: comment.resolved === true || comment.resolver != null,
    resolver: comment.resolver ? actor(comment.resolver) : undefined,
  };
}

export function toActionJob(job: GiteaActionJob): ActionJob {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    head_sha: job.head_sha,
    head_branch: job.head_branch,
    html_url: job.html_url,
    run_id: job.run_id,
  };
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /→ 404\b/.test(err.message);
}

function isActionsDisabledError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/rate limit/i.test(err.message)) return false;
  return /→ (403|404)\b/.test(err.message);
}

/**
 * Minimal Gitea REST API client.
 * All methods throw on non-2xx responses.
 */
export class GiteaAPI {
  private readonly base: string;
  private readonly token: string;

  constructor(serverUrl: string, token: string) {
    // Ensure no trailing slash
    this.base = `${serverUrl.replace(/\/$/, "")}/api/v1`;
    this.token = token;
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `token ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gitea API ${method} ${url} → ${res.status}: ${text}`);
    }
    // 204 No Content
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async requestText(path: string, maxBytes = 1_048_576): Promise<string> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { ...this.headers(), Accept: "text/plain, */*" },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gitea API GET ${url} → ${res.status}: ${text}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const slice = buf.byteLength > maxBytes ? buf.subarray(buf.byteLength - maxBytes) : buf;
    return new TextDecoder().decode(slice);
  }

  private get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  private post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, body);
  }
  private patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }

  private repoPath(owner: string, repo: string): string {
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  // Paginated GET — collects all pages (page size 50)
  private async getAll<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (true) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.get<T[]>(`${path}${sep}limit=50&page=${page}`);
      results.push(...batch);
      if (batch.length < 50) break;
      page++;
    }
    return results;
  }

  private async getPages<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (page <= 40) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.get<T[]>(`${path}${sep}limit=50&page=${page}`);
      results.push(...batch);
      if (batch.length !== 50) break;
      page += 1;
    }
    return results;
  }

  // ── Repositories ───────────────────────────────────────────────────────────

  async getRepo(owner: string, repo: string): Promise<Repo> {
    return toRepo(await this.get<GiteaRepo>(`/repos/${this.repoPath(owner, repo)}`));
  }

  async getCollaboratorPermission(owner: string, repo: string, username: string): Promise<CollaboratorPermission> {
    const info = await this.get<{ permission: string; role_name?: string }>(
      `/repos/${this.repoPath(owner, repo)}/collaborators/${encodeURIComponent(username)}/permission`
    );
    return { permission: info.permission, role_name: info.role_name };
  }

  // ── Pull Requests ─────────────────────────────────────────────────────────────

  async getPR(owner: string, repo: string, index: number): Promise<Pull> {
    return toPull(await this.get<GiteaPR>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}`));
  }

  async listOpenPulls(owner: string, repo: string): Promise<Pull[]> {
    const pulls = await this.getAll<GiteaPR>(`/repos/${this.repoPath(owner, repo)}/pulls?state=open`);
    return pulls.map(toPull);
  }

  async createPullRequest(
    owner: string,
    repo: string,
    pull: { title: string; body: string; head: string; base: string }
  ): Promise<Pull> {
    return toPull(await this.post<GiteaPR>(`/repos/${this.repoPath(owner, repo)}/pulls`, pull));
  }

  async closePullRequest(owner: string, repo: string, index: number): Promise<Pull> {
    return toPull(
      await this.patch<GiteaPR>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}`, { state: "closed" })
    );
  }

  async reopenPullRequest(owner: string, repo: string, index: number): Promise<Pull> {
    return toPull(await this.patch<GiteaPR>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}`, { state: "open" }));
  }

  async updatePullRequestBody(owner: string, repo: string, index: number, body: string): Promise<Pull> {
    return toPull(await this.patch<GiteaPR>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}`, { body }));
  }

  async getIssue(owner: string, repo: string, index: number): Promise<Task> {
    return toTask(await this.get<GiteaIssue>(`/repos/${this.repoPath(owner, repo)}/issues/${index}`));
  }

  async addIssueLabel(owner: string, repo: string, index: number, label: string): Promise<unknown> {
    return this.post(`/repos/${this.repoPath(owner, repo)}/issues/${index}/labels`, { labels: [label] });
  }

  private async getAllOrEmptyOn404<T>(path: string): Promise<T[]> {
    try {
      return await this.getAll<T>(path);
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
  }

  async listIssueDependencies(owner: string, repo: string, index: number): Promise<LinkedIssue[]> {
    const issues = await this.getAllOrEmptyOn404<GiteaIssue>(
      `/repos/${this.repoPath(owner, repo)}/issues/${index}/dependencies`
    );
    return issues.map((issue) => toLinkedIssue(issue, owner, repo));
  }

  async listIssueBlocks(owner: string, repo: string, index: number): Promise<LinkedIssue[]> {
    const issues = await this.getAllOrEmptyOn404<GiteaIssue>(
      `/repos/${this.repoPath(owner, repo)}/issues/${index}/blocks`
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
    if (opts?.type) params.set("type", opts.type);
    if (opts?.assignedBy) params.set("assigned_by", opts.assignedBy);
    params.set("limit", "50");
    params.set("page", "1");
    const issues = await this.get<GiteaIssue[]>(`/repos/${this.repoPath(owner, repo)}/issues?${params.toString()}`);
    return issues.map((issue) => toLinkedIssue(issue, owner, repo));
  }

  async createIssueDependency(
    owner: string,
    repo: string,
    index: number,
    dependency: { owner: string; repo: string; number: number }
  ): Promise<void> {
    await this.post(`/repos/${this.repoPath(owner, repo)}/issues/${index}/dependencies`, {
      index: dependency.number,
      owner: dependency.owner,
      repo: dependency.repo,
    });
  }

  async getPRFiles(owner: string, repo: string, index: number): Promise<PullFile[]> {
    const files = await this.getAll<GiteaPRFile>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/files`);
    return files.map(toPullFile);
  }

  // ── Issues / Comments ─────────────────────────────────────────────────────────

  async createIssueComment(owner: string, repo: string, index: number, body: string): Promise<Comment> {
    return toComment(
      await this.post<GiteaComment>(`/repos/${this.repoPath(owner, repo)}/issues/${index}/comments`, { body })
    );
  }

  /**
   * Find the sticky review comment without retaining the full issue timeline.
   * Gitea may ignore page size and return the whole thread in one response; we
   * still scan once, keep only a minimal match (id), and drop the rest so
   * multi‑MB Tapio/PR-summary histories are not held for the rest of the job.
   */
  async findStickyIssueComment(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined> {
    const path = `/repos/${this.repoPath(owner, repo)}/issues/${index}/comments`;
    let page = 1;
    while (page <= 40) {
      const batch = await this.get<GiteaComment[]>(`${path}?limit=50&page=${page}`);
      for (const comment of batch) {
        if (
          loginEquals(comment.user?.login, botUsername) &&
          typeof comment.body === "string" &&
          comment.body.includes(marker)
        ) {
          return { id: comment.id };
        }
      }
      // Gitea may ignore limit and return the full thread (length !== 50).
      // Only advance pages when we got a full page of exactly 50.
      if (batch.length !== 50) break;
      page += 1;
    }
    return undefined;
  }

  async updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<Comment> {
    return toComment(
      await this.patch<GiteaComment>(`/repos/${this.repoPath(owner, repo)}/issues/comments/${commentId}`, { body })
    );
  }

  async listIssueComments(owner: string, repo: string, index: number): Promise<Comment[]> {
    const comments = await this.getPages<GiteaComment>(`/repos/${this.repoPath(owner, repo)}/issues/${index}/comments`);
    return comments.map(toComment);
  }

  async listPullReviewCommentsByReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number
  ): Promise<InlineComment[]> {
    const comments = await this.getPages<GiteaPullReviewComment>(
      `/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews/${reviewId}/comments`
    );
    return comments.map(toInlineComment);
  }

  async listPullReviewComments(owner: string, repo: string, index: number): Promise<InlineComment[]> {
    const reviews = await this.listPullReviews(owner, repo, index);
    const comments: InlineComment[] = [];
    for (const review of reviews) {
      if (typeof review.id !== "number" || !Number.isFinite(review.id)) continue;
      try {
        comments.push(
          ...(await this.listPullReviewCommentsByReview(owner, repo, index, review.id)).map((comment) => ({
            ...comment,
            pull_request_review_id: comment.pull_request_review_id ?? review.id,
          }))
        );
      } catch (err) {
        if (isNotFoundError(err)) continue;
        throw err;
      }
    }
    return comments;
  }

  async listPullReviews(owner: string, repo: string, index: number): Promise<PullReview[]> {
    const reviews = await this.getPages<GiteaPullReview>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews`);
    return reviews.map(toPullReview);
  }

  async createPullReview(
    owner: string,
    repo: string,
    index: number,
    review: CreatePullReviewOptions
  ): Promise<PullReview> {
    return toPullReview(
      await this.post<GiteaPullReview>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews`, review)
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
      await this.post<GiteaPullReview>(`/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews/${reviewId}`, {
        ...(body != null ? { body } : {}),
        event: "COMMENT",
      })
    );
  }

  async resolvePullComment(owner: string, repo: string, commentId: number): Promise<void> {
    await this.post(`/repos/${this.repoPath(owner, repo)}/pulls/comments/${commentId}/resolve`, {});
  }

  async unresolvePullComment(owner: string, repo: string, commentId: number): Promise<void> {
    await this.post(`/repos/${this.repoPath(owner, repo)}/pulls/comments/${commentId}/unresolve`, {});
  }

  async dismissPullReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    opts?: { message?: string; priors?: boolean }
  ): Promise<PullReview> {
    return toPullReview(
      await this.post<GiteaPullReview>(
        `/repos/${this.repoPath(owner, repo)}/pulls/${index}/reviews/${reviewId}/dismissals`,
        { message: opts?.message ?? "superseded", priors: opts?.priors ?? false }
      )
    );
  }

  // ── Commit statuses ───────────────────────────────────────────────────────────

  async createCommitStatus(owner: string, repo: string, sha: string, status: CheckPayload): Promise<CheckPayload> {
    return toCheckPayload(
      await this.post<GiteaCommitStatusPayload>(
        `/repos/${this.repoPath(owner, repo)}/statuses/${encodeURIComponent(sha)}`,
        status
      )
    );
  }

  async listCommitStatuses(owner: string, repo: string, sha: string): Promise<Check[]> {
    const statuses = await this.getAll<GiteaCommitStatus>(
      `/repos/${this.repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/statuses`
    );
    return statuses.map(toCheck);
  }

  async listCheckRuns(_owner: string, _repo: string, _sha: string): Promise<Check[]> {
    return [];
  }

  async listActionJobs(
    owner: string,
    repo: string,
    opts?: { status?: string; headSha?: string }
  ): Promise<ActionJob[]> {
    const results: ActionJob[] = [];
    let page = 1;
    const statusQ = opts?.status ? `&status=${encodeURIComponent(opts.status)}` : "";
    const needle = opts?.headSha?.toLowerCase();
    while (page <= 40) {
      let body: { jobs?: GiteaActionJob[] };
      try {
        body = await this.get<{ jobs?: GiteaActionJob[] }>(
          `/repos/${this.repoPath(owner, repo)}/actions/jobs?limit=50&page=${page}&order=desc${statusQ}`
        );
      } catch (err) {
        if (results.length === 0 && isActionsDisabledError(err)) return [];
        throw err;
      }
      const batch = Array.isArray(body?.jobs) ? body.jobs : [];
      for (const job of batch) {
        if (needle && (job.head_sha ?? "").toLowerCase() !== needle) continue;
        results.push(toActionJob(job));
      }
      if (batch.length !== 50) break;
      page += 1;
    }
    return results;
  }

  async getActionJobLogs(owner: string, repo: string, jobId: number): Promise<string> {
    return this.requestText(`/repos/${this.repoPath(owner, repo)}/actions/jobs/${jobId}/logs`);
  }
}
