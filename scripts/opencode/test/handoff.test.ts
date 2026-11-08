import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFLICT_PROMPT, FOLLOWUP_PROMPT, IMPLEMENT_PROMPT, IMPLEMENT_YIELD_PROMPT } from "../src/git.ts";
import {
  capHandoffNote,
  HANDOFF_FILE,
  HANDOFF_MAX_BYTES,
  handoffKey,
  handoffKeyForJob,
  injectStoredHandoff,
  MemoryHandoffStore,
  readHandoffFromWorktree,
  saveWorktreeHandoff,
  writeHandoffToWorktree,
} from "../src/handoff.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import { isExternalIssueJob, makeExternalIssueJob } from "../src/tracker.ts";
import { handleIssueCancel } from "../src/worker.ts";
import { handleWorkerWebhookEvent } from "../src/worker_webhook.ts";
import { makeComment, makePayload, makePR, makeRepo, makeWorkerConfig } from "./fixtures.ts";

describe("handoff note", () => {
  test("write and read round-trip a worktree file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-handoff-"));
    try {
      await writeHandoffToWorktree(dir, "key files: src/a.ts\nverified: bun test\nleft: none");
      expect(await readHandoffFromWorktree(dir)).toContain("src/a.ts");
      expect(await readFile(join(dir, HANDOFF_FILE), "utf8")).toContain("bun test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing note removes a stale file so a hop never reads another issue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-handoff-"));
    try {
      await writeFile(join(dir, HANDOFF_FILE), "stale");
      await writeHandoffToWorktree(dir, null);
      expect(await readHandoffFromWorktree(dir)).toBeNull();
      await writeFile(join(dir, HANDOFF_FILE), "stale");
      await injectStoredHandoff(dir, new MemoryHandoffStore(), handoffKey("gitea", "o", "r", 1));
      expect(await readHandoffFromWorktree(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cap truncates to 16 KiB and keeps the head", async () => {
    expect(HANDOFF_MAX_BYTES).toBe(16 * 1024);
    const big = `${"k: v\n".repeat(5000)}tail-marker`;
    const capped = capHandoffNote(big);
    expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
    expect(capped).toContain("k: v");
    expect(capped).not.toContain("tail-marker");
    expect(capHandoffNote("  hello\0\0  ")).toBe("hello");
  });

  test("store replaces the previous round note and isolates forges", async () => {
    const store = new MemoryHandoffStore();
    const gitea = handoffKey("gitea", "kirmanak", "demo", 12);
    const github = handoffKey("github", "kirmanak", "demo", 12);
    await store.put(gitea, "first");
    expect(await store.get(gitea)).toBe("first");
    await store.put(gitea, "second");
    expect(await store.get(gitea)).toBe("second");
    expect(await store.get(github)).toBeNull();
    await store.put(github, "gh");
    expect(await store.get(gitea)).toBe("second");
    await store.deleteForIssue("kirmanak", "demo", 12);
    expect(await store.get(gitea)).toBeNull();
    expect(await store.get(github)).toBeNull();
  });

  test("save caps before storing, inject returns the stored note on the next round", async () => {
    const store = new MemoryHandoffStore();
    const key = handoffKey("gitea", "kirmanak", "demo", 12);
    const first = await mkdtemp(join(tmpdir(), "jumi-handoff-"));
    const second = await mkdtemp(join(tmpdir(), "jumi-handoff-"));
    try {
      await writeHandoffToWorktree(first, `note\n${"x".repeat(20_000)}`);
      const saved = await saveWorktreeHandoff(first, store, key);
      expect(saved).not.toBeNull();
      expect(new TextEncoder().encode(saved as string).byteLength).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
      expect(new TextEncoder().encode((await store.get(key)) as string).byteLength).toBeLessThanOrEqual(
        HANDOFF_MAX_BYTES
      );
      const injected = await injectStoredHandoff(second, store, key);
      expect(injected).toBe(await store.get(key));
      expect(await readFile(join(second, HANDOFF_FILE), "utf8")).toBe((await store.get(key)) as string);
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  test("prompts require the handoff and mark the previous note as stale", () => {
    for (const prompt of [IMPLEMENT_PROMPT, IMPLEMENT_YIELD_PROMPT, FOLLOWUP_PROMPT, CONFLICT_PROMPT]) {
      expect(prompt).toContain(HANDOFF_FILE);
      expect(prompt).toContain("Do not commit JUMI_HANDOFF.md");
    }
    expect(IMPLEMENT_PROMPT).toContain("may be stale");
    expect(FOLLOWUP_PROMPT).toContain("may be stale");
    expect(CONFLICT_PROMPT).toContain("may be stale");
  });

  test("kill switch deletes the handoff via the ledger latch clear", async () => {
    const store = new MemoryReviewJobStore();
    const key = handoffKey("gitea", "kirmanak", "demo", 12);
    await store.handoffs.put(key, "round one");
    expect(await store.handoffs.get(key)).toBe("round one");
    await store.clearIssueSkipLatch("kirmanak", "demo", 12);
    expect(await store.handoffs.get(key)).toBeNull();
  });

  test("cancel queued rows also drop the handoff", async () => {
    const store = new MemoryReviewJobStore();
    const key = handoffKey("github", "kirmanak", "demo", 12);
    await store.handoffs.put(key, "round one");
    await store.cancelQueuedForIssue("kirmanak", "demo", 12);
    expect(await store.handoffs.get(key)).toBeNull();
  });

  test("handleIssueCancel clears the handoff without a ledger", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-handoff-cancel-"));
    try {
      const config = makeWorkerConfig({ home });
      const { memoryHandoffsFor } = await import("../src/handoff.ts");
      await memoryHandoffsFor(home).put(handoffKey("gitea", "kirmanak", "demo", 12), "round one");
      await handleIssueCancel(config, {} as never, "kirmanak", "demo", 12);
      expect(await memoryHandoffsFor(home).get(handoffKey("gitea", "kirmanak", "demo", 12))).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("issue close deletes the handoff", async () => {
    const store = new MemoryHandoffStore();
    await store.put(handoffKey("gitea", "kirmanak", "demo", 12), "round one");
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: "closed",
        repository: {
          full_name: "kirmanak/demo",
          html_url: "https://gitea.example/kirmanak/demo",
          clone_url: "https://gitea.example/kirmanak/demo.git",
        },
        issue: {
          number: 12,
          title: "t",
          body: "",
          html_url: "https://gitea.example/kirmanak/demo/issues/12",
          updated_at: new Date().toISOString(),
        },
        sender: { login: "alice" },
      })
    );
    const res = await handleWorkerWebhookEvent(
      new Uint8Array(body),
      "issues",
      "issues",
      "d1",
      {
        giteaUrl: "https://gitea.example",
        allowedOrgs: ["kirmanak"],
        allowedRepos: [],
        botUsername: "jumi",
      },
      {
        queue: { enqueue: () => ({ key: "k", queued: false }) },
        handoffs: store,
      }
    );
    expect(res.status).toBe(202);
    expect(await store.get(handoffKey("gitea", "kirmanak", "demo", 12))).toBeNull();
  });

  test("cancelLedgerWorkerJobs path keeps stopped behavior with handoffs present", async () => {
    const store = new MemoryReviewJobStore();
    await store.handoffs.put(handoffKey("gitea", "kirmanak", "demo", 12), "round one");
    const { cancelLedgerWorkerJobs } = await import("../src/worker_webhook.ts");
    await cancelLedgerWorkerJobs({
      store,
      api: {
        findStickyIssueComment: async () => undefined,
        createIssueComment: async () => makeComment({ body: "stopped" }),
        updateIssueComment: async () => makeComment({ body: "stopped" }),
      },
      owner: "kirmanak",
      repo: "demo",
      issueNumber: 12,
      botUsername: "jumi",
    });
    expect(await store.handoffs.get(handoffKey("gitea", "kirmanak", "demo", 12))).toBeNull();
  });

  test("pull_request close does not delete the issue-numbered handoff", async () => {
    const store = new MemoryHandoffStore();
    await store.put(handoffKey("gitea", "kirmanak", "demo", 12), "round one");
    const body = new TextEncoder().encode(
      JSON.stringify(
        makePayload({
          action: "closed",
          repository: {
            ...makeRepo(),
            html_url: "https://gitea.example/kirmanak/demo",
            clone_url: "https://gitea.example/kirmanak/demo.git",
          },
          pull_request: makePR({ number: 12, state: "closed", merged: true }),
        })
      )
    );
    const res = await handleWorkerWebhookEvent(
      new Uint8Array(body),
      "pull_request",
      "pull_request",
      "d-pr",
      {
        giteaUrl: "https://gitea.example",
        allowedOrgs: ["kirmanak"],
        allowedRepos: [],
        botUsername: "jumi",
      },
      {
        queue: { enqueue: () => ({ key: "k", queued: false }) },
        handoffs: store,
      }
    );
    expect(res.status).toBe(202);
    expect(await store.get(handoffKey("gitea", "kirmanak", "demo", 12))).toBe("round one");
  });

  test("external briefs share one handoff key, so the implement path skips them", async () => {
    const first = makeExternalIssueJob({
      tracker: "fake",
      trackerId: "FAKE-123",
      trackerUrl: "https://tracker.example/items/FAKE-123",
      title: "Fix the thing",
      body: "Please implement this.\n\nRepository: kirmanak/demo\n",
      owner: "kirmanak",
      repo: "demo",
      defaultBranch: "main",
      cloneUrl: "https://gitea.example/kirmanak/demo.git",
    });
    const second = makeExternalIssueJob({
      tracker: "fake",
      trackerId: "FAKE-456",
      trackerUrl: "https://tracker.example/items/FAKE-456",
      title: "Fix another thing",
      body: "Please implement this.\n\nRepository: kirmanak/demo\n",
      owner: "kirmanak",
      repo: "demo",
      defaultBranch: "main",
      cloneUrl: "https://gitea.example/kirmanak/demo.git",
    });
    expect(first.issueNumber).toBe(0);
    expect(isExternalIssueJob(first)).toBe(true);
    expect(isExternalIssueJob(second)).toBe(true);
    // Both briefs resolve to the same forge/owner/repo#0 key: sharing it
    // would leak notes between unrelated trackers, so implementExternalIssue
    // skips the handoff round-trip for external jobs instead of using it.
    expect(handoffKeyForJob(first)).toEqual(handoffKeyForJob(second));
  });
});
