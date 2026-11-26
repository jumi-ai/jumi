import { expect, test } from "bun:test";
import { isJumiPullReviewFinding, isJumiReviewFinding } from "../src/followup.ts";
import { publishReviewResult } from "../src/review.ts";
import { hasFindingProof } from "../src/verdict.ts";
import { forEachForge, makeReviewApi } from "./fakes/forge.ts";

const RISK_ONLY_FAILURE = "src/demo.ts:1: 🟡 risk: race on retry.\n<!-- jumi-check: failure; 1 risk -->";
const BUG_ONLY_FAILURE = "src/demo.ts:1: 🔴 bug: crashes on empty.\n<!-- jumi-check: failure; 1 blocking -->";

async function publish(
  preset: { capabilities: unknown },
  opts: {
    resultMarkdown: string;
    settingsContent?: string;
    previousFindings?: string[];
    reviewRound?: number;
  }
): Promise<{
  states: Array<{ state: string; description?: string }>;
  reviewBodies: string[];
}> {
  const states: Array<{ state: string; description?: string }> = [];
  const reviewBodies: string[] = [];
  const api = makeReviewApi({
    capabilities: preset.capabilities as import("../src/forge_capabilities.ts").ForgeCapabilities,
    getRepoFile: async () =>
      opts.settingsContent !== undefined ? { found: true, content: opts.settingsContent } : { found: false },
    createCommitStatus: async (_o, _r, _s, status) => {
      states.push({ state: status.state, description: status.description });
      return status;
    },
    createPullReview: async (_o, _r, _p, review) => {
      if (typeof review.body === "string") reviewBodies.push(review.body);
      return { id: 1 };
    },
  });
  await publishReviewResult({
    api,
    forge: api,
    owner: "o",
    repo: "r",
    prNumber: 7,
    expectedHeadSha: "headsha",
    botUsername: "jumi",
    logger: () => undefined,
    resultMarkdown: opts.resultMarkdown,
    ...(opts.previousFindings ? { previousFindings: opts.previousFindings } : {}),
    ...(opts.reviewRound !== undefined ? { reviewRound: opts.reviewRound } : {}),
  });
  return { states, reviewBodies };
}

forEachForge("risks block: no setting fails a 🟡-only review", async (preset) => {
  const { states } = await publish(preset, { resultMarkdown: RISK_ONLY_FAILURE });
  expect(states).toHaveLength(1);
  expect(states[0]?.state).toBe("failure");
  expect(states[0]?.description).toContain("1 risk");
});

forEachForge("risks block: blocking_risks:false passes 🟡-only and wakes worker", async (preset) => {
  const { states, reviewBodies } = await publish(preset, {
    resultMarkdown: RISK_ONLY_FAILURE,
    settingsContent: "blocking_risks: false\n",
  });
  expect(states).toHaveLength(1);
  expect(states[0]?.state).toBe("success");
  expect(states[0]?.description).toContain("1 non-blocking risk");
  const body = reviewBodies[0] ?? "";
  expect(body).toContain("1 non-blocking risk");
  const successBody = `<!-- jumi-review:o/r#7 -->\nReviewed commit: \`abcdef1\`\n\n<!-- jumi-check: success; 1 non-blocking risk -->`;
  expect(
    isJumiReviewFinding({ body: successBody, user: { login: "jumi" } }, "abcdef1", { prAuthor: "alice" }, "jumi", [])
  ).toBe(true);
  expect(
    isJumiReviewFinding(
      { body: successBody, user: { login: "jumi" } },
      "abcdef1",
      { prAuthor: "alice", followupOnRisks: false },
      "jumi",
      []
    )
  ).toBe(false);
});

forEachForge("risks block: 🔴 always blocks", async (preset) => {
  const { states } = await publish(preset, {
    resultMarkdown: BUG_ONLY_FAILURE,
    settingsContent: "blocking_risks: false\n",
    reviewRound: 3,
    previousFindings: ["src/other.ts:1: 🔴 bug: old."],
  });
  expect(states).toHaveLength(1);
  expect(states[0]?.state).toBe("failure");
});

forEachForge("risks block: third review new 🟡 without proof is advisory", async (preset) => {
  const { states } = await publish(preset, {
    resultMarkdown: RISK_ONLY_FAILURE,
    reviewRound: 3,
    previousFindings: ["src/other.ts:9: 🟡 risk: unrelated old finding."],
  });
  expect(states).toHaveLength(1);
  expect(states[0]?.state).toBe("success");
  expect(states[0]?.description).toContain("1 non-blocking risk");
});

forEachForge("risks block: third review new 🟡 with proof blocks", async (preset) => {
  const proven =
    "src/demo.ts:1: 🟡 risk: race on retry. Proof: crashes when two workers retry the same job; see src/demo.ts:1.\n" +
    "  ```\n  $ bun test retry\n  fail: duplicate insert\n  ```\n<!-- jumi-check: failure; 1 risk -->";
  expect(hasFindingProof(proven)).toBe(true);
  const { states } = await publish(preset, {
    resultMarkdown: proven,
    reviewRound: 3,
    previousFindings: ["src/other.ts:9: 🟡 risk: unrelated old finding."],
  });
  expect(states).toHaveLength(1);
  expect(states[0]?.state).toBe("failure");
  expect(states[0]?.description).toContain("1 risk");
  expect(states[0]?.description).not.toContain("non-blocking");
});

forEachForge("risks block: third review repeated 🟡 blocks", async (preset) => {
  const { states } = await publish(preset, {
    resultMarkdown: RISK_ONLY_FAILURE,
    reviewRound: 3,
    previousFindings: ["src/demo.ts:1: 🟡 risk: race on retry."],
  });
  expect(states).toHaveLength(1);
  expect(states[0]?.state).toBe("failure");
});

forEachForge("risks block: pull-review wake honors followup_on_risks", async (preset) => {
  void preset;
  const body = `<!-- jumi-review:o/r#7 -->\nReviewed commit: \`abcdef1\`\n\n<!-- jumi-check: success; 1 non-blocking risk -->`;
  const review = {
    id: 1,
    user: { login: "jumi" },
    body,
    submitted_at: "2026-01-01T00:00:00Z",
    commit_id: "abcdef1",
  } as never;
  expect(isJumiPullReviewFinding(review, "jumi", "abcdef1", { prAuthor: "alice" }, [])).toBe(true);
  expect(isJumiPullReviewFinding(review, "jumi", "abcdef1", { prAuthor: "alice", followupOnRisks: false }, [])).toBe(
    false
  );
});

test("proof needs a scenario plus a file:line ref or command output", () => {
  expect(hasFindingProof("src/a.ts:1: 🟡 risk: x. Proof: crashes on retry; see src/a.ts:1.")).toBe(true);
  expect(hasFindingProof("src/a.ts:1: 🟡 risk: x. Proof: run `$ bun test`:\n```\nfail\n```")).toBe(true);
  expect(hasFindingProof("src/a.ts:1: 🟡 risk: x. Proof:")).toBe(false);
  expect(hasFindingProof("src/a.ts:1: 🟡 risk: x.")).toBe(false);
});
