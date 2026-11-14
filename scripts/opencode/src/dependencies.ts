import { isAssignedToBot, isPullRequestIssue } from "./assignee.ts";
import { pullRequestWorkingOnIssue } from "./gitea_issues.ts";
import type { LinkedIssue, Pull } from "./ports.ts";

export const DEPENDENCY_GRAPH_CAP = 32;
export const DEPENDENCY_CYCLE_REASON = "stuck: dependency cycle";

export type BlockerCheck =
  | { status: "ready" }
  | { status: "blocked"; blockers: LinkedIssue[] }
  | { status: "stuck"; reason: string };

function issueKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

export function formatIssueRef(
  issue: { owner: string; repo: string; number: number },
  homeOwner: string,
  homeRepo: string
): string {
  if (issue.owner === homeOwner && issue.repo === homeRepo) return `#${issue.number}`;
  return `${issue.owner}/${issue.repo}#${issue.number}`;
}

export function blockedOnComment(
  blockers: readonly { owner: string; repo: string; number: number }[],
  homeOwner: string,
  homeRepo: string
): string {
  const refs = [...blockers]
    .sort((a, b) => {
      const ownerCmp = a.owner.localeCompare(b.owner);
      if (ownerCmp !== 0) return ownerCmp;
      const repoCmp = a.repo.localeCompare(b.repo);
      if (repoCmp !== 0) return repoCmp;
      return a.number - b.number;
    })
    .map((issue) => formatIssueRef(issue, homeOwner, homeRepo));
  return `blocked on ${refs.join(", ")}`;
}

type OpenPullsApi = {
  listOpenPulls(owner: string, repo: string): Promise<Pull[]>;
};

async function cachedOpenPulls(
  api: OpenPullsApi,
  cache: Map<string, Pull[]>,
  owner: string,
  repo: string
): Promise<Pull[]> {
  const key = `${owner}/${repo}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pulls = await api.listOpenPulls(owner, repo);
  cache.set(key, pulls);
  return pulls;
}

export async function isBlockerUnresolved(
  issue: LinkedIssue,
  api: OpenPullsApi,
  cache: Map<string, Pull[]> = new Map(),
  opts?: { branchPrefix?: string }
): Promise<boolean> {
  if (issue.state === "open") return true;
  const pulls = await cachedOpenPulls(api, cache, issue.owner, issue.repo);
  // A blocker stays unresolved until someone closes it: with
  // `closing_keyword: refs` the working PR uses `Refs #N`, which never
  // closes, so the branch number and the non-closing reference count here
  // alongside closing keywords.
  return pulls.some((pr) => pullRequestWorkingOnIssue(pr, issue.number, opts?.branchPrefix));
}

export async function checkIssueBlockers(
  api: {
    listIssueDependencies(owner: string, repo: string, index: number): Promise<LinkedIssue[]>;
    listOpenPulls(owner: string, repo: string): Promise<Pull[]>;
  },
  owner: string,
  repo: string,
  issueNumber: number,
  opts?: { branchPrefix?: string }
): Promise<BlockerCheck> {
  const seen = new Set<string>();
  const stack = new Set<string>();
  const unresolved = new Map<string, LinkedIssue>();
  const pullsCache = new Map<string, Pull[]>();

  const walk = async (curOwner: string, curRepo: string, number: number): Promise<"ok" | "cycle" | "cap"> => {
    const key = issueKey(curOwner, curRepo, number);
    if (stack.has(key)) return "cycle";
    if (seen.has(key)) return "ok";
    if (seen.size >= DEPENDENCY_GRAPH_CAP) return "cap";
    seen.add(key);
    stack.add(key);
    const deps = await api.listIssueDependencies(curOwner, curRepo, number);
    for (const dep of deps) {
      const child = await walk(dep.owner, dep.repo, dep.number);
      if (child !== "ok") {
        stack.delete(key);
        return child;
      }
      if (await isBlockerUnresolved(dep, api, pullsCache, { branchPrefix: opts?.branchPrefix })) {
        unresolved.set(issueKey(dep.owner, dep.repo, dep.number), dep);
      }
    }
    stack.delete(key);
    return "ok";
  };

  const result = await walk(owner, repo, issueNumber);
  if (result === "cycle" || result === "cap") return { status: "stuck", reason: DEPENDENCY_CYCLE_REASON };
  if (unresolved.size === 0) return { status: "ready" };
  return { status: "blocked", blockers: [...unresolved.values()] };
}

export const QUEUE_FILE = "JUMI_QUEUE.md";
export const BLOCKED_BY_FILE = "JUMI_BLOCKED.md";
export const BLOCKED_BY_REJECTED_STUCK = "stuck: blocked-by rejected";
export const QUEUE_CANDIDATE_CAP = 32;
export const QUEUE_CITATION_CAP = 16;

export type QueueCandidateKind = "issue" | "closer" | "cited" | "dependency";

export type QueueCandidate = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  kind: QueueCandidateKind;
  closes?: { owner: string; repo: string; number: number };
};

export type IssueRef = { owner: string; repo: string; number: number };

export type BlockedByParse = { present: false } | { present: true; parsed: IssueRef | undefined };

export type YieldDecision = { ok: true; blocker: IssueRef } | { ok: false; reason: "invalid" | "unknown" | "self" };

const CROSS_REF = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
const HASH_REF = /(?<![A-Za-z0-9_])#(\d+)\b/g;
const URL_REF = /https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/(?:issues|pulls)\/(\d+)\b/gi;
const BLOCKED_BY_MARKER = /<!--\s*jumi-blocked-by:\s*(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#)?(\d+)\s*-->/i;

function addRef(seen: Map<string, IssueRef>, owner: string, repo: string, number: number): void {
  if (!Number.isFinite(number) || number <= 0) return;
  const key = issueKey(owner, repo, number);
  if (seen.has(key)) return;
  seen.set(key, { owner, repo, number });
}

export function parseIssueCitations(body: string, homeOwner: string, homeRepo: string): IssueRef[] {
  const seen = new Map<string, IssueRef>();
  for (const match of body.matchAll(CROSS_REF)) {
    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo) continue;
    addRef(seen, owner, repo, Number(match[3]));
  }
  for (const match of body.matchAll(HASH_REF)) {
    addRef(seen, homeOwner, homeRepo, Number(match[1]));
  }
  for (const match of body.matchAll(URL_REF)) {
    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo) continue;
    addRef(seen, owner, repo, Number(match[3]));
  }
  return [...seen.values()].slice(0, QUEUE_CITATION_CAP);
}

export function parseBlockedByArtifact(
  text: string | null | undefined,
  homeOwner: string,
  homeRepo: string
): BlockedByParse {
  if (text == null) return { present: false };
  const match = text.match(BLOCKED_BY_MARKER);
  if (!match) return { present: true, parsed: undefined };
  const number = Number(match[2]);
  if (!Number.isFinite(number) || number <= 0) return { present: true, parsed: undefined };
  const cross = match[1];
  if (cross) {
    const [owner, repo] = cross.split("/");
    if (!owner || !repo) return { present: true, parsed: undefined };
    return { present: true, parsed: { owner, repo, number } };
  }
  return { present: true, parsed: { owner: homeOwner, repo: homeRepo, number } };
}

export function validateYield(
  parsed: IssueRef | undefined,
  candidates: readonly QueueCandidate[],
  homeOwner: string,
  homeRepo: string,
  selfNumber: number
): YieldDecision {
  if (!parsed) return { ok: false, reason: "invalid" };
  if (parsed.owner === homeOwner && parsed.repo === homeRepo && parsed.number === selfNumber) {
    return { ok: false, reason: "self" };
  }
  const hit = candidates.find(
    (row) => row.owner === parsed.owner && row.repo === parsed.repo && row.number === parsed.number
  );
  if (!hit) return { ok: false, reason: "unknown" };
  const blocker = hit.closes ?? hit;
  return { ok: true, blocker: { owner: blocker.owner, repo: blocker.repo, number: blocker.number } };
}

function pushCandidate(out: QueueCandidate[], seen: Set<string>, row: QueueCandidate): void {
  if (out.length >= QUEUE_CANDIDATE_CAP) return;
  const key = issueKey(row.owner, row.repo, row.number);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(row);
}

export function formatQueueMarkdown(
  candidates: readonly QueueCandidate[],
  homeOwner: string,
  homeRepo: string
): string {
  const lines = ["# Queue", "", "In-flight work you may wait on. Yield at most one id from this list.", ""];
  for (const row of candidates) {
    const ref = formatIssueRef(row, homeOwner, homeRepo);
    if (row.kind === "closer" && row.closes) {
      lines.push(`- ${ref} open closer of ${formatIssueRef(row.closes, homeOwner, homeRepo)}`);
    } else {
      const title = row.title.trim() || "untitled";
      lines.push(`- ${ref} ${title}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function collectCandidateQueue(opts: {
  api: {
    listRepoIssues(
      owner: string,
      repo: string,
      query?: { state?: "open" | "closed" | "all"; type?: "issues" | "pulls"; assignedBy?: string }
    ): Promise<LinkedIssue[]>;
    listIssueDependencies(owner: string, repo: string, index: number): Promise<LinkedIssue[]>;
    getIssue(
      owner: string,
      repo: string,
      index: number
    ): Promise<{
      number: number;
      title: string;
      state: "open" | "closed";
      pull_request?: unknown;
      is_pull?: boolean;
    }>;
  };
  owner: string;
  repo: string;
  issueNumber: number;
  botUsername: string;
  body: string;
  pulls: readonly Pull[];
  /** Branch prefix for issue-branch matching. Defaults to `jumi`. */
  branchPrefix?: string;
}): Promise<QueueCandidate[]> {
  const out: QueueCandidate[] = [];
  const seen = new Set<string>();
  const assigned = await opts.api.listRepoIssues(opts.owner, opts.repo, {
    state: "open",
    type: "issues",
    assignedBy: opts.botUsername,
  });
  const assignedIssues: QueueCandidate[] = [];
  for (const issue of assigned) {
    if (issue.owner === opts.owner && issue.repo === opts.repo && issue.number === opts.issueNumber) continue;
    if (isPullRequestIssue(issue)) continue;
    if (issue.state !== "open") continue;
    if (!isAssignedToBot(issue, opts.botUsername)) continue;
    const row: QueueCandidate = {
      owner: issue.owner,
      repo: issue.repo,
      number: issue.number,
      title: issue.title,
      kind: "issue",
    };
    assignedIssues.push(row);
    pushCandidate(out, seen, row);
  }
  for (const issue of assignedIssues) {
    for (const pr of opts.pulls) {
      if (!pullRequestWorkingOnIssue(pr, issue.number, opts.branchPrefix)) continue;
      pushCandidate(out, seen, {
        owner: opts.owner,
        repo: opts.repo,
        number: pr.number,
        title: pr.title,
        kind: "closer",
        closes: { owner: issue.owner, repo: issue.repo, number: issue.number },
      });
    }
  }
  for (const cited of parseIssueCitations(opts.body, opts.owner, opts.repo)) {
    if (cited.owner === opts.owner && cited.repo === opts.repo && cited.number === opts.issueNumber) continue;
    if (seen.has(issueKey(cited.owner, cited.repo, cited.number))) continue;
    try {
      const issue = await opts.api.getIssue(cited.owner, cited.repo, cited.number);
      if (issue.state !== "open") continue;
      pushCandidate(out, seen, {
        owner: cited.owner,
        repo: cited.repo,
        number: issue.number,
        title: issue.title,
        kind: "cited",
      });
    } catch {
      // Closed, missing, or out of reach — not a candidate.
    }
  }
  try {
    const deps = await opts.api.listIssueDependencies(opts.owner, opts.repo, opts.issueNumber);
    for (const dep of deps) {
      if (dep.state !== "open") continue;
      if (dep.owner === opts.owner && dep.repo === opts.repo && dep.number === opts.issueNumber) continue;
      pushCandidate(out, seen, {
        owner: dep.owner,
        repo: dep.repo,
        number: dep.number,
        title: dep.title,
        kind: "dependency",
      });
    }
  } catch {
    // Existing edges are optional for the injected list.
  }
  return out;
}
