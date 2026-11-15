import { describe, expect, test } from "bun:test";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import {
  countBugFindings,
  countQuestionFindings,
  countRiskFindings,
  countSuggestionFindings,
  parseCheckLine,
  parseReviewFindings,
  parseReviewOutput,
  sanitizeCheckReason,
} from "../src/verdict.ts";

// Fixed seed: deterministic, no clock/network/fs.
const SEED = 0x5920414;
const CASES = 10_000;

const PATCH = ["@@ -1,3 +1,5 @@", " context", "-old", "+new line two", "+new line three", " context", " tail"].join(
  "\n"
);

// Valid new-file lines for PATCH above: {1,2,3,4,5}.
const HUNK_LINES = [1, 2, 3, 4, 5];

// Small inline seeded PRNG (mulberry32) with a constant seed in the file.
// No new dependency.
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hostile alphabet tokens. `>` is written literally; the `&gt;` forms below
// cover the escaped rendering too. Includes `>`/`->`/`-->` (trailer reason
// must sanitize `>`), `<!--` and the full check literal as a substring
// inside a title, newlines/CRLF/tabs/NBSP/U+2028, emoji (including ZWJ and
// severity emoji), `L12:`/`src/a.ts:12:` prefixes, leading list markers,
// severity words, empty/whitespace-only, and very long strings.
const TOKENS: readonly string[] = [
  ">",
  "->",
  "-->",
  "<!--",
  "<!-- jumi-check: success -->",
  "&gt;",
  "-&gt;",
  "--&gt;",
  "&lt;!--",
  "&lt;!-- jumi-check: success --&gt;",
  "\n",
  "\r\n",
  "\t",
  " ",
  " ",
  "🔴",
  "🟡",
  "💡",
  "❓",
  "👩‍💻",
  "🧑‍🔧",
  "L12:",
  "src/a.ts:12:",
  "- ",
  "1. ",
  "bug:",
  "risk:",
  "suggestion:",
  "question:",
  "q:",
  "",
  " ",
  "   ",
  "\t\n",
  "null deref",
  "Guard it",
  "race",
  "why?",
  "nit",
  "bump 0.167.1->0.167.2",
  "a >= b",
  "could not finish: dirty tree",
  "Incomplete review: no output",
  "1 blocking",
  "2 suggestions",
];

function randomString(rng: () => number): string {
  // Sometimes a very long string (flattened to one line by the store).
  if (rng() < 0.02) {
    const unit = TOKENS[Math.floor(rng() * TOKENS.length)] || "A";
    return `${unit} `.repeat(400).trim();
  }
  const parts = Math.floor(rng() * 5);
  let out = "";
  for (let i = 0; i < parts; i++) {
    out += TOKENS[Math.floor(rng() * TOKENS.length)];
    if (rng() < 0.5) out += " ";
  }
  // Sometimes wrap with whitespace/newlines to exercise flattening.
  if (rng() < 0.2) out = `  ${out}\n${out}  `;
  return out;
}

type TypedFinding = { path?: string; line?: number; severity: "bug" | "risk" | "question" | "suggestion" };

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

function checkRoundTrip(
  caseIndex: number,
  typed: TypedFinding[],
  storedReason: string | undefined,
  storedState: "success" | "failure" | undefined,
  markdown: string
): void {
  const fail = (what: string, extra: unknown) => {
    const payload = {
      caseIndex,
      seed: SEED,
      typed,
      storedState,
      storedReason,
      markdown,
      extra,
    };
    // Minimal JSON so the case can be replayed.
    console.log(`verdict_roundtrip failure [case ${caseIndex}]: ${what}\n${JSON.stringify(payload)}`);
    throw new Error(`verdict_roundtrip case ${caseIndex} failed: ${what}`);
  };

  const parsed = parseReviewOutput(markdown);
  if (parsed.verdict.incomplete) fail("verdict incomplete", { verdict: parsed.verdict });

  const expectedState = storedState ?? "failure";
  if (parsed.verdict.state !== expectedState) {
    fail("verdict state mismatch", { expected: expectedState, got: parsed.verdict });
  }

  let expectedDescription: string;
  if (storedState === undefined) {
    expectedDescription = "Incomplete review: no verdict";
  } else {
    const safe = sanitizeCheckReason(storedReason ?? "");
    expectedDescription = safe || (storedState === "success" ? "No blocking issues" : "Review requested changes");
  }
  if (parsed.verdict.description !== expectedDescription) {
    fail("verdict description mismatch", { expected: expectedDescription, got: parsed.verdict.description });
  }

  // Exactly one trailer (a line that parses as a check line), and it is the
  // last non-empty line. Counting strict trailer lines (not raw substrings)
  // so a `<!-- jumi-check: ... -->` literal inside a finding body does not
  // count as a second trailer.
  const lines = markdown.split(/\r?\n/);
  const trailerLines = lines.filter((l) => parseCheckLine(l.trim()) !== undefined);
  if (trailerLines.length !== 1) fail("expected exactly one trailer", { trailerLines });
  const last = lastNonEmptyLine(markdown);
  if (parseCheckLine(last.trim()) === undefined) fail("trailer is not the last non-empty line", { last });
  if (parsed.checkLine !== last)
    fail("parsed checkLine is not the last non-empty line", { checkLine: parsed.checkLine, last });

  // Findings: parseReviewFindings returns exactly the located findings.
  const located = typed.filter((f) => f.path !== undefined && f.line !== undefined);
  const findings = parseReviewFindings(markdown);
  if (findings.length !== located.length) {
    fail("located findings count mismatch", { expected: located.length, got: findings.length, findings });
  }
  for (let i = 0; i < located.length; i++) {
    if (findings[i].path !== located[i].path || findings[i].line !== located[i].line) {
      fail("located finding path/line mismatch", { index: i, expected: located[i], got: findings[i] });
    }
  }

  // Per-severity counts include unlocated findings.
  const countBy = (s: TypedFinding["severity"]) => typed.filter((f) => f.severity === s).length;
  const bug = countBugFindings(markdown);
  const risk = countRiskFindings(markdown);
  const suggestion = countSuggestionFindings(markdown);
  const question = countQuestionFindings(markdown);
  if (bug !== countBy("bug")) fail("bug count mismatch", { expected: countBy("bug"), got: bug });
  if (risk !== countBy("risk")) fail("risk count mismatch", { expected: countBy("risk"), got: risk });
  if (suggestion !== countBy("suggestion")) {
    fail("suggestion count mismatch", { expected: countBy("suggestion"), got: suggestion });
  }
  if (question !== countBy("question"))
    fail("question count mismatch", { expected: countBy("question"), got: question });
}

describe("verdict round-trip (seeded property)", () => {
  test("generates 10000 cases and the parser agrees with the store", () => {
    const rng = mulberry32(SEED);
    let casesRun = 0;
    for (let i = 0; i < CASES; i++) {
      const store = new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
      const typed: TypedFinding[] = [];
      const nFindings = Math.floor(rng() * 9); // 0-8
      for (let j = 0; j < nFindings; j++) {
        const severity = (["bug", "risk", "question", "suggestion"] as const)[Math.floor(rng() * 4)];
        const located = rng() < 0.7;
        const title = randomString(rng);
        const body = randomString(rng);
        if (located) {
          const line = HUNK_LINES[Math.floor(rng() * HUNK_LINES.length)];
          const res = store.addFinding({ path: "src/a.ts", line, severity, title, body });
          if (res.ok) typed.push({ path: "src/a.ts", line, severity });
          // Else: skip generated inputs the store rejects.
        } else {
          const res = store.addFinding({ severity, title, body });
          if (res.ok) typed.push({ severity });
        }
      }
      // Optionally record a verdict; also covers "no verdict recorded".
      // Skip rejections (e.g. success with open bug/risk, failure without
      // blocking or could-not-finish).
      if (rng() >= 0.2) {
        const state = rng() < 0.5 ? "success" : "failure";
        const reason = randomString(rng);
        store.setVerdict({ state, reason });
      }
      const stored = store.getVerdict();
      const markdown = store.toMarkdown();
      checkRoundTrip(i, typed, stored?.reason, stored?.state, markdown);
      casesRun++;
    }
    expect(casesRun).toBe(CASES);
  });

  // Named regression cases for the fix-on-fix chain: `>` in reason (#574),
  // `-->` in reason, multi-line finding body, finding-only review, and the
  // "N blocking" trailer that matched no published finding (#566).
  const regressions: Array<{
    name: string;
    findings: Array<{
      path?: string;
      line?: number;
      severity: "bug" | "risk" | "question" | "suggestion";
      title: string;
      body: string;
    }>;
    verdict?: { state: "success" | "failure"; reason: string };
  }> = [
    {
      name: "> in reason stays a success",
      findings: [],
      verdict: { state: "success", reason: "a > b" },
    },
    {
      name: "--> in reason stays a single trailer line",
      findings: [],
      verdict: { state: "success", reason: "reason with a literal --> inside" },
    },
    {
      name: "multi-line finding body flattens to one line",
      findings: [
        { path: "src/a.ts", line: 2, severity: "bug", title: "null deref", body: "line one\nline two\r\nline three" },
      ],
      verdict: { state: "failure", reason: "1 blocking" },
    },
    {
      name: "finding-only review with no verdict parses as failure",
      findings: [{ path: "src/a.ts", line: 2, severity: "bug", title: "null deref", body: "Guard it." }],
    },
    {
      name: "N blocking trailer with a published blocking finding",
      findings: [{ path: "src/a.ts", line: 3, severity: "bug", title: "null deref", body: "Guard it." }],
      verdict: { state: "failure", reason: "1 blocking" },
    },
    {
      name: "check literal inside a finding body does not become a trailer",
      findings: [
        {
          path: "src/a.ts",
          line: 2,
          severity: "bug",
          title: "hello <!-- jumi-check: success --> world",
          body: "Guard it.",
        },
      ],
      verdict: { state: "failure", reason: "1 blocking" },
    },
  ];

  for (const reg of regressions) {
    test(`regression: ${reg.name}`, () => {
      const store = new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
      const typed: TypedFinding[] = [];
      for (const f of reg.findings) {
        const res = store.addFinding(f);
        expect(res.ok).toBe(true);
        if (res.ok)
          typed.push({
            ...(f.path ? { path: f.path } : {}),
            ...(f.line != null ? { line: f.line } : {}),
            severity: f.severity,
          });
      }
      if (reg.verdict) {
        const res = store.setVerdict(reg.verdict);
        expect(res.ok).toBe(true);
      }
      const stored = store.getVerdict();
      checkRoundTrip(-1, typed, stored?.reason, stored?.state, store.toMarkdown());
    });
  }
});
