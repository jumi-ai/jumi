import type { ServiceConfig } from "../src/config.ts";
import type { LinkedIssue } from "../src/ports.ts";
import type {
  GiteaActionJob,
  GiteaComment,
  GiteaCommitStatus,
  GiteaIssue,
  GiteaIssueCommentPayload,
  GiteaIssuePayload,
  GiteaPR,
  GiteaPRBranch,
  GiteaPRFile,
  GiteaPRPayload,
  GiteaPushPayload,
  GiteaRepo,
  GiteaUser,
  GiteaWorkflowJobPayload,
  IssueJob,
  ReviewJob,
} from "../src/types.ts";
import type { WorkerConfig } from "../src/worker_config.ts";

export function makeUser(overrides: Partial<GiteaUser> = {}): GiteaUser {
  return {
    id: 1,
    login: "alice",
    full_name: "Alice",
    email: "alice@example.com",
    avatar_url: "https://gitea.kirmanak.stream/avatars/alice",
    ...overrides,
  };
}

export function makeRepo(overrides: Partial<GiteaRepo> = {}): GiteaRepo {
  const owner = overrides.owner ?? makeUser({ login: "kirmanak" });
  const name = overrides.name ?? "demo";
  const fullName = overrides.full_name ?? `${owner.login}/${name}`;
  return {
    id: 10,
    name,
    full_name: fullName,
    private: true,
    owner,
    html_url: `https://gitea.kirmanak.stream/${fullName}`,
    clone_url: `https://gitea.kirmanak.stream/${fullName}.git`,
    default_branch: "main",
    ...overrides,
  };
}

export function makeBranch(overrides: Partial<GiteaPRBranch> = {}): GiteaPRBranch {
  const repo = overrides.repo === undefined ? makeRepo() : overrides.repo;
  return {
    label: "kirmanak:feature",
    ref: "feature",
    sha: "abc123",
    repo,
    repo_id: repo?.id ?? 10,
    ...overrides,
  };
}

export function makePR(overrides: Partial<GiteaPR> = {}): GiteaPR & { forgeRef: string } {
  const pr: GiteaPR = {
    id: 100,
    number: 7,
    title: "Add feature",
    body: "PR body",
    state: "open",
    user: makeUser(),
    head: makeBranch({ sha: "headsha" }),
    base: makeBranch({ label: "kirmanak:main", ref: "main", sha: "basesha" }),
    merged: false,
    created_at: "2026-05-23T00:00:00Z",
    updated_at: "2026-05-23T00:00:00Z",
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/7",
    ...overrides,
  };
  return { ...pr, forgeRef: String(pr.number) };
}

export function makeFile(overrides: Partial<GiteaPRFile> = {}): GiteaPRFile {
  return {
    filename: "src/demo.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1 +1 @@\n-old\n+new",
    ...overrides,
  };
}

export function makeComment(overrides: Partial<GiteaComment> = {}): GiteaComment {
  return {
    id: 55,
    body: "comment",
    user: makeUser({ login: "jumi" }),
    created_at: "2026-05-23T00:00:00Z",
    updated_at: "2026-05-23T00:00:00Z",
    ...overrides,
  };
}

export function makePayload(overrides: Partial<GiteaPRPayload> = {}): GiteaPRPayload {
  const repository = overrides.repository ?? makeRepo();
  const pr = overrides.pull_request ?? makePR({ number: 7 });
  return {
    action: "opened",
    number: pr.number,
    pull_request: pr,
    repository,
    sender: makeUser({ login: "alice" }),
    ...overrides,
  };
}

export function makeIssue(overrides: Partial<GiteaIssue> = {}): GiteaIssue & { trackerRef: string } {
  const issue: GiteaIssue = {
    id: 200,
    number: 12,
    title: "Fix the thing",
    body: "Please implement this.",
    state: "open",
    html_url: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
    user: makeUser(),
    assignee: makeUser({ login: "jumi" }),
    assignees: [makeUser({ login: "jumi" })],
    updated_at: "2026-05-23T00:00:00Z",
    created_at: "2026-05-23T00:00:00Z",
    ...overrides,
  };
  return { ...issue, trackerRef: String(issue.number) };
}

export function makeIssueCommentPayload(overrides: Partial<GiteaIssueCommentPayload> = {}): GiteaIssueCommentPayload {
  const repository = overrides.repository ?? makeRepo();
  const issue =
    overrides.issue ??
    makeIssue({
      number: 127,
      title: "Fix the thing",
      body: "Fixes #12",
      html_url: "https://gitea.kirmanak.stream/kirmanak/demo/pulls/127",
      user: makeUser({ login: "jumi" }),
      pull_request: { merged_at: null },
    });
  return {
    action: "created",
    comment: makeComment({
      id: 55,
      body: "please fix the tests",
      user: makeUser({ login: "alice" }),
    }),
    issue,
    repository,
    sender: makeUser({ login: "alice" }),
    ...overrides,
  };
}

export function makeIssuePayload(overrides: Partial<GiteaIssuePayload> = {}): GiteaIssuePayload {
  const repository = overrides.repository ?? makeRepo();
  const issue = overrides.issue ?? makeIssue({ number: 12 });
  return {
    action: "assigned",
    number: issue.number,
    issue,
    repository,
    sender: makeUser({ login: "alice" }),
    ...overrides,
  };
}

export function makeLinkedIssue(overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  const owner = overrides.owner ?? "kirmanak";
  const repo = overrides.repo ?? "demo";
  const number = overrides.number ?? 196;
  return {
    owner,
    repo,
    number,
    title: "Blocker",
    state: "open",
    html_url: `https://gitea.kirmanak.stream/${owner}/${repo}/issues/${number}`,
    body: "",
    assignee: { login: "jumi" },
    assignees: [{ login: "jumi" }],
    updated_at: "2026-05-23T00:00:00Z",
    ...overrides,
  };
}

export function emptyCiMethods(): {
  listCommitStatuses: () => Promise<GiteaCommitStatus[]>;
  listCheckRuns: () => Promise<GiteaCommitStatus[]>;
  listActionJobs: () => Promise<GiteaActionJob[]>;
  getActionJobLogs: () => Promise<string>;
  listIssueDependencies: () => Promise<LinkedIssue[]>;
  listIssueBlocks: () => Promise<LinkedIssue[]>;
  listRepoIssues: () => Promise<LinkedIssue[]>;
  createIssueDependency: () => Promise<void>;
} {
  return {
    listCommitStatuses: async () => [],
    listCheckRuns: async () => [],
    listActionJobs: async () => [],
    getActionJobLogs: async () => "",
    listIssueDependencies: async () => [],
    listIssueBlocks: async () => [],
    listRepoIssues: async () => [],
    createIssueDependency: async () => undefined,
  };
}

export function makeWorkflowJobPayload(
  overrides: Partial<GiteaWorkflowJobPayload> & {
    workflow_job?: GiteaWorkflowJobPayload["workflow_job"];
  } = {}
): GiteaWorkflowJobPayload {
  const repository = overrides.repository ?? makeRepo();
  return {
    action: "completed",
    workflow_job: {
      id: 99,
      name: "build",
      status: "completed",
      conclusion: "failure",
      head_sha: "headsha",
      head_branch: "jumi/issue-12-fix-the-thing",
      html_url: "https://gitea.kirmanak.stream/kirmanak/demo/actions/runs/1/jobs/99",
      run_id: 1,
    },
    repository,
    sender: makeUser({ login: "alice" }),
    ...overrides,
  };
}

export function makePushPayload(overrides: Partial<GiteaPushPayload> = {}): GiteaPushPayload {
  const repository = overrides.repository ?? makeRepo();
  return {
    ref: `refs/heads/${repository.default_branch}`,
    before: "1111111111111111111111111111111111111111",
    after: "2222222222222222222222222222222222222222",
    repository,
    pusher: makeUser({ login: "alice" }),
    sender: makeUser({ login: "alice" }),
    commits: [],
    ...overrides,
  };
}

export function makeIssueJob(overrides: Partial<IssueJob> = {}): IssueJob {
  return {
    delivery: "delivery-1",
    owner: "kirmanak",
    repo: "demo",
    issueNumber: 12,
    action: "assigned",
    title: "Fix the thing",
    body: "Please implement this.",
    htmlUrl: "https://gitea.kirmanak.stream/kirmanak/demo/issues/12",
    issueUpdatedAt: "2026-05-23T00:00:00Z",
    defaultBranch: "main",
    cloneUrl: "https://gitea.kirmanak.stream/kirmanak/demo.git",
    receivedAt: "2026-05-23T00:00:00Z",
    ...overrides,
  };
}

export function makeJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    delivery: "delivery-1",
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    action: "opened",
    headSha: "headsha",
    receivedAt: "2026-05-23T00:00:00Z",
    prUpdatedAt: "2026-05-23T00:00:00Z",
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    forge: "gitea",
    giteaUrl: "https://gitea.kirmanak.stream",
    giteaToken: "bot-token",
    webhookSecret: "webhook-secret",
    allowedOrgs: ["kirmanak"],
    allowedRepos: [],
    botUsername: "jumi",
    followupIgnoreLogins: [],
    trustedSenderLogins: [],
    model: "openai/gpt-5.5",
    runners: { primary: { type: "opencode", model: "openai/gpt-5.5" } },
    chain: ["primary"],
    opencodeWellKnownUrl: "https://kirmanak.stream",
    opencodeWellKnownKey: "OPENCODE_WELLKNOWN_TOKEN",
    opencodeWellKnownToken: "unused",
    home: "/data",
    workdir: "/work",
    queueConcurrency: 1,
    maxFiles: 100,
    maxPatchBytes: 500_000,
    maxOutputBytes: 80_000,
    maxWebhookBytes: 1_048_576,
    opencodeTimeoutMs: 900_000,
    role: "router",
    databaseUrl: "postgres://jumi",
    leaseMs: 1_500_000,
    maxJobAttempts: 2,
    maxFollowupRounds: 3,
    maxIncompleteRetries: 2,
    ...overrides,
  };
}

export function makeWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    forge: "gitea",
    giteaUrl: "https://gitea.kirmanak.stream",
    giteaToken: "bot-token",
    webhookSecret: "webhook-secret",
    allowedOrgs: ["kirmanak"],
    allowedRepos: [],
    botUsername: "jumi",
    followupIgnoreLogins: [],
    trustedSenderLogins: [],
    model: "openai/gpt-5.5",
    runners: { primary: { type: "opencode", model: "openai/gpt-5.5" } },
    chain: ["primary"],
    opencodeWellKnownUrl: "https://kirmanak.stream",
    opencodeWellKnownKey: "OPENCODE_WELLKNOWN_TOKEN",
    opencodeWellKnownToken: "unused",
    home: "/data",
    workdir: "/work",
    queueConcurrency: 1,
    maxOutputBytes: 80_000,
    maxWebhookBytes: 1_048_576,
    opencodeTimeoutMs: 14_400_000,
    followupTimeoutMs: 3_600_000,
    conflictTimeoutMs: 3_600_000,
    maxFollowupRounds: 3,
    maxConflictRounds: 3,
    leaseMs: 14_400_000 + 10 * 60 * 1000,
    maxJobAttempts: 2,
    ...overrides,
  };
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export async function signBody(rawBody: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const body = rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.sign("HMAC", key, body);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}

export function stripGitConfigArgs(args: string[]): string[] {
  const result = [...args];
  while (result[0] === "-c") result.splice(0, 2);
  return result;
}

/** Worker webhook API whose permission lookup says every sender can push. */
export function pushApi<T extends object>(overrides?: T) {
  return {
    listOpenPulls: async () => [],
    getIssue: async () => makeIssue(),
    getCollaboratorPermission: async () => ({ permission: "write" }),
    ...overrides,
  };
}
