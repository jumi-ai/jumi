import { describe, expect, test } from "bun:test";
import { createPiReviewCustomTools } from "../src/pi_review.ts";
import { resolveReviewFacts } from "../src/review_facts.ts";
import { probeReviewMcpServer, startReviewMcpServer } from "../src/review_mcp.ts";
import {
  attachPostPullReviewMeta,
  attachStickyReviewMeta,
  buildReviewMetaBlock,
  decodeMetaPayload,
  deriveReviewMetaKey,
  encodeMetaPayload,
  insertReviewMetaBeforeTrailer,
  parseReviewMetaBlock,
  sha256Hex,
  signMetaPayload,
  verifyReviewMeta,
} from "../src/review_meta.ts";
import { buildKeyedPriors } from "../src/review_prior.ts";
import { type KeyedPriorInfo, ReviewVerdictStore } from "../src/review_verdict_store.ts";
import {
  findingFingerprint,
  parseReviewFindings,
  parseReviewOutput,
  publishedFindingBlocks,
  reviewFindingLines,
} from "../src/verdict.ts";
import type { GitRunner } from "../src/workspace.ts";
import { makeComment } from "./fixtures.ts";

const PATCH = ["@@ -1,3 +1,5 @@", " context", "-old", "+new line two", "+new line three", " context", " tail"].join(
  "\n"
);
const SECRET = "test-webhook-secret-979";
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

function keyedPrior(overrides: Partial<KeyedPriorInfo> & { key: string }): KeyedPriorInfo {
  return {
    text: "🔴 bug: broken",
    severity: "bug",
    placement: "body",
    path: "src/a.ts",
    line: 2,
    unchanged: true,
    ...overrides,
  };
}

function makeStore(priors: KeyedPriorInfo[], unkeyed: string[] = []) {
  return new ReviewVerdictStore({
    changedFiles: [{ filename: "src/a.ts", patch: PATCH }],
    ...(priors.length > 0 ? { keyedPriors: priors } : {}),
    ...(unkeyed.length > 0 ? { previousFindings: unkeyed } : {}),
  });
}

function signSticky(
  bodyWithoutMeta: string,
  findings: Parameters<typeof encodeMetaPayload>[0]["findings"],
  opts: { head?: string } = {}
) {
  const payload = {
    v: 1 as const,
    forge: IDENTITY,
    repo: `${OWNER}/${REPO}`,
    pr: PR,
    head: opts.head ?? HEAD,
    state: "failure" as const,
    md: sha256Hex(bodyWithoutMeta),
    findings,
  };
  const hex = encodeMetaPayload(payload);
  const sig = signMetaPayload(hex, deriveReviewMetaKey(SECRET));
  return insertReviewMetaBeforeTrailer(bodyWithoutMeta, buildReviewMetaBlock(hex, sig));
}

function stickyBody(findingsText: string, trailer: string, head: string = HEAD): string {
  const inner = findingsText.trim() ? `${findingsText}\n\n` : "";
  return `${MARKER}\n### Jumi review\n\nReviewed commit: \`${head}\`\n\n${inner}${trailer}`;
}

function fakeGit(handlers: Record<string, (args: string[]) => string>): GitRunner {
  return (async (args: string[]) => {
    const key = args[0] ?? "";
    if (handlers[key]) return handlers[key](args);
    throw new Error(`unexpected git ${args.join(" ")}`);
  }) as GitRunner;
}

describe("dispositions: missing gate", () => {
  test("same-head re-review requires disposition even without previous_findings", () => {
    const store = makeStore([keyedPrior({ key: "k_job_1" })]);
    const verdict = store.setVerdict({ state: "success" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/k_job_1/);
    expect(store.setDisposition({ key: "k_job_1", disposition: "fixed" }).ok).toBe(true);
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
  });

  test("unknown and ineligible keys are errors", () => {
    const store = makeStore([keyedPrior({ key: "k_job_1" })]);
    expect(store.setDisposition({ key: "nope", disposition: "fixed" }).ok).toBe(false);
    expect(store.setDisposition({ key: "k_job_1", disposition: "bogus" }).ok).toBe(false);
  });

  test("fixed/withdrawn add no finding; replacing works", () => {
    const store = makeStore([keyedPrior({ key: "k_job_1" })]);
    expect(store.setDisposition({ key: "k_job_1", disposition: "fixed", note: "gone" }).ok).toBe(true);
    expect(store.listFindings()).toHaveLength(0);
    expect(store.setDisposition({ key: "k_job_1", disposition: "withdrawn" }).ok).toBe(true);
    expect(store.listFindings()).toHaveLength(0);
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
    expect(store.toRecord().dispositions).toEqual([{ key: "k_job_1", disposition: "withdrawn", by: "reviewer" }]);
  });

  test("incomplete needs no dispositions; explicit still_present still validates", () => {
    const store = makeStore([keyedPrior({ key: "k_job_1" })]);
    expect(store.setVerdict({ state: "failure", incomplete: "could_not_finish" }).ok).toBe(true);
    const store2 = makeStore([keyedPrior({ key: "k_job_1" })]);
    const out = store2.setDisposition({ key: "k_job_1", disposition: "still_present" });
    expect(out.ok).toBe(true);
    if (out.ok && "id" in out) expect(out.id).toMatch(/^f/);
    expect(store2.listFindings()).toHaveLength(1);
  });
});

describe("dispositions: still_present", () => {
  test("unchanged file prefills location; same key twice returns same handle", () => {
    const store = makeStore([
      keyedPrior({ key: "k_job_1", text: "🔴 bug: broken  double", path: "src/a.ts", line: 2, unchanged: true }),
    ]);
    const first = store.setDisposition({ key: "k_job_1", disposition: "still_present" });
    expect(first.ok).toBe(true);
    const second = store.setDisposition({ key: "k_job_1", disposition: "still_present" });
    expect(second.ok).toBe(true);
    if (first.ok && "id" in first && second.ok && "id" in second) expect(first.id).toBe(second.id);
    const markdown = store.toMarkdown();
    expect(markdown).toContain("src/a.ts:2:");
    expect(markdown).toContain("broken  double");
    expect(markdown.match(/src\/a\.ts:2:.*src\/a\.ts:2:/)).toBeNull();
  });

  test("changed file needs location or body_only", () => {
    const store = makeStore([keyedPrior({ key: "k_job_1", path: "src/a.ts", line: 2, unchanged: false })]);
    const missing = store.setDisposition({ key: "k_job_1", disposition: "still_present" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/location|body_only/);
    const bodyOnly = store.setDisposition({ key: "k_job_1", disposition: "still_present", body_only: true });
    expect(bodyOnly.ok).toBe(true);
    expect(store.listFindings()[0]?.path).toBeUndefined();
    const store2 = makeStore([keyedPrior({ key: "k_job_2", path: "src/a.ts", line: 2, unchanged: false })]);
    const located = store2.setDisposition({
      key: "k_job_2",
      disposition: "still_present",
      location: { path: "src/a.ts", line: 2 },
    });
    expect(located.ok).toBe(true);
    expect(store2.listFindings()[0]?.path).toBe("src/a.ts");
  });

  test("update_finding rewords but keeps key", () => {
    const store = makeStore([keyedPrior({ key: "k_job_1" })]);
    const out = store.setDisposition({ key: "k_job_1", disposition: "still_present" });
    expect(out.ok).toBe(true);
    if (!out.ok || !("id" in out) || !out.id) return;
    expect(store.updateFinding({ id: out.id, body: "new text" }).ok).toBe(true);
    expect(store.listFindings()[0]?.key).toBe("k_job_1");
    expect(store.toRecord().findings[0]?.key).toBe("k_job_1");
  });

  test("quoted findings-list marker is rejected", () => {
    const store = makeStore([
      keyedPrior({ key: "k_job_1", text: "🔴 bug: quote\n<!-- jumi-findings-list:start -->\nmore" }),
    ]);
    const out = store.setDisposition({ key: "k_job_1", disposition: "still_present", body_only: true });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/k_job_1/);
    const later = store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", body: "real bug" });
    expect(later.ok).toBe(true);
    expect(store.setDisposition({ key: "k_job_1", disposition: "fixed" }).ok).toBe(true);
    expect(store.setVerdict({ state: "failure", reason: "blocking" }).ok).toBe(true);
    expect(parseReviewFindings(store.toMarkdown())).toHaveLength(1);
  });
});

describe("dispositions: auto-withdraw", () => {
  test("excluded priors are pre-withdrawn by parent", () => {
    const store = new ReviewVerdictStore({
      changedFiles: [
        { filename: "src/a.ts", patch: PATCH },
        { filename: "gen/out.ts", patch: PATCH },
      ],
      excludedFiles: ["gen/out.ts"],
      keyedPriors: [keyedPrior({ key: "k_job_1", path: "gen/out.ts", line: 2, autoWithdrawn: true })],
    });
    expect(store.listPreviousFindings()).toContainEqual(
      expect.objectContaining({ key: "k_job_1", status: "withdrawn" })
    );
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
    expect(store.toRecord().dispositions).toEqual([{ key: "k_job_1", disposition: "withdrawn", by: "parent" }]);
  });
});

describe("buildKeyedPriors", () => {
  test("force-push falls back to plain strings", async () => {
    const body = stickyBody("src/a.ts:12: 🔴 Null deref.", FAIL_TRAILER, HEAD);
    const signed = signSticky(
      body,
      [{ k: "k_job_1_1", s: "bug", p: "body", path: "src/a.ts", line: 12, proof: 0, o: 1 }],
      {
        head: HEAD,
      }
    );
    const git = fakeGit({
      "merge-base": () => {
        throw new Error("not ancestor");
      },
    });
    const out = await buildKeyedPriors({
      comments: [makeComment({ id: 1, body: signed })],
      reviews: [],
      inlines: [],
      botUsername: BOT,
      marker: MARKER,
      trust: { webhookSecret: SECRET, forgeIdentity: IDENTITY, owner: OWNER, repo: REPO, prNumber: PR },
      currentHeadSha: OTHER_HEAD,
      prFilenames: new Set(["src/a.ts"]),
      excludedFilenames: new Set(),
      git,
      cwd: "/tmp",
      env: {},
    });
    expect(out.verified).toBe(false);
    expect(out.keyed).toHaveLength(0);
    expect(out.unkeyed.length).toBeGreaterThan(0);
    expect(out.unkeyed.every((line) => typeof line === "string")).toBe(true);
  });

  test("duplicate identical body findings collapse to unkeyed", async () => {
    const raw = stickyBody(
      "src/a.ts:12: Null deref on empty input.\nsrc/a.ts:12: Null deref on empty input.",
      FAIL_TRAILER,
      HEAD
    );
    const signed = signSticky(
      raw,
      [
        { k: "k_job_1_1", s: "bug", p: "body", path: "src/a.ts", line: 12, proof: 0, o: 1 },
        { k: "k_job_1_2", s: "bug", p: "body", path: "src/a.ts", line: 12, proof: 0, o: 2 },
      ],
      { head: HEAD }
    );
    const git = fakeGit({});
    const out = await buildKeyedPriors({
      comments: [makeComment({ id: 1, body: signed })],
      reviews: [],
      inlines: [],
      botUsername: BOT,
      marker: MARKER,
      trust: { webhookSecret: SECRET, forgeIdentity: IDENTITY, owner: OWNER, repo: REPO, prNumber: PR },
      currentHeadSha: HEAD,
      prFilenames: new Set(["src/a.ts"]),
      excludedFilenames: new Set(),
      git,
      cwd: "/tmp",
      env: {},
    });
    expect(out.verified).toBe(true);
    expect(out.keyed).toHaveLength(0);
    expect(out.unkeyed.length).toBeGreaterThan(0);
  });

  test("removed file auto-withdraws", async () => {
    const body = stickyBody("src/gone.ts:3: 🔴 Gone bug.", FAIL_TRAILER, HEAD);
    const signed = signSticky(
      body,
      [{ k: "k_job_1_1", s: "bug", p: "body", path: "src/gone.ts", line: 3, proof: 0, o: 1 }],
      {
        head: HEAD,
      }
    );
    const git = fakeGit({
      "ls-tree": () => "",
    });
    const out = await buildKeyedPriors({
      comments: [makeComment({ id: 1, body: signed })],
      reviews: [],
      inlines: [],
      botUsername: BOT,
      marker: MARKER,
      trust: { webhookSecret: SECRET, forgeIdentity: IDENTITY, owner: OWNER, repo: REPO, prNumber: PR },
      currentHeadSha: HEAD,
      prFilenames: new Set(["src/gone.ts"]),
      excludedFilenames: new Set(),
      git,
      cwd: "/tmp",
      env: {},
    });
    expect(out.verified).toBe(true);
    expect(out.keyed[0]?.autoWithdrawn).toBe(true);
  });

  test("existence lookup failure falls back to unverified text", async () => {
    const body = stickyBody("src/a.ts:3: 🔴 Present bug.", FAIL_TRAILER, HEAD);
    const signed = signSticky(
      body,
      [{ k: "k_job_1_1", s: "bug", p: "body", path: "src/a.ts", line: 3, proof: 0, o: 1 }],
      {
        head: HEAD,
      }
    );
    const git = fakeGit({
      "ls-tree": () => {
        throw new Error("workspace git failure");
      },
    });
    const out = await buildKeyedPriors({
      comments: [makeComment({ id: 1, body: signed })],
      reviews: [],
      inlines: [],
      botUsername: BOT,
      marker: MARKER,
      trust: { webhookSecret: SECRET, forgeIdentity: IDENTITY, owner: OWNER, repo: REPO, prNumber: PR },
      currentHeadSha: HEAD,
      prFilenames: new Set(["src/a.ts"]),
      excludedFilenames: new Set(),
      git,
      cwd: "/tmp",
      env: {},
    });
    expect(out.verified).toBe(false);
    expect(out.keyed).toHaveLength(0);
    expect(out.unkeyed.length).toBeGreaterThan(0);
  });
});

describe("MCP and Pi parity", () => {
  async function drive(
    call: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>
  ): Promise<string[]> {
    const out: string[] = [];
    const prior = { key: "k_job_1", text: "🔴 bug: broken", severity: "bug", status: "pending" };
    void prior;
    const prev = await call("previous_findings", {});
    out.push(`prev:${prev.ok}:${prev.text.slice(0, 80)}`);
    const bad = await call("set_disposition", { key: "nope", disposition: "fixed" });
    out.push(`bad:${bad.ok}:${bad.text.slice(0, 60)}`);
    const fixed = await call("set_disposition", { key: "k_job_1", disposition: "fixed" });
    out.push(`fixed:${fixed.ok}:${fixed.text}`);
    const verdict = await call("set_verdict", { state: "success" });
    out.push(`verdict:${verdict.ok}:${verdict.text}`);
    return out;
  }

  test("identical sequences give identical results", async () => {
    const mcpStore = makeStore([keyedPrior({ key: "k_job_1" })]);
    const mcpServer = await startReviewMcpServer({ store: mcpStore, token: "tok" });
    try {
      const mcpOut = await drive((name, args) => probeReviewMcpServer(mcpServer.url, "tok", name, args));
      const piStore = makeStore([keyedPrior({ key: "k_job_1" })]);
      const tools = createPiReviewCustomTools(piStore);
      const byName = new Map(tools.map((tool) => [(tool as { name: string }).name, tool as never]));
      const piCall = async (name: string, args: Record<string, unknown>) => {
        const tool = byName.get(name) as unknown as {
          execute: (_id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
        };
        if (!tool) return { ok: false, text: `unknown tool: ${name}` };
        const res = await tool.execute("id", args);
        return { ok: !res.isError, text: res.content[0]?.text ?? "" };
      };
      const piOut = await drive((name, args) => {
        const mapped =
          name === "previous_findings"
            ? "jumi_previous_findings"
            : name === "set_disposition"
              ? "jumi_set_disposition"
              : name === "set_verdict"
                ? "jumi_set_verdict"
                : name;
        return piCall(mapped, args);
      });
      expect(piOut).toEqual(mcpOut);
    } finally {
      mcpServer.close();
    }
  });
});

describe("signed block dispositions", () => {
  test("next block lists dispositions; old readers classify identically", async () => {
    const store = makeStore([keyedPrior({ key: "k_job_1" })]);
    expect(store.setDisposition({ key: "k_job_1", disposition: "still_present" }).ok).toBe(true);
    expect(store.setVerdict({ state: "failure", reason: "blocking" }).ok).toBe(true);
    const record = store.toRecord();
    const comment = "src/a.ts:2: 🔴 bug: broken";
    const trailer = "<!-- jumi-check: failure; blocking -->";
    const sticky = `${MARKER}\n### Jumi review\n\nReviewed commit: \`${HEAD}\`\n\n${comment}\n\n${trailer}`;
    const blocks = publishedFindingBlocks(comment, { keep: [] }).map((block) => ({
      first: block.first,
      body: block.body,
      rest: block.rest,
      ...(block.path !== undefined ? { path: block.path } : {}),
      ...(block.line !== undefined ? { line: block.line } : {}),
    }));
    void blocks;
    const withMeta = attachStickyReviewMeta({
      meta: {
        webhookSecret: SECRET,
        forgeIdentity: IDENTITY,
        jobId: "job-1",
        record,
      },
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      headSha: HEAD,
      marker: MARKER,
      botUsername: BOT,
      state: "failure",
      stickyBody: sticky,
      comment,
      log: () => undefined,
    });
    const parsed = parseReviewMetaBlock(withMeta);
    expect(parsed).toBeDefined();
    const payload = decodeMetaPayload(parsed!.payloadHex);
    expect(payload.dispositions).toEqual([{ key: "k_job_1", disposition: "still_present", by: "reviewer" }]);
    expect(payload.findings[0]?.k).toBe("k_job_1");
    const verified = verifyReviewMeta(withMeta, SECRET, { headSha: HEAD });
    expect(verified.ok).toBe(true);
    const typed = resolveReviewFacts({
      body: withMeta,
      trust: {
        webhookSecret: SECRET,
        forgeIdentity: IDENTITY,
        owner: OWNER,
        repo: REPO,
        prNumber: PR,
        headSha: HEAD,
      },
    });
    expect(typed.source).toBe("typed");
    const legacyBody = withMeta.replace(/<!-- jumi-review:meta.*?-->/s, "");
    expect(parseReviewOutput(legacyBody).verdict.state).toBe("failure");
    expect(parseReviewOutput(withMeta).verdict.state).toBe("failure");
    expect(parseReviewFindings(legacyBody)).toHaveLength(parseReviewFindings(withMeta).length);
  });

  test("postPullReview shape verifies and maps inlines", async () => {
    const { buildFindingsList, stripFindingLines } = await import("../src/verdict.ts");
    const comment = "src/a.ts:2: 🔴 bug: Null deref on empty input.";
    const findings = parseReviewFindings(comment);
    const posted = new Set([findingFingerprint(findings[0]!.path, findings[0]!.body)]);
    const livePostedBody = `${findings[0]!.body}\n\n${MARKER}`;
    const published = [{ id: 501, path: findings[0]!.path, body: livePostedBody, new_position: 2 }];
    const list = buildFindingsList(findings);
    const failed = stripFindingLines(comment, { posted });
    const topBody = [
      MARKER,
      "### Jumi review",
      "",
      `Reviewed commit: \`${HEAD}\``,
      "",
      [list, failed].filter(Boolean).join("\n\n"),
      "",
      FAIL_TRAILER,
    ].join("\n");
    const store = new ReviewVerdictStore({ changedFiles: [{ filename: "src/a.ts", patch: PATCH }] });
    expect(
      store.addFinding({ path: "src/a.ts", line: 2, severity: "bug", body: "Null deref on empty input." }).ok
    ).toBe(true);
    expect(store.setVerdict({ state: "failure", reason: "blocking" }).ok).toBe(true);
    const record = store.toRecord();
    const finalBody = attachPostPullReviewMeta({
      meta: {
        webhookSecret: SECRET,
        giteaUrl: "https://gitea.example.com",
        forgeIdentity: IDENTITY,
        jobId: "job-1",
        verdictState: "failure",
        record,
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
    const live = [
      {
        id: 501,
        body: livePostedBody,
        user: { login: BOT },
        created_at: "",
        updated_at: "",
        path: "src/a.ts",
        new_position: 2,
      },
    ];
    const resolved = resolveReviewFacts({
      body: finalBody,
      inlines: live as never,
      trust: { webhookSecret: SECRET, forgeIdentity: IDENTITY, owner: OWNER, repo: REPO, prNumber: PR, headSha: HEAD },
    });
    expect(resolved.source).toBe("typed");
    expect(resolved.facts.findings.find((finding) => finding.inlineId === 501)?.severity).toBe("bug");
  });
});

describe("text-era priors", () => {
  test("no block behaves as today", () => {
    const store = new ReviewVerdictStore({
      changedFiles: [{ filename: "src/a.ts", patch: PATCH }],
      previousFindings: ["src/a.ts:2: 🔴 old bug"],
    });
    expect(store.listPreviousFindings()).toEqual(["src/a.ts:2: 🔴 old bug"]);
    expect(store.setVerdict({ state: "success" }).ok).toBe(true);
  });
});
