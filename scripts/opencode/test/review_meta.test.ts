import { describe, expect, test } from "bun:test";
import { auditChildEnv, CHILD_FORBIDDEN_KEYS } from "../src/child_env.ts";
import type { Comment, InlineComment } from "../src/ports.ts";
import { findPreviousReview } from "../src/review_delta.ts";
import { publishReviewResult } from "../src/review.ts";
import {
  assembleReviewMeta,
  attachReviewMeta,
  buildMetaAssembleFindings,
  buildReviewMetaBlock,
  countReviewMetaBlocks,
  decodeMetaPayload,
  defaultForgeIdentity,
  deriveReviewMetaKey,
  encodeMetaPayload,
  expectedStoreFindingText,
  hasCompetingSyntax,
  insertReviewMetaBeforeTrailer,
  metaBlocksForContent,
  parseReviewMetaBlock,
  questionSubtypeOf,
  REVIEW_META_DIGEST,
  REVIEW_META_HKDF_INFO,
  REVIEW_META_MAX_BYTES,
  REVIEW_META_VERSION,
  resetReviewMetaNoSecretLog,
  sha256Hex,
  signMetaPayload,
  storeFindingForMeta,
  stripReviewMeta,
  textSeverityOfFinding,
  verifyReviewMeta,
  type MetaAssembleFinding,
  type MetaBlockInput,
  type MetaFindingEntry,
  type MetaLiveInline,
  type MetaPayload,
  type MetaPlacement,
  type MetaQuestionSubtype,
  type MetaSeverity,
  type MetaStoreFinding,
} from "../src/review_meta.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import { findReviewEnvViolations } from "../src/review_sandbox.ts";
import { fingerprintFindingIdentityFromParts } from "../src/stuck.ts";
import {
  countBugFindings,
  countMaintainerQuestionFindings,
  countNonMaintainerQuestionFindings,
  countQuestionFindings,
  countRiskFindings,
  countSuggestionFindings,
  findingFingerprint,
  parseCheckLine,
  parseReviewFindings,
  reviewFindingLines,
} from "../src/verdict.ts";
import { parseLastCheckTrailer } from "../src/review_facts.ts";
import { makeReviewApi } from "./fakes/forge.ts";

const SECRET = "test-webhook-secret-977";
const IDENTITY = "gitea.example.com/jumi";
const MARKER = "<!-- jumi-review:o/r#7 -->";
const OWNER = "o";
const REPO = "r";
const PR = 7;
const HEAD = "abc1234deadbeef";

const PATCH = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,5 @@ ctx",
  " ctx",
  " ctx",
  "+add12",
  " ctx",
  " ctx",
  "@@ -19,3 +21,5 @@ ctx",
  " ctx",
  " ctx",
  "+add21",
  " ctx",
  " ctx",
].join("\n");

function twoBugStore(): ReviewVerdictStore {
  const store = new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
  const first = store.addFinding({ path: "src/a.ts", line: 12, severity: "bug", title: "null deref", body: "Guard it." });
  if (!first.ok) throw new Error(`addFinding failed: ${first.error}`);
  const second = store.addFinding({ path: "src/a.ts", line: 21, severity: "risk", title: "slow path", body: "Cache it." });
  if (!second.ok) throw new Error(`addFinding failed: ${second.error}`);
  const verdict = store.setVerdict({ state: "failure", reason: "2 blocking" });
  if (!verdict.ok) throw new Error(`setVerdict failed: ${verdict.error}`);
  return store;
}

function suggestionStore(count: number): ReviewVerdictStore {
  const store = new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
  const lines = [10, 11, 12, 13, 14, 21];
  for (let i = 0; i < count; i++) {
    const added = store.addFinding({
      path: "src/a.ts",
      line: lines[i] ?? 10,
      severity: "suggestion",
      title: `cleanup ${i}`,
      body: "Tidy it.",
    });
    if (!added.ok) throw new Error(`addFinding failed: ${added.error}`);
  }
  const verdict = store.setVerdict({ state: "success" });
  if (!verdict.ok) throw new Error(`setVerdict failed: ${verdict.error}`);
  return store;
}

function topBody(comment: string, trailer: string): string {
  return `${MARKER}\n### Jumi review\n\nReviewed commit: \`${HEAD}\`\n\n${comment}\n\n${trailer}`;
}

function attachUnit(opts: {
  comment: string;
  trailer: string;
  store?: MetaStoreFinding[];
  blockingGate?: boolean;
  exactText?: boolean;
  jobId?: string;
  log?: (message: string) => void;
}): string {
  const body = topBody(opts.comment, opts.trailer);
  return attachReviewMeta({
    webhookSecret: SECRET,
    forgeIdentity: IDENTITY,
    owner: OWNER,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    state: "failure",
    marker: MARKER,
    jobId: opts.jobId ?? "job-1",
    bodyWithoutMeta: body,
    blocks: metaBlocksForContent(opts.comment),
    ...(opts.store ? { store: opts.store } : {}),
    blockingGate: opts.blockingGate ?? false,
    ...(opts.exactText !== undefined ? { exactText: opts.exactText } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
}

describe("review meta signing", () => {
  test("two distinct findings write one block that verifies", () => {
    const store = twoBugStore();
    const md = store.toMarkdown();
    const parsed = md.split("\n");
    const comment = parsed.slice(0, -1).join("\n");
    const trailer = parsed[parsed.length - 1] ?? "";
    const withMeta = attachUnit({ comment, trailer, store: store.toRecord().findings.map(storeFindingForMeta) });
    expect(countReviewMetaBlocks(withMeta)).toBe(1);
    const verified = verifyReviewMeta(withMeta, SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.findings).toHaveLength(2);
    expect(verified.payload.findings[0]).toMatchObject({ k: "k_job-1_1", s: "bug", p: "body", path: "src/a.ts", line: 12, proof: 0, o: 1 });
    expect(verified.payload.findings[1]).toMatchObject({ k: "k_job-1_2", s: "risk", p: "body", path: "src/a.ts", line: 21, proof: 0, o: 2 });
  });

  test("flipping payload, repo, pr, head, or identity fails verification", () => {
    const store = twoBugStore();
    const md = store.toMarkdown();
    const lines = md.split("\n");
    const withMeta = attachUnit({
      comment: lines.slice(0, -1).join("\n"),
      trailer: lines[lines.length - 1] ?? "",
      store: store.toRecord().findings.map(storeFindingForMeta),
    });
    expect(verifyReviewMeta(withMeta, "wrong-secret").ok).toBe(false);
    expect(verifyReviewMeta(withMeta, SECRET, { repo: `${OWNER}/other` }).ok).toBe(false);
    expect(verifyReviewMeta(withMeta, SECRET, { prNumber: PR + 1 }).ok).toBe(false);
    expect(verifyReviewMeta(withMeta, SECRET, { headSha: "other" }).ok).toBe(false);
    expect(verifyReviewMeta(withMeta, SECRET, { forgeIdentity: "other/jumi" }).ok).toBe(false);
    expect(verifyReviewMeta(withMeta, SECRET, { state: "success" }).ok).toBe(false);
    // Flip one hex character of the payload.
    const tamperedPayload = withMeta.replace(/d=([0-9a-f])/, (_m, c: string) => `d=${c === "a" ? "b" : "a"}`);
    expect(verifyReviewMeta(tamperedPayload, SECRET).ok).toBe(false);
  });

  test("tampering with the posted body text is detected via the digest", () => {
    const store = twoBugStore();
    const md = store.toMarkdown();
    const lines = md.split("\n");
    const withMeta = attachUnit({
      comment: lines.slice(0, -1).join("\n"),
      trailer: lines[lines.length - 1] ?? "",
      store: store.toRecord().findings.map(storeFindingForMeta),
    });
    const tampered = withMeta.replace("Guard it.", "Guard it!!!");
    expect(verifyReviewMeta(tampered, SECRET).ok).toBe(false);
    // The trailer stays the last non-empty line so old readers classify identically.
    const nonEmpty = withMeta.split("\n").map((line) => line.trim()).filter(Boolean);
    expect(nonEmpty[nonEmpty.length - 1]).toMatch(/jumi-check:/);
  });

  test("encoding never contains > or --", () => {
    const store = twoBugStore();
    const md = store.toMarkdown();
    const lines = md.split("\n");
    const withMeta = attachUnit({
      comment: lines.slice(0, -1).join("\n"),
      trailer: lines[lines.length - 1] ?? "",
      store: store.toRecord().findings.map(storeFindingForMeta),
    });
    const inner = withMeta.match(/<!-- jumi-review:meta (.*) -->/)?.[1] ?? "";
    expect(inner).not.toContain(">");
    expect(inner).not.toContain("--");
    expect(inner).toMatch(/^[A-Za-z0-9_.:=\s-]+$/);
  });

  test("without a webhook secret the block is not written, logged once", () => {
    resetReviewMetaNoSecretLog();
    const logs: string[] = [];
    const body = topBody("src/a.ts:12: 🔴 bug: x.", "<!-- jumi-check: failure -->");
    const input = {
      webhookSecret: "",
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure" as const,
      marker: MARKER,
      jobId: "job-1",
      bodyWithoutMeta: body,
      blocks: metaBlocksForContent("src/a.ts:12: 🔴 bug: x."),
      blockingGate: false,
      log: (message: string) => logs.push(message),
    };
    expect(attachReviewMeta(input)).toBe(body);
    expect(attachReviewMeta(input)).toBe(body);
    expect(logs).toHaveLength(1);
  });
});

describe("review meta one-to-one keys", () => {
  function inlineCase(opts: { liveBody?: string; livePath?: string; liveLine?: number; liveId?: number }) {
    const store = twoBugStore();
    const md = store.toMarkdown();
    const comment = md.split("\n").slice(0, -1).join("\n");
    const blocks = metaBlocksForContent(comment);
    const expected = new Map<string, string>();
    for (const block of blocks) {
      if (block.path === undefined) continue;
      const fingerprint = findingFingerprint(block.path, block.body);
      expected.set(fingerprint, `${block.body}\n\n${MARKER}`);
    }
    const posted = new Set<string>();
    for (const block of blocks) {
      if (block.path === undefined) continue;
      posted.add(findingFingerprint(block.path, block.body));
    }
    const first = blocks[0];
    const firstFingerprint = first?.path !== undefined ? findingFingerprint(first.path, first.body) : "";
    const live: MetaLiveInline[] = [];
    if (first?.path !== undefined) {
      live.push({
        id: opts.liveId ?? 101,
        path: opts.livePath ?? first.path,
        line: opts.liveLine ?? first.line ?? 0,
        body: opts.liveBody ?? expected.get(firstFingerprint) ?? "",
      });
    }
    return { store, blocks, expected, posted, live, firstFingerprint };
  }

  test("same live text mints a key; forged or moved live text does not", () => {
    const good = inlineCase({});
    const built = buildMetaAssembleFindings({
      blocks: good.blocks,
      store: good.store.toRecord().findings.map(storeFindingForMeta),
      blockingGate: false,
      marker: MARKER,
      postedFingerprints: good.posted,
      liveInlines: good.live,
      expectedBodies: good.expected,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const assembled = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: "body",
      marker: MARKER,
      jobId: "job-9",
      findings: built.findings,
      exactText: true,
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const inline = assembled.payload.findings.find((entry) => entry.p === "inline");
    expect(inline).toMatchObject({ k: expect.stringMatching(/^k_job-9_\d+$/), cid: 101 });
    expect(inline?.cs).toBe(sha256Hex(good.expected.get(good.firstFingerprint) ?? ""));

    // Forge normalisation (same fingerprint, different bytes) loses the key.
    const alteredBody = (good.expected.get(good.firstFingerprint) ?? "").replace("Guard it.", "Guard  it.");
    const altered = buildMetaAssembleFindings({
      blocks: good.blocks,
      store: good.store.toRecord().findings.map(storeFindingForMeta),
      blockingGate: false,
      marker: MARKER,
      postedFingerprints: good.posted,
      liveInlines: [
        { id: 101, path: "src/a.ts", line: 12, body: alteredBody },
      ],
      expectedBodies: good.expected,
    });
    expect(altered.ok).toBe(true);
    if (!altered.ok) return;
    const assembledAltered = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: "body",
      marker: MARKER,
      jobId: "job-9",
      findings: altered.findings,
      exactText: true,
    });
    expect(assembledAltered.ok).toBe(true);
    if (!assembledAltered.ok) return;
    expect(assembledAltered.payload.findings.find((entry) => entry.p === "inline")?.k).toBeNull();

    // Moved live location loses the key too.
    const moved = buildMetaAssembleFindings({
      blocks: good.blocks,
      store: good.store.toRecord().findings.map(storeFindingForMeta),
      blockingGate: false,
      marker: MARKER,
      postedFingerprints: good.posted,
      liveInlines: [
        { id: 101, path: "src/a.ts", line: 13, body: good.expected.get(good.firstFingerprint) ?? "" },
      ],
      expectedBodies: good.expected,
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const withMoved = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: "body",
      marker: MARKER,
      jobId: "job-9",
      findings: moved.findings,
      exactText: true,
    });
    expect(withMoved.ok).toBe(true);
    if (!withMoved.ok) return;
    expect(withMoved.payload.findings.find((entry) => entry.p === "inline")?.k).toBeNull();
  });

  test("store location differing from posted withholds the key but keeps the facts", () => {
    const block: MetaBlockInput = {
      path: "src/a.ts",
      line: 14,
      first: "src/a.ts:14: 🔴 bug: null deref Guard it.",
      body: "🔴 bug: null deref Guard it.",
      rest: [],
    };
    const store: MetaStoreFinding = {
      path: "src/a.ts",
      line: 12,
      severity: "bug",
      title: "null deref",
      body: "Guard it.",
    };
    const built = buildMetaAssembleFindings({ blocks: [block], store: [store], blockingGate: false, marker: MARKER });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const assembled = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: "body",
      marker: MARKER,
      jobId: "job-1",
      findings: built.findings,
      exactText: true,
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    // Still listed with the store's typed facts, but keyless.
    expect(assembled.payload.findings).toHaveLength(1);
    expect(assembled.payload.findings[0]).toMatchObject({ k: null, s: "bug", p: "body", path: "src/a.ts", line: 12 });
  });

  test("retry fallback reaches the same decision as the batch path", () => {
    const setup = inlineCase({});
    const run = (live: MetaLiveInline[]) =>
      buildMetaAssembleFindings({
        blocks: setup.blocks,
        store: setup.store.toRecord().findings.map(storeFindingForMeta),
        blockingGate: false,
        marker: MARKER,
        postedFingerprints: setup.posted,
        liveInlines: live,
        expectedBodies: setup.expected,
      });
    // Batch order vs individual-retry order: the decision depends only on the
    // final live state, so both agree.
    const batch = run(setup.live);
    const retryOrder = run([...setup.live].reverse());
    expect(batch.ok && retryOrder.ok).toBe(true);
    if (!batch.ok || !retryOrder.ok) return;
    const keys = (findings: MetaAssembleFinding[]) =>
      findings.map((finding) => `${finding.placement}:${finding.path ?? ""}:${finding.line ?? 0}`);
    expect(keys(batch.findings)).toEqual(keys(retryOrder.findings));
  });

  test("body finding whose extractor location differs gets no key", () => {
    const finding: MetaAssembleFinding = {
      severity: "bug",
      placement: "body",
      path: "src/a.ts",
      line: 12,
      proof: false,
      title: "null deref",
      body: "Guard it.",
      rendered: "src/a.ts:12: 🔴 bug: Guard it.\nGuard it.",
      ordinal: 1,
      sources: 1,
      postedPath: "src/a.ts",
      postedLine: 12,
      bodyLocationVerified: false,
    };
    const assembled = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: "body",
      marker: MARKER,
      jobId: "job-1",
      findings: [finding],
      exactText: true,
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.payload.findings[0]?.k).toBeNull();
  });

  test("competing syntax withholds the key; a quoted mention does not change counts", () => {
    expect(hasCompetingSyntax("line\n<!-- jumi-findings-list:start -->")).toBe(true);
    expect(hasCompetingSyntax("line\n<!-- jumi-review:meta v=1 -->")).toBe(true);
    expect(hasCompetingSyntax("prose\nsrc/b.ts:3: 🔴 bug: other")).toBe(true);
    expect(hasCompetingSyntax("quoting jumi-findings-list:start in prose")).toBe(false);
    const comment = [
      "src/a.ts:12: 🔴 bug: first.",
      "  quoting jumi-findings-list:start in prose",
      "src/b.ts:3: 🔴 bug: real.",
    ].join("\n");
    expect(parseReviewFindings(comment)).toHaveLength(2);
    expect(countBugFindings(comment)).toBe(2);
    expect(countBugFindings("src/b.ts:3: 🔴 bug: real.")).toBe(1);
  });

  test("duplicate locations never collide; identical findings keep ordinal keys", () => {
    const comment = ["- src/a.ts:1: 🔴 bug: same.", "src/a.ts:1: 🔴 bug: same."].join("\n");
    const blocks = metaBlocksForContent(comment);
    expect(blocks).toHaveLength(2);
    const built = buildMetaAssembleFindings({ blocks, blockingGate: false, marker: MARKER });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const assembled = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: comment,
      marker: MARKER,
      jobId: "job-7",
      findings: built.findings,
      exactText: true,
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const keys = assembled.payload.findings.map((entry) => entry.k);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["k_job-7_1", "k_job-7_2"]);
  });

  test("finding text containing the review marker withholds the key", () => {
    const block: MetaBlockInput = {
      path: "src/a.ts",
      line: 1,
      first: "src/a.ts:1: 🔴 bug: x.",
      body: `🔴 bug: x mentions ${MARKER} inline.`,
      rest: [],
    };
    const built = buildMetaAssembleFindings({ blocks: [block], blockingGate: false, marker: MARKER });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const assembled = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: "body",
      marker: MARKER,
      jobId: "job-1",
      findings: built.findings,
      exactText: true,
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.payload.findings[0]?.k).toBeNull();
  });
});

describe("review meta suppression", () => {
  test("parent-added finding after set_verdict suppresses the block", () => {
    const logs: string[] = [];
    const store = twoBugStore();
    const md = store.toMarkdown();
    const lines = md.split("\n");
    const altered = [...lines.slice(0, -1), "src/a.ts:10: 🔴 bug: injected.", lines[lines.length - 1] ?? ""].join("\n");
    const body = topBody(altered, "<!-- jumi-check: failure -->");
    const out = attachReviewMeta({
      webhookSecret: SECRET,
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      marker: MARKER,
      jobId: "job-1",
      bodyWithoutMeta: body,
      blocks: metaBlocksForContent(altered),
      store: store.toRecord().findings.map(storeFindingForMeta),
      blockingGate: false,
      log: (message: string) => logs.push(message),
    });
    expect(out).toBe(body);
    expect(countReviewMetaBlocks(out)).toBe(0);
    expect(logs.join("\n")).toContain("store-post-mismatch");
  });

  test("redaction altering a finding suppresses the block", () => {
    const store = new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
    const added = store.addFinding({ path: "src/a.ts", line: 12, severity: "bug", title: "leak", body: "token hunter2" });
    if (!added.ok) throw new Error(`addFinding failed: ${added.error}`);
    const verdict = store.setVerdict({ state: "failure" });
    if (!verdict.ok) throw new Error(`setVerdict failed: ${verdict.error}`);
    const md = store.toMarkdown().replace("hunter2", "***");
    const lines = md.split("\n");
    const body = topBody(lines.slice(0, -1).join("\n"), lines[lines.length - 1] ?? "");
    const out = attachReviewMeta({
      webhookSecret: SECRET,
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      marker: MARKER,
      jobId: "job-1",
      bodyWithoutMeta: body,
      blocks: metaBlocksForContent(lines.slice(0, -1).join("\n")),
      store: store.toRecord().findings.map(storeFindingForMeta),
      blockingGate: false,
    });
    expect(out).toBe(body);
  });

  test("MCP post-processing suppresses via exactText", () => {
    const store = twoBugStore();
    const md = store.toMarkdown();
    const lines = md.split("\n");
    const out = attachUnit({
      comment: lines.slice(0, -1).join("\n"),
      trailer: lines[lines.length - 1] ?? "",
      store: store.toRecord().findings.map(storeFindingForMeta),
      exactText: false,
    });
    expect(countReviewMetaBlocks(out)).toBe(0);
  });

  test("over the cap the block drops keys first, then itself", () => {
    const findings: MetaAssembleFinding[] = [];
    const jobId = `j-${"j".repeat(78)}`;
    for (let i = 0; i < 45; i++) {
      findings.push({
        severity: "bug",
        placement: "body",
        path: "src/a.ts",
        line: 10 + (i % 5),
        proof: false,
        title: `finding ${i}`,
        body: `body ${"x".repeat(30)} ${i}`,
        rendered: `src/a.ts:1: 🔴 bug: finding ${i}\nbody ${i}`,
        ordinal: i + 1,
        sources: 1,
        postedPath: "src/a.ts",
        postedLine: 10 + (i % 5),
        bodyLocationVerified: true,
      });
    }
    const mid = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: "body",
      marker: MARKER,
      jobId,
      findings,
      exactText: true,
    });
    if (mid.ok) {
      // Keys dropped but the typed facts still publish.
      expect(mid.payload.findings.every((entry) => entry.k === null)).toBe(true);
      expect(mid.payload.findings).toHaveLength(45);
    } else {
      expect(mid.suppressed).toBe("size-cap");
    }
    const huge = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: "body",
      marker: MARKER,
      jobId,
      findings: [...findings, ...findings, ...findings, ...findings, ...findings],
      exactText: true,
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.suppressed).toBe("size-cap");
    expect(REVIEW_META_MAX_BYTES).toBe(8192);
  });
});

describe("review meta publication", () => {
  function publishOpts(api: ReturnType<typeof makeReviewApi>) {
    return {
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      expectedHeadSha: "headsha",
      botUsername: "jumi",
      logger: () => undefined,
      api,
    };
  }

  function statefulForge(opts?: { failBatch?: boolean }) {
    const marker = "<!-- jumi-review:kirmanak/demo#7 -->";
    const inlines: InlineComment[] = [];
    let nextId = 101;
    const reviews: unknown[] = [];
    const api = makeReviewApi({
      listPullReviewComments: async () => [...inlines],
      createPullReview: async (_owner, _repo, _index, review) => {
        if (opts?.failBatch && (review.comments?.length ?? 0) > 1) throw new Error("batch rejected");
        reviews.push(review);
        for (const comment of review.comments ?? []) {
          inlines.push({
            id: nextId++,
            body: comment.body,
            user: { login: "jumi" },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            path: comment.path,
            new_position: comment.new_position,
            html_url: `https://example.com/inline/${nextId}`,
          });
        }
        return { id: reviews.length };
      },
    });
    return { api, reviews, inlines, marker };
  }

  test("pull-review shape: empty-body inline review plus a signed summary body", async () => {
    const forge = statefulForge();
    const store = twoBugStore();
    const md = store.toMarkdown();
    const result = await publishReviewResult({
      ...publishOpts(forge.api),
      resultMarkdown: md,
      meta: {
        record: store.toRecord(),
        webhookSecret: SECRET,
        giteaUrl: "https://gitea.example.com",
        jobId: "job-1",
      },
    });
    expect(result).toEqual({ status: "posted" });
    expect(forge.reviews).toHaveLength(2);
    const [inlineReview, summary] = forge.reviews as Array<{
      commit_id: string;
      event: string;
      comments?: Array<{ path: string; new_position: number; body: string }>;
      body?: string;
    }>;
    // Inlines ride in a separate empty-body review on the same commit.
    expect(inlineReview?.commit_id).toBe("headsha");
    expect(inlineReview?.comments).toHaveLength(2);
    expect(inlineReview?.body ?? "").toBe("");
    // The summary body carries the findings list, the trailer, and the block.
    expect(summary?.comments ?? []).toEqual([]);
    expect(summary?.body ?? "").toContain("<!-- jumi-findings-list:start -->");
    expect(countReviewMetaBlocks(summary?.body ?? "")).toBe(1);
    const verified = verifyReviewMeta(summary?.body ?? "", SECRET, {
      forgeIdentity: "gitea.example.com/jumi",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "headsha",
      state: "failure",
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const inlineEntries = verified.payload.findings.filter((entry) => entry.p === "inline");
    expect(inlineEntries).toHaveLength(2);
    expect(inlineEntries[0]).toMatchObject({ k: "k_job-1_1", cid: 101 });
    expect(inlineEntries[1]).toMatchObject({ k: "k_job-1_2", cid: 102 });
    for (const entry of inlineEntries) {
      const live = forge.inlines.find((inline) => inline.id === entry.cid);
      expect(live).toBeDefined();
      expect(entry.cs).toBe(sha256Hex(live?.body ?? ""));
    }
  });

  test("inline bodies are byte-identical with and without the slice", async () => {
    const first = statefulForge();
    const second = statefulForge();
    const store = twoBugStore();
    const md = store.toMarkdown();
    const record = store.toRecord();
    await publishReviewResult({
      ...publishOpts(first.api),
      resultMarkdown: md,
      meta: { record, giteaUrl: "https://gitea.example.com", jobId: "job-1" },
    });
    await publishReviewResult({
      ...publishOpts(second.api),
      resultMarkdown: md,
      meta: { record, webhookSecret: SECRET, giteaUrl: "https://gitea.example.com", jobId: "job-1" },
    });
    const bodies = (forge: typeof first) =>
      (forge.reviews as Array<{ comments?: Array<{ body: string }> }>).flatMap((review) =>
        (review.comments ?? []).map((comment) => comment.body)
      );
    expect(bodies(second)).toEqual(bodies(first));
  });

  test("re-publication reconciles existing inlines and reuses them", async () => {
    const forge = statefulForge();
    const store = twoBugStore();
    const md = store.toMarkdown();
    const marker = "<!-- jumi-review:kirmanak/demo#7 -->";
    // A pre-existing open inline for the first finding, byte-identical.
    forge.inlines.push({
      id: 55,
      body: `🔴 bug: null deref Guard it.\n\n${marker}`,
      user: { login: "jumi" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      path: "src/a.ts",
      new_position: 12,
      html_url: "https://example.com/inline/55",
    });
    const result = await publishReviewResult({
      ...publishOpts(forge.api),
      resultMarkdown: md,
      meta: {
        record: store.toRecord(),
        webhookSecret: SECRET,
        giteaUrl: "https://gitea.example.com",
        jobId: "job-1",
      },
    });
    expect(result).toEqual({ status: "posted" });
    // Only the second finding posts a new inline; the first is reconciled.
    const inlineReviews = (forge.reviews as Array<{ comments?: unknown[] }>).filter(
      (review) => (review.comments ?? []).length > 0
    );
    expect(inlineReviews).toHaveLength(1);
    const summary = (forge.reviews as Array<{ body?: string }>).find((review) => review.body);
    const verified = verifyReviewMeta(summary?.body ?? "", SECRET, {
      forgeIdentity: "gitea.example.com/jumi",
      owner: "kirmanak",
      repo: "demo",
      prNumber: 7,
      headSha: "headsha",
      state: "failure",
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.findings.filter((entry) => entry.p === "inline")).toHaveLength(2);
    expect(verified.payload.findings.find((entry) => entry.cid === 55)?.k).toBe("k_job-1_1");
  });

  test("suggestion cap records dropped_by_cap without a key", async () => {
    const forge = statefulForge();
    const store = suggestionStore(6);
    const md = store.toMarkdown();
    const result = await publishReviewResult({
      ...publishOpts(forge.api),
      resultMarkdown: md,
      meta: {
        record: store.toRecord(),
        webhookSecret: SECRET,
        giteaUrl: "https://gitea.example.com",
        jobId: "job-1",
      },
    });
    expect(result).toEqual({ status: "posted" });
    const summary = (forge.reviews as Array<{ body?: string }>).find((review) => review.body);
    const verified = verifyReviewMeta(summary?.body ?? "", SECRET, { state: "success" });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.findings.filter((entry) => entry.p === "inline")).toHaveLength(5);
    const dropped = verified.payload.findings.filter((entry) => entry.p === "dropped_by_cap");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.k).toBeNull();
  });

  test("individual-retry fallback reaches the same decision as the batch path", async () => {
    const store = twoBugStore();
    const md = store.toMarkdown();
    const publishWith = async (failBatch: boolean) => {
      const forge = statefulForge({ failBatch });
      const result = await publishReviewResult({
        ...publishOpts(forge.api),
        resultMarkdown: md,
        meta: {
          record: store.toRecord(),
          webhookSecret: SECRET,
          giteaUrl: "https://gitea.example.com",
          jobId: "job-1",
        },
      });
      expect(result).toEqual({ status: "posted" });
      return (forge.reviews as Array<{ body?: string }>).find((review) => review.body)?.body ?? "";
    };
    const viaBatch = await publishWith(false);
    const viaRetry = await publishWith(true);
    const blockOf = (body: string) => body.match(/<!-- jumi-review:meta .* -->/)?.[0];
    // Same final live state, so the signed blocks are byte-identical.
    expect(blockOf(viaRetry)).toBe(blockOf(viaBatch));
    expect(verifyReviewMeta(viaRetry, SECRET).ok).toBe(true);
  });

  test("publication dedupe keys only the surviving finding", () => {
    const comment = ["src/a.ts:12: 🔴 bug: same.", "src/a.ts:12: 🔴 bug: same."].join("\n");
    const blocks = metaBlocksForContent(comment);
    expect(blocks).toHaveLength(2);
    const fingerprint = findingFingerprint("src/a.ts", "🔴 bug: same.");
    const built = buildMetaAssembleFindings({
      blocks,
      blockingGate: false,
      marker: MARKER,
      postedFingerprints: new Set([fingerprint]),
      liveInlines: [{ id: 7, path: "src/a.ts", line: 12, body: `🔴 bug: same.\n\n${MARKER}` }],
      expectedBodies: new Map([[fingerprint, `🔴 bug: same.\n\n${MARKER}`]]),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const assembled = assembleReviewMeta(SECRET, {
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      bodyWithoutMeta: comment,
      marker: MARKER,
      jobId: "job-1",
      findings: built.findings,
      exactText: true,
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const inlines = assembled.payload.findings.filter((entry) => entry.p === "inline");
    expect(inlines).toHaveLength(1);
    expect(inlines[0]?.k).toBe("k_job-1_1");
  });

  test("sticky fallback carries a verifying block when the pull review fails", async () => {
    const bodies: string[] = [];
    const api = makeReviewApi({
      createPullReview: async () => {
        throw new Error("pull reviews disabled");
      },
      createIssueComment: async (_owner, _repo, _index, body) => {
        bodies.push(body);
        return { id: 1, body, user: { login: "jumi" }, created_at: "", updated_at: "" };
      },
    });
    const store = twoBugStore();
    const md = store.toMarkdown();
    const result = await publishReviewResult({
      ...publishOpts(api),
      resultMarkdown: md,
      meta: {
        record: store.toRecord(),
        webhookSecret: SECRET,
        giteaUrl: "https://gitea.example.com",
        jobId: "job-1",
      },
    });
    expect(result).toEqual({ status: "posted", commentId: 1 });
    expect(bodies).toHaveLength(1);
    expect(countReviewMetaBlocks(bodies[0] ?? "")).toBe(1);
    expect(verifyReviewMeta(bodies[0] ?? "", SECRET, { state: "failure" }).ok).toBe(true);
  });
});

describe("review meta encoding primitives", () => {
  test("version, info, and digest constants", () => {
    expect(REVIEW_META_VERSION).toBe(1);
    expect(REVIEW_META_HKDF_INFO).toBe("jumi-review-meta-v1");
    expect(REVIEW_META_DIGEST).toBe("sha256");
  });

  test("encode, sign, build, and parse round-trip", () => {
    const severity: MetaSeverity = "bug";
    const subtype: MetaQuestionSubtype = "plain";
    const placement: MetaPlacement = "body";
    const payload: MetaPayload = {
      v: 1,
      forge: IDENTITY,
      repo: `${OWNER}/${REPO}`,
      pr: PR,
      head: HEAD,
      state: "failure",
      md: sha256Hex("body"),
      findings: [{ k: "k_job_1", s: severity, t: subtype, p: placement, proof: 0, o: 1 }],
    };
    const hex = encodeMetaPayload(payload);
    expect(decodeMetaPayload(hex)).toEqual(payload);
    const key = deriveReviewMetaKey(SECRET);
    const sig = signMetaPayload(hex, key);
    const block = buildReviewMetaBlock(hex, sig);
    expect(block).toContain("jumi-review:meta");
    const parsed = parseReviewMetaBlock(block);
    expect(parsed).toEqual({ payloadHex: hex, sigHex: sig });
    const entry: MetaFindingEntry = payload.findings[0] as MetaFindingEntry;
    expect(entry.k).toBe("k_job_1");
  });

  test("severity and subtype classifiers", () => {
    expect(textSeverityOfFinding("src/a.ts:1: 🔴 bug: x.")).toBe("bug");
    expect(textSeverityOfFinding("src/a.ts:1: 🟡 risk: x.")).toBe("risk");
    expect(textSeverityOfFinding("src/a.ts:1: 💡 simpler: x.")).toBe("suggestion");
    expect(textSeverityOfFinding("src/a.ts:1: ❓ q: x?")).toBe("question");
    expect(textSeverityOfFinding("plain prose")).toBe("other");
    expect(questionSubtypeOf(true, false)).toBe("maintainer");
    expect(questionSubtypeOf(false, true)).toBe("blocking");
    expect(questionSubtypeOf(false, false)).toBe("plain");
  });

  test("store finding rendering matches the published line", () => {
    const store: MetaStoreFinding = {
      path: "src/a.ts",
      line: 12,
      severity: "bug",
      title: "null deref",
      body: "Guard it.",
    };
    expect(expectedStoreFindingText(store)).toBe("🔴 bug: null deref Guard it.");
  });
});

describe("review meta compatibility", () => {  const corpus = [
    [
      "src/a.ts:12: 🔴 bug: null deref. Guard it.",
      "src/b.ts:3: 🟡 risk: slow path. Cache it.",
      "<!-- jumi-check: failure; 2 blocking -->",
    ].join("\n"),
    ["src/a.ts:12: ❓ q: is this intentional?", "src/c.ts:7: 💡 simpler: drop it.", "<!-- jumi-check: success -->"].join("\n"),
    [
      "src/a.ts:12: 🔴 bug: quoting jumi-findings-list:start in prose.",
      "  Proof: src/a.ts:12 shows it",
      "src/b.ts:3: 🔴 bug: real.",
      "<!-- jumi-check: failure; 2 blocking -->",
    ].join("\n"),
  ];

  function withMetaBodies() {
    return corpus.map((comment) => {
      const body = `${MARKER}\n### Jumi review\n\nReviewed commit: \`${HEAD}\`\n\n${comment}`;
      return { plain: body, meta: insertReviewMetaBeforeTrailer(body, "<!-- jumi-review:meta v=1 d=ab s=cd -->") };
    });
  }

  test("readers classify identically with and without the block", () => {
    expect(REVIEW_META_DIGEST).toBe("sha256");
    for (const { plain, meta } of withMetaBodies()) {
      expect(parseReviewFindings(meta)).toEqual(parseReviewFindings(plain));
      expect(countBugFindings(meta)).toBe(countBugFindings(plain));
      expect(countRiskFindings(meta)).toBe(countRiskFindings(plain));
      expect(countSuggestionFindings(meta)).toBe(countSuggestionFindings(plain));
      expect(countQuestionFindings(meta)).toBe(countQuestionFindings(plain));
      expect(countMaintainerQuestionFindings(meta)).toBe(countMaintainerQuestionFindings(plain));
      expect(countNonMaintainerQuestionFindings(meta)).toBe(countNonMaintainerQuestionFindings(plain));
      expect(reviewFindingLines(meta)).toEqual(reviewFindingLines(plain));
      expect(parseLastCheckTrailer(meta)).toEqual(parseLastCheckTrailer(plain));
      const lastLine = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
      expect(parseCheckLine(lastLine(meta))).toEqual(parseCheckLine(lastLine(plain)));
      expect(fingerprintFindingIdentityFromParts(meta, [])).toBe(fingerprintFindingIdentityFromParts(plain, []));
      const comment = (body: string): Comment => ({
        id: 1,
        body,
        user: { login: "jumi" },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      });
      const previous = (body: string) =>
        findPreviousReview({ comments: [comment(body)], reviews: [], inlines: [], botUsername: "jumi", marker: MARKER });
      expect(previous(meta)).toEqual(previous(plain));
    }
  });

  test("no secret material in the block, logs, record, or child env", () => {
    const logs: string[] = [];
    const store = twoBugStore();
    const record = store.toRecord();
    expect(JSON.stringify(record)).not.toContain(SECRET);
    const md = store.toMarkdown();
    const lines = md.split("\n");
    const withMeta = attachUnit({
      comment: lines.slice(0, -1).join("\n"),
      trailer: lines[lines.length - 1] ?? "",
      store: record.findings.map(storeFindingForMeta),
      log: (message: string) => logs.push(message),
    });
    expect(withMeta).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(deriveReviewMetaKey(SECRET).toString("hex")).not.toContain(SECRET);
    // The reviewer child env boundary still refuses the webhook secret.
    expect(CHILD_FORBIDDEN_KEYS).toContain("GITEA_WEBHOOK_SECRET");
    expect(findReviewEnvViolations({ GITEA_WEBHOOK_SECRET: SECRET })).toContain("GITEA_WEBHOOK_SECRET");
    expect(auditChildEnv({ GITEA_WEBHOOK_SECRET: SECRET }).forbidden).toContain("GITEA_WEBHOOK_SECRET");
  });

  test("forge identity defaults to host plus bot", () => {
    expect(defaultForgeIdentity("https://gitea.example.com/", "Jumi")).toBe("gitea.example.com/jumi");
    expect(defaultForgeIdentity("https://gitea.example.com", "jumi")).toBe("gitea.example.com/jumi");
  });
});
