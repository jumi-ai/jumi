import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { signBody } from "./fixtures.ts";
import { withEnv } from "./harness/env.ts";
import { fakeGit } from "./harness/git.ts";
import { fakeK8s } from "./harness/k8s.ts";
import { recordingSql } from "./harness/sql.ts";
import { withTempDirs, withWorkspace } from "./harness/temp.ts";
import { webhookPost } from "./harness/webhook.ts";

describe("test harness", () => {
  test("withWorkspace removes its dir even when the scope throws", async () => {
    let seen = "";
    await expect(
      withWorkspace(async (workspace) => {
        seen = workspace;
        expect(existsSync(workspace)).toBe(true);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });

  test("withTempDirs removes every dir even when the scope throws", async () => {
    let seen: string[] = [];
    await expect(
      withTempDirs(["jumi-harness-a-", "jumi-harness-b-"], async (...dirs) => {
        seen = dirs;
        expect(dirs).toHaveLength(2);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(seen).toHaveLength(2);
    for (const dir of seen) expect(existsSync(dir)).toBe(false);
  });

  test("withEnv restores set variables and deletes unset ones", async () => {
    process.env.JUMI_HARNESS_SET = "original";
    delete process.env.JUMI_HARNESS_UNSET;
    await withEnv({ JUMI_HARNESS_SET: "changed", JUMI_HARNESS_UNSET: "temporary" }, async () => {
      expect(process.env.JUMI_HARNESS_SET).toBe("changed");
      expect(process.env.JUMI_HARNESS_UNSET).toBe("temporary");
    });
    expect(process.env.JUMI_HARNESS_SET).toBe("original");
    expect(process.env.JUMI_HARNESS_UNSET).toBeUndefined();
    delete process.env.JUMI_HARNESS_SET;
  });

  test("withEnv restores even when the scope throws and leaves process.env unchanged", async () => {
    const before = { ...process.env };
    process.env.JUMI_HARNESS_THROW = "original";
    await expect(
      withEnv({ JUMI_HARNESS_THROW: "changed", JUMI_HARNESS_NEW: "new" }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(process.env.JUMI_HARNESS_THROW).toBe("original");
    expect(process.env.JUMI_HARNESS_NEW).toBeUndefined();
    delete process.env.JUMI_HARNESS_THROW;
    expect(process.env).toEqual(before);
  });

  test("withEnv beforeEach/afterEach form returns a restore function", () => {
    process.env.JUMI_HARNESS_HOOK = "original";
    const restore = withEnv({ JUMI_HARNESS_HOOK: "changed" });
    expect(process.env.JUMI_HARNESS_HOOK).toBe("changed");
    restore();
    expect(process.env.JUMI_HARNESS_HOOK).toBe("original");
    delete process.env.JUMI_HARNESS_HOOK;
  });

  test("webhookPost signature verifies with signBody", async () => {
    const body = { action: "opened" };
    const request = await webhookPost(body, {
      defaultEvent: "pull_request",
      url: "https://reviewer.test/webhooks/gitea",
    });
    expect(request.headers.get("x-gitea-event")).toBe("pull_request");
    expect(request.headers.get("x-gitea-delivery")).toBe("delivery-1");
    const raw = Buffer.from(await request.arrayBuffer());
    const expected = await signBody(new Uint8Array(raw), "webhook-secret");
    expect(request.headers.get("x-gitea-signature")).toBe(expected);
  });

  test("fakeK8s records creates, deletes, and pods", async () => {
    const fake = fakeK8s();
    const first = await fake.fetchImpl("https://k8s.test/apis/batch/v1/namespaces/default/jobs", {
      method: "POST",
      body: JSON.stringify({ metadata: { name: "job-1" } }),
    });
    expect(first.status).toBe(201);
    const conflict = await fake.fetchImpl("https://k8s.test/apis/batch/v1/namespaces/default/jobs", {
      method: "POST",
      body: JSON.stringify({ metadata: { name: "job-1" } }),
    });
    expect(conflict.status).toBe(409);
    expect(fake.creates).toEqual(["job-1", "job-1"]);
    expect(fake.jobs.has("job-1")).toBe(true);
    const deleted = await fake.fetchImpl(
      "https://k8s.test/apis/batch/v1/namespaces/default/jobs/job-1?propagationPolicy=Background",
      { method: "DELETE" }
    );
    expect(deleted.status).toBe(200);
    expect(fake.deletes).toEqual(["job-1"]);
    expect(fake.deleteUrls.some((url) => url.includes("propagationPolicy=Background"))).toBe(true);
    expect(fake.jobs.has("job-1")).toBe(false);
  });

  test("fakeGit answers rev-parse, status, and the base REVIEW.md", async () => {
    const git = fakeGit({ head: "abc123", baseReviewMd: "hello" });
    expect(await git(["rev-parse"], { cwd: "/", env: {} })).toBe("abc123");
    const plain = fakeGit();
    expect(await plain(["rev-parse"], { cwd: "/", env: {} })).toBe("headsha");
    expect(await plain(["status"], { cwd: "/", env: {} })).toBe("?? JUMI_REVIEW.md");
  });

  test("recordingSql replays row sets by query shape", async () => {
    const { sql, queries } = recordingSql({ insertRows: [{ id: 1 }] });
    expect(await sql.unsafe("INSERT INTO review_jobs")).toEqual([{ id: 1 }]);
    expect(await sql.unsafe("SELECT FOR UPDATE")).toEqual([]);
    expect(queries).toHaveLength(2);
  });
});
