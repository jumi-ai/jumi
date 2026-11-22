import { disabledKickWhy, isFailingVerdictRow, kickReasonOf } from "./kick.ts";
import type { ReviewJobRecord, ReviewJobStore } from "./review_jobs.ts";
import { errorMessage } from "./util/error.ts";

/**
 * Scoped bulk requeue for failed review executions.
 *
 * A bounded batch of explicitly confirmed candidates from the operator
 * board's failed-review-execution group. Only same-head review jobs are
 * ever queued: no push, no reopen, no CI rerun, no latch clearing.
 *
 * Eligibility is a narrow allowlist of execution-failure classifications
 * (runner produced no review artifact). Published verdicts, CI/policy/auth
 * waits or failures, dependency rechecks, implement/follow-up/conflict
 * jobs, stuck-latch recovery and dismissal-only rows are never eligible.
 * Unknown reasons fail closed.
 */

export const BOARD_BULK_PATH = "/api/board/kick/bulk";

/** Bounded batch size: a bulk submit carries at most this many candidates. */
export const BOARD_BULK_MAX_ITEMS = 20;

/** Peer forge name. Mirrors board.ts PEER_FORGE without importing it. */
const BULK_PEER_FORGE = "github";

/** Peer bulk hop budget: a slow peer must not hang the homelab bulk kick. */
const BULK_PEER_TIMEOUT_MS = 15_000;

/** Peer bulk response cap: a compromised peer must not spike memory per batch. */
const BULK_PEER_MAX_BYTES = 1_048_576;

/** Catalog fragment so the board page invalidates when bulk rules change. */
export const BULK_CATALOG_SUFFIX = `bulk-v1:${BOARD_BULK_MAX_ITEMS}:${BULK_PEER_FORGE}`;

/**
 * Supported execution-failure classifications for bulk requeue. Exact
 * matches only: a new reason is ineligible until it is listed here.
 * These are the no-artifact outcomes where the runner produced no review
 * artifact for the head (failed or skipped), so the same head can be
 * retried without a push.
 */
const BULK_REQUEUEABLE_REASONS: ReadonlySet<string> = new Set([
  "Incomplete review: no output",
  "Incomplete review: no findings",
  "Incomplete review: no check verdict",
  "incomplete review: no artifact",
]);

function isBulkRequeueableReason(reason: string | null | undefined): boolean {
  if (typeof reason !== "string") return false;
  return BULK_REQUEUEABLE_REASONS.has(reason.trim());
}

interface BulkRow {
  kind: string;
  state: string;
  resultReason: string | null;
  error: string | null;
  resultMarkdown: string | null;
  resultJson?: ReviewJobRecord["resultJson"];
  headSha: string | null;
  failingVerdict?: boolean;
}

/** Typed eligibility from authoritative review job state. Fails closed. */
export function isBulkEligibleReviewRow(row: BulkRow): boolean {
  if (row.kind !== "review") return false;
  if (row.state !== "failed" && row.state !== "skipped") return false;
  if (row.failingVerdict === true) return false;
  const head = (row.headSha ?? "").trim();
  if (head === "") return false;
  const reason = kickReasonOf({
    state: row.state,
    resultReason: row.resultReason,
    error: row.error,
    resultMarkdown: row.resultMarkdown,
    resultJson: row.resultJson,
  }).trim();
  if (reason === "") return false;
  if (!isBulkRequeueableReason(reason)) return false;
  if (disabledKickWhy(reason) !== undefined) return false;
  return true;
}

/** One-call eligibility for a ledger row, including the published-verdict exclusion. */
export function bulkEligibleForRequeueItem(row: {
  kind: string;
  state: string;
  resultReason: string | null;
  error: string | null;
  resultMarkdown: string | null;
  resultJson?: ReviewJobRecord["resultJson"];
  headSha: string | null;
}): boolean {
  if (isFailingVerdictRow({ state: row.state, resultMarkdown: row.resultMarkdown, resultJson: row.resultJson })) {
    return false;
  }
  return isBulkEligibleReviewRow({ ...row });
}

/** True when a board item was marked bulk-eligible by the server. */
export function isBulkEligibleBoardItem(item: {
  kind?: string;
  commit?: string;
  headSha?: string;
  failingVerdict?: boolean;
  bulkEligible?: boolean;
  kick?: { kick?: string };
}): boolean {
  if (item.bulkEligible !== true) return false;
  if (item.kind !== "review") return false;
  if (item.failingVerdict === true) return false;
  const head = (item.commit ?? item.headSha ?? "").trim();
  if (head === "") return false;
  const kick = (item.kick?.kick ?? "").trim();
  if (!isBulkRequeueableReason(kick)) return false;
  return true;
}

interface BulkCandidate {
  owner: string;
  repo: string;
  number: number;
  commit: string;
  kick: string;
}

interface ParsedBulkBody {
  candidates: BulkCandidate[];
  idempotencyKey: string;
  forge: string;
}

function strField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

function parseOneCandidate(value: unknown): BulkCandidate | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "expected a candidate object" };
  const rec = value as Record<string, unknown>;
  const owner = strField(rec.owner).trim();
  const repo = strField(rec.repo).trim();
  const number = numField(rec.number) ?? numField(rec.prNumber) ?? numField(rec.pr_number) ?? numField(rec.issueNumber);
  const commit = (strField(rec.commit) || strField(rec.headSha) || strField(rec.head_sha) || strField(rec.sha)).trim();
  const kick = (
    strField(rec.kick) ||
    strField(rec.kickId) ||
    strField(rec.kick_id) ||
    strField(rec.id) ||
    strField(rec.reason)
  ).trim();
  if (!owner) return { error: "missing owner" };
  if (!repo) return { error: "missing repo" };
  if (number === undefined) return { error: "missing number" };
  if (!commit) return { error: "missing commit" };
  if (!kick) return { error: "missing kick" };
  const forgeField = strField(rec.forge).trim();
  if (forgeField !== "") return { error: `per-item forge not allowed (${forgeField})` };
  return { owner, repo, number, commit, kick };
}

/** Parse a bulk body. The actor never comes from the body. */
function parseBulkBody(body: unknown, headerIdempotencyKey: string): ParsedBulkBody | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "expected a JSON object" };
  const rec = body as Record<string, unknown>;
  const rawItems = rec.items ?? rec.candidates ?? rec.rows;
  if (!Array.isArray(rawItems)) return { error: "missing items" };
  if (rawItems.length === 0) return { error: "missing items" };
  if (rawItems.length > BOARD_BULK_MAX_ITEMS) {
    return { error: `too many items (max ${BOARD_BULK_MAX_ITEMS})` };
  }
  const candidates: BulkCandidate[] = [];
  for (const entry of rawItems) {
    const parsed = parseOneCandidate(entry);
    if ("error" in parsed) return { error: parsed.error };
    candidates.push(parsed);
  }
  const forge = strField(rec.forge).trim();
  const idempotencyKey = (
    headerIdempotencyKey ||
    strField(rec.idempotencyKey) ||
    strField(rec.idempotency_key) ||
    strField(rec["idempotency-key"])
  ).trim();
  if (idempotencyKey === "") return { error: "missing idempotencyKey" };
  return { candidates, idempotencyKey, forge };
}

export interface BulkForge {
  getPR(
    owner: string,
    repo: string,
    index: number
  ): Promise<{ state: string; merged: boolean; head?: { sha: string } }>;
}

type BulkResultStatus = "queued" | "skipped" | "failed";

interface BulkItemResult {
  owner: string;
  repo: string;
  number: number;
  commit: string;
  status: BulkResultStatus;
  code: string;
  reason: string;
  jobId?: number;
  deduped?: boolean;
}

function isNotFoundForgeError(err: unknown): boolean {
  return err instanceof Error && /→ 404\b/.test(err.message);
}

function bulkSubKey(batchKey: string, candidate: BulkCandidate): string {
  return `bulk:${batchKey}:${candidate.owner}/${candidate.repo}#${candidate.number}@${candidate.commit}::${candidate.kick}`;
}

function shortReason(text: string, max = 220): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Validate one candidate against live forge state and the latest ledger
 * attempt, then enqueue the same-head review when both agree. Never
 * enqueues when the forge cannot be checked. Sequential: concurrency is
 * bounded to one candidate at a time by the caller.
 */
async function runBulkCandidate(
  store: ReviewJobStore,
  forgeApi: BulkForge | undefined,
  candidate: BulkCandidate,
  opts: { actor: string; batchKey: string; delivery: string }
): Promise<BulkItemResult> {
  const base = { owner: candidate.owner, repo: candidate.repo, number: candidate.number, commit: candidate.commit };
  const subKey = bulkSubKey(opts.batchKey, candidate);
  // Idempotent replay comes first: a duplicate batch submit returns the
  // first result without re-validating live state and without a new job.
  try {
    const prior = await store.getKickByIdempotencyKey(subKey);
    if (
      prior &&
      prior.owner === candidate.owner &&
      prior.repo === candidate.repo &&
      prior.number === candidate.number &&
      prior.commit === candidate.commit &&
      prior.kick === candidate.kick
    ) {
      if (prior.result === "ok" && prior.newJobId != null) {
        return { ...base, status: "queued", code: "ok", reason: "Queued.", jobId: prior.newJobId, deduped: true };
      }
      if (prior.result === "ok") {
        return { ...base, status: "queued", code: "ok", reason: "Queued.", deduped: true };
      }
      if (
        prior.result === "conflict" ||
        prior.result === "stale-kick" ||
        prior.result === "not-found" ||
        prior.result === "not-kickable"
      ) {
        const code = prior.result === "not-kickable" ? "not-eligible" : prior.result;
        return { ...base, status: "skipped", code, reason: `already decided: ${prior.result}`, deduped: true };
      }
      return {
        ...base,
        status: "failed",
        code: prior.result,
        reason: `already decided: ${prior.result}`,
        deduped: true,
      };
    }
  } catch {
    // A ledger read failure here is not a replay: fall through to the
    // normal path, which will surface the outage per candidate.
  }
  if (!forgeApi) {
    return { ...base, status: "failed", code: "forge-unavailable", reason: "Forge unavailable; nothing enqueued." };
  }
  let pr: { state: string; merged: boolean; head?: { sha: string } };
  try {
    pr = await forgeApi.getPR(candidate.owner, candidate.repo, candidate.number);
  } catch (err) {
    if (isNotFoundForgeError(err)) {
      return { ...base, status: "skipped", code: "not-found", reason: "Pull request not found." };
    }
    return {
      ...base,
      status: "failed",
      code: "forge-unavailable",
      reason: `Forge unavailable (${shortReason(errorMessage(err))}); nothing enqueued.`,
    };
  }
  if (pr.merged || pr.state !== "open") {
    return { ...base, status: "skipped", code: "closed", reason: "Pull request is closed or merged." };
  }
  const liveHead = (pr.head?.sha ?? "").trim();
  if (liveHead === "") {
    return { ...base, status: "failed", code: "forge-unavailable", reason: "Forge head unknown; nothing enqueued." };
  }
  if (liveHead !== candidate.commit) {
    return { ...base, status: "skipped", code: "superseded", reason: "Head moved; candidate is superseded." };
  }
  let rows: ReviewJobRecord[];
  try {
    rows = await store.listRowsForNumber(candidate.owner, candidate.repo, candidate.number, 50);
  } catch (err) {
    return {
      ...base,
      status: "failed",
      code: "queue-unavailable",
      reason: `Queue unavailable (${shortReason(errorMessage(err))}).`,
    };
  }
  const reviews = rows.filter((row) => row.kind === "review").sort((a, b) => a.id - b.id);
  if (reviews.length === 0) {
    return { ...base, status: "skipped", code: "not-found", reason: "No review row for this pull." };
  }
  const latest = reviews[reviews.length - 1]!;
  if (latest.state === "queued" || latest.state === "leased") {
    return { ...base, status: "skipped", code: "conflict", reason: "Already queued or running." };
  }
  if ((latest.headSha ?? "").trim() !== candidate.commit) {
    return { ...base, status: "skipped", code: "superseded", reason: "A newer review attempt exists." };
  }
  if (latest.state === "succeeded") {
    return { ...base, status: "skipped", code: "not-eligible", reason: "Newly reviewed; not an execution failure." };
  }
  if (latest.state === "cancelled") {
    return { ...base, status: "skipped", code: "not-eligible", reason: "Terminal result is not retryable in bulk." };
  }
  const currentReason = kickReasonOf({
    state: latest.state,
    resultReason: latest.resultReason,
    error: latest.error,
    resultMarkdown: latest.resultMarkdown,
    resultJson: latest.resultJson,
  }).trim();
  if (candidate.kick.trim() !== currentReason) {
    return { ...base, status: "skipped", code: "stale", reason: "Preview is stale; refresh and confirm again." };
  }
  if (
    !isBulkEligibleReviewRow({
      kind: latest.kind,
      state: latest.state,
      resultReason: latest.resultReason,
      error: latest.error,
      resultMarkdown: latest.resultMarkdown,
      resultJson: latest.resultJson,
      headSha: latest.headSha,
      failingVerdict: (latest as { failingVerdict?: boolean }).failingVerdict,
    })
  ) {
    return { ...base, status: "skipped", code: "not-eligible", reason: "Not a bulk-retryable execution failure." };
  }
  try {
    const outcome = await store.requeueKick({
      owner: candidate.owner,
      repo: candidate.repo,
      prNumber: candidate.number,
      headSha: candidate.commit,
      kick: candidate.kick,
      actor: opts.actor,
      idempotencyKey: subKey,
      delivery: opts.delivery,
    });
    if (outcome.status === "ok") {
      return {
        ...base,
        status: "queued",
        code: "ok",
        reason: "Queued.",
        jobId: outcome.job.id,
        ...(outcome.deduped ? { deduped: true as const } : {}),
      };
    }
    if (outcome.code === "conflict") {
      return { ...base, status: "skipped", code: "conflict", reason: shortReason(outcome.why) };
    }
    if (outcome.code === "stale-kick" || outcome.code === "not-found" || outcome.code === "not-kickable") {
      return { ...base, status: "skipped", code: outcome.code, reason: shortReason(outcome.why) };
    }
    return { ...base, status: "failed", code: outcome.code, reason: shortReason(outcome.why) };
  } catch (err) {
    return {
      ...base,
      status: "failed",
      code: "queue-unavailable",
      reason: `Queue unavailable (${shortReason(errorMessage(err))}).`,
    };
  }
}

function bulkJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

type BulkFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function bulkKickUrlOf(peerUrl: string): string | undefined {
  const trimmed = peerUrl.trim();
  if (trimmed === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  try {
    return new URL(BOARD_BULK_PATH, parsed.toString()).toString();
  } catch {
    return undefined;
  }
}

async function readCappedBulkBody(response: Response): Promise<{ text: string; tooLarge: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      const text = await response.text();
      if (text.length > BULK_PEER_MAX_BYTES) return { text: "", tooLarge: true };
      return { text, tooLarge: false };
    } catch {
      return { text: "", tooLarge: true };
    }
  }
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    seen += value.byteLength;
    if (seen > BULK_PEER_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return { text: "", tooLarge: true };
    }
    chunks.push(value);
  }
  try {
    return { text: new TextDecoder().decode(Buffer.concat(chunks)), tooLarge: false };
  } catch {
    return { text: "", tooLarge: true };
  }
}

/**
 * HTTP entry for the scoped bulk requeue.
 *
 * Same write rules as the single kick: the caller already checked edge
 * identity (homelab) or the bearer (peer), Origin, and content-type. This
 * function validates the batch, refuses cross-forge batches, forwards a
 * peer-forge batch over the bearer hop, and otherwise validates each
 * candidate against live forge state plus the latest ledger attempt and
 * enqueues same-head reviews sequentially. No MCP bulk tool exists.
 */
async function handleBulkKickRequest(opts: {
  body: unknown;
  headerIdempotencyKey: string;
  store: ReviewJobStore;
  forgeApi: BulkForge | undefined;
  actor: string;
  localForge: string;
  peerUrl: string;
  peerToken: string;
  fetchFn: BulkFetchFn;
  peerTimeoutMs?: number;
  logger: (message: string) => void;
}): Promise<Response> {
  const { body, headerIdempotencyKey, store, forgeApi, actor, localForge, peerUrl, peerToken, fetchFn } = opts;
  const peerTimeoutMs = opts.peerTimeoutMs ?? BULK_PEER_TIMEOUT_MS;
  const logger = opts.logger;
  const parsed = parseBulkBody(body, headerIdempotencyKey);
  if ("error" in parsed) return bulkJson(400, { error: parsed.error });
  const isHomelab = (localForge ?? "gitea") !== BULK_PEER_FORGE;
  const wantsPeer = parsed.forge === BULK_PEER_FORGE;
  // Cross-forge batches are never allowed: one forge per submit.
  if (parsed.forge !== "" && parsed.forge !== localForge && parsed.forge !== BULK_PEER_FORGE) {
    return bulkJson(400, { error: `unknown forge ${JSON.stringify(parsed.forge)}` });
  }
  if (!isHomelab && wantsPeer) {
    return bulkJson(400, { error: "cross-forge batches are not allowed" });
  }
  if (isHomelab && wantsPeer) {
    const kickUrl = bulkKickUrlOf(peerUrl);
    const token = peerToken.trim();
    if (!kickUrl || token === "") {
      logger(`bulk kick unavailable actor=${actor} forge=${BULK_PEER_FORGE}: peer unavailable`);
      return bulkJson(503, { error: "bulk unavailable for this forge" });
    }
    const forwardBody = {
      forge: BULK_PEER_FORGE,
      idempotencyKey: parsed.idempotencyKey,
      items: parsed.candidates,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), peerTimeoutMs);
    let peerResponse: Response;
    try {
      peerResponse = await fetchFn(kickUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": parsed.idempotencyKey,
        },
        body: JSON.stringify(forwardBody),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (err) {
      logger(`bulk kick forward unavailable actor=${actor} forge=${BULK_PEER_FORGE}: ${errorMessage(err)}`);
      return bulkJson(503, { error: "peer unavailable" });
    } finally {
      clearTimeout(timer);
    }
    if (peerResponse.status === 401 || peerResponse.status === 403) {
      logger(`bulk kick forward unavailable actor=${actor} forge=${BULK_PEER_FORGE}: peer rejected hop`);
      return bulkJson(503, { error: "peer unavailable" });
    }
    if (peerResponse.status === 404) {
      logger(`bulk kick unavailable actor=${actor} forge=${BULK_PEER_FORGE}: peer has no bulk path`);
      return bulkJson(503, { error: "bulk unavailable for this forge" });
    }
    const { text, tooLarge } = await readCappedBulkBody(peerResponse).catch(() => ({ text: "", tooLarge: true }));
    if (tooLarge) {
      logger(`bulk kick forward unavailable actor=${actor} forge=${BULK_PEER_FORGE}: peer response too large`);
      return bulkJson(503, { error: "peer unavailable" });
    }
    let peerBody: unknown;
    try {
      peerBody = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
    } catch {
      logger(`bulk kick forward unavailable actor=${actor} forge=${BULK_PEER_FORGE}: invalid JSON`);
      return bulkJson(503, { error: "peer unavailable" });
    }
    logger(
      `bulk kick forward actor=${actor} forge=${BULK_PEER_FORGE} items=${parsed.candidates.length} status=${peerResponse.status}`
    );
    return bulkJson(peerResponse.status, peerBody);
  }
  if (parsed.forge !== "" && parsed.forge !== localForge) {
    return bulkJson(400, { error: "cross-forge batches are not allowed" });
  }
  if (!forgeApi) {
    logger(`bulk kick unavailable actor=${actor}: forge unavailable`);
    return bulkJson(503, { error: "forge unavailable" });
  }
  const deliveryBase = `board-bulk:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;
  const results: BulkItemResult[] = [];
  // Sequential: one candidate at a time, so bulk concurrency is bounded to 1.
  for (let index = 0; index < parsed.candidates.length; index++) {
    const candidate = parsed.candidates[index]!;
    const result = await runBulkCandidate(store, forgeApi, candidate, {
      actor,
      batchKey: parsed.idempotencyKey,
      delivery: `${deliveryBase}:${index}`,
    });
    results.push(result);
  }
  let queued = 0;
  let skipped = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === "queued") queued++;
    else if (result.status === "skipped") skipped++;
    else failed++;
  }
  logger(
    `bulk kick actor=${actor} items=${results.length} queued=${queued} skipped=${skipped} failed=${failed} forge=${localForge}`
  );
  return bulkJson(200, {
    ok: true,
    forge: localForge,
    batchKey: parsed.idempotencyKey,
    results,
    totals: { queued, skipped, failed },
  });
}

/**
 * HTTP wrapper sharing the single-kick request shape: POST JSON only, with
 * the caller's Origin decision and idempotency header passed in. Keeps the
 * board route small; auth (edge identity vs bearer) stays at the call site.
 */
export async function handleBulkHttpRequest(
  request: Request,
  opts: {
    store: ReviewJobStore;
    forgeApi: BulkForge | undefined;
    actor: string;
    localForge: string;
    peerUrl: string;
    peerToken: string;
    fetchFn: BulkFetchFn;
    peerTimeoutMs?: number;
    logger: (message: string) => void;
    isOriginAllowed: boolean;
    headerKey: string;
  }
): Promise<Response> {
  if (request.method !== "POST") return bulkJson(405, { error: "method not allowed" });
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return bulkJson(400, { error: "invalid kick payload" });
  if (!opts.isOriginAllowed) return bulkJson(403, { error: "forbidden" });
  let body: unknown;
  try {
    const text = await request.text();
    body = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  } catch {
    return bulkJson(400, { error: "invalid JSON" });
  }
  return handleBulkKickRequest({ body, headerIdempotencyKey: opts.headerKey, ...opts });
}
