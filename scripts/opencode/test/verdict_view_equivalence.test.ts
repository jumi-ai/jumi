import { describe, expect, test } from "bun:test";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import { reviewVerdictView } from "../src/verdict.ts";

// Fixed seed: deterministic, no clock/network/fs.
const SEED = 0x594002;
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

// Hostile alphabet tokens: same family as the round-trip test (trailer
// syntax, severity markers, location prefixes, whitespace games, emoji),
// plus maintainer-marker text to prove the record path agrees there too.
const TOKENS: readonly string[] = [
  ">",
  "->",
  "-->",
  "<!--",
  "<!-- jumi-check: success -->",
  "<!-- jumi-check: failure; 1 blocking -->",
  "&gt;",
  "\n",
  "\r\n",
  "\t",
  " ",
  "🔴",
  "🟡",
  "💡",
  "❓",
  "L12:",
  "src/a.ts:12:",
  "- ",
  "1. ",
  "bug:",
  "risk:",
  "suggestion:",
  "question:",
  "q:",
  "maintainer:",
  "❓ maintainer:",
  "",
  "   ",
  "null deref",
  "Guard it",
  "race",
  "why?",
  "nit",
  "a -> b",
  "a >= b",
  "could not finish: dirty tree",
  "1 blocking",
  "2 suggestions",
];

function randomString(rng: () => number): string {
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
  if (rng() < 0.2) out = `  ${out}\n${out}  `;
  return out;
}

const PR_AUTHORS: readonly (string | null | undefined)[] = [
  "renovate-bot",
  "Renovate-Bot",
  "alice",
  "repo-bot",
  "JUMI",
  "",
  "   ",
  null,
  undefined,
];

const BLOCKING_LISTS: readonly (readonly string[] | null | undefined)[] = [
  undefined,
  null,
  [],
  ["renovate-bot"],
  ["Renovate-Bot"],
  ["alice", "renovate-bot"],
  ["nobody"],
  [""],
];

describe("verdict view equivalence (seeded property)", () => {
  test("record-backed view equals text-backed view on every field", () => {
    const rng = mulberry32(SEED);
    let casesRun = 0;
    for (let i = 0; i < CASES; i++) {
      const store = new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
      const nFindings = Math.floor(rng() * 9); // 0-8
      for (let j = 0; j < nFindings; j++) {
        const severity = (["bug", "risk", "question", "suggestion"] as const)[Math.floor(rng() * 4)];
        const title = randomString(rng);
        const body = randomString(rng);
        if (rng() < 0.7) {
          const line = HUNK_LINES[Math.floor(rng() * HUNK_LINES.length)];
          store.addFinding({ path: "src/a.ts", line, severity, title, body });
        } else {
          store.addFinding({ severity, title, body });
        }
      }
      // Also covers "no verdict recorded"; skips rejections (e.g. success
      // with open bug/risk, failure without blocking or could-not-finish).
      if (rng() >= 0.2) {
        const state = rng() < 0.5 ? "success" : "failure";
        store.setVerdict({ state, reason: randomString(rng) });
      }
      const markdown = store.toMarkdown();
      const record = store.toRecord();
      const prAuthor = PR_AUTHORS[Math.floor(rng() * PR_AUTHORS.length)];
      const blockingAuthors = BLOCKING_LISTS[Math.floor(rng() * BLOCKING_LISTS.length)];

      const textView = reviewVerdictView({ markdown });
      const recordView = reviewVerdictView({ markdown, record });
      const fail = (field: string, expected: unknown, actual: unknown) => {
        const payload = {
          caseIndex: i,
          seed: SEED,
          field,
          expected,
          actual,
          markdown,
          record,
          prAuthor,
          blockingAuthors,
        };
        console.log(`verdict_view_equivalence failure [case ${i}]: ${field}\n${JSON.stringify(payload)}`);
        throw new Error(`verdict_view_equivalence case ${i} failed: ${field}`);
      };

      if (textView.incomplete !== recordView.incomplete) fail("incomplete", textView.incomplete, recordView.incomplete);
      if (textView.state !== recordView.state) fail("state", textView.state, recordView.state);
      if (textView.description !== recordView.description)
        fail("description", textView.description, recordView.description);
      if (textView.suggestionCount !== recordView.suggestionCount)
        fail("suggestionCount", textView.suggestionCount, recordView.suggestionCount);
      if (textView.isMaintainerOnly !== recordView.isMaintainerOnly)
        fail("isMaintainerOnly", textView.isMaintainerOnly, recordView.isMaintainerOnly);
      const textBlocking = textView.blockingQuestionCount(prAuthor, blockingAuthors);
      const recordBlocking = recordView.blockingQuestionCount(prAuthor, blockingAuthors);
      if (textBlocking !== recordBlocking) fail("blockingQuestionCount", textBlocking, recordBlocking);
      const textBare = textView.blockingQuestionCount(undefined, undefined);
      const recordBare = recordView.blockingQuestionCount(undefined, undefined);
      if (textBare !== recordBare) fail("blockingQuestionCount(undefined)", textBare, recordBare);

      casesRun++;
    }
    expect(casesRun).toBe(CASES);
  });
});
