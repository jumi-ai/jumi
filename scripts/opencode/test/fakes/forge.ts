import type {
  ActionJob,
  AttachmentMeta,
  BranchProtection,
  Check,
  CheckPayload,
  CollaboratorPermission,
  Comment,
  CreatePullReviewOptions,
  Forge,
  InlineComment,
  IssueApi,
  IssueTimelineEvent,
  LinkedIssue,
  Pull,
  PullCommit,
  PullFile,
  PullReview,
  Repo,
  ReviewApi,
  Task,
} from "../../src/ports.ts";

export interface ForgeCall {
  method: string;
  args: unknown[];
}

export interface ForgeProbe {
  calls: ForgeCall[];
  callsTo(method: string): ForgeCall[];
}

export type ForgeFake<T> = T & ForgeProbe;

function neutralRepo(): Repo {
  return {
    name: "demo",
    full_name: "kirmanak/demo",
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo",
    clone_url: "https://gitea.kirmanak.stream/kirmanak/demo.git",
    default_branch: "main",
    owner: { login: "kirmanak" },
  };
}

function neutralPull(index = 7): Pull {
  return {
    number: index,
    title: "Add feature",
    body: "PR body",
    state: "open",
    html_url: `https://gitea.kirmanak.stream/kirmanak/demo/pulls/${index}`,
    user: { login: "alice" },
    head: {
      ref: "feature",
      sha: "headsha",
      repo: {
        full_name: "kirmanak/demo",
        clone_url: "https://gitea.kirmanak.stream/kirmanak/demo.git",
      },
    },
    base: { ref: "main", sha: "basesha" },
    merged: false,
    created_at: "2026-05-23T00:00:00Z",
    updated_at: "2026-05-23T00:00:00Z",
  };
}

function neutralIssue(): Task {
  return {
    number: 12,
    title: "Fix the thing",
    body: "Please implement this.",
    state: "open",
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
    user: { login: "alice" },
    assignee: { login: "jumi" },
    assignees: [{ login: "jumi" }],
    updated_at: "2026-05-23T00:00:00Z",
    created_at: "2026-05-23T00:00:00Z",
  };
}

function neutralComment(body: string, id = 1): Comment {
  return {
    id,
    body,
    user: { login: "jumi" },
    created_at: "2026-05-23T00:00:00Z",
    updated_at: "2026-05-23T00:00:00Z",
  };
}

function makeProbe(calls: ForgeCall[]): ForgeProbe {
  return {
    calls,
    callsTo: (method: string) => calls.filter((call) => call.method === method),
  };
}

function applyOverrides<T extends object>(api: T, calls: ForgeCall[], overrides: Partial<T>): void {
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const value = overrides[key];
    if (value === undefined) {
      (api as Record<string, unknown>)[key as string] = undefined;
    } else if (typeof value === "function") {
      const method = key as string;
      const fn = value as (...args: never[]) => unknown;
      (api as Record<string, unknown>)[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return fn(...(args as never[]));
      };
    } else {
      (api as Record<string, unknown>)[key as string] = value;
    }
  }
}

/** Neutral file list entry used when a review fake needs a file. */
export function neutralFile(): PullFile {
  return {
    filename: "src/demo.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1 +1 @@\n-old\n+new",
  };
}

function neutralCheck(): Check {
  return { id: 1, context: "build", status: "success" };
}

function neutralActionJob(): ActionJob {
  return { id: 1, name: "build", status: "completed", conclusion: "success", head_sha: "headsha" };
}

/** Complete neutral Forge fake with a built-in call recorder. */
export function makeForgeApi(overrides: Partial<Forge> = {}): ForgeFake<Forge> {
  const calls: ForgeCall[] = [];
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
  };
  const defaults: Forge = {
    getRepo: async (...args) => {
      record("getRepo", args);
      return neutralRepo();
    },
    getPR: async (...args) => {
      record("getPR", args);
      const index = typeof args[2] === "number" ? args[2] : 7;
      return neutralPull(index);
    },
    listOpenPulls: async (...args) => {
      record("listOpenPulls", args);
      return [];
    },
    addIssueAssignees: async (...args) => {
      record("addIssueAssignees", args);
      return undefined;
    },
    addIssueLabel: async (...args) => {
      record("addIssueLabel", args);
      return undefined;
    },
    getBranch: async (...args) => {
      record("getBranch", args);
      const out: BranchProtection = { protected: false };
      return out;
    },
    getRepoFile: async (...args) => {
      record("getRepoFile", args);
      return { found: false };
    },
    cancelAutoMerge: async (...args) => {
      record("cancelAutoMerge", args);
      return false;
    },
    scheduleAutoMerge: async (...args) => {
      record("scheduleAutoMerge", args);
    },
    getCollaboratorPermission: async (...args) => {
      record("getCollaboratorPermission", args);
      const out: CollaboratorPermission = { permission: "write", role_name: "write" };
      return out;
    },
    getAppPermissions: async (...args) => {
      record("getAppPermissions", args);
      return undefined;
    },
    listIssueTimeline: async (...args) => {
      record("listIssueTimeline", args);
      const out: IssueTimelineEvent[] = [];
      return out;
    },
    deleteGitRef: async (...args) => {
      record("deleteGitRef", args);
    },
    createPullRequest: async (...args) => {
      record("createPullRequest", args);
      const pull = args[2] as { title: string; body: string };
      return { ...neutralPull(3), title: pull.title, body: pull.body };
    },
    closePullRequest: async (...args) => {
      record("closePullRequest", args);
      const index = args[2] as number;
      return { ...neutralPull(index), state: "closed" as const };
    },
    reopenPullRequest: async (...args) => {
      record("reopenPullRequest", args);
      const index = args[2] as number;
      return { ...neutralPull(index), state: "open" as const };
    },
    updatePullRequestBody: async (...args) => {
      record("updatePullRequestBody", args);
      const index = args[2] as number;
      const body = args[3] as string;
      return { ...neutralPull(index), body };
    },
    getPRFiles: async (...args) => {
      record("getPRFiles", args);
      return [];
    },
    listIssueComments: async (...args) => {
      record("listIssueComments", args);
      return [];
    },
    findStickyIssueComment: async (...args) => {
      record("findStickyIssueComment", args);
      return undefined;
    },
    createIssueComment: async (...args) => {
      record("createIssueComment", args);
      const body = args[3] as string;
      return neutralComment(body, 1);
    },
    updateIssueComment: async (...args) => {
      record("updateIssueComment", args);
      const commentId = args[2] as number;
      const body = args[3] as string;
      return neutralComment(body, commentId);
    },
    listPullReviewComments: async (...args) => {
      record("listPullReviewComments", args);
      const out: InlineComment[] = [];
      return out;
    },
    listPullReviews: async (...args) => {
      record("listPullReviews", args);
      const out: PullReview[] = [];
      return out;
    },
    createPullReview: async (...args) => {
      record("createPullReview", args);
      const review = args[3] as CreatePullReviewOptions | undefined;
      void review;
      return { id: 1 };
    },
    submitPullReview: async (...args) => {
      record("submitPullReview", args);
      return { id: 1 };
    },
    resolvePullComment: async (...args) => {
      record("resolvePullComment", args);
    },
    unresolvePullComment: async (...args) => {
      record("unresolvePullComment", args);
    },
    dismissPullReview: async (...args) => {
      record("dismissPullReview", args);
      return { id: 1 };
    },
    createCommitStatus: async (...args) => {
      record("createCommitStatus", args);
      return args[3] as CheckPayload;
    },
    listCommitStatuses: async (...args) => {
      record("listCommitStatuses", args);
      return [];
    },
    listCheckRuns: async (...args) => {
      record("listCheckRuns", args);
      return [];
    },
    listActionJobs: async (...args) => {
      record("listActionJobs", args);
      const out: ActionJob[] = [];
      void neutralActionJob;
      void neutralCheck;
      return out;
    },
    getActionJobLogs: async (...args) => {
      record("getActionJobLogs", args);
      return "";
    },
    listPullCommits: async (...args) => {
      record("listPullCommits", args);
      const out: PullCommit[] = [];
      return out;
    },
    listClosingIssues: async (...args) => {
      record("listClosingIssues", args);
      return [];
    },
    listIssueAttachments: async (...args) => {
      record("listIssueAttachments", args);
      const out: AttachmentMeta[] = [];
      return out;
    },
    listIssueCommentAttachments: async (...args) => {
      record("listIssueCommentAttachments", args);
      const out: AttachmentMeta[] = [];
      return out;
    },
    downloadAttachmentBytes: async (...args) => {
      record("downloadAttachmentBytes", args);
      return new Uint8Array(0);
    },
  };
  const api = { ...defaults } as Forge;
  applyOverrides(api, calls, overrides);
  return Object.assign(api, makeProbe(calls));
}

/** Complete neutral ReviewApi fake with a built-in call recorder. */
export function makeReviewApi(overrides: Partial<ReviewApi> = {}): ForgeFake<ReviewApi> {
  const calls: ForgeCall[] = [];
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
  };
  const defaults: ReviewApi = {
    getRepo: async (...args) => {
      record("getRepo", args);
      return neutralRepo();
    },
    getPR: async (...args) => {
      record("getPR", args);
      const index = typeof args[2] === "number" ? args[2] : 7;
      return neutralPull(index);
    },
    getPRFiles: async (...args) => {
      record("getPRFiles", args);
      return [];
    },
    listIssueComments: async (...args) => {
      record("listIssueComments", args);
      return [];
    },
    findStickyIssueComment: async (...args) => {
      record("findStickyIssueComment", args);
      return undefined;
    },
    createIssueComment: async (...args) => {
      record("createIssueComment", args);
      const body = args[3] as string;
      return neutralComment(body, 1);
    },
    updateIssueComment: async (...args) => {
      record("updateIssueComment", args);
      const commentId = args[2] as number;
      const body = args[3] as string;
      return neutralComment(body, commentId);
    },
    listPullReviewComments: async (...args) => {
      record("listPullReviewComments", args);
      const out: InlineComment[] = [];
      return out;
    },
    listPullReviews: async (...args) => {
      record("listPullReviews", args);
      const out: PullReview[] = [];
      return out;
    },
    createPullReview: async (...args) => {
      record("createPullReview", args);
      const review = args[3] as CreatePullReviewOptions | undefined;
      void review;
      return { id: 1 };
    },
    submitPullReview: async (...args) => {
      record("submitPullReview", args);
      return { id: 1 };
    },
    resolvePullComment: async (...args) => {
      record("resolvePullComment", args);
    },
    unresolvePullComment: async (...args) => {
      record("unresolvePullComment", args);
    },
    dismissPullReview: async (...args) => {
      record("dismissPullReview", args);
      return { id: 1 };
    },
    createCommitStatus: async (...args) => {
      record("createCommitStatus", args);
      return args[3] as CheckPayload;
    },
    listCommitStatuses: async (...args) => {
      record("listCommitStatuses", args);
      return [];
    },
    listCheckRuns: async (...args) => {
      record("listCheckRuns", args);
      return [];
    },
    listActionJobs: async (...args) => {
      record("listActionJobs", args);
      const out: ActionJob[] = [];
      return out;
    },
    getActionJobLogs: async (...args) => {
      record("getActionJobLogs", args);
      return "";
    },
    getCollaboratorPermission: async (...args) => {
      record("getCollaboratorPermission", args);
      const out: CollaboratorPermission = { permission: "write", role_name: "write" };
      return out;
    },
    getIssue: async (...args) => {
      record("getIssue", args);
      return neutralIssue();
    },
  };
  const api = { ...defaults } as ReviewApi;
  applyOverrides(api, calls, overrides);
  return Object.assign(api, makeProbe(calls));
}

/** Complete neutral IssueApi fake with a built-in call recorder. */
export function makeIssueApi(overrides: Partial<IssueApi> = {}): ForgeFake<IssueApi> {
  const calls: ForgeCall[] = [];
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
  };
  const defaults: IssueApi = {
    getIssue: async (...args) => {
      record("getIssue", args);
      return neutralIssue();
    },
    listIssueComments: async (...args) => {
      record("listIssueComments", args);
      return [];
    },
    findStickyIssueComment: async (...args) => {
      record("findStickyIssueComment", args);
      return undefined;
    },
    createIssueComment: async (...args) => {
      record("createIssueComment", args);
      const body = args[3] as string;
      return neutralComment(body, 1);
    },
    updateIssueComment: async (...args) => {
      record("updateIssueComment", args);
      const commentId = args[2] as number;
      const body = args[3] as string;
      return neutralComment(body, commentId);
    },
    listIssueDependencies: async (...args) => {
      record("listIssueDependencies", args);
      const out: LinkedIssue[] = [];
      return out;
    },
    listIssueBlocks: async (...args) => {
      record("listIssueBlocks", args);
      const out: LinkedIssue[] = [];
      return out;
    },
    listRepoIssues: async (...args) => {
      record("listRepoIssues", args);
      const out: LinkedIssue[] = [];
      return out;
    },
    createIssueDependency: async (...args) => {
      record("createIssueDependency", args);
    },
    getRepo: async (...args) => {
      record("getRepo", args);
      return neutralRepo();
    },
    getPR: async (...args) => {
      record("getPR", args);
      const index = typeof args[2] === "number" ? args[2] : 7;
      return neutralPull(index);
    },
    listOpenPulls: async (...args) => {
      record("listOpenPulls", args);
      return [];
    },
    createPullRequest: async (...args) => {
      record("createPullRequest", args);
      const pull = args[2] as { title: string; body: string };
      return { ...neutralPull(3), title: pull.title, body: pull.body };
    },
    closePullRequest: async (...args) => {
      record("closePullRequest", args);
      const index = args[2] as number;
      return { ...neutralPull(index), state: "closed" as const };
    },
    updatePullRequestBody: async (...args) => {
      record("updatePullRequestBody", args);
      const index = args[2] as number;
      const body = args[3] as string;
      return { ...neutralPull(index), body };
    },
    listPullReviewComments: async (...args) => {
      record("listPullReviewComments", args);
      const out: InlineComment[] = [];
      return out;
    },
    listPullReviews: async (...args) => {
      record("listPullReviews", args);
      const out: PullReview[] = [];
      return out;
    },
    listCommitStatuses: async (...args) => {
      record("listCommitStatuses", args);
      return [];
    },
    listCheckRuns: async (...args) => {
      record("listCheckRuns", args);
      return [];
    },
    listActionJobs: async (...args) => {
      record("listActionJobs", args);
      const out: ActionJob[] = [];
      return out;
    },
    getActionJobLogs: async (...args) => {
      record("getActionJobLogs", args);
      return "";
    },
    getCollaboratorPermission: async (...args) => {
      record("getCollaboratorPermission", args);
      const out: CollaboratorPermission = { permission: "write", role_name: "write" };
      return out;
    },
  };
  const api = { ...defaults } as IssueApi;
  applyOverrides(api, calls, overrides);
  return Object.assign(api, makeProbe(calls));
}
