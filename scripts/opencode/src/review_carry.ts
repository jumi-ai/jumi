import { lastCheckTrailer, parseReviewedCommitSha } from "./followup.ts";
import type { Comment, InlineComment, PullReview } from "./ports.ts";
import { reviewFindingLines } from "./verdict.ts";
import type { GitRunner } from "./workspace.ts";

const REVIEW_CARRY_MARKER = "Carried forward from";

const CARRY_FROM_RE = /Carried forward from\s+`([0-9a-fA-F]{7,40})`/i;

/** Parse the source SHA a carried review names, if any. */
function parseCarrySourceSha(body: string): string | undefined {
  const match = CARRY_FROM_RE.exec(body ?? "");
  return match?.[1];
}

interface PreviousReviewWithVerdict {
  sha: string;
  findings: string[];
  state: "success" | "failure";
  body: string;
  carriedFrom?: string;
}

/**
 * Newest Jumi review with its trailer verdict, sharing `findPreviousReview`
 * selection (newest by instant, sticky or pull review). Unlike
 * `findPreviousReview`, a failed review with no findings still returns (the
 * carry gate needs its `failure` state to refuse); callers that want the old
 * "no previous" behaviour keep using `findPreviousReview`.
 */
function findPreviousReviewWithVerdict(opts: {
  comments: readonly Comment[];
  reviews: readonly PullReview[];
  inlines: readonly InlineComment[];
  botUsername: string;
  marker: string;
}): PreviousReviewWithVerdict | undefined {
  type Candidate = { sha: string; at: string; body: string; pull: boolean };
  const candidates: Candidate[] = [];
  const isSticky = (comment: { body?: string | null; user?: { login?: string } }) => {
    const body = comment.body ?? "";
    if (!body.trim()) return false;
    if (!body.includes(opts.marker)) return false;
    if (!lastCheckTrailer(body)) return false;
    if (typeof opts.botUsername === "string" && opts.botUsername) {
      const login = comment.user?.login ?? "";
      if (login.toLowerCase() !== opts.botUsername.toLowerCase()) return false;
    }
    return Boolean(parseReviewedCommitSha(body));
  };
  const isWriteup = (review: PullReview) => {
    const login = review.user?.login ?? "";
    if (login.toLowerCase() !== opts.botUsername.toLowerCase()) return false;
    const body = review.body ?? review.content ?? "";
    if (!body.trim()) return false;
    return lastCheckTrailer(body) !== undefined;
  };
  for (const comment of opts.comments) {
    const body = comment.body ?? "";
    if (!body.includes(opts.marker) || !isSticky(comment)) continue;
    const sha = parseReviewedCommitSha(body);
    if (sha) candidates.push({ sha, at: comment.updated_at || comment.created_at || "", body, pull: false });
  }
  for (const review of opts.reviews) {
    const body = review.body ?? review.content ?? "";
    if (review.dismissed || !body.includes(opts.marker)) continue;
    if (!isWriteup(review)) continue;
    const sha = parseReviewedCommitSha(body) ?? review.commit_id;
    if (!sha) continue;
    candidates.push({ sha, at: review.submitted_at ?? review.updated_at ?? review.created_at ?? "", body, pull: true });
  }
  const latest = candidates.sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || "")).at(-1);
  if (!latest) return undefined;
  const trailer = lastCheckTrailer(latest.body);
  if (!trailer) return undefined;
  const findings = reviewFindingLines(latest.body);
  if (latest.pull) {
    const slug = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");
    const botSlug = slug(opts.botUsername);
    for (const inline of opts.inlines) {
      const login = inline.user?.login ?? "";
      if (slug(login) !== botSlug) continue;
      const resolver = inline.resolver?.login;
      const resolvedByBot = resolver ? slug(resolver) === botSlug : inline.resolved === true;
      if (resolvedByBot) continue;
      const body = inline.body ?? "";
      if (!inline.path || !body.includes(opts.marker)) continue;
      const text = body.split(opts.marker).join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      findings.push(inline.new_position ? `${inline.path}:${inline.new_position}: ${text}` : `${inline.path}: ${text}`);
    }
  }
  const deduped = [...new Set(findings)];
  const carriedFrom = parseCarrySourceSha(latest.body);
  return {
    sha: latest.sha,
    findings: deduped,
    state: trailer.state,
    body: latest.body,
    ...(carriedFrom ? { carriedFrom } : {}),
  };
}

/** True when any finding still opens a 🔴, 🟡 or ❓. 💡 suggestions may stay open. */
function hasOpenBlockers(findings: readonly string[]): boolean {
  return findings.some((line) => /🔴|🟡|❓/.test(line));
}

/** Case-insensitive SHA match allowing abbreviated prefixes either way. */
function shaMatches(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  return x.startsWith(y) || y.startsWith(x);
}

/** Full carry line(s) from the original markdown, so the source SHA survives publish filtering. */
function extractCarryNote(text: string): string | undefined {
  const lines = (text ?? "").split(/\r?\n/).filter((line) => line.includes(REVIEW_CARRY_MARKER));
  if (lines.length === 0) return undefined;
  return lines.map((line) => line.trim()).join("\n");
}

/**
 * Re-attach the full carry line(s) to the finding-only published comment, so
 * the sticky and status name the source like the excluded-file disclosure.
 */
export function attachCarryNote(baseComment: string, parsedComment: string): string {
  const carryNote = extractCarryNote(parsedComment);
  if (!carryNote || baseComment.includes(carryNote)) return baseComment;
  return baseComment ? `${carryNote}\n\n${baseComment}` : carryNote;
}

interface CarryEligibility {
  eligible: boolean;
  reason?: string;
  parent1?: string;
  parent2?: string;
}

/**
 * Check the git half of the carry gate: the head is a two-parent merge whose
 * first parent is the reviewed head, its tree equals the automatic merge of
 * the two parents, and the merge brings in no file the pull itself changes.
 */
async function checkCleanMerge(opts: {
  previousSha: string;
  pullFilenames: readonly string[];
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  log?: (message: string) => void;
}): Promise<CarryEligibility> {
  const run = (args: string[]) => opts.git(args, { cwd: opts.cwd, env: opts.env });
  let parentsLine: string;
  try {
    parentsLine = await run(["rev-list", "--parents", "-n", "1", "HEAD"]);
  } catch (err) {
    opts.log?.(`carry parents unavailable: ${String(err)}`);
    return { eligible: false, reason: "parents unavailable" };
  }
  const parts = parentsLine.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3) {
    return { eligible: false, reason: "not a two-parent merge" };
  }
  const [, p1, p2] = parts as [string, string, string];
  if (!shaMatches(p1, opts.previousSha)) {
    return { eligible: false, reason: "first parent not the reviewed head", parent1: p1, parent2: p2 };
  }
  let headTree = "";
  let autoOut = "";
  try {
    headTree = (await run(["rev-parse", "HEAD^{tree}"])).trim().toLowerCase();
    autoOut = await run(["merge-tree", "--write-tree", p1, p2]);
  } catch (err) {
    opts.log?.(`carry tree check unavailable: ${String(err)}`);
    return { eligible: false, reason: "tree check unavailable", parent1: p1, parent2: p2 };
  }
  const autoLines = autoOut
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const autoTree = autoLines[0]?.toLowerCase() ?? "";
  const singleTree = autoLines.length === 1 && /^[0-9a-f]{40}$/i.test(autoLines[0] ?? "");
  if (!singleTree || autoTree !== headTree) {
    return { eligible: false, reason: "hand-edited merge tree", parent1: p1, parent2: p2 };
  }
  let mergeNames = "";
  try {
    mergeNames = await run(["diff", "--name-only", p1, "HEAD"]);
  } catch (err) {
    opts.log?.(`carry diff unavailable: ${String(err)}`);
    return { eligible: false, reason: "diff unavailable", parent1: p1, parent2: p2 };
  }
  const mergeSet = new Set(
    mergeNames
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const overlap = opts.pullFilenames.filter((name) => mergeSet.has(name.trim()));
  if (overlap.length > 0) {
    return { eligible: false, reason: "overlap with PR files", parent1: p1, parent2: p2 };
  }
  return { eligible: true, parent1: p1, parent2: p2 };
}

/** Build the carried markdown: names the source SHA and the target branch. */
function buildCarriedMarkdown(opts: {
  marker: string;
  headSha: string;
  previousSha: string;
  targetBranch: string;
  findings: readonly string[];
}): string {
  const findingsBlock = opts.findings.length > 0 ? `\n\n${opts.findings.map((line) => `- ${line}`).join("\n")}` : "";
  return (
    `${opts.marker}\n### Jumi review\n\nReviewed commit: \`${opts.headSha}\`\n\n` +
    `${REVIEW_CARRY_MARKER} \`${opts.previousSha}\`: this head is a clean merge of \`${opts.targetBranch}\` ` +
    `into the reviewed head, so no new model review ran.${findingsBlock}\n\n<!-- jumi-check: success -->`
  );
}

type CarryEvaluation =
  | { kind: "carried"; markdown: string; previousSha: string; findings: string[] }
  | { kind: "refused"; reason: string }
  | { kind: "no-previous" };

/** Full carry evaluation without settings: find previous, check verdict, check git. */
async function evaluateCarry(opts: {
  comments: readonly Comment[];
  reviews: readonly PullReview[];
  inlines: readonly InlineComment[];
  botUsername: string;
  marker: string;
  headSha: string;
  targetBranch: string;
  pullFilenames: readonly string[];
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  log?: (message: string) => void;
}): Promise<CarryEvaluation> {
  const withVerdict = findPreviousReviewWithVerdict({
    comments: opts.comments,
    reviews: opts.reviews,
    inlines: opts.inlines,
    botUsername: opts.botUsername,
    marker: opts.marker,
  });
  if (!withVerdict) return { kind: "no-previous" };
  if (withVerdict.state !== "success") return { kind: "refused", reason: "previous review not success" };
  if (hasOpenBlockers(withVerdict.findings)) return { kind: "refused", reason: "previous review has open findings" };
  if (shaMatches(withVerdict.sha, opts.headSha)) return { kind: "refused", reason: "head already reviewed" };
  const clean = await checkCleanMerge({
    previousSha: withVerdict.sha,
    pullFilenames: opts.pullFilenames,
    git: opts.git,
    cwd: opts.cwd,
    env: opts.env,
    log: opts.log,
  });
  if (!clean.eligible) return { kind: "refused", reason: clean.reason ?? "not eligible" };
  return {
    kind: "carried",
    markdown: buildCarriedMarkdown({
      marker: opts.marker,
      headSha: opts.headSha,
      previousSha: withVerdict.sha,
      targetBranch: opts.targetBranch,
      findings: withVerdict.findings,
    }),
    previousSha: withVerdict.sha,
    findings: withVerdict.findings,
  };
}

/**
 * Settings-gated carry attempt without a model. Returns the published result
 * when the head qualifies, else undefined to run today's delta review. The
 * `publish` callback keeps `review.ts` as the only `publishReviewResult`
 * caller, so this file stays free of that import cycle.
 */
export async function tryCarryReview<T>(opts: {
  settingsEnabled: boolean;
  comments: readonly Comment[];
  reviews: readonly PullReview[];
  inlines: readonly InlineComment[];
  botUsername: string;
  marker: string;
  headSha: string;
  targetBranch: string;
  pullFilenames: readonly string[];
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  log?: (message: string) => void;
  reviewLabel: string;
  persist: (markdown: string) => Promise<void>;
  publish: (markdown: string, previousSha: string, findings: string[]) => Promise<T>;
}): Promise<T | undefined> {
  if (!opts.settingsEnabled) return undefined;
  const evaluated = await evaluateCarry(opts);
  if (evaluated.kind === "carried") {
    await opts.persist(evaluated.markdown);
    opts.log?.(`review_carry ${opts.reviewLabel}@${opts.headSha} from ${evaluated.previousSha}`);
    return await opts.publish(evaluated.markdown, evaluated.previousSha, evaluated.findings);
  }
  if (evaluated.kind === "refused") {
    opts.log?.(`carry refused for ${opts.reviewLabel}@${opts.headSha}: ${evaluated.reason}`);
  }
  return undefined;
}
