import { describe, expect, test } from "bun:test";
import { publishReviewResult } from "../src/review.ts";
import {
  BLOCKING_FINDING_OUTCOMES,
  BLOCKING_FINDING_SEVERITIES,
  type BlockingFinding,
  type BlockingFindingOutcome,
  type BlockingFindingSeverity,
  blockingSeverityOf,
  classifyBlockingFindings,
  FINDING_RESPONSE_STATUSES,
  filterBlockingFindings,
  isBlockingFindingOutcome,
  isFindingTouched,
  isSameBlockingFinding,
  MAX_FINDING_RESPONSE_REASON_CHARS,
  normalizeFindingForge,
  normalizeFindingOutcome,
  normalizeFindingRunner,
  normalizeFindingSeverity,
  parseBlockingFindings,
  parseFindingResponseSelector,
  persistFindingResponses,
  touchedFromFilenames,
  validateFindingResponse,
} from "../src/review_findings.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { renderLedgerMetrics } from "../src/run_usage.ts";
import { WorkerResultStore } from "../src/worker_mcp.ts";
import { forEachForge, makeReviewApi } from "./fakes/forge.ts";
import { makeFile } from "./fixtures.ts";

function finding(path: string, line: number, body: string): BlockingFinding {
  const severity = body.startsWith("🔴") || /^bug:/i.test(body.replace(/^🔴\s*/, "")) ? "bug" : "risk";
  return { path, line, body, severity: severity as "bug" | "risk" };
}

forEachForge("blocking finding outcomes are recorded per forge", (preset) => {
  const forge = preset.name;
  const prev: BlockingFinding[] = [
    finding("src/a.ts", 10, "🔴 bug: null deref. Guard it."),
    finding("src/b.ts", 20, "🟡 risk: race on retry."),
    finding("src/c.ts", 30, "🔴 bug: off by one. Fix the loop."),
    finding("src/d.ts", 40, "🟡 risk: slow query."),
  ];
  const curr: BlockingFinding[] = [
    finding("src/c.ts", 30, "🔴 bug: off by one. Fix the loop bound."),
    finding("src/e.ts", 50, "🔴 bug: new issue."),
  ];
  const touched = { paths: new Set(["src/a.ts", "src/c.ts", "src/e.ts"]), lines: new Map() };

  const classified = classifyBlockingFindings(prev, curr, touched);
  const byPath = new Map(classified.map((entry) => [entry.prev.path, entry.outcome]));
  expect(byPath.get("src/a.ts")).toBe("fixed");
  expect(byPath.get("src/b.ts")).toBe("dismissed");
  expect(byPath.get("src/c.ts")).toBe("repeated");
  expect(byPath.get("src/d.ts")).toBe("dismissed");
  expect(normalizeFindingForge(forge)).toBe(forge === "github" ? "github" : "gitea");
  expect(normalizeFindingRunner("_Jumi · opencode · x_")).toBe("opencode");
});

forEachForge("publish records fixed/dismissed/repeated and merge settles open_at_merge", async (preset) => {
  const forge = preset.name;
  const store = new MemoryReviewJobStore();
  const previous = [
    "src/a.ts:10: 🔴 bug: null deref. Guard it.",
    "src/b.ts:20: 🟡 risk: race on retry.",
    "src/c.ts:30: 🔴 bug: off by one. Fix the loop.",
  ];
  const markdown = [
    "src/c.ts:30: 🔴 bug: off by one. Fix the loop bound.",
    "<!-- jumi-check: failure; 1 blocking -->",
  ].join("\n");
  const api = makeReviewApi({
    capabilities: preset.capabilities,
    getPRFiles: async () => [makeFile({ filename: "src/a.ts" }), makeFile({ filename: "src/c.ts" })],
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    createPullReview: async () => ({ id: 1 }),
  });
  await publishReviewResult({
    api,
    owner: "kirmanak",
    repo: "demo",
    prNumber: 7,
    expectedHeadSha: "headsha",
    botUsername: "jumi",
    logger: () => undefined,
    forgeKind: forge,
    resultRunner: "_Jumi · opencode · x_",
    resultMarkdown: markdown,
    previousFindings: previous,
    changedFiles: [{ filename: "src/a.ts" }, { filename: "src/c.ts" }],
    recordFindings: async (rows) => {
      await store.recordReviewFindings(rows);
    },
  });
  const totals = await store.getReviewFindingTotals();
  const outcomes = new Map(totals.map((row) => [`${row.severity}:${row.outcome}`, row.count]));
  // src/a.ts touched -> fixed, src/b.ts untouched -> dismissed, src/c.ts still present -> repeated.
  expect(outcomes.get("bug:fixed") ?? 0).toBe(1);
  expect(outcomes.get("risk:dismissed") ?? 0).toBe(1);
  expect(outcomes.get("bug:repeated") ?? 0).toBe(1);

  const settled = await store.markFindingsOpenAtMerge("kirmanak", "demo", 7);
  expect(settled).toBe(1);
  const after = await store.getReviewFindingTotals();
  const openAtMerge = after.find((row) => row.outcome === "open_at_merge");
  expect(openAtMerge?.count).toBe(1);

  const text = await renderLedgerMetrics(store);
  expect(text).toContain('jumi_review_findings_total{runner="opencode"');
  expect(text).toContain('outcome="fixed"');
  expect(text).toContain('outcome="dismissed"');
  expect(text).toContain('outcome="open_at_merge"');
});

forEachForge("unmatched findings and structured worker pushback are recorded", async (preset) => {
  const forge = preset.name;
  const store = new MemoryReviewJobStore();
  const prev: BlockingFinding[] = [{ path: "", line: 0, body: "🔴 bug: stray marker.", severity: "bug" }];
  const classified = classifyBlockingFindings(prev, [], touchedFromFilenames([]));
  expect(classified[0]?.outcome).toBe("unmatched");
  await store.recordReviewFindings([
    {
      forge,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 9,
      severity: "bug",
      reviewerRunner: "opencode",
      writerRunner: "claude",
      reviewRound: 2,
      outcome: classified[0]?.outcome ?? "unmatched",
      fingerprint: classified[0]?.fingerprint ?? "fp",
      path: "",
      line: 0,
    },
  ]);

  // Structured pushback: unchanged with a reason validates and records.
  const worker = new WorkerResultStore();
  const validated = validateFindingResponse({
    finding: "src/a.ts:10: 🔴 bug: null deref.",
    status: "unchanged",
    reason: "The pointer cannot be null on this path; callers guard it.",
  });
  expect(validated.ok).toBe(true);
  if (validated.ok) {
    expect(worker.setFindingResponse(validated).ok).toBe(true);
  }
  expect(worker.hasFindingResponses()).toBe(true);
  expect(worker.getFindingResponses()).toHaveLength(1);

  const bad = validateFindingResponse({ finding: "x", status: "unchanged", reason: "" });
  expect(bad.ok).toBe(false);

  // Record the pushback against a real row (fingerprint match wins).
  await store.recordReviewFindings([
    {
      forge,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 9,
      severity: "bug",
      reviewerRunner: "opencode",
      writerRunner: "",
      reviewRound: 2,
      outcome: "repeated",
      fingerprint: "src/a.ts:10:fp",
      path: "src/a.ts",
      line: 10,
    },
  ]);
  const updated = await store.recordFindingResponse({
    owner: "kirmanak",
    repo: "demo",
    prNumber: 9,
    fingerprint: "src/a.ts:10:fp",
    status: "unchanged",
    reason: "Callers guard the pointer.",
  });
  expect(updated).toBe(true);

  const text = await renderLedgerMetrics(store);
  expect(text).toContain('outcome="unmatched"');
  expect(text).toContain("jumi_review_findings_unmatched_total");
});

forEachForge("touchedFiles (between-reviews delta) decides fixed vs dismissed", async (preset) => {
  const store = new MemoryReviewJobStore();
  const previous = ["src/a.ts:10: 🔴 bug: null deref. Guard it."];
  const api = makeReviewApi({
    capabilities: preset.capabilities,
    getPRFiles: async () => [makeFile({ filename: "src/a.ts" })],
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
    createPullReview: async () => ({ id: 1 }),
  });
  // Full-PR list touches src/a.ts, but nothing between the reviews did: dismissed.
  await publishReviewResult({
    api,
    owner: "kirmanak",
    repo: "demo",
    prNumber: 11,
    expectedHeadSha: "headsha",
    botUsername: "jumi",
    logger: () => undefined,
    forgeKind: preset.name,
    resultRunner: "_Jumi · opencode · x_",
    resultMarkdown: "unrelated note\n<!-- jumi-check: success -->",
    previousFindings: previous,
    changedFiles: [{ filename: "src/a.ts" }],
    touchedFiles: [],
    recordFindings: async (rows) => {
      await store.recordReviewFindings(rows);
    },
  });
  const totals = await store.getReviewFindingTotals();
  expect(totals.find((row) => row.outcome === "dismissed")?.count ?? 0).toBe(1);
  expect(totals.find((row) => row.outcome === "fixed")?.count ?? 0).toBe(0);
});

forEachForge("finding_response answers persist against rows by path and line", async (preset) => {
  const store = new MemoryReviewJobStore();
  await store.recordReviewFindings([
    {
      forge: preset.name,
      owner: "kirmanak",
      repo: "demo",
      prNumber: 12,
      severity: "bug",
      reviewerRunner: "opencode",
      writerRunner: "",
      reviewRound: 1,
      outcome: "repeated",
      fingerprint: "fp-1",
      path: "src/a.ts",
      line: 10,
    },
  ]);
  const recorded = await persistFindingResponses(
    [{ finding: "src/a.ts:10: 🔴 bug: null deref.", status: "unchanged", reason: "Guarded upstream." }],
    { owner: "kirmanak", repo: "demo", prNumber: 12 },
    store,
    () => undefined
  );
  expect(recorded).toBe(1);
  // No selector at all matches nothing (and must not clobber another row).
  expect(
    await store.recordFindingResponse({ owner: "kirmanak", repo: "demo", prNumber: 12, status: "fixed", reason: "x" })
  ).toBe(false);
  expect(await persistFindingResponses([], { owner: "kirmanak", repo: "demo", prNumber: 12 }, store)).toBe(0);
  expect(
    await persistFindingResponses(
      [{ finding: "src/a.ts:10: 🔴 bug: null deref.", status: "fixed", reason: "" }],
      { owner: "kirmanak", repo: "demo", prNumber: 12 },
      undefined
    )
  ).toBe(0);
});

describe("finding response selectors", () => {
  test("path:line prefix parses, bare text stays a fingerprint", () => {
    expect(parseFindingResponseSelector("src/a.ts:10: 🔴 bug: x.")).toEqual({
      fingerprint: "src/a.ts:10: 🔴 bug: x.",
      path: "src/a.ts",
      line: 10,
    });
    expect(parseFindingResponseSelector("just some text")).toEqual({ fingerprint: "just some text" });
  });
});

describe("blocking finding parsing", () => {
  test("parses only blocking severities", () => {
    const findings = parseBlockingFindings(
      [
        "src/a.ts:1: 🔴 bug: null deref.",
        "src/b.ts:2: 🟡 risk: race.",
        "src/c.ts:3: 💡 simpler: tidy.",
        "src/d.ts:4: ❓ q: why?",
      ].join("\n")
    );
    expect(findings.map((f) => f.severity).sort()).toEqual(["bug", "risk"]);
  });

  test("severity helpers stay bounded", () => {
    expect(BLOCKING_FINDING_SEVERITIES).toEqual(["bug", "risk"]);
    expect(BLOCKING_FINDING_OUTCOMES).toEqual(["fixed", "dismissed", "repeated", "open_at_merge", "unmatched"]);
    expect(FINDING_RESPONSE_STATUSES).toEqual(["fixed", "unchanged"]);
    const bug: BlockingFindingSeverity = "bug";
    const repeated: BlockingFindingOutcome = "repeated";
    expect(bug).toBe("bug");
    expect(repeated).toBe("repeated");
    expect(blockingSeverityOf("🔴 bug: null deref.")).toBe("bug");
    expect(blockingSeverityOf("🟡 risk: race.")).toBe("risk");
    expect(blockingSeverityOf("💡 simpler: tidy.")).toBeNull();
    expect(isBlockingFindingOutcome("fixed")).toBe(true);
    expect(isBlockingFindingOutcome("nope")).toBe(false);
    expect(normalizeFindingSeverity("bug")).toBe("bug");
    expect(normalizeFindingSeverity("RISK")).toBe("risk");
    expect(normalizeFindingSeverity("zzz")).toBe("unknown");
    expect(normalizeFindingOutcome("dismissed")).toBe("dismissed");
    expect(normalizeFindingOutcome("zzz")).toBe("unmatched");
  });

  test("filtering and matching reuse the suggestion matcher", () => {
    const parsed = parseBlockingFindings("src/a.ts:1: 🔴 bug: null deref.\nsrc/b.ts:2: 💡 simpler: tidy.");
    expect(filterBlockingFindings(parsed)).toHaveLength(1);
    expect(
      isSameBlockingFinding(
        { path: "src/a.ts", body: "🔴 bug: null deref guard" },
        { path: "src/a.ts", body: "🔴 bug: null deref guard it" }
      )
    ).toBe(true);
    expect(
      isSameBlockingFinding(
        { path: "src/a.ts", body: "🔴 bug: null deref" },
        { path: "src/b.ts", body: "🔴 bug: null deref" }
      )
    ).toBe(false);
  });

  test("touch checks file and lines", () => {
    const target = { path: "src/a.ts", line: 10 };
    expect(
      isFindingTouched(target, { paths: new Set(["src/a.ts"]), lines: new Map([["src/a.ts", new Set([10])]]) })
    ).toBe(true);
    expect(
      isFindingTouched(target, { paths: new Set(["src/a.ts"]), lines: new Map([["src/a.ts", new Set([11])]]) })
    ).toBe(false);
    expect(isFindingTouched(target, { paths: new Set(["src/other.ts"]) })).toBe(false);
  });

  test("oversized pushback reasons are rejected", () => {
    const tooLong = "x".repeat(MAX_FINDING_RESPONSE_REASON_CHARS + 1);
    expect(validateFindingResponse({ finding: "src/a.ts:1: 🔴 bug: x.", status: "fixed", reason: tooLong }).ok).toBe(
      false
    );
    expect(validateFindingResponse({ finding: "", status: "fixed" }).ok).toBe(false);
    expect(validateFindingResponse({ finding: "src/a.ts:1: 🔴 bug: x.", status: "bogus" }).ok).toBe(false);
  });
});
