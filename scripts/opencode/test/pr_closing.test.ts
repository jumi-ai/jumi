import { describe, expect, test } from "bun:test";
import { parseFollowUpState, readFollowUpState, writeFollowUpState } from "../src/followup.ts";
import {
  buildFollowupPullRequestBody,
  buildPullRequestBody,
  jumiPrBodyRegion,
  wrapJumiPrBody,
} from "../src/implement.ts";
import { createPiWorkerCustomTools } from "../src/pi_worker.ts";
import {
  POST_MERGE_HEADING,
  parsePersistedPrClosing,
  persistedClosingDecision,
  type RemainingItem,
  type RemainingKind,
  sha256Hex,
  validateRemainingItems,
} from "../src/pr_closing.ts";
import { PgSkipLatchStore } from "../src/skip_latches.ts";
import { parseEvalRemaining } from "../src/worker_eval.ts";
import { startWorkerMcpServer, validatePrRemaining, WorkerResultStore } from "../src/worker_mcp.ts";

const KINDS: readonly RemainingKind[] = ["work", "ci_check", "post_merge_check"];

describe("typed remaining items", () => {
  test("kinds are work, ci_check, post_merge_check", () => {
    expect([...KINDS]).toEqual(["work", "ci_check", "post_merge_check"]);
  });

  test("typed work with a CI substring keeps Refs; the bare string is CI-only", () => {
    const typed: readonly RemainingItem[] = [{ text: "add test:pg coverage", kind: "work" }];
    const body = buildPullRequestBody(12, "Did part.", undefined, [], undefined, typed);
    expect(body).toContain("Refs #12");
    expect(body).toContain("Remaining:");
    expect(body).toContain("add test:pg coverage");
    expect(body).not.toMatch(/fixes #12/i);
    const untyped = buildPullRequestBody(12, "Did part.", undefined, [], undefined, ["add test:pg coverage"]);
    expect(untyped).toMatch(/fixes #12/i);
  });

  test("only post_merge_check keeps Refs under its own heading; mixed renders both", () => {
    const only: readonly RemainingItem[] = [{ text: "verify deploy", kind: "post_merge_check" }];
    const body = buildPullRequestBody(12, "Did part.", undefined, [], undefined, only);
    expect(body).toContain("Refs #12");
    expect(body).not.toContain("Remaining:");
    expect(body).toContain(POST_MERGE_HEADING);
    expect(body).toContain("verify deploy");
    const mixed: readonly RemainingItem[] = [
      { text: "backfill test", kind: "work" },
      { text: "verify deploy", kind: "post_merge_check" },
    ];
    const both = buildPullRequestBody(12, "Did part.", undefined, [], undefined, mixed);
    expect(both).toContain("Refs #12");
    expect(both).toContain("Remaining:");
    expect(both).toContain(POST_MERGE_HEADING);
  });

  test("ci_check alone and explicit [] publish Fixes; omitted/null publish Fixes", () => {
    const ciOnly: readonly RemainingItem[] = [{ text: "wait for ci", kind: "ci_check" }];
    expect(buildPullRequestBody(12, "Done.", undefined, [], undefined, ciOnly)).toMatch(/fixes #12/i);
    expect(buildPullRequestBody(12, "Done.", undefined, [], undefined, ciOnly)).not.toContain("Remaining:");
    expect(buildPullRequestBody(12, "Done.", undefined, [], undefined, [])).toMatch(/fixes #12/i);
    expect(buildPullRequestBody(12, "Done.", undefined, [], undefined, undefined)).toMatch(/fixes #12/i);
    expect(buildPullRequestBody(12, "Done.", undefined, [], undefined, null)).toMatch(/fixes #12/i);
  });

  test("visible closing keywords in typed text are scrubbed; code spans stay untouched", () => {
    const scrubbed = buildPullRequestBody(12, "Did part.", undefined, [], undefined, [
      { text: "Fixes #12", kind: "work" },
    ]);
    expect(scrubbed).toContain("- Refs #12");
    expect(scrubbed).not.toContain("Fixes #12");
    const span = buildPullRequestBody(12, "Did part.", undefined, [], undefined, [
      { text: "`Fixes #12`", kind: "work" },
    ]);
    expect(span).toContain("`Fixes #12`");
  });

  test("closing_keyword refs with only ci_check items still yields Refs", () => {
    const body = buildPullRequestBody(12, "Done.", undefined, [], "refs", [{ text: "ci green", kind: "ci_check" }]);
    expect(body).toContain("Refs #12");
    expect(body).not.toMatch(/fixes #12/i);
  });

  test("post-merge heading is not parsed as work by the eval parser", () => {
    const body = buildPullRequestBody(12, "Did part.", undefined, [], undefined, [
      { text: "verify deploy", kind: "post_merge_check" },
    ]);
    expect(parseEvalRemaining(wrapJumiPrBody(body))).toEqual([]);
  });
});

describe("typed remaining validation", () => {
  test("shared validator accepts typed items and drops blank text", () => {
    expect(validatePrRemaining(undefined)).toEqual({ ok: true, remaining: undefined });
    expect(validatePrRemaining([{ text: "  ", kind: "work" }])).toEqual({ ok: true, remaining: [] });
    const typed = validatePrRemaining([{ text: " backfill ", kind: "work" }]);
    expect(typed).toEqual({ ok: true, remaining: [{ text: "backfill", kind: "work" }] });
  });

  test("unknown kind and non-object items are errors; length limits apply to text", () => {
    expect(validatePrRemaining([{ text: "x", kind: "nope" }]).ok).toBe(false);
    expect(validatePrRemaining([42]).ok).toBe(false);
    expect(validatePrRemaining([{ text: "x".repeat(1001), kind: "work" }]).ok).toBe(false);
    expect(validatePrRemaining(new Array(21).fill("x")).ok).toBe(false);
    expect(validateRemainingItems("nope").ok).toBe(false);
  });

  test("MCP store rejects unknown kinds; MCP schema description names the three kinds", async () => {
    const store = new WorkerResultStore();
    expect(store.setPrBody({ markdown: "body", remaining: [{ text: "x", kind: "nope" }] }).ok).toBe(false);
    expect(store.setPrBody({ markdown: "body", remaining: [42] }).ok).toBe(false);
    expect(store.setPrBody({ markdown: "body", remaining: [{ text: "backfill", kind: "work" }] }).ok).toBe(true);
    const server = await startWorkerMcpServer({ store: new WorkerResultStore(), token: "tok" });
    try {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const payload = (await res.json()) as {
        result?: { tools?: Array<{ name?: string; description?: string }> };
      };
      const tool = payload.result?.tools?.find((t) => t.name === "set_pr_body");
      expect(tool?.description).toContain("work");
      expect(tool?.description).toContain("ci_check");
      expect(tool?.description).toContain("post_merge_check");
    } finally {
      server.close();
    }
  });

  test("Pi binding accepts typed items and rejects unknown kinds", async () => {
    const store = new WorkerResultStore();
    const tools = createPiWorkerCustomTools(store, "implement");
    const tool = tools.find((t) => t.name === "jumi_set_pr_body") as unknown as {
      description: string;
      execute: (_id: string, params: Record<string, unknown>) => Promise<{ ok?: unknown } | unknown>;
    };
    expect(tool.description).toContain("work");
    expect(tool.description).toContain("ci_check");
    expect(tool.description).toContain("post_merge_check");
    const okStore = new WorkerResultStore();
    const okTools = createPiWorkerCustomTools(okStore, "implement");
    const okTool = okTools.find((t) => t.name === "jumi_set_pr_body") as unknown as {
      execute: (_id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    await okTool.execute("1", { markdown: "body", remaining: [{ text: "backfill", kind: "work" }] });
    expect(okStore.getPrRemaining()).toEqual([{ text: "backfill", kind: "work" }]);
    const badStore = new WorkerResultStore();
    const badTools = createPiWorkerCustomTools(badStore, "implement");
    const badTool = badTools.find((t) => t.name === "jumi_set_pr_body") as unknown as {
      execute: (_id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    await badTool.execute("1", { markdown: "body", remaining: [{ text: "x", kind: "nope" }] });
    expect(badStore.hasPrBody()).toBe(false);
  });
});

describe("persisted closing decision", () => {
  test("omitted/null reuses persisted refs when the live region hash matches, even when parse says fixes", () => {
    const liveBody = wrapJumiPrBody("Fixes #12");
    const region = jumiPrBodyRegion(liveBody) ?? liveBody;
    const persisted = { prNumber: 99, decision: "refs" as const, regionSha256: sha256Hex(region) };
    const omitted = buildFollowupPullRequestBody(12, "Done.", liveBody, undefined, [], undefined, undefined, {
      persistedClosing: persisted,
      prNumber: 99,
    });
    expect(omitted).toContain("Refs #12");
    const nulled = buildFollowupPullRequestBody(12, "Done.", liveBody, undefined, [], undefined, null, {
      persistedClosing: persisted,
      prNumber: 99,
    });
    expect(nulled).toContain("Refs #12");
  });

  test("hash mismatch, missing record, and other-PR records fall back to the live parse", () => {
    const liveFixes = wrapJumiPrBody("Fixes #12");
    const region = jumiPrBodyRegion(liveFixes) ?? liveFixes;
    const mismatched = { prNumber: 99, decision: "refs" as const, regionSha256: sha256Hex("edited") };
    expect(
      buildFollowupPullRequestBody(12, "Done.", liveFixes, undefined, [], undefined, undefined, {
        persistedClosing: mismatched,
        prNumber: 99,
      })
    ).toMatch(/fixes #12/i);
    expect(buildFollowupPullRequestBody(12, "Done.", liveFixes, undefined, [], undefined, undefined)).toMatch(
      /fixes #12/i
    );
    const otherPr = { prNumber: 100, decision: "refs" as const, regionSha256: sha256Hex(region) };
    expect(
      buildFollowupPullRequestBody(12, "Done.", liveFixes, undefined, [], undefined, undefined, {
        persistedClosing: otherPr,
        prNumber: 99,
      })
    ).toMatch(/fixes #12/i);
    const liveRefs = wrapJumiPrBody("Refs #12");
    const refsRegion = jumiPrBodyRegion(liveRefs) ?? liveRefs;
    const persistedFixes = { prNumber: 99, decision: "fixes" as const, regionSha256: sha256Hex(refsRegion) };
    expect(
      buildFollowupPullRequestBody(12, "Done.", liveRefs, undefined, [], undefined, undefined, {
        persistedClosing: persistedFixes,
        prNumber: 99,
      })
    ).toMatch(/fixes #12/i);
  });

  test("explicit [] ignores a matching persisted refs and publishes Fixes", () => {
    const liveBody = wrapJumiPrBody("Refs #12");
    const region = jumiPrBodyRegion(liveBody) ?? liveBody;
    const persisted = { prNumber: 99, decision: "refs" as const, regionSha256: sha256Hex(region) };
    expect(
      buildFollowupPullRequestBody(12, "Done.", liveBody, undefined, [], undefined, [], {
        persistedClosing: persisted,
        prNumber: 99,
      })
    ).toMatch(/fixes #12/i);
  });

  test("persisted record parsing and hash gating", () => {
    expect(parsePersistedPrClosing(undefined)).toBeUndefined();
    expect(parsePersistedPrClosing({ prNumber: 0, decision: "refs", regionSha256: sha256Hex("x") })).toBeUndefined();
    expect(parsePersistedPrClosing({ prNumber: 1, decision: "nope", regionSha256: sha256Hex("x") })).toBeUndefined();
    const record = { prNumber: 7, decision: "refs" as const, regionSha256: sha256Hex("region") };
    expect(parsePersistedPrClosing(record)).toEqual(record);
    expect(persistedClosingDecision(record, 8, "region")).toBeUndefined();
    expect(persistedClosingDecision(record, 7, "other")).toBeUndefined();
    expect(persistedClosingDecision(record, 7, "region")).toBe("refs");
  });

  test("persisted field survives other FollowUpState writes and memory round-trips", async () => {
    const record = { prNumber: 7, decision: "refs" as const, regionSha256: sha256Hex("region") };
    const parsed = parseFollowUpState({
      prNumber: 7,
      round: 2,
      lastHeadSha: "abc",
      handledCommentIds: [1],
      handledReviewIds: [],
      handledReviewFindings: [],
      updatedAt: "t",
      suggestionHold: { count: 1 },
      prClosing: record,
    });
    expect(parsed.prClosing).toEqual(record);
    expect(parsed.suggestionHold).toEqual({ count: 1 });
    const rewritten = parseFollowUpState({ ...parsed, handledCommentIds: [1, 2] });
    expect(rewritten.prClosing).toEqual(record);
    const path = `/tmp/jumi-pr-closing-test/worker/jobs/acme/widgets/42.followup.json`;
    await writeFollowUpState(path, { ...parsed, prNumber: 7 });
    expect((await readFollowUpState(path)).prClosing).toEqual(record);
  });

  test("postgres latch store round-trips the persisted field inside followup JSON", async () => {
    const record = { prNumber: 7, decision: "fixes" as const, regionSha256: sha256Hex("region") };
    let saved: unknown;
    const fakeSql = {
      unsafe: async (text: string, params?: unknown[]) => {
        if (text.includes("SELECT followup")) {
          return [{ followup: saved ?? {}, conflict: {}, ci: {}, stuck: {}, review_stuck: {} }];
        }
        saved = params?.[3] != null ? JSON.parse(params[3] as string) : {};
        return [];
      },
    };
    const store = new PgSkipLatchStore(fakeSql as never);
    const key = { owner: "acme", repo: "widgets", issueNumber: 42 };
    await store.put(key, {
      followup: { prNumber: 7, round: 1, prClosing: record },
    });
    const roundTripped = parseFollowUpState((await store.get(key)).followup);
    expect(roundTripped.prClosing).toEqual(record);
  });
});
