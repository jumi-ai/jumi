import { describe, expect, test } from "bun:test";
import { assessMaintainerHoldRelease, isJumiReviewFinding, type ReviewFindingMatchOpts } from "../src/followup.ts";
import { shouldHandoverFollowUp } from "../src/handover.ts";
import { resolveSettledHoldThreads } from "../src/hold_resolve.ts";
import { settleFollowUpHold } from "../src/hold_settlement.ts";
import type { InlineComment } from "../src/ports.ts";
import { tryCarryReview } from "../src/review_carry.ts";
import { type ReviewFallbackReason, type ReviewTrustCtx, resolveReviewFacts } from "../src/review_facts.ts";
import {
  attachPostPullReviewMeta,
  buildReviewMetaBlock,
  deriveReviewMetaKey,
  encodeMetaPayload,
  insertReviewMetaBeforeTrailer,
  type MetaFindingEntry,
  type MetaPayload,
  sha256Hex,
  signMetaPayload,
  stripReviewMeta,
} from "../src/review_meta.ts";
import { MemorySkipLatchStore } from "../src/skip_latches.ts";
import { fingerprintFindingIdentityFromParts, sameFindingDisplayFromParts } from "../src/stuck.ts";
import { markSuggestionHoldConsumed } from "../src/suggestion_hold.ts";
import { findingFingerprint, parseReviewFindings } from "../src/verdict.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeBranch, makeComment, makePR, makeRepo, makeUser } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// Typed review facts: verified signed block drives consumers, text is the
// fallback. Every fixture below signs with SECRET; tampering the secret,
// coordinates, digest, signature, version, or head falls back to text.
// ---------------------------------------------------------------------------

const SECRET = "test-webhook-secret-978";
const ROTATED = "rotated-webhook-secret-978";
const IDENTITY = "gitea.example.com/jumi";
const OWNER = "o";
const REPO = "r";
const PR = 7;
const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const OTHER_HEAD = "feedfacefeedfacefeedfacefeedfacefeedface";
const MARKER = "<!-- jumi-review:o/r#7 -->";
const BOT = "jumi";
const SUCCESS_TRAILER = "<!-- jumi-check: success -->";
const FAIL_TRAILER = "<!-- jumi-check: failure; 1 blocking -->";

function stickyBody(findingsText: string, trailer: string, head: string = HEAD): string {
  const inner = findingsText.trim() ? `${findingsText}\n\n` : "";
  return `${MARKER}\n### Jumi review\n\nReviewed commit: \`${head}\`\n\n${inner}${trailer}`;
}

function signBody(
  bodyWithoutMeta: string,
  findings: MetaFindingEntry[],
  opts: {
    head?: string;
    forge?: string;
    repo?: string;
    pr?: number;
    version?: number;
    secret?: string;
    state?: "success" | "failure";
    tamperSig?: boolean;
  } = {}
): string {
  const payload: MetaPayload = {
    v: (opts.version ?? 1) as 1,
    forge: opts.forge ?? IDENTITY,
    repo: opts.repo ?? `${OWNER}/${REPO}`,
    pr: opts.pr ?? PR,
    head: opts.head ?? HEAD,
    state: opts.state ?? "failure",
    md: sha256Hex(bodyWithoutMeta),
    findings,
  };
  const hex = encodeMetaPayload(payload);
  const sig = signMetaPayload(hex, deriveReviewMetaKey(opts.secret ?? SECRET));
  const version = opts.version ?? 1;
  const block =
    version === 1 ? buildReviewMetaBlock(hex, sig) : `<!-- jumi-review:meta v=${version} d=${hex} s=${sig} -->`;
  const finalSig = opts.tamperSig ? `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}` : sig;
  const finalBlock = version === 1 && opts.tamperSig ? buildReviewMetaBlock(hex, finalSig) : block;
  return insertReviewMetaBeforeTrailer(bodyWithoutMeta, finalBlock);
}

function bodyEntry(
  severity: MetaFindingEntry["s"],
  path: string,
  line: number,
  ordinal: number,
  subtype?: MetaFindingEntry["t"]
): MetaFindingEntry {
  return {
    k: `k_job-1_${ordinal}`,
    s: severity,
    ...(subtype ? { t: subtype } : {}),
    p: "body",
    path,
    line,
    proof: 0,
    o: ordinal,
  };
}

function inlineEntry(
  severity: MetaFindingEntry["s"],
  cid: number,
  liveBody: string,
  path: string,
  line: number,
  subtype?: MetaFindingEntry["t"]
): MetaFindingEntry {
  return {
    k: null,
    s: severity,
    ...(subtype ? { t: subtype } : {}),
    p: "inline",
    path,
    line,
    proof: 0,
    cid,
    cs: sha256Hex(liveBody),
  };
}

function liveInline(id: number, body: string, path = "src/a.ts", line = 12): InlineComment {
  return {
    id,
    body: `${body}\n\n${MARKER}`,
    user: { login: BOT },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    path,
    new_position: line,
  } as InlineComment;
}

function testTrust(
  head: string = HEAD,
  extra: Partial<ReviewTrustCtx> = {}
): { trust: ReviewTrustCtx; logs: string[]; lastReason: () => ReviewFallbackReason | undefined } {
  const logs: string[] = [];
  const lastReason = (): ReviewFallbackReason | undefined => {
    const match = logs
      .slice()
      .reverse()
      .map((line) => /reason=([a-z-]+)/.exec(line)?.[1])
      .find(Boolean);
    return match as ReviewFallbackReason | undefined;
  };
  return {
    logs,
    lastReason,
    trust: {
      webhookSecret: SECRET,
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: head,
      log: (message: string) => logs.push(message),
      ...extra,
    },
  };
}

function matchOpts(author?: string, blocking?: readonly string[]): ReviewFindingMatchOpts {
  return {
    ...(author ? { prAuthor: author } : {}),
    ...(blocking ? { blockingQuestionAuthors: blocking } : {}),
  };
}

describe("review facts switch: verification matrix", () => {
  const body = stickyBody("src/a.ts:12: 🔴 Null deref on empty input.", FAIL_TRAILER);
  const findings = [bodyEntry("bug", "src/a.ts", 12, 1)];

  test("verified block resolves typed", () => {
    const { trust, logs } = testTrust();
    const resolved = resolveReviewFacts({ body: signBody(body, findings), trust });
    expect(resolved.source).toBe("typed");
    expect(resolved.reason).toBeUndefined();
    expect(resolved.facts.bugCount).toBe(1);
    expect(logs.some((line) => line.includes("source=typed"))).toBe(true);
  });

  test("tampered signature falls back with bad-signature", () => {
    const { trust, logs } = testTrust();
    const resolved = resolveReviewFacts({ body: signBody(body, findings, { tamperSig: true }), trust });
    expect(resolved.source).toBe("text");
    expect(resolved.reason).toBe("bad-signature");
    expect(logs.some((line) => line.includes("source=text reason=bad-signature"))).toBe(true);
  });

  test("wrong repo falls back with identity-mismatch", () => {
    const { trust, logs, lastReason } = testTrust();
    const signed = signBody(body, findings, { repo: "o/other" });
    const resolved = resolveReviewFacts({ body: signed, trust });
    expect(resolved.source).toBe("text");
    expect(resolved.reason).toBe("identity-mismatch");
    expect(lastReason()).toBe("identity-mismatch");
    expect(logs.some((line) => line.includes("identity-mismatch"))).toBe(true);
  });

  test("wrong pr falls back with identity-mismatch", () => {
    const { trust } = testTrust();
    const resolved = resolveReviewFacts({ body: signBody(body, findings, { pr: 8 }), trust });
    expect(resolved.source).toBe("text");
    expect(resolved.reason).toBe("identity-mismatch");
  });

  test("wrong forge identity falls back with identity-mismatch", () => {
    const { trust } = testTrust();
    const resolved = resolveReviewFacts({ body: signBody(body, findings, { forge: "other.example.com/jumi" }), trust });
    expect(resolved.source).toBe("text");
    expect(resolved.reason).toBe("identity-mismatch");
  });

  test("one body character edit fails the digest with digest-mismatch", () => {
    const { trust, logs } = testTrust();
    const signed = signBody(body, findings).replace("Null deref", "Null dereff");
    const resolved = resolveReviewFacts({ body: signed, trust });
    expect(resolved.source).toBe("text");
    expect(resolved.reason).toBe("digest-mismatch");
    expect(logs.some((line) => line.includes("digest-mismatch"))).toBe(true);
  });

  test("unknown version falls back with bad-version", () => {
    const { trust } = testTrust();
    const resolved = resolveReviewFacts({ body: signBody(body, findings, { version: 2 }), trust });
    expect(resolved.source).toBe("text");
    expect(resolved.reason).toBe("bad-version");
  });

  test("unsigned artifact falls back with no-block", () => {
    const { trust, logs } = testTrust();
    const resolved = resolveReviewFacts({ body, trust });
    expect(resolved.source).toBe("text");
    expect(resolved.reason).toBe("no-block");
    expect(logs.some((line) => line.includes("source=text reason=no-block"))).toBe(true);
  });

  test("head rule: signed head equal to evaluated head verifies", () => {
    const { trust } = testTrust(HEAD);
    const resolved = resolveReviewFacts({ body: signBody(body, findings), trust });
    expect(resolved.source).toBe("typed");
  });

  test("head rule: unrelated head falls back with head-rule", () => {
    const { trust, logs } = testTrust(OTHER_HEAD);
    const resolved = resolveReviewFacts({ body: signBody(body, findings), trust });
    expect(resolved.source).toBe("text");
    expect(resolved.reason).toBe("head-rule");
    expect(resolved.payload?.head).toBe(HEAD);
    expect(logs.some((line) => line.includes("source=text reason=head-rule"))).toBe(true);
  });

  test("head rule: verified ancestor verifies for carry", () => {
    const { trust } = testTrust(OTHER_HEAD, { ancestorOk: true });
    const resolved = resolveReviewFacts({ body: signBody(body, findings), trust });
    expect(resolved.source).toBe("typed");
  });

  test("secret rotation falls back to text and never throws", () => {
    const { trust } = testTrust(HEAD, { webhookSecret: ROTATED });
    let resolved;
    expect(() => {
      resolved = resolveReviewFacts({ body: signBody(body, findings), trust });
    }).not.toThrow();
    expect(resolved!.source).toBe("text");
    expect(resolved!.reason).toBe("bad-signature");
    expect(() =>
      assessMaintainerHoldRelease({
        reviewBody: signBody(body, findings),
        inlines: [],
        holdEnabled: true,
        trust: trust,
      })
    ).not.toThrow();
    expect(() =>
      shouldHandoverFollowUp({ published: { status: "posted" }, markdown: signBody(body, findings), trust })
    ).not.toThrow();
  });
});

describe("review facts switch: accepted-change fixtures", () => {
  test("🔴.ts suggestion: typed holds nothing, legacy misreads a bug", () => {
    const raw = stickyBody(
      "🔴.ts:2: 💡 simpler: Tidy this helper.\nsrc/e.ts:4: ❓ maintainer: File the upstream issue?",
      SUCCESS_TRAILER
    );
    const entries = [bodyEntry("suggestion", "🔴.ts", 2, 1), bodyEntry("question", "src/e.ts", 4, 2, "maintainer")];
    const signed = signBody(raw, entries, { state: "success" });
    const { trust, logs } = testTrust();
    const typed = resolveReviewFacts({ body: signed, trust });
    expect(typed.source).toBe("typed");
    expect(typed.facts.openBugs).toBe(0);
    const assessment = assessMaintainerHoldRelease({
      reviewBody: signed,
      inlines: [],
      holdEnabled: true,
      trust,
    });
    expect(assessment.releasable).toBe(true);
    expect(logs.some((line) => line.includes("source=typed"))).toBe(true);
    // Legacy outcome with the block removed: the path text misreads a bug.
    const legacy = resolveReviewFacts({ body: stripReviewMeta(signed) });
    expect(legacy.source).toBe("text");
    expect(legacy.facts.openBugs).toBe(1);
    expect(
      assessMaintainerHoldRelease({ reviewBody: stripReviewMeta(signed), inlines: [], holdEnabled: true }).releasable
    ).toBe(false);
  });

  test("severity-less legacy finding uses the stored severity for latch inputs", () => {
    const raw = stickyBody("src/a.ts:12: Null deref on empty input.", FAIL_TRAILER);
    const signed = signBody(raw, [bodyEntry("bug", "src/a.ts", 12, 1)]);
    const { trust } = testTrust();
    const typed = resolveReviewFacts({ body: signed, trust });
    expect(typed.source).toBe("typed");
    expect(typed.facts.bugCount).toBe(1);
    expect(fingerprintFindingIdentityFromParts(signed, [], trust)).toBeDefined();
    expect(sameFindingDisplayFromParts(signed, [], trust)).toContain("🔴");
    // Legacy: the severity-less line classifies nothing and latches nothing.
    const legacyBody = stripReviewMeta(signed);
    expect(fingerprintFindingIdentityFromParts(legacyBody, [])).toBeUndefined();
    expect(sameFindingDisplayFromParts(legacyBody, [])).toBeUndefined();
  });

  test("inline reused at a different line follows the signed location", () => {
    const findingText = "🔴 Null deref on empty input.";
    const live = liveInline(201, findingText, "src/a.ts", 30);
    const raw = stickyBody("", SUCCESS_TRAILER);
    const signed = signBody(raw, [inlineEntry("bug", 201, live.body ?? "", "src/a.ts", 12)], { state: "success" });
    const { trust } = testTrust();
    const typed = resolveReviewFacts({ body: signed, inlines: [live], carryMarker: MARKER, trust });
    expect(typed.source).toBe("typed");
    const inlineFact = typed.facts.findings.find((finding) => finding.placement === "inline");
    expect(inlineFact?.line).toBe(12);
    expect(inlineFact?.severity).toBe("bug");
    expect(typed.facts.openBugs).toBe(1);
    expect(typed.facts.carryLines).toContain(`src/a.ts:12: ${findingText}`);
    // Legacy follows the comment's current position and still counts the bug.
    const legacy = resolveReviewFacts({ body: stripReviewMeta(signed), inlines: [live], carryMarker: MARKER });
    expect(legacy.facts.findings.find((finding) => finding.placement === "inline")?.line).toBe(30);
  });

  test("rollback/dedupe artifact: identical findings collapse but keep the stored severity", () => {
    const raw = stickyBody(
      "src/a.ts:12: Null deref on empty input.\nsrc/a.ts:12: Null deref on empty input.",
      FAIL_TRAILER
    );
    const signed = signBody(raw, [bodyEntry("bug", "src/a.ts", 12, 1), bodyEntry("bug", "src/a.ts", 12, 2)]);
    const { trust } = testTrust();
    const typed = resolveReviewFacts({ body: signed, trust });
    expect(typed.source).toBe("typed");
    expect(typed.facts.bugCount).toBe(2);
    // Both producers collapse identical findings to one latch identity;
    // only the typed one recovers the severity the text parser could not see.
    expect(typed.facts.findingIdentities).toHaveLength(1);
    const legacy = resolveReviewFacts({ body: stripReviewMeta(signed) });
    expect(legacy.facts.bugCount).toBe(0);
    expect(legacy.facts.findingIdentities).toHaveLength(0);
  });
});

describe("review facts switch: wake and blocking questions", () => {
  const raw = stickyBody("src/d.ts:9: Should this retry on 429s?", SUCCESS_TRAILER);
  const entries = [bodyEntry("question", "src/d.ts", 9, 1, "blocking")];

  test("verified blocking question wakes a follow-up worker", () => {
    const signed = signBody(raw, entries, { state: "success" });
    const { trust, logs } = testTrust();
    const wake = isJumiReviewFinding(
      { body: signed, user: { login: BOT } },
      HEAD,
      { ...matchOpts("alice", ["alice"]), trust },
      BOT
    );
    expect(wake).toBe(true);
    expect(logs.some((line) => line.includes("source=typed"))).toBe(true);
    // One body character edited: digest fails, legacy sees no finding, no wake.
    const edited = signed.replace("Should this retry", "Should this ret impact retry");
    const { trust: trust2, logs: logs2 } = testTrust();
    expect(
      isJumiReviewFinding(
        { body: edited, user: { login: BOT } },
        HEAD,
        { ...matchOpts("alice", ["alice"]), trust: trust2 },
        BOT
      )
    ).toBe(false);
    expect(logs2.some((line) => line.includes("source=text reason=digest-mismatch"))).toBe(true);
  });

  test("verified maintainer-only review stays with the maintainer", async () => {
    const { isMaintainerOnlyTrailer } = await import("../src/handover.ts");
    const raw = stickyBody("src/e.ts:4: Please file the upstream issue?", SUCCESS_TRAILER);
    const signed = signBody(raw, [bodyEntry("question", "src/e.ts", 4, 1, "maintainer")], { state: "success" });
    const { trust } = testTrust();
    expect(isMaintainerOnlyTrailer(signed, null, trust)).toBe(true);
    expect(isMaintainerOnlyTrailer(stripReviewMeta(signed))).toBe(false);
  });

  test("verified blocking question hands over", () => {
    const signed = signBody(raw, entries, { state: "success" });
    const { trust } = testTrust();
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: signed,
        prAuthor: "alice",
        blockingQuestionAuthors: ["alice"],
        trust,
      })
    ).toBe(true);
    expect(
      shouldHandoverFollowUp({
        published: { status: "posted" },
        markdown: stripReviewMeta(signed),
        prAuthor: "alice",
        blockingQuestionAuthors: ["alice"],
      })
    ).toBe(false);
  });
});

describe("review facts switch: mixed artifacts verify per artifact", () => {
  test("first verified, second unsigned resolve independently", () => {
    const verifiedBody = stickyBody("src/a.ts:12: 🔴 Null deref on empty input.", FAIL_TRAILER);
    const verified = signBody(verifiedBody, [bodyEntry("bug", "src/a.ts", 12, 1)]);
    const unsigned = stickyBody("src/b.ts:3: 🟡 Slow query on cold cache.", FAIL_TRAILER);
    const { trust, logs } = testTrust();
    const first = resolveReviewFacts({ body: verified, trust });
    const second = resolveReviewFacts({ body: unsigned, trust });
    expect(first.source).toBe("typed");
    expect(second.source).toBe("text");
    expect(second.reason).toBe("no-block");
    expect(logs.filter((line) => line.includes("source=typed"))).toHaveLength(1);
    expect(logs.filter((line) => line.includes("source=text reason=no-block"))).toHaveLength(1);
    // One failed verification never invalidates the other artifact.
    const { trust: retryTrust } = testTrust();
    expect(resolveReviewFacts({ body: verified, trust: retryTrust }).source).toBe("typed");
  });

  test("two newer reviews each drive the wake predicate from their own source", () => {
    const verifiedBody = stickyBody("src/a.ts:12: 🔴 Null deref on empty input.", FAIL_TRAILER);
    const verified = signBody(verifiedBody, [bodyEntry("bug", "src/a.ts", 12, 1)]);
    const unsigned = stickyBody("All clear.", SUCCESS_TRAILER);
    const { trust, logs } = testTrust();
    const findingOpts = (t: ReviewTrustCtx): ReviewFindingMatchOpts => ({ trust: t });
    expect(isJumiReviewFinding({ body: verified, user: { login: BOT } }, HEAD, findingOpts(trust), BOT)).toBe(true);
    expect(isJumiReviewFinding({ body: unsigned, user: { login: BOT } }, HEAD, findingOpts(trust), BOT)).toBe(false);
    expect(logs.filter((line) => line.includes("source=typed"))).toHaveLength(1);
    expect(logs.filter((line) => line.includes("source=text"))).toHaveLength(1);
  });
});

describe("review facts switch: edited inline classified from text", () => {
  test("a digest mismatch on one inline leaves verified siblings untouched", () => {
    const bugText = "🔴 Null deref on empty input.";
    const editedLive = liveInline(302, "💡 simpler: Tidy this helper.", "src/b.ts", 3);
    const verifiedLive = liveInline(301, bugText, "src/a.ts", 12);
    const raw = stickyBody("", SUCCESS_TRAILER);
    const signed = signBody(
      raw,
      [
        inlineEntry("bug", 301, verifiedLive.body ?? "", "src/a.ts", 12),
        // Signed over the original bug text; the live body was edited after signing.
        {
          ...inlineEntry("bug", 302, `${bugText}\n\n${MARKER}`, "src/b.ts", 3),
          cs: sha256Hex(`${bugText}\n\n${MARKER}`),
        },
      ],
      { state: "success" }
    );
    const { trust } = testTrust();
    const resolved = resolveReviewFacts({ body: signed, inlines: [verifiedLive, editedLive], trust });
    expect(resolved.source).toBe("typed");
    const byId = new Map(resolved.facts.findings.map((finding) => [finding.inlineId, finding]));
    expect(byId.get(301)?.severity).toBe("bug");
    expect(byId.get(301)?.line).toBe(12);
    expect(byId.get(302)?.severity).toBe("suggestion");
    expect(resolved.facts.openBugs).toBe(1);
  });
});

describe("review facts switch: suppressed block behaves as today", () => {
  test("parent-added finding suppresses the block and falls back silently", async () => {
    const { attachReviewMeta } = await import("../src/review_meta.ts");
    const bodyWithoutMeta = stickyBody("src/a.ts:12: 🔴 Null deref on empty input.", FAIL_TRAILER);
    const body = attachReviewMeta({
      webhookSecret: SECRET,
      forgeIdentity: IDENTITY,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      state: "failure",
      marker: MARKER,
      jobId: "job-1",
      bodyWithoutMeta,
      blocks: [],
      blockingGate: false,
      exactText: false,
      exactTextReason: "parent-added finding",
      log: () => undefined,
    });
    expect(body).toBe(bodyWithoutMeta);
    expect(body).not.toContain("jumi-review:meta");
    const { trust, logs } = testTrust();
    const resolved = resolveReviewFacts({ body, trust });
    expect(resolved.source).toBe("text");
    expect(resolved.reason).toBe("no-block");
    expect(logs.some((line) => line.includes("source=text reason=no-block"))).toBe(true);
    expect(resolved.facts.openBugs).toBe(1);
  });
});

describe("review facts switch: hold resolve from typed entries", () => {
  test("verified suggestion in a 🔴-named file resolves, typed bug does not", async () => {
    const suggestionLive = liveInline(401, "💡 simpler: Tidy this helper.", "🔴.ts", 2);
    const bugLive = liveInline(402, "🔴 Null deref on empty input.", "src/a.ts", 12);
    const raw = stickyBody("", FAIL_TRAILER);
    const signed = signBody(raw, [
      inlineEntry("suggestion", 401, suggestionLive.body ?? "", "🔴.ts", 2),
      inlineEntry("bug", 402, bugLive.body ?? "", "src/a.ts", 12),
    ]);
    const resolvedCalls: Array<{ id: number }> = [];
    const api = {
      resolvePullComment: async (_owner: string, _repo: string, id: number) => {
        resolvedCalls.push({ id });
      },
    };
    const { trust, logs } = testTrust();
    const outcome = await resolveSettledHoldThreads({
      api,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      inlines: [suggestionLive, bugLive],
      botUsername: BOT,
      log: (message: string) => logs.push(message),
      reviewBody: signed,
      trust,
    });
    expect(outcome).toEqual({ resolved: 1, failed: 0, permission: false });
    expect(resolvedCalls).toEqual([{ id: 401 }]);
    expect(logs.some((line) => line.includes("source=typed"))).toBe(true);
    // Legacy text: the 🔴 path misreads as a bug, so nothing resolves.
    const legacy = await resolveSettledHoldThreads({
      api: { resolvePullComment: async () => {} },
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      inlines: [suggestionLive, bugLive],
      botUsername: BOT,
    });
    expect(legacy).toEqual({ resolved: 0, failed: 0, permission: false });
  });
});

describe("review facts switch: hold settlement from typed entries", () => {
  const SUMMARY_ID = 4110;
  const INLINE_ID = 4109;
  const SETTLE_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  function settleSummary(findingsList: string): string {
    return [
      MARKER,
      "### Jumi review",
      "",
      `Reviewed commit: \`${SETTLE_HEAD}\``,
      "",
      "<!-- jumi-findings-list:start -->",
      ...findingsList.split("\n"),
      "<!-- jumi-findings-list:end -->",
      "",
      SUCCESS_TRAILER,
    ].join("\n");
  }

  function settleReviews(summaryBody: string) {
    return [
      {
        id: INLINE_ID,
        body: "",
        user: makeUser({ login: BOT }),
        commit_id: SETTLE_HEAD,
        submitted_at: "2026-11-19T18:29:19Z",
        updated_at: "2026-11-19T18:29:19Z",
      },
      {
        id: SUMMARY_ID,
        body: summaryBody,
        user: makeUser({ login: BOT }),
        commit_id: SETTLE_HEAD,
        submitted_at: "2026-11-19T18:29:20Z",
        updated_at: "2026-11-19T18:29:20Z",
      },
    ];
  }

  function settlePr() {
    const repo = makeRepo();
    return makePR({
      number: PR,
      title: "Fix the thing",
      body: "Fixes #12",
      user: makeUser({ login: BOT }),
      head: { label: "o:jumi/issue-1-fix", ref: "jumi/issue-1-fix", sha: SETTLE_HEAD, repo, repo_id: repo.id },
    });
  }

  async function settleApi(
    statuses: Array<{ state: string; description?: string }>,
    summaryBody: string,
    inlines: unknown[],
    resolvedIds: number[]
  ) {
    const human = makeComment({ id: 55, body: "answered, thanks", user: makeUser({ login: "alice" }) });
    return makeIssueApi({
      listOpenPulls: async () => [settlePr()],
      getPR: async () => settlePr(),
      listIssueComments: async () => [human],
      listPullReviews: async () => settleReviews(summaryBody),
      listPullReviewComments: async () => inlines,
      createCommitStatus: async (_o: string, _r: string, _s: string, status: never) => {
        statuses.push(status as never);
        return status as never;
      },
      resolvePullComment: async (_o: string, _r: string, id: number) => {
        resolvedIds.push(id);
      },
      getRepoFile: async () => ({ found: false }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listCommitStatuses: async () => [],
    } as never);
  }

  async function settleHold() {
    const store = new MemorySkipLatchStore();
    await markSuggestionHoldConsumed(store, { owner: OWNER, repo: REPO, issueNumber: 12 }, SETTLE_HEAD, 2);
    return store;
  }

  const latchKey = { owner: OWNER, repo: REPO, issueNumber: 12 };

  test("verified block releases a hold the legacy parser keeps", async () => {
    const maintainerLive = {
      ...makeComment({
        id: 9001,
        body: `❓ maintainer: please file the follow-up issue?\n\n${MARKER}`,
        user: makeUser({ login: BOT }),
      }),
      path: "src/foo.ts",
      new_position: 73,
      pull_request_review_id: INLINE_ID,
    };
    const suggestionLive = {
      ...makeComment({
        id: 9002,
        body: `💡 simpler: extract a helper\n\n${MARKER}`,
        user: makeUser({ login: BOT }),
      }),
      path: "🔴.ts",
      new_position: 10,
      pull_request_review_id: INLINE_ID,
    };
    const summary = settleSummary(
      "- 💡 [`🔴.ts:10`](https://example.test): extract a helper\n- ❓ [`src/foo.ts:73`](https://example.test): maintainer: please file the follow-up issue?"
    );
    const signed = signBody(
      summary,
      [
        inlineEntry("suggestion", 9002, suggestionLive.body ?? "", "🔴.ts", 10),
        inlineEntry("question", 9001, maintainerLive.body ?? "", "src/foo.ts", 73, "maintainer"),
      ],
      { head: SETTLE_HEAD, state: "success" }
    );
    const statuses: Array<{ state: string; description?: string }> = [];
    const resolvedIds: number[] = [];
    const api = await settleApi(statuses, signed, [maintainerLive, suggestionLive], resolvedIds);
    const logged: string[] = [];
    await settleFollowUpHold({
      api,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      latches: await settleHold(),
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      botUsername: BOT,
      defaultBranch: "main",
      log: (message) => logged.push(message),
      trust: {
        webhookSecret: SECRET,
        forgeIdentity: IDENTITY,
        owner: OWNER,
        repo: REPO,
        prNumber: PR,
        log: (message) => logged.push(message),
      },
    });
    expect(statuses.filter((status) => status.state === "success")).toHaveLength(1);
    expect(resolvedIds.sort()).toEqual([9001, 9002]);
    expect(logged.some((line) => line.includes("source=typed"))).toBe(true);
    // Same artifact with one body character edited: digest fails, the 🔴 path
    // misreads as a bug, and the hold is kept.
    const edited = signed.replace("extract a helper", "extract a helpers");
    const keptStatuses: Array<{ state: string; description?: string }> = [];
    const keptResolved: number[] = [];
    const keptApi = await settleApi(keptStatuses, edited, [maintainerLive, suggestionLive], keptResolved);
    const keptLogged: string[] = [];
    await settleFollowUpHold({
      api: keptApi,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      latches: await settleHold(),
      latchKey,
      intent: { kind: "completed" },
      trigger: { event: "issue_comment", commentId: 55, sender: "alice" },
      botUsername: BOT,
      defaultBranch: "main",
      log: (message) => keptLogged.push(message),
      trust: {
        webhookSecret: SECRET,
        forgeIdentity: IDENTITY,
        owner: OWNER,
        repo: REPO,
        prNumber: PR,
        log: (message) => keptLogged.push(message),
      },
    });
    expect(keptStatuses).toHaveLength(0);
    expect(keptResolved).toHaveLength(0);
    expect(keptLogged.some((line) => line.includes("source=text reason=digest-mismatch"))).toBe(true);
  });
});

describe("review facts switch: carry open-blocker check", () => {
  const P1 = "a".repeat(40);
  const P2 = "b".repeat(40);
  const MERGE = "c".repeat(40);
  const TREE = "e".repeat(40);
  const CARRY_MARKER = MARKER;

  function carryGit(opts: { p1?: string; failParents?: boolean } = {}): GitRunner {
    return (async (args: string[]) => {
      if (args[0] === "rev-list") {
        if (opts.failParents) throw new Error("missing objects");
        return `${MERGE} ${opts.p1 ?? P1} ${P2}`;
      }
      if (args[0] === "rev-parse") return TREE;
      if (args[0] === "merge-tree") return TREE;
      if (args[0] === "diff" && args.includes("--name-only")) return "src/target.ts";
      if (args[0] === "log") return "";
      if (args[0] === "diff") return "";
      throw new Error(`unexpected git ${args.join(" ")}`);
    }) as GitRunner;
  }

  async function runCarryTest(opts: {
    previousBody: string;
    trust?: ReviewTrustCtx;
    git?: GitRunner;
  }): Promise<{ published: string[]; carried: string | undefined }> {
    const published: string[] = [];
    const carried = await tryCarryReview({
      settingsEnabled: true,
      comments: [makeComment({ id: 50, body: opts.previousBody })],
      reviews: [],
      inlines: [],
      botUsername: BOT,
      marker: CARRY_MARKER,
      headSha: MERGE,
      targetBranch: "main",
      pullFilenames: ["src/pr.ts"],
      git: opts.git ?? carryGit(),
      cwd: "/tmp",
      env: {},
      reviewLabel: "o/r#7",
      persist: async () => undefined,
      publish: async (markdown) => {
        published.push(markdown);
        return "carried";
      },
      ...(opts.trust ? { trust: opts.trust } : {}),
    });
    return { published, carried };
  }

  test("verified ancestor carries a review the legacy parser refuses", async () => {
    const previous = stickyBody("🔴.ts:2: 💡 simpler: Tidy this helper.", SUCCESS_TRAILER, P1);
    const signed = signBody(previous, [bodyEntry("suggestion", "🔴.ts", 2, 1)], { head: P1, state: "success" });
    const { trust, logs } = testTrust(MERGE);
    const { published, carried } = await runCarryTest({ previousBody: signed, trust });
    expect(carried).toBe("carried");
    expect(published).toHaveLength(1);
    expect(logs.some((line) => line.includes("source=typed"))).toBe(true);
    // Legacy text: the 🔴 path misreads as an open blocker, so no carry.
    const { published: legacyPublished, carried: legacyCarried } = await runCarryTest({
      previousBody: stripReviewMeta(signed),
      trust,
    });
    expect(legacyCarried).toBeUndefined();
    expect(legacyPublished).toHaveLength(0);
  });

  test("force-pushed head falls back to text and refuses", async () => {
    const previous = stickyBody("🔴.ts:2: 💡 simpler: Tidy this helper.", SUCCESS_TRAILER, P1);
    const signed = signBody(previous, [bodyEntry("suggestion", "🔴.ts", 2, 1)], { head: P1, state: "success" });
    const { trust, logs } = testTrust(MERGE);
    const { published, carried } = await runCarryTest({
      previousBody: signed,
      trust,
      git: carryGit({ p1: "d".repeat(40) }),
    });
    expect(carried).toBeUndefined();
    expect(published).toHaveLength(0);
    expect(logs.some((line) => line.includes("source=text reason=head-rule"))).toBe(true);
  });

  test("ancestry lookup failure never throws and refuses", async () => {
    const previous = stickyBody("🔴.ts:2: 💡 simpler: Tidy this helper.", SUCCESS_TRAILER, P1);
    const signed = signBody(previous, [bodyEntry("suggestion", "🔴.ts", 2, 1)], { head: P1, state: "success" });
    const { trust } = testTrust(MERGE);
    const result = await runCarryTest({ previousBody: signed, trust, git: carryGit({ failParents: true }) });
    expect(result.carried).toBeUndefined();
  });
});

describe("review facts switch: postPullReview shape verifies end to end", () => {
  test("summary body plus empty-body inlines verify and map", async () => {
    const { buildFindingsList, stripFindingLines } = await import("../src/verdict.ts");
    const comment = "src/a.ts:12: 🔴 Null deref on empty input.\n\nsrc/b.ts:3: 💡 simpler: Tidy the helper.";
    const findings = parseReviewFindings(comment);
    expect(findings).toHaveLength(2);
    const posted = new Set([findingFingerprint(findings[0]!.path, findings[0]!.body)]);
    const livePostedBody = `${findings[0]!.body}\n\n${MARKER}`;
    const published = [{ id: 501, path: findings[0]!.path, body: livePostedBody, new_position: 12 }];
    const list = buildFindingsList(findings);
    const failed = stripFindingLines(comment, { posted });
    const topBody = [
      MARKER,
      "### Jumi review",
      "",
      `Reviewed commit: \`${HEAD}\``,
      "",
      [list, failed].filter((part) => part.trim()).join("\n\n"),
      "",
      SUCCESS_TRAILER,
    ].join("\n");
    const finalBody = attachPostPullReviewMeta({
      meta: {
        webhookSecret: SECRET,
        giteaUrl: "https://gitea.example.com",
        forgeIdentity: IDENTITY,
        jobId: "job-1",
        verdictState: "success",
      },
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      marker: MARKER,
      botUsername: BOT,
      topBody,
      comment,
      findings: findings.map((finding) => ({ path: finding.path, line: finding.line, body: finding.body })),
      posted,
      published,
      log: () => undefined,
    });
    const { trust, logs } = testTrust();
    const live: InlineComment[] = [
      {
        id: 501,
        body: livePostedBody,
        user: { login: BOT },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        path: "src/a.ts",
        new_position: 12,
      } as InlineComment,
    ];
    const resolved = resolveReviewFacts({ body: finalBody, inlines: live, trust });
    expect(resolved.source).toBe("typed");
    expect(logs.some((line) => line.includes("source=typed"))).toBe(true);
    const inlineFact = resolved.facts.findings.find((finding) => finding.inlineId === 501);
    expect(inlineFact?.severity).toBe("bug");
    expect(inlineFact?.line).toBe(12);
    expect(resolved.facts.openBugs).toBe(1);
    const bodyFact = resolved.facts.findings.find((finding) => finding.placement === "body");
    expect(bodyFact?.severity).toBe("suggestion");
  });
});
