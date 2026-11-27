/**
 * Signed summary block on published reviews (writer only, slice #977).
 *
 * When Jumi publishes a review it embeds one hidden HTML comment,
 * `<!-- jumi-review:meta ... -->`, in the top-level body. The block carries
 * the typed facts of that review (verdict state, per-finding severity,
 * subtype, placement, location, proof flag) and a parent-minted finding key
 * per finding, authenticated with an HMAC so a model, a user, or a forge edit
 * cannot forge or alter it. Inline comment bodies stay byte-identical: there
 * is no per-inline marker.
 *
 * This slice only writes. No consumer reads or trusts the block yet; old
 * readers behave exactly as before (the block sits before the check trailer
 * so the trailer stays the last non-empty line, and it matches the
 * `jumi-review:` strip patterns where they already apply).
 *
 * Wire format: `<!-- jumi-review:meta v=1 d=<hex> s=<hex> -->` where `d` is
 * the hex of the canonical JSON payload and `s` is HMAC-SHA-256 hex over the
 * raw payload bytes with a dedicated key derived via HKDF-SHA-256
 * (`jumi-review-meta-v1`) from the webhook secret. Hex never contains `>` or
 * `--`, and the payload digest binds the exact posted body (minus the block).
 */

import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { CI_ABSENT_NOTE } from "./ci.ts";
import { canonicalFindingLine, renderProofLines, type ReviewProof } from "./review_verdict_typed.ts";
import type { ReviewMcpFindingRecord, ReviewRecord } from "./review_verdict_store.ts";
import {
  findingFingerprint,
  hasFindingProof,
  isBlockingQuestionAuthor,
  isBugFindingFirstLine,
  isMaintainerQuestionFirstLine,
  isQuestionFindingFirstLine,
  isRiskFindingFirstLine,
  isSuggestionFindingFirstLine,
  publishedFindingBlocks,
  type PublishedFindingBlock,
} from "./verdict.ts";

/** Format version of the signed block. */
export const REVIEW_META_VERSION = 1;
/** HKDF info string for the dedicated signing key. Never the raw secret. */
export const REVIEW_META_HKDF_INFO = "jumi-review-meta-v1";
/** Maximum encoded block bytes (forge comments are never grown past the limit because of the block). */
export const REVIEW_META_MAX_BYTES = 8 * 1024;
/** Digest algorithm for the bound markdown (hex). */
export const REVIEW_META_DIGEST = "sha256";

const META_RE = /<!--\s*jumi-review:meta\s+v=1\s+d=([0-9a-f]+)\s+s=([0-9a-f]+)\s*-->/;
const META_RE_GLOBAL = /<!--\s*jumi-review:meta\s+v=1\s+d=[0-9a-f]+\s+s=[0-9a-f]+\s*-->/g;

let loggedNoSecret = false;

/** Reset the once-only no-secret log (tests only). */
export function resetReviewMetaNoSecretLog(): void {
  loggedNoSecret = false;
}

export type MetaSeverity = "bug" | "risk" | "suggestion" | "question";
export type MetaQuestionSubtype = "maintainer" | "blocking" | "plain";
export type MetaPlacement = "body" | "inline" | "dropped_by_cap";

export interface MetaFindingEntry {
  /** Parent-minted key (`k_<job>_<n>`), or null when the one-to-one rule fails. */
  k: string | null;
  s: MetaSeverity;
  /** Questions only; undefined for bug/risk/suggestion. */
  t?: MetaQuestionSubtype;
  p: MetaPlacement;
  path?: string;
  line?: number;
  /** 1 when the store finding carries proof, else 0. */
  proof: 0 | 1;
  /** Body findings: 1-based ordinal among body placements. */
  o?: number;
  /** Inline findings: verified live comment id. */
  cid?: number;
  /** Inline findings: sha256 hex of the expected posted bytes. */
  cs?: string;
}

export interface MetaPayload {
  v: 1;
  forge: string;
  repo: string;
  pr: number;
  head: string;
  state: "success" | "failure";
  /** sha256 hex of the exact posted top-level body with the block stripped. */
  md: string;
  findings: MetaFindingEntry[];
}

export interface MetaAssembleFinding {
  severity: MetaSeverity;
  subtype?: MetaQuestionSubtype;
  placement: MetaPlacement;
  path?: string;
  line?: number;
  proof: boolean;
  /** Raw store title/body (before the parent-appended footer). */
  title: string;
  body: string;
  /** Rendered posted block text (raw first line plus continuations) for the competing-syntax rule. */
  rendered: string;
  /** 1-based ordinal in publish order (body entries serialize it as `o`). */
  ordinal: number;
  /** Exactly one source finding must reach this placement for a key. */
  sources: number;
  /** Inline only: path/line actually posted. */
  postedPath?: string;
  postedLine?: number;
  /** Inline only: live location re-read from the forge after posting. */
  liveId?: number;
  livePath?: string;
  liveLine?: number;
  /** Inline only: live comment bytes. */
  liveBody?: string;
  /** Inline only: expected posted bytes (`${finding.body}\n\n${marker}`). */
  expectedBody?: string;
  /** Body only: the extractor recovers this location from the rendered body. */
  bodyLocationVerified?: boolean;
}

export interface MetaAssembleOpts {
  forgeIdentity: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  state: "success" | "failure";
  /** Exact top-level body bytes that will post, without the meta block. */
  bodyWithoutMeta: string;
  /** This PR's literal review marker (for the marker-in-text rule). */
  marker: string;
  /** Parent job id used for key minting (`k_<job>_<n>`). */
  jobId: string;
  findings: MetaAssembleFinding[];
  /** False when anything between store and post changed the text: suppress. */
  exactText: boolean;
  exactTextReason?: string;
  log?: (message: string) => void;
}

export type MetaAssembleResult =
  | { ok: true; block: string; payload: MetaPayload }
  | { ok: false; suppressed: string };

/**
 * Default forge identity: the forge base URL host plus the bot username,
 * lowercased so verification is stable across login-case drift.
 */
export function defaultForgeIdentity(giteaUrl: string, botUsername: string): string {
  let host = giteaUrl.trim();
  try {
    host = new URL(giteaUrl).host.toLowerCase();
  } catch {
    host = giteaUrl.trim().toLowerCase().replace(/\/+$/, "");
  }
  return `${host}/${botUsername.trim().toLowerCase()}`;
}

/** Dedicated signing key: HKDF-SHA-256 over the webhook secret. */
export function deriveReviewMetaKey(webhookSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(webhookSecret, "utf8"), Buffer.alloc(0), REVIEW_META_HKDF_INFO, 32));
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sanitizeJobId(jobId: string): string {
  const clean = jobId.trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return clean || "job";
}

function mintKey(jobId: string, ordinal: number): string {
  return `k_${sanitizeJobId(jobId)}_${ordinal}`;
}

/**
 * Competing syntax: anything the legacy parsers could read as an
 * additional/different finding boundary, severity, or location. The finding's
 * own first line is allowed; every continuation line must not look like a new
 * finding, and no full `jumi-` control comment or findings-list marker may
 * appear anywhere (a prose mention without the `<!-- -->` form is harmless).
 */
export function hasCompetingSyntax(rendered: string): boolean {
  if (/<!--\s*jumi-/i.test(rendered)) return true;
  const lines = rendered.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim().replace(/^(?:[-*]|\d+\.)\s+/, "");
    if (!line) continue;
    // A continuation line starting with another finding (severity marker,
    // location, or L<n>:) would parse as a second finding.
    if (/^(?:🔴|🟡|💡|❓)/u.test(line)) return true;
    if (/^(?:bug|risk|simpler|suggestions?|questions?|q)\s*:/i.test(line)) return true;
    if (/^(?:L\d+|\S+?:\d+)\s*:/.test(line)) return true;
    if (/^L\d+:\s*\S/.test(line)) return true;
  }
  return false;
}

/** Encode the payload: hex JSON (never `>`, never `--`). */
export function encodeMetaPayload(payload: MetaPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("hex");
}

export function decodeMetaPayload(hex: string): MetaPayload {
  return JSON.parse(Buffer.from(hex, "hex").toString("utf8")) as MetaPayload;
}

/** Sign raw payload bytes with the derived key. */
export function signMetaPayload(payloadHex: string, derivedKey: Buffer): string {
  return createHmac("sha256", derivedKey).update(Buffer.from(payloadHex, "hex")).digest("hex");
}

/** Build the hidden comment. The payload/sig hex never contain `>` or `--`. */
export function buildReviewMetaBlock(payloadHex: string, sigHex: string): string {
  return `<!-- jumi-review:meta v=1 d=${payloadHex} s=${sigHex} -->`;
}

/** Remove every meta block from a body (golden comparisons). */
export function stripReviewMeta(body: string): string {
  return body.replace(META_RE_GLOBAL, "");
}

/**
 * Excise exactly one meta block with its separators: the exact inverse of
 * `insertReviewMetaBeforeTrailer`, so the digest input round-trips byte for
 * byte on an honest body and any whitespace edit around the block fails.
 */
function exciseMetaBlock(body: string): string {
  const match = META_RE.exec(body);
  if (!match || match.index === undefined) return body;
  const start = match.index;
  const end = start + match[0].length;
  const before = body.slice(0, start);
  const after = body.slice(end);
  if (before.endsWith("\n\n") && after.startsWith("\n\n")) return `${before}${after.slice(2)}`;
  if (before === "" && after.startsWith("\n\n")) return after.slice(2);
  if (after === "" && before.endsWith("\n\n")) return before.slice(0, -2);
  return `${before}${after}`;
}

/** Parse the single meta block, or undefined when absent. */
export function parseReviewMetaBlock(body: string): { payloadHex: string; sigHex: string } | undefined {
  const match = META_RE.exec(body);
  if (!match) return undefined;
  return { payloadHex: match[1], sigHex: match[2] };
}

/** Count meta blocks in a body. */
export function countReviewMetaBlocks(body: string): number {
  const matches = body.match(META_RE_GLOBAL);
  return matches ? matches.length : 0;
}

export interface VerifyReviewMetaExpected {
  forgeIdentity?: string;
  owner?: string;
  repo?: string;
  prNumber?: number;
  headSha?: string;
  state?: "success" | "failure";
}

export type VerifyReviewMetaResult =
  | { ok: true; payload: MetaPayload }
  | { ok: false; reason: string };

function payloadEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Test verifier (lives in this slice for tests; consumers don't use it).
 * Checks exactly one block, the HMAC, the markdown digest, and any expected
 * coordinates (repo, PR, head, forge identity, verdict state).
 */
export function verifyReviewMeta(
  body: string,
  webhookSecret: string,
  expected?: VerifyReviewMetaExpected
): VerifyReviewMetaResult {
  if (!webhookSecret) return { ok: false, reason: "no-secret" };
  if (countReviewMetaBlocks(body) !== 1) return { ok: false, reason: "block-count" };
  const parsed = parseReviewMetaBlock(body);
  if (!parsed) return { ok: false, reason: "no-block" };
  let payload: MetaPayload;
  try {
    payload = decodeMetaPayload(parsed.payloadHex);
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  if (payload.v !== REVIEW_META_VERSION) return { ok: false, reason: "bad-version" };
  const derived = deriveReviewMetaKey(webhookSecret);
  const expectedSig = signMetaPayload(parsed.payloadHex, derived);
  if (!payloadEquals(expectedSig, parsed.sigHex)) return { ok: false, reason: "bad-signature" };
  if (sha256Hex(exciseMetaBlock(body)) !== payload.md) return { ok: false, reason: "body-tampered" };
  if (expected?.forgeIdentity !== undefined && payload.forge !== expected.forgeIdentity) {
    return { ok: false, reason: "forge-mismatch" };
  }
  if (expected?.owner !== undefined || expected?.repo !== undefined) {
    const want = `${expected.owner ?? ""}/${expected.repo ?? ""}`;
    if (payload.repo !== want) return { ok: false, reason: "repo-mismatch" };
  }
  if (expected?.prNumber !== undefined && payload.pr !== expected.prNumber) {
    return { ok: false, reason: "pr-mismatch" };
  }
  if (expected?.headSha !== undefined && payload.head !== expected.headSha) {
    return { ok: false, reason: "head-mismatch" };
  }
  if (expected?.state !== undefined && payload.state !== expected.state) {
    return { ok: false, reason: "state-mismatch" };
  }
  return { ok: true, payload };
}

/**
 * Insert the block before the check trailer (which stays the last non-empty
 * line so every existing trailer reader classifies identically), or append
 * it when there is no trailer.
 */
export function insertReviewMetaBeforeTrailer(bodyWithoutMeta: string, block: string): string {
  const lines = bodyWithoutMeta.split("\n");
  let trailerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!(lines[i] ?? "").trim()) continue;
    trailerIndex = i;
    break;
  }
  const isTrailer =
    trailerIndex >= 0 &&
    /<!--\s*jumi-check:\s*(?:success|failure)(?:\s*;\s*(?:(?!-->).)*?)?\s*-->/i.test((lines[trailerIndex] ?? "").trim());
  if (!isTrailer) {
    return bodyWithoutMeta.trimEnd() ? `${bodyWithoutMeta.trimEnd()}\n\n${block}` : block;
  }
  const before = lines.slice(0, trailerIndex).join("\n").trimEnd();
  const trailer = (lines[trailerIndex] ?? "").trim();
  return before ? `${before}\n\n${block}\n\n${trailer}` : `${block}\n\n${trailer}`;
}

function decideKey(finding: MetaAssembleFinding, marker: string): string | null {
  if (finding.sources !== 1) return null;
  if (finding.placement === "dropped_by_cap") return null;
  if (finding.body.includes(marker) || finding.title.includes(marker)) return null;
  if (hasCompetingSyntax(finding.rendered)) return null;
  if (finding.placement === "inline") {
    if (finding.postedPath === undefined || finding.postedLine === undefined) return null;
    if (finding.liveId == null || finding.livePath === undefined || finding.liveLine === undefined) return null;
    // Store location must equal the posted location and the verified live one.
    const storePath = (finding.path ?? "").trim();
    const storeLine = finding.line ?? 0;
    if (storePath !== finding.postedPath || storeLine !== finding.postedLine) return null;
    if (finding.postedPath !== finding.livePath || finding.postedLine !== finding.liveLine) return null;
    if (finding.expectedBody === undefined || finding.liveBody === undefined) return null;
    if (sha256Hex(finding.expectedBody) !== sha256Hex(finding.liveBody)) return null;
    return mintKey("x", finding.ordinal);
  }
  // Body placement: the consumer's extractor must recover the signed location.
  if (finding.bodyLocationVerified !== true) return null;
  return mintKey("x", finding.ordinal);
}

/**
 * Assemble the payload, applying the one-to-one key rules, then encode, sign,
 * and enforce the 8 KiB cap (drop keys first, then the block). Returns the
 * block plus the decoded payload for tests. Never throws on content: any
 * content problem suppresses the block with a reason so publication is
 * otherwise unchanged.
 */
export function assembleReviewMeta(webhookSecret: string, opts: MetaAssembleOpts): MetaAssembleResult {
  const log = opts.log ?? (() => undefined);
  if (!webhookSecret) {
    if (!loggedNoSecret) {
      loggedNoSecret = true;
      log("review meta suppressed: no webhook secret");
    }
    return { ok: false, suppressed: "no-secret" };
  }
  if (!opts.exactText) {
    log(`review meta suppressed: ${opts.exactTextReason ?? "store text differs from posted text"}`);
    return { ok: false, suppressed: opts.exactTextReason ?? "text-changed" };
  }
  const md = sha256Hex(opts.bodyWithoutMeta);
  const seenOrdinals = new Set<number>();
  const findings: MetaFindingEntry[] = [];
  for (const finding of opts.findings) {
    let key = decideKey(finding, opts.marker);
    if (key !== null) {
      // Keys stay distinct per ordinal; a duplicate ordinal never collides:
      // the second claim loses its key.
      if (seenOrdinals.has(finding.ordinal)) key = null;
      else {
        seenOrdinals.add(finding.ordinal);
        key = mintKey(opts.jobId, finding.ordinal);
      }
    }
    const entry: MetaFindingEntry = {
      k: key,
      s: finding.severity,
      p: finding.placement,
      proof: finding.proof ? 1 : 0,
    };
    if (finding.severity === "question") entry.t = finding.subtype ?? "plain";
    if (finding.path !== undefined) entry.path = finding.path;
    if (finding.line !== undefined) entry.line = finding.line;
    if (finding.placement === "body") entry.o = finding.ordinal;
    if (finding.placement === "inline" && finding.liveId != null) entry.cid = finding.liveId;
    if (finding.placement === "inline" && finding.expectedBody !== undefined) {
      entry.cs = sha256Hex(finding.expectedBody);
    }
    findings.push(entry);
  }
  const payload: MetaPayload = {
    v: 1,
    forge: opts.forgeIdentity,
    repo: `${opts.owner}/${opts.repo}`,
    pr: opts.prNumber,
    head: opts.headSha,
    state: opts.state,
    md,
    findings,
  };
  const derived = deriveReviewMetaKey(webhookSecret);
  const finish = (withKeys: boolean): MetaAssembleResult => {
    const use: MetaPayload =
      withKeys === false
        ? {
            ...payload,
            findings: payload.findings.map((entry) => {
              const copy: MetaFindingEntry = { k: null, s: entry.s, p: entry.p, proof: entry.proof };
              if (entry.t !== undefined) copy.t = entry.t;
              if (entry.path !== undefined) copy.path = entry.path;
              if (entry.line !== undefined) copy.line = entry.line;
              if (entry.o !== undefined) copy.o = entry.o;
              if (entry.cid !== undefined) copy.cid = entry.cid;
              if (entry.cs !== undefined) copy.cs = entry.cs;
              return copy;
            }),
          }
        : payload;
    const payloadHex = encodeMetaPayload(use);
    const sig = signMetaPayload(payloadHex, derived);
    const block = buildReviewMetaBlock(payloadHex, sig);
    if (block.length > REVIEW_META_MAX_BYTES) return { ok: false, suppressed: "size-cap" };
    return { ok: true, block, payload: use };
  };
  const full = finish(true);
  if (full.ok) return full;
  if (full.suppressed !== "size-cap") return full;
  log("review meta suppressed: size cap");
  return finish(false);
}

/** Severity text classifiers agree with the legacy body counters. */
export function textSeverityOfFinding(firstLine: string): MetaSeverity | "other" {
  if (isBugFindingFirstLine(firstLine)) return "bug";
  if (isRiskFindingFirstLine(firstLine)) return "risk";
  if (isSuggestionFindingFirstLine(firstLine)) return "suggestion";
  if (isQuestionFindingFirstLine(firstLine)) return "question";
  return "other";
}

/** Question subtype from the marker and the blocking gate (success + allowlisted author). */
export function questionSubtypeOf(isMaintainer: boolean, blockingGate: boolean): MetaQuestionSubtype {
  if (isMaintainer) return "maintainer";
  return blockingGate ? "blocking" : "plain";
}

export interface MetaStoreFinding {
  path?: string;
  line?: number;
  severity: MetaSeverity;
  title: string;
  body: string;
  maintainerDecision?: "typed_true" | "typed_false" | "none";
  proof?: ReviewProof;
}

/** Adapt a store record finding (proof/subtype come from the store, never text). */
export function storeFindingForMeta(
  finding: Pick<ReviewMcpFindingRecord, "path" | "line" | "severity" | "title" | "body" | "maintainerDecision" | "proof">
): MetaStoreFinding {
  return {
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    ...(finding.maintainerDecision !== undefined ? { maintainerDecision: finding.maintainerDecision } : {}),
    ...(finding.proof !== undefined ? { proof: finding.proof } : {}),
  };
}

/**
 * Full published text of one store finding: the canonical first-line body
 * plus attached proof lines, exactly as `toMarkdown()` renders. Callers
 * compare this byte for byte with the posted block body.
 */
export function expectedStoreFindingText(store: MetaStoreFinding): string {
  const canonical = canonicalFindingLine(store.title, store.body, store.severity, store.maintainerDecision ?? "none");
  if (!store.proof) return canonical;
  return [canonical, ...renderProofLines(store.proof)].join("\n");
}

export interface MetaBlockInput {
  /** Located block, or unlocated when path/line are absent. */
  path?: string;
  line?: number;
  /** Raw first line (with location prefix when located), for text classifiers. */
  first: string;
  /** Full block body: first-line body plus continuation lines. */
  body: string;
  /** Raw continuation lines after the first, for the competing-syntax rule. */
  rest: string[];
}

export interface MetaLiveInline {
  id: number;
  path: string;
  line: number;
  body: string;
}

export interface MetaBuildOpts {
  /** Published blocks in order (list section already excluded by the extractor). */
  blocks: MetaBlockInput[];
  /** Store findings (MCP path). Undefined on the legacy file-artifact path. */
  store?: MetaStoreFinding[];
  /** True when an ordinary question would block (complete success + allowlisted author). */
  blockingGate: boolean;
  /** Suggestion-cap drop count the parent enforced. 0 when the cap did not drop. */
  droppedSuggestions?: number;
  /** Pull-review path: fingerprints the forge accepted as inlines (reconciled + posted). */
  postedFingerprints?: ReadonlySet<string>;
  /** Pull-review path: live inlines re-read from the forge after posting. */
  liveInlines?: MetaLiveInline[];
  /** This PR's literal review marker (for the marker-in-text rule). */
  marker: string;
  /** Pull-review path: expected posted bytes by finding fingerprint. */
  expectedBodies?: ReadonlyMap<string, string>;
  singleFilePath?: string;
}

export type MetaBuildResult =
  | { ok: true; findings: MetaAssembleFinding[]; exactText: boolean; exactTextReason?: string }
  | { ok: false; suppressed: string };

/**
 * Resolve typed facts and placements for every published block, in order.
 *
 * Store path: each block must match exactly one store finding byte for byte
 * (canonical line plus proof lines); a parent-added finding after
 * `set_verdict`, or redaction altering a finding, suppresses the block.
 * Unmatched store findings past the cap drop become `dropped_by_cap`
 * entries; any other loss suppresses. Text path: facts come from the legacy
 * classifiers on the posted text.
 *
 * Body findings take ordinals in publish order. Inline entries carry the
 * verified live comment id; inline keys additionally need digest equality,
 * which `assembleReviewMeta` enforces.
 */
export function buildMetaAssembleFindings(opts: MetaBuildOpts): MetaBuildResult {
  const typed = resolveMetaTyped(opts);
  if (!typed.ok) return typed;
  const findings: MetaAssembleFinding[] = [];
  let ordinal = 0;
  const seenInline = new Set<string>();
  for (let index = 0; index < opts.blocks.length; index++) {
    const block = opts.blocks[index];
    if (!block) continue;
    const info = typed.typed[index];
    if (!info) return { ok: false, suppressed: "typed-mismatch" };
    const fingerprint = block.path !== undefined ? findingFingerprint(block.path, block.body) : undefined;
    const isPosted = fingerprint !== undefined && (opts.postedFingerprints?.has(fingerprint) ?? false);
    if (isPosted && fingerprint !== undefined) {
      if (seenInline.has(fingerprint)) continue;
      seenInline.add(fingerprint);
    }
    const placement: MetaPlacement = isPosted ? "inline" : "body";
    let live: MetaLiveInline | undefined;
    if (isPosted && fingerprint !== undefined) {
      const candidates = (opts.liveInlines ?? []).filter(
        (inline) => findingFingerprint(inline.path, inline.body) === fingerprint
      );
      if (candidates.length === 1) live = candidates[0];
    }
    // Keys ride per-entry ordinals: body entries serialize theirs as `o`,
    // inline entries stay ordinal-keyed without serializing it.
    ordinal++;
    const expectedBody =
      placement === "inline" && fingerprint !== undefined ? opts.expectedBodies?.get(fingerprint) : undefined;
    // Body keys need the extractor location to equal the signed (store)
    // location. Keys are ordinal-minted, so duplicate forms (`- a.ts:1:` vs
    // `a.ts:1:`, identical findings at distinct ordinals) never collide.
    const storeMatchesPosted =
      (info.blockPath ?? info.path ?? "") === (info.path ?? "") &&
      (info.blockLine ?? info.line ?? 0) === (info.line ?? 0);
    findings.push({
      severity: info.severity,
      ...(info.subtype !== undefined ? { subtype: info.subtype } : {}),
      placement,
      ...(info.path !== undefined ? { path: info.path } : {}),
      ...(info.line !== undefined ? { line: info.line } : {}),
      proof: info.proof,
      title: info.title,
      body: info.body,
      rendered: [block.first, ...block.rest].join("\n"),
      ordinal,
      sources: 1,
      ...(block.path !== undefined ? { postedPath: block.path } : {}),
      ...(block.line !== undefined ? { postedLine: block.line } : {}),
      ...(live ? { liveId: live.id, livePath: live.path, liveLine: live.line, liveBody: live.body } : {}),
      ...(expectedBody !== undefined ? { expectedBody } : {}),
      ...(placement === "body" ? { bodyLocationVerified: storeMatchesPosted } : {}),
    });
  }
  // Cap-dropped store suggestions ride as keyless entries past the body ones.
  for (const dropped of typed.dropped) {
    findings.push({
      severity: dropped.severity,
      ...(dropped.subtype !== undefined ? { subtype: dropped.subtype } : {}),
      placement: "dropped_by_cap",
      ...(dropped.path !== undefined ? { path: dropped.path } : {}),
      ...(dropped.line !== undefined ? { line: dropped.line } : {}),
      proof: dropped.proof,
      title: dropped.title,
      body: dropped.body,
      rendered: `${dropped.title}\n${dropped.body}`,
      ordinal: 0,
      sources: 1,
    });
  }
  return { ok: true, findings, exactText: true };
}

interface ResolvedTyped {
  severity: MetaSeverity;
  subtype?: MetaQuestionSubtype;
  proof: boolean;
  /** Signed location: the store's (store path) or the posted block's (text path). */
  path?: string;
  line?: number;
  /** Posted block location (store path only; the key needs store == posted). */
  blockPath?: string;
  blockLine?: number;
  title: string;
  body: string;
}

function resolveMetaTyped(opts: MetaBuildOpts):
  | { ok: true; typed: ResolvedTyped[]; dropped: ResolvedTyped[] }
  | { ok: false; suppressed: string } {
  if (!opts.store) {
    return {
      ok: true,
      typed: opts.blocks.map((block) => {
        const severity = textSeverityOfFinding(block.first);
        const resolved: ResolvedTyped = {
          severity: severity === "other" ? "question" : severity,
          proof: hasFindingProof(block.body),
          title: block.first,
          body: block.body,
        };
        if (block.path !== undefined) resolved.path = block.path;
        if (block.line !== undefined) resolved.line = block.line;
        if (resolved.severity === "question") {
          resolved.subtype = questionSubtypeOf(isMaintainerQuestionFirstLine(block.first), opts.blockingGate);
        }
        return resolved;
      }),
      dropped: [],
    };
  }
  const remaining = [...opts.store];
  const typed: ResolvedTyped[] = [];
  for (const block of opts.blocks) {
    // Match on the finding text alone: the publisher posts what the comment
    // says, which can move a finding the store recorded elsewhere. The signed
    // location stays the store's; a store/posted mismatch withholds the key
    // (one-to-one rule) instead of suppressing the block. Text the store never
    // produced (parent additions, redaction) matches nothing and suppresses.
    const idx = remaining.findIndex((store) => expectedStoreFindingText(store) === block.body);
    if (idx < 0) return { ok: false, suppressed: "store-post-mismatch" };
    const store = remaining.splice(idx, 1)[0];
    if (!store) return { ok: false, suppressed: "store-post-mismatch" };
    const resolved: ResolvedTyped = {
      severity: store.severity,
      proof: store.proof !== undefined,
      title: store.title,
      body: store.body,
      ...(block.path !== undefined ? { blockPath: block.path } : {}),
      ...(block.line !== undefined ? { blockLine: block.line } : {}),
    };
    if (store.path !== undefined) resolved.path = store.path;
    if (store.line !== undefined) resolved.line = store.line;
    if (store.severity === "question") {
      const canonical = canonicalFindingLine(store.title, store.body, "question", store.maintainerDecision ?? "none");
      resolved.subtype = questionSubtypeOf(
        store.maintainerDecision === "typed_true" ||
          (store.maintainerDecision !== "typed_false" && isMaintainerQuestionFirstLine(canonical)),
        opts.blockingGate
      );
    }
    typed.push(resolved);
  }
  const droppedCount = opts.droppedSuggestions ?? 0;
  const dropped: ResolvedTyped[] = [];
  const leftovers = [...remaining];
  for (const store of leftovers) {
    if (store.severity !== "suggestion") return { ok: false, suppressed: "store-post-mismatch" };
    const resolved: ResolvedTyped = {
      severity: store.severity,
      proof: store.proof !== undefined,
      title: store.title,
      body: store.body,
    };
    if (store.path !== undefined) resolved.path = store.path;
    if (store.line !== undefined) resolved.line = store.line;
    dropped.push(resolved);
  }
  if (dropped.length !== droppedCount) return { ok: false, suppressed: "store-post-mismatch" };
  return { ok: true, typed, dropped };
}

/** Published blocks of posted content for the meta builder (list section excluded). */
export function metaBlocksForContent(
  content: string,
  opts?: { singleFilePath?: string; keep?: readonly string[] }
): MetaBlockInput[] {
  return publishedFindingBlocks(content, opts).map(toMetaBlockInput);
}

function toMetaBlockInput(block: PublishedFindingBlock): MetaBlockInput {
  const input: MetaBlockInput = { first: block.first, body: block.body, rest: block.rest };
  if (block.path !== undefined) input.path = block.path;
  if (block.line !== undefined) input.line = block.line;
  return input;
}

/**
 * Single publication entry point: resolve typed facts, assemble, sign, and
 * insert the block before the check trailer. Returns the body with the block,
 * or the input unchanged when the block is suppressed (never throws on
 * content: suppression keeps publication otherwise unchanged).
 */
export interface TopLevelMetaInput {
  webhookSecret: string | undefined;
  forgeIdentity: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  state: "success" | "failure";
  marker: string;
  jobId: string;
  /** Full top-level body without the meta block (digest input, trailer included). */
  bodyWithoutMeta: string;
  /** Findings blocks in publish order (list section already excluded by the extractor). */
  blocks: MetaBlockInput[];
  store?: MetaStoreFinding[];
  blockingGate: boolean;
  droppedSuggestions?: number;
  postedFingerprints?: ReadonlySet<string>;
  liveInlines?: MetaLiveInline[];
  expectedBodies?: ReadonlyMap<string, string>;
  singleFilePath?: string;
  /** False when anything between store and post changed the text: suppress. */
  exactText?: boolean;
  exactTextReason?: string;
  log?: (message: string) => void;
}

export function attachReviewMeta(input: TopLevelMetaInput): string {
  const log = input.log ?? (() => undefined);
  try {
    if (!input.webhookSecret) {
      if (!loggedNoSecret) {
        loggedNoSecret = true;
        log("review meta suppressed: no webhook secret");
      }
      return input.bodyWithoutMeta;
    }
    if (input.exactText === false) {
      log(`review meta suppressed: ${input.exactTextReason ?? "store text differs from posted text"}`);
      return input.bodyWithoutMeta;
    }
    const built = buildMetaAssembleFindings({
      blocks: input.blocks,
      ...(input.store ? { store: input.store } : {}),
      blockingGate: input.blockingGate,
      ...(input.droppedSuggestions !== undefined ? { droppedSuggestions: input.droppedSuggestions } : {}),
      ...(input.postedFingerprints ? { postedFingerprints: input.postedFingerprints } : {}),
      ...(input.liveInlines ? { liveInlines: input.liveInlines } : {}),
      marker: input.marker,
      ...(input.expectedBodies ? { expectedBodies: input.expectedBodies } : {}),
      ...(input.singleFilePath ? { singleFilePath: input.singleFilePath } : {}),
    });
    if (!built.ok) {
      log(`review meta suppressed: ${built.suppressed}`);
      return input.bodyWithoutMeta;
    }
    if (!built.exactText) {
      log("review meta suppressed: store text differs from posted text");
      return input.bodyWithoutMeta;
    }
    const assembled = assembleReviewMeta(input.webhookSecret, {
      forgeIdentity: input.forgeIdentity,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      state: input.state,
      bodyWithoutMeta: input.bodyWithoutMeta,
      marker: input.marker,
      jobId: input.jobId,
      findings: built.findings,
      exactText: true,
      log,
    });
    if (!assembled.ok) {
      if (assembled.suppressed !== "no-secret") log(`review meta suppressed: ${assembled.suppressed}`);
      return input.bodyWithoutMeta;
    }
    return insertReviewMetaBeforeTrailer(input.bodyWithoutMeta, assembled.block);
  } catch (err) {
    log(`review meta suppressed: ${err instanceof Error ? err.message : String(err)}`);
    return input.bodyWithoutMeta;
  }
}

/**
 * Publication options for the signed block. Threaded through
 * `postPullReview` / `publishReviewResult` as one `meta` field so the
 * publication diff stays small; everything stays optional and an absent
 * secret writes no block.
 */
export interface ReviewMetaPublishOpts {
  webhookSecret?: string;
  giteaUrl?: string;
  forgeIdentity?: string;
  jobId?: string;
  record?: ReviewRecord;
  blockingGate?: boolean;
  droppedSuggestions?: number;
  verdictState?: "success" | "failure";
  exactText?: boolean;
}

/** Fill verdict-derived defaults (state, blocking gate, cap drops) over caller-provided inputs. */
export function withMetaBase(
  meta: ReviewMetaPublishOpts | undefined,
  verdictState: "success" | "failure",
  prAuthorLogin: string | undefined,
  blockingQuestionAuthors: readonly string[] | undefined,
  verdictComplete: boolean,
  droppedSuggestions: number
): ReviewMetaPublishOpts {
  return {
    ...meta,
    verdictState,
    blockingGate:
      verdictComplete &&
      verdictState === "success" &&
      isBlockingQuestionAuthor(prAuthorLogin, blockingQuestionAuthors),
    droppedSuggestions,
  };
}

/** Sticky (top-level comment) publication entry: every block is a body placement. */
export function attachStickyReviewMeta(args: {
  meta?: ReviewMetaPublishOpts;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  marker: string;
  botUsername: string;
  state: "success" | "failure";
  stickyBody: string;
  comment: string;
  singleFilePath?: string;
  log: (message: string) => void;
}): string {
  return attachReviewMeta({
    webhookSecret: args.meta?.webhookSecret,
    forgeIdentity: args.meta?.forgeIdentity ?? defaultForgeIdentity(args.meta?.giteaUrl ?? "gitea", args.botUsername),
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    headSha: args.headSha,
    state: args.state,
    marker: args.marker,
    jobId: args.meta?.jobId ?? `${args.owner}/${args.repo}#${args.prNumber}`,
    bodyWithoutMeta: args.stickyBody,
    blocks: metaBlocksForContent(args.comment, {
      ...(args.singleFilePath ? { singleFilePath: args.singleFilePath } : {}),
      keep: [CI_ABSENT_NOTE],
    }),
    ...(args.meta?.record ? { store: args.meta.record.findings.map(storeFindingForMeta) } : {}),
    blockingGate: args.meta?.blockingGate ?? false,
    ...(args.meta?.droppedSuggestions !== undefined ? { droppedSuggestions: args.meta.droppedSuggestions } : {}),
    ...(args.singleFilePath ? { singleFilePath: args.singleFilePath } : {}),
    ...(args.meta?.exactText === false ? { exactText: false as const } : {}),
    log: args.log,
  });
}

/** Pull-review publication entry: posted fingerprints split body from inline placements. */
export function attachPostPullReviewMeta(args: {
  meta?: ReviewMetaPublishOpts;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  marker: string;
  botUsername: string;
  topBody: string;
  comment: string;
  findings: { path: string; line: number; body: string }[];
  posted: ReadonlySet<string>;
  published: { id: number; path?: string; body?: string | null; new_position?: number | null }[];
  singleFilePath?: string;
  log: (message: string) => void;
}): string {
  const expectedBodies = new Map<string, string>();
  for (const finding of args.findings) {
    const fingerprint = findingFingerprint(finding.path, finding.body);
    if (!expectedBodies.has(fingerprint)) expectedBodies.set(fingerprint, `${finding.body}\n\n${args.marker}`);
  }
  const live = args.published.flatMap((comment) =>
    comment.path && comment.body != null
      ? [{ id: comment.id, path: comment.path, line: comment.new_position ?? 0, body: comment.body }]
      : []
  );
  return attachReviewMeta({
    webhookSecret: args.meta?.webhookSecret,
    forgeIdentity: args.meta?.forgeIdentity ?? defaultForgeIdentity(args.meta?.giteaUrl ?? "gitea", args.botUsername),
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    headSha: args.headSha,
    state: args.meta?.verdictState ?? "failure",
    marker: args.marker,
    jobId: args.meta?.jobId ?? `${args.owner}/${args.repo}#${args.prNumber}`,
    bodyWithoutMeta: args.topBody,
    blocks: metaBlocksForContent(args.comment, {
      ...(args.singleFilePath ? { singleFilePath: args.singleFilePath } : {}),
      keep: [CI_ABSENT_NOTE],
    }),
    ...(args.meta?.record ? { store: args.meta.record.findings.map(storeFindingForMeta) } : {}),
    blockingGate: args.meta?.blockingGate ?? false,
    ...(args.meta?.droppedSuggestions !== undefined ? { droppedSuggestions: args.meta.droppedSuggestions } : {}),
    postedFingerprints: args.posted,
    liveInlines: live,
    expectedBodies,
    ...(args.singleFilePath ? { singleFilePath: args.singleFilePath } : {}),
    ...(args.meta?.exactText === false ? { exactText: false as const } : {}),
    log: args.log,
  });
}
