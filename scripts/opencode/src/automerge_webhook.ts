import { handleAutomergeLabelChange } from "./automerge.ts";
import { isJumiPrIdentity } from "./gitea_issues.ts";
import { DEFAULT_AUTOMERGE_LABEL, DEFAULT_NO_AUTOMERGE_LABEL, loadRepoSettings } from "./repo_settings.ts";
import { assertRepositoryPolicy, type WebhookPolicy } from "./webhook.ts";

export type AutomergeWebhookPolicy = WebhookPolicy & {
  botUsername: string;
  automergeRepos?: readonly string[];
  automergeEnabled?: boolean;
  trustedSenderLogins?: readonly string[];
  forgeKind?: string;
};

type AutomergeWebhookApi = Parameters<typeof handleAutomergeLabelChange>[0]["api"] & {
  getRepo(owner: string, repo: string): Promise<{ default_branch?: string }>;
};

function loginEquals(a: string | undefined, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

interface ParsedLabelEvent {
  owner: string;
  repo: string;
  number: number;
  action: string;
  labelName: string;
  senderLogin?: string;
  baseBranch?: string;
  htmlUrl?: string;
  cloneUrl?: string;
}

/**
 * Best-effort parse of a Gitea or GitHub label webhook (`labeled` /
 * `unlabeled`). Supports `issue` (with or without `pull_request`) and
 * `pull_request` payloads. Returns undefined when the body is not a label
 * event.
 */
export function parseAutomergeLabelEvent(rawBody: Uint8Array): ParsedLabelEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const action = typeof record["action"] === "string" ? (record["action"] as string) : "";
  if (action !== "labeled" && action !== "unlabeled") return undefined;
  const repository = record["repository"] as
    | { full_name?: string; default_branch?: string; html_url?: string; clone_url?: string }
    | undefined;
  const fullName = typeof repository?.full_name === "string" ? repository.full_name : "";
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return undefined;
  const label = record["label"] as { name?: string } | string | undefined;
  const labelName = typeof label === "string" ? label : (label?.name ?? "");
  if (!labelName.trim()) return undefined;
  const sender = record["sender"] as { login?: string } | undefined;
  const htmlUrl = typeof repository?.html_url === "string" ? repository.html_url : undefined;
  const cloneUrl = typeof repository?.clone_url === "string" ? repository.clone_url : undefined;
  // PR number: prefer pull_request.number, else issue.number when it is a PR.
  const pr = record["pull_request"] as { number?: number } | undefined;
  if (typeof pr?.number === "number") {
    return {
      owner,
      repo,
      number: pr.number,
      action,
      labelName,
      senderLogin: sender?.login,
      baseBranch: typeof repository?.default_branch === "string" ? repository.default_branch : undefined,
      ...(htmlUrl ? { htmlUrl } : {}),
      ...(cloneUrl ? { cloneUrl } : {}),
    };
  }
  const issue = record["issue"] as { number?: number; pull_request?: unknown; is_pull?: boolean } | undefined;
  if (typeof issue?.number === "number") {
    const isPr = issue.pull_request != null || issue.is_pull === true;
    if (!isPr) return undefined;
    return {
      owner,
      repo,
      number: issue.number,
      action,
      labelName,
      senderLogin: sender?.login,
      baseBranch: typeof repository?.default_branch === "string" ? repository.default_branch : undefined,
      ...(htmlUrl ? { htmlUrl } : {}),
      ...(cloneUrl ? { cloneUrl } : {}),
    };
  }
  return undefined;
}

/**
 * Handle a label webhook for per-PR auto-merge override labels. Returns a
 * short reason when handled (scheduled/cancelled/none/bot/skip), or undefined
 * when the event is not an automerge label on a Jumi PR (caller falls through
 * to existing pickup logic).
 *
 * Only PRs Jumi opened are handled; takeovers and handoffs are left alone.
 * The bot's own copy event is ignored.
 */
export async function tryHandleAutomergeLabelEvent(opts: {
  rawBody: Uint8Array;
  policy: AutomergeWebhookPolicy;
  api?: AutomergeWebhookApi;
  log?: (message: string) => void;
}): Promise<{ handled: true; reason: string } | { handled: false }> {
  const log = opts.log ?? (() => undefined);
  const parsed = parseAutomergeLabelEvent(opts.rawBody);
  if (!parsed) return { handled: false };
  const policy = opts.policy;
  try {
    assertRepositoryPolicy(
      {
        full_name: `${parsed.owner}/${parsed.repo}`,
        ...(parsed.htmlUrl ? { html_url: parsed.htmlUrl } : {}),
        ...(parsed.cloneUrl ? { clone_url: parsed.cloneUrl } : {}),
      } as never,
      policy
    );
  } catch {
    return { handled: false };
  }
  if (loginEquals(parsed.senderLogin, policy.botUsername)) {
    log(`automerge label event ignored (sender is bot) for ${parsed.owner}/${parsed.repo}#${parsed.number}`);
    return { handled: true, reason: "sender is bot" };
  }
  const api = opts.api;
  if (!api || typeof api.getPR !== "function" || typeof api.getRepo !== "function") return { handled: false };
  let pr: {
    user?: { login?: string } | null | undefined;
    head?: { ref?: string } | null | undefined;
    base?: { ref?: string } | null | undefined;
    merged?: boolean;
    state?: string;
    title?: string;
    body?: string;
  } & { number: number };
  try {
    pr = (await api.getPR(parsed.owner, parsed.repo, parsed.number)) as typeof pr;
  } catch {
    return { handled: false };
  }
  if (pr.merged || pr.state !== "open") return { handled: false };
  if (
    !isJumiPrIdentity(
      { user: pr.user ?? undefined, head: pr.head ?? undefined } as {
        user?: { login?: string };
        head?: { ref?: string };
      },
      policy.botUsername
    )
  ) {
    return { handled: false };
  }
  // Resolve base branch for the settings read: payload default branch wins,
  // else the PR base ref, else the repo default branch.
  let baseBranch = parsed.baseBranch?.trim() ? parsed.baseBranch : "";
  if (!baseBranch && pr.base && typeof pr.base.ref === "string" && pr.base.ref.trim()) {
    baseBranch = pr.base.ref.trim();
  }
  if (!baseBranch) {
    try {
      const info = await api.getRepo(parsed.owner, parsed.repo);
      baseBranch = typeof info.default_branch === "string" && info.default_branch ? info.default_branch : "main";
    } catch {
      return { handled: false };
    }
  }
  // Load label names to decide whether this event is even about auto-merge.
  // Invalid/unreadable files fall back to defaults for the match; the change
  // handler below posts the invalid note when it applies.
  let automergeLabel = DEFAULT_AUTOMERGE_LABEL;
  let noAutomergeLabel = DEFAULT_NO_AUTOMERGE_LABEL;
  try {
    const settings = await loadRepoSettings(api as never, parsed.owner, parsed.repo, baseBranch);
    if (settings.state === "valid") {
      automergeLabel = settings.automergeLabel;
      noAutomergeLabel = settings.noAutomergeLabel;
    } else if (settings.state === "invalid") {
      // Still handle: the change handler posts the invalid note.
    }
  } catch {
    // Fall back to defaults for the match.
  }
  const needle = parsed.labelName.trim().toLowerCase();
  if (needle !== automergeLabel.toLowerCase() && needle !== noAutomergeLabel.toLowerCase()) {
    return { handled: false };
  }
  const { extractWorkingIssueNumber } = await import("./gitea_issues.ts");
  const issueNumber = extractWorkingIssueNumber({
    title: (pr as { title?: string }).title ?? "",
    body: (pr as { body?: string }).body ?? "",
    head: pr.head as { ref?: string },
  });
  const result = await handleAutomergeLabelChange({
    api: api as never,
    forgeKind: (policy.forgeKind as "gitea" | "github") ?? "gitea",
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.number,
    baseBranch,
    automergeRepos: policy.automergeRepos,
    automergeEnabled: policy.automergeEnabled,
    trustedSenderLogins: policy.trustedSenderLogins,
    botUsername: policy.botUsername,
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    log,
  });
  return { handled: true, reason: `automerge label ${parsed.action}: ${result.action}` };
}
