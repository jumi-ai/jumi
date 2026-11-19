import { describe, expect, test } from "bun:test";
import {
  openBugsForReview,
  openMaintainerQuestionsForReview,
  openQuestionsForReview,
  openRisksForReview,
} from "../src/followup.ts";
import {
  buildCheckTrailer,
  countBlockingFindings,
  countBugFindings,
  countMaintainerQuestionFindings,
  countQuestionFindings,
  countRiskFindings,
  countSuggestionFindings,
  describeBlockingReason,
  findingFingerprint,
  parseCheckLine,
  parseReviewFindings,
  parseReviewOutput,
  sanitizeCheckReason,
  stripFindingLines,
} from "../src/verdict.ts";

// Fixed seeds: deterministic, no clock/network/fs. A failing case logs its
// JSON payload so the seed + case index reproduces it.
const SEED_COUNTS = 0x676001;
const SEED_TRAILER = 0x676002;
const SEED_BLOCKING = 0x676003;
const CASES = 500;
const BOT = "jumi";
const REVIEW_MARKER = "<!-- jumi-review: finding -->";

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FindingKind = "bug" | "risk" | "suggestion" | "question" | "maintainer";

const KINDS: readonly FindingKind[] = ["bug", "risk", "suggestion", "question", "maintainer"];

function findingLine(kind: FindingKind, line: number, title: string): string {
  switch (kind) {
    case "bug":
      return `src/a.ts:${line}: 🔴 bug: ${title}`;
    case "risk":
      return `src/a.ts:${line}: 🟡 risk: ${title}`;
    case "suggestion":
      return `src/a.ts:${line}: 💡 suggestion: ${title}`;
    case "question":
      return `src/a.ts:${line}: ❓ q: ${title}`;
    case "maintainer":
      return `src/a.ts:${line}: ❓ maintainer: ${title}`;
  }
}

const TITLE_WORDS = ["null deref", "race on retry", "leak", "off by one", "naming", "docs", "timeout", "cleanup"];

interface GeneratedReview {
  kinds: FindingKind[];
  lines: string[];
  posted: boolean[];
}

function generateReview(rng: () => number, index: number): GeneratedReview {
  const n = 1 + Math.floor(rng() * 6);
  const kinds: FindingKind[] = [];
  const lines: string[] = [];
  const posted: boolean[] = [];
  for (let j = 0; j < n; j++) {
    const kind = KINDS[Math.floor(rng() * KINDS.length)] ?? "bug";
    const title = `${TITLE_WORDS[Math.floor(rng() * TITLE_WORDS.length)]} ${index}-${j}`;
    kinds.push(kind);
    lines.push(findingLine(kind, j + 1, title));
    posted.push(rng() < 0.5);
  }
  // Never post everything and never post nothing: both sides stay exercised.
  if (posted.every(Boolean)) posted[posted.length - 1] = false;
  if (posted.every((p) => !p)) posted[0] = true;
  return { kinds, lines, posted };
}

function fail(suite: string, caseIndex: number, seed: number, what: string, extra: unknown): never {
  console.log(`${suite} failure [case ${caseIndex}]: ${what}\n${JSON.stringify({ caseIndex, seed, extra })}`);
  throw new Error(`${suite} case ${caseIndex} failed: ${what}`);
}

describe("verdict invariants (seeded property)", () => {
  test("body + inline counts equal the typed record", () => {
    const rng = mulberry32(SEED_COUNTS);
    let casesRun = 0;
    for (let i = 0; i < CASES; i++) {
      const gen = generateReview(rng, i);
      const modelText = gen.lines.join("\n");
      const parsed = parseReviewFindings(modelText);
      if (parsed.length !== gen.lines.length) {
        fail("counts", i, SEED_COUNTS, "generated lines do not parse as findings", {
          lines: gen.lines,
          parsed,
        });
      }
      const postedSet = new Set<string>();
      gen.lines.forEach((_, j) => {
        if (gen.posted[j]) {
          const f = parsed[j];
          if (f) postedSet.add(findingFingerprint(f.path, f.body));
        }
      });
      const stripped = stripFindingLines(modelText, { posted: postedSet });
      const reviewBody = `${stripped}\n\n${buildCheckTrailer("success", "No blocking issues")}`;
      const inlines = gen.lines
        .filter((_, j) => gen.posted[j])
        .map((line, k) => ({
          id: 1000 + k,
          path: "src/a.ts",
          body: `${line} ${REVIEW_MARKER}`,
          user: { login: BOT },
        }));
      const typed = (kind: FindingKind) => gen.kinds.filter((k) => k === kind).length;
      const typedQuestions = typed("question") + typed("maintainer");
      const typedBlocking = typed("bug") + typed("risk");

      const bugs = openBugsForReview(reviewBody, inlines as never, BOT);
      if (bugs !== typed("bug")) {
        fail("counts", i, SEED_COUNTS, "bug count mismatch", { expected: typed("bug"), got: bugs, gen });
      }
      const risks = openRisksForReview(reviewBody, inlines as never, BOT);
      if (risks !== typed("risk")) {
        fail("counts", i, SEED_COUNTS, "risk count mismatch", { expected: typed("risk"), got: risks, gen });
      }
      const questions = openQuestionsForReview(reviewBody, inlines as never, BOT);
      if (questions !== typedQuestions) {
        fail("counts", i, SEED_COUNTS, "question count mismatch", {
          expected: typedQuestions,
          got: questions,
          gen,
        });
      }
      const maintainers = openMaintainerQuestionsForReview(reviewBody, inlines as never, BOT);
      if (maintainers !== typed("maintainer")) {
        fail("counts", i, SEED_COUNTS, "maintainer count mismatch", {
          expected: typed("maintainer"),
          got: maintainers,
          gen,
        });
      }
      const comment = parseReviewOutput(reviewBody).comment;
      if (countBugFindings(comment) + inlines.reduce((n, inl) => n + countBugFindings(inl.body), 0) !== typed("bug")) {
        fail("counts", i, SEED_COUNTS, "direct bug count mismatch", { gen });
      }
      if (
        countRiskFindings(comment) + inlines.reduce((n, inl) => n + countRiskFindings(inl.body), 0) !==
        typed("risk")
      ) {
        fail("counts", i, SEED_COUNTS, "direct risk count mismatch", { gen });
      }
      const bodySuggestions = countSuggestionFindings(comment);
      const inlineSuggestions = inlines.reduce((n, inl) => n + countSuggestionFindings(inl.body), 0);
      if (bodySuggestions + inlineSuggestions !== typed("suggestion")) {
        fail("counts", i, SEED_COUNTS, "suggestion count mismatch", {
          expected: typed("suggestion"),
          got: bodySuggestions + inlineSuggestions,
          gen,
        });
      }
      const bodyBlocking = countBlockingFindings(comment);
      const inlineBlocking = inlines.reduce((n, inl) => n + countBlockingFindings(inl.body), 0);
      if (bodyBlocking + inlineBlocking !== typedBlocking || bugs + risks !== typedBlocking) {
        fail("counts", i, SEED_COUNTS, "blocking count mismatch", {
          expected: typedBlocking,
          got: bodyBlocking + inlineBlocking,
          openSum: bugs + risks,
          gen,
        });
      }
      casesRun++;
    }
    expect(casesRun).toBe(CASES);
  });

  test("check trailer round-trips hostile reasons", () => {
    const tokens = [
      "<",
      ">",
      "&lt;",
      "&gt;",
      "`code`",
      "```fence```",
      "a\nb",
      "a\r\nb",
      "a|b",
      "| table |",
      "café",
      "日本語",
      "🧑‍🔧 emoji",
      "zero-width​join",
      "One suggestion",
      "two risks",
      "1 blocking",
      "12 risks",
      "3 blocking, 2 risks",
      "a > b",
      "a -> b",
      "a --> b",
      "<!-- jumi-check: success -->",
      "pipe | and tick `x`",
    ];
    const rng = mulberry32(SEED_TRAILER);
    let casesRun = 0;
    for (let i = 0; i < CASES; i++) {
      const parts = 1 + Math.floor(rng() * 3);
      let reason = "";
      for (let p = 0; p < parts; p++) {
        reason += tokens[Math.floor(rng() * tokens.length)] ?? "x";
        if (rng() < 0.5) reason += " ";
      }
      const state = rng() < 0.5 ? "success" : "failure";
      const trailer = buildCheckTrailer(state, reason);
      const back = parseCheckLine(trailer.trim());
      if (!back) {
        fail("trailer", i, SEED_TRAILER, "trailer does not parse", { reason, trailer });
      }
      const expectedReason = sanitizeCheckReason(reason);
      if (back.state !== state || back.reason !== expectedReason) {
        fail("trailer", i, SEED_TRAILER, "trailer round-trip mismatch", {
          reason,
          expectedReason,
          state,
          back,
          trailer,
        });
      }
      casesRun++;
    }
    expect(casesRun).toBe(CASES);
  });

  test("built blocking trailer matches published blocking findings", () => {
    const rng = mulberry32(SEED_BLOCKING);
    let casesRun = 0;
    for (let i = 0; i < CASES; i++) {
      // Actionable blocking findings plus bare marker-only lines, which must
      // never count (191c679: a stale `🔴` summary is not a live finding).
      const nBugs = 1 + Math.floor(rng() * 3);
      const lines: string[] = [];
      for (let b = 0; b < nBugs; b++) {
        lines.push(`src/a.ts:${b + 1}: 🔴 bug: live bug ${i}-${b}`);
      }
      const nBare = Math.floor(rng() * 3);
      const bareMarkers = ["🔴", "🟡", "bug:", "risk:"];
      for (let m = 0; m < nBare; m++) {
        lines.push(bareMarkers[Math.floor(rng() * bareMarkers.length)] ?? "🔴");
      }
      const published = lines.join("\n");
      const counted = countBlockingFindings(published);
      if (counted !== nBugs) {
        fail("blocking", i, SEED_BLOCKING, "blocking count includes bare markers", {
          expected: nBugs,
          got: counted,
          lines,
        });
      }
      const trailer = buildCheckTrailer("failure", describeBlockingReason(countBugFindings(published), 0));
      const back = parseCheckLine(trailer.trim());
      if (!back) fail("blocking", i, SEED_BLOCKING, "blocking trailer does not parse", { trailer });
      const match = /(\d+)\s+blocking/i.exec(back.reason);
      const n = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
      if (n !== counted) {
        fail("blocking", i, SEED_BLOCKING, "trailer blocking count mismatch", {
          expected: counted,
          got: n,
          reason: back.reason,
          lines,
        });
      }
      const maintainerLines = `src/a.ts:9: ❓ maintainer: needs a human ${i}\n${buildCheckTrailer("success", "1 maintainer question")}`;
      if (countMaintainerQuestionFindings(maintainerLines) !== 1 || countQuestionFindings(maintainerLines) !== 1) {
        fail("blocking", i, SEED_BLOCKING, "maintainer count mismatch", { maintainerLines });
      }
      casesRun++;
    }
    expect(casesRun).toBe(CASES);
  });
});
