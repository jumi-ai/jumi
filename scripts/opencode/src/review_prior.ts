import { CI_ABSENT_NOTE } from "./ci.ts";
import type { Comment, InlineComment, PullReview } from "./ports.ts";
import { findPreviousReview } from "./review_delta.ts";
import { type ReviewFactsInlineInput, type ReviewTrustCtx, resolveReviewFacts } from "./review_facts.ts";
import { sha256Hex as metaSha256Hex, stripReviewMeta } from "./review_meta.ts";
import type { KeyedPriorInfo } from "./review_verdict_store.ts";
import { loginEquals } from "./util/login.ts";
import { publishedFindingBlocks } from "./verdict.ts";
import type { GitRunner } from "./workspace.ts";

const REVIEW_MARKER_RE = /<!--\s*jumi-review:/;

function isResolvedByBot(inline: InlineComment, botUsername: string): boolean {
  const slug = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");
  const resolver = inline.resolver?.login;
  if (!resolver) return inline.resolved === true;
  return slug(resolver) === slug(botUsername);
}

function timeOf(at: string): number {
  const time = Date.parse(at);
  return Number.isNaN(time) ? 0 : time;
}

interface Candidate {
  sha: string;
  at: string;
  body: string;
  pull: boolean;
}

function pickLatest(opts: {
  comments: readonly Comment[];
  reviews: readonly PullReview[];
  botUsername: string;
  marker: string;
}): Candidate | undefined {
  const candidates: Candidate[] = [];
  for (const comment of opts.comments) {
    const body = comment.body ?? "";
    if (!body.includes(opts.marker)) continue;
    const user = (comment as { user?: { login?: string } }).user?.login ?? "";
    if (!loginEquals(user, opts.botUsername)) continue;
    const m = /Reviewed commit:\s*`([0-9a-fA-F]{7,40})`/.exec(body);
    const sha = m?.[1];
    if (!sha) continue;
    candidates.push({
      sha,
      at:
        (comment as { updated_at?: string; created_at?: string }).updated_at ??
        (comment as { created_at?: string }).created_at ??
        "",
      body,
      pull: false,
    });
  }
  for (const review of opts.reviews) {
    const body = (review as { body?: string; content?: string }).body ?? (review as { content?: string }).content ?? "";
    if ((review as { dismissed?: boolean }).dismissed || !body.includes(opts.marker)) continue;
    const user = (review as { user?: { login?: string } }).user?.login ?? "";
    if (!loginEquals(user, opts.botUsername)) continue;
    const m = /Reviewed commit:\s*`([0-9a-fA-F]{7,40})`/.exec(body);
    const sha = m?.[1] ?? (review as { commit_id?: string }).commit_id;
    if (!sha) continue;
    candidates.push({
      sha,
      at:
        (review as { submitted_at?: string; updated_at?: string; created_at?: string }).submitted_at ??
        (review as { updated_at?: string }).updated_at ??
        (review as { created_at?: string }).created_at ??
        "",
      body,
      pull: true,
    });
  }
  return candidates.sort((a, b) => timeOf(a.at) - timeOf(b.at)).at(-1);
}

function headMatches(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 7 && y.length >= 7) return x.startsWith(y) || y.startsWith(x);
  return false;
}

function stripFooterOnce(liveBody: string, marker: string): string {
  const suffix = `\n\n${marker}`;
  if (liveBody.endsWith(suffix)) return liveBody.slice(0, -suffix.length);
  const trimmed = liveBody.trimEnd();
  if (trimmed.endsWith(marker)) {
    const without = trimmed.slice(0, -marker.length).trimEnd();
    return without;
  }
  return liveBody;
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface KeyedPriorsResult {
  keyed: KeyedPriorInfo[];
  unkeyed: string[];
  verified: boolean;
  previousSha?: string;
}

/**
 * Build eligible keyed priors for a re-review from the verified signed block.
 * Same-head verifies directly; a descendant proves ancestry via merge-base.
 * Unrelated heads, unknown ancestry, or unverified blocks fall back to
 * today's free-text strings with no keys.
 */
export async function buildKeyedPriors(opts: {
  comments: readonly Comment[];
  reviews: readonly PullReview[];
  inlines: readonly InlineComment[];
  botUsername: string;
  marker: string;
  trust: Omit<ReviewTrustCtx, "headSha" | "ancestorOk">;
  currentHeadSha: string;
  prFilenames: ReadonlySet<string>;
  excludedFilenames: ReadonlySet<string>;
  git: GitRunner;
  cwd: string;
  env: Record<string, string | undefined>;
  log?: (message: string) => void;
  singleFilePath?: string;
}): Promise<KeyedPriorsResult> {
  const latest = pickLatest({
    comments: opts.comments,
    reviews: opts.reviews,
    botUsername: opts.botUsername,
    marker: opts.marker,
  });
  if (!latest) return { keyed: [], unkeyed: [], verified: false };
  const inlineSubset: InlineComment[] = [];
  if (latest.pull) {
    for (const inline of opts.inlines) {
      if (!loginEquals(inline.user?.login, opts.botUsername)) continue;
      if (isResolvedByBot(inline, opts.botUsername)) continue;
      inlineSubset.push(inline);
    }
  }
  const baseTrust: ReviewTrustCtx = {
    ...opts.trust,
    headSha: opts.currentHeadSha,
    ...(opts.log ? { log: opts.log } : {}),
  };
  let resolved = resolveReviewFacts({
    body: latest.body,
    inlines: inlineSubset as unknown as ReviewFactsInlineInput[],
    carryMarker: opts.marker,
    ...(opts.singleFilePath ? { singleFilePath: opts.singleFilePath } : {}),
    trust: baseTrust,
  });
  if (resolved.source === "text" && resolved.reason === "head-rule" && resolved.payload) {
    const signedHead = resolved.payload.head;
    if (headMatches(signedHead, opts.currentHeadSha)) {
      resolved = resolveReviewFacts({
        body: latest.body,
        inlines: inlineSubset as unknown as ReviewFactsInlineInput[],
        carryMarker: opts.marker,
        ...(opts.singleFilePath ? { singleFilePath: opts.singleFilePath } : {}),
        trust: { ...baseTrust, ancestorOk: true },
      });
    } else {
      let isAncestor = false;
      try {
        await opts.git(["merge-base", "--is-ancestor", signedHead, "HEAD"], { cwd: opts.cwd, env: opts.env });
        isAncestor = true;
      } catch {
        isAncestor = false;
      }
      if (!isAncestor) {
        const fallback = findPreviousReview({
          comments: opts.comments,
          reviews: opts.reviews,
          inlines: opts.inlines,
          botUsername: opts.botUsername,
          marker: opts.marker,
        });
        return { keyed: [], unkeyed: fallback?.findings ?? [], verified: false, previousSha: latest.sha };
      }
      resolved = resolveReviewFacts({
        body: latest.body,
        inlines: inlineSubset as unknown as ReviewFactsInlineInput[],
        carryMarker: opts.marker,
        ...(opts.singleFilePath ? { singleFilePath: opts.singleFilePath } : {}),
        trust: { ...baseTrust, ancestorOk: true },
      });
    }
  }
  if (resolved.source !== "typed" || !resolved.payload) {
    const fallback = findPreviousReview({
      comments: opts.comments,
      reviews: opts.reviews,
      inlines: opts.inlines,
      botUsername: opts.botUsername,
      marker: opts.marker,
    });
    return { keyed: [], unkeyed: fallback?.findings ?? [], verified: false, previousSha: latest.sha };
  }
  const payload = resolved.payload;
  const stripped = stripReviewMeta(latest.body);
  const blocks = publishedFindingBlocks(stripped, {
    ...(opts.singleFilePath ? { singleFilePath: opts.singleFilePath } : {}),
    keep: [CI_ABSENT_NOTE],
  });
  const withOrder = payload.findings.map((entry, index) => ({ entry, index }));
  const bodyEntries = withOrder
    .filter(({ entry }) => entry.p === "body")
    .sort(
      (a, b) => (a.entry.o ?? Number.MAX_SAFE_INTEGER) - (b.entry.o ?? Number.MAX_SAFE_INTEGER) || a.index - b.index
    )
    .map(({ entry }) => entry);
  if (bodyEntries.length !== blocks.length) {
    const fallback = findPreviousReview({
      comments: opts.comments,
      reviews: opts.reviews,
      inlines: opts.inlines,
      botUsername: opts.botUsername,
      marker: opts.marker,
    });
    return { keyed: [], unkeyed: fallback?.findings ?? [], verified: false, previousSha: latest.sha };
  }
  type RawPrior = Omit<KeyedPriorInfo, "unchanged" | "autoWithdrawn"> & { carryLine: string };
  const raw: RawPrior[] = [];
  for (let i = 0; i < bodyEntries.length; i++) {
    const entry = bodyEntries[i]!;
    if (!entry.k) continue;
    const block = blocks[i]!;
    const text = block.body;
    if (!text.trim()) continue;
    if (!REVIEW_MARKER_RE.test(block.first) && /<!--\s*jumi-/i.test(text)) {
      continue;
    }
    const severity = entry.s as KeyedPriorInfo["severity"];
    const maintainerDecision =
      entry.s === "question"
        ? entry.t === "maintainer"
          ? ("typed_true" as const)
          : ("typed_false" as const)
        : ("none" as const);
    const carryLine =
      block.path !== undefined && block.line !== undefined ? `${block.path}:${block.line}: ${text}` : text;
    raw.push({
      key: entry.k,
      text,
      severity,
      ...(maintainerDecision !== "none" || entry.s === "question" ? { maintainerDecision } : {}),
      ...(entry.path !== undefined ? { path: entry.path } : {}),
      ...(entry.line !== undefined ? { line: entry.line } : {}),
      placement: "body",
      carryLine,
    });
  }
  const inlineEntries = payload.findings.filter((entry) => entry.p === "inline");
  for (const entry of inlineEntries) {
    if (!entry.k || entry.cid === undefined || entry.cs === undefined) continue;
    const live = inlineSubset.find((item) => item.id === entry.cid);
    if (!live) continue;
    const liveBody = (live.body ?? "") as string;
    if (!liveBody.includes(opts.marker)) continue;
    if (!loginEquals(live.user?.login, opts.botUsername)) continue;
    if (metaSha256Hex(liveBody) !== entry.cs) continue;
    if (entry.path !== undefined && (live.path ?? "").trim() !== entry.path.trim()) continue;
    const text = stripFooterOnce(liveBody, opts.marker);
    if (!text.trim()) continue;
    if (/<!--\s*jumi-/i.test(text)) continue;
    const severity = entry.s as KeyedPriorInfo["severity"];
    const maintainerDecision =
      entry.s === "question"
        ? entry.t === "maintainer"
          ? ("typed_true" as const)
          : ("typed_false" as const)
        : ("none" as const);
    const collapsed = collapseWs(text);
    const locPath = (entry.path ?? live.path ?? "").trim();
    const locLine = typeof entry.line === "number" && entry.line > 0 ? entry.line : (live.new_position ?? 0);
    const carryLine = locPath && locLine > 0 ? `${locPath}:${locLine}: ${collapsed}` : collapsed;
    raw.push({
      key: entry.k,
      text,
      severity,
      ...(maintainerDecision !== "none" || entry.s === "question" ? { maintainerDecision } : {}),
      ...(entry.path !== undefined ? { path: entry.path } : {}),
      ...(entry.line !== undefined ? { line: entry.line } : {}),
      placement: "inline",
      carryLine,
    });
  }
  const byText = new Map<string, RawPrior[]>();
  for (const item of raw) {
    const list = byText.get(item.text) ?? [];
    list.push(item);
    byText.set(item.text, list);
  }
  const ambiguousTexts = new Set<string>();
  for (const [text, list] of byText) {
    if (list.length > 1) ambiguousTexts.add(text);
  }
  const fallback = findPreviousReview({
    comments: opts.comments,
    reviews: opts.reviews,
    inlines: opts.inlines,
    botUsername: opts.botUsername,
    marker: opts.marker,
  });
  const fallbackLines = fallback?.findings ?? [];
  const keyedCarry = new Set<string>();
  const keyedCollapsedCarry = new Set<string>();
  for (const item of raw) {
    if (ambiguousTexts.has(item.text)) continue;
    keyedCarry.add(item.carryLine);
    keyedCollapsedCarry.add(collapseWs(item.carryLine));
  }
  const unkeyed: string[] = [];
  for (const line of fallbackLines) {
    if (keyedCarry.has(line)) continue;
    if (keyedCollapsedCarry.has(collapseWs(line))) continue;
    unkeyed.push(line);
  }
  for (const text of ambiguousTexts) {
    const first = byText.get(text)?.[0];
    if (!first) continue;
    const asLine = first.path && first.line ? `${first.path}:${first.line}: ${first.text}` : first.text;
    if (!unkeyed.includes(asLine) && !keyedCarry.has(asLine)) unkeyed.push(asLine);
  }
  const eligible = raw.filter((item) => !ambiguousTexts.has(item.text));
  const keyed: KeyedPriorInfo[] = [];
  const sameHead = headMatches(payload.head, opts.currentHeadSha);
  for (const item of eligible) {
    let autoWithdrawn = false;
    let unchanged: boolean | undefined;
    if (item.path !== undefined) {
      const p = item.path.trim();
      if (opts.excludedFilenames.has(p)) {
        autoWithdrawn = true;
      } else if (!opts.prFilenames.has(p)) {
        autoWithdrawn = true;
      } else {
        let exists = true;
        try {
          await opts.git(["cat-file", "-e", `HEAD:${p}`], { cwd: opts.cwd, env: opts.env });
        } catch {
          exists = false;
        }
        if (!exists) {
          autoWithdrawn = true;
        } else if (sameHead) {
          unchanged = true;
        } else {
          try {
            const out = await opts.git(["diff", "--numstat", payload.head, "HEAD", "--", p], {
              cwd: opts.cwd,
              env: opts.env,
            });
            unchanged = out.trim() === "";
          } catch {
            return { keyed: [], unkeyed: fallbackLines, verified: false, previousSha: latest.sha };
          }
        }
      }
    }
    keyed.push({
      key: item.key,
      text: item.text,
      severity: item.severity,
      ...(item.maintainerDecision !== undefined ? { maintainerDecision: item.maintainerDecision } : {}),
      ...(item.path !== undefined ? { path: item.path } : {}),
      ...(item.line !== undefined ? { line: item.line } : {}),
      placement: item.placement,
      ...(unchanged !== undefined ? { unchanged } : {}),
      ...(autoWithdrawn ? { autoWithdrawn: true } : {}),
    });
  }
  return { keyed, unkeyed, verified: true, previousSha: latest.sha };
}
