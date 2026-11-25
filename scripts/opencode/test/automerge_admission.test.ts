import { describe, expect, test } from "bun:test";
import { automergeCauseId } from "../src/automerge_admission.ts";
import { MemoryAutomergeReconcileStore } from "../src/automerge_reconcile.ts";
import { JUMI_REVIEW_CONTEXT } from "../src/ci.ts";
import type { IssueApi } from "../src/ports.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { makeBranch, makeComment, makePR, makeUser } from "./fixtures.ts";

function labelApi(order: string[], opts: { prLabels: Array<string | { name?: string }>; prFails?: boolean }) {
  const fake = makeIssueApi({
    getIssue: (async () => {
      throw new Error("not used");
    }) as never,
    getRepo: (async () => {
      order.push("getRepo");
      return {
        name: "demo",
        full_name: "kirmanak/demo",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
        default_branch: "main",
        owner: { login: "kirmanak" },
        defaultMergeStyle: "merge",
      };
    }) as never,
    getPR: (async (_owner: string, _repo: string, index: number) => {
      order.push("getPR");
      if (opts.prFails) throw new Error("forge down");
      return makePR({
        number: index,
        user: makeUser({ login: "jumi" }),
        head: makeBranch({ ref: "jumi/issue-12-foo", sha: "headsha" }),
        title: "Jumi: fix the thing",
        body: "Fixes #12",
        labels: opts.prLabels as never,
      });
    }) as never,
    getRepoFile: (async () => {
      order.push("getRepoFile");
      return { found: true, content: "automerge: false\n" };
    }) as never,
    cancelAutoMerge: (async () => {
      order.push("cancelAutoMerge");
      return true;
    }) as never,
    getBranch: (async () => {
      order.push("getBranch");
      return { protected: true, enableStatusCheck: true, requiredContexts: [JUMI_REVIEW_CONTEXT] };
    }) as never,
    scheduleAutoMerge: (async () => {
      order.push("scheduleAutoMerge");
    }) as never,
    getCollaboratorPermission: (async () => ({ permission: "write" })) as never,
    createIssueComment: (async (_owner: string, _repo: string, _index: number, body: string) => {
      order.push("createIssueComment");
      return makeComment({ body });
    }) as never,
    updateIssueComment: (async (_owner: string, _repo: string, _id: number, body: string) => {
      order.push("updateIssueComment");
      return makeComment({ body });
    }) as never,
  });
  (fake as unknown as Record<string, unknown>)["getPRFiles"] = async () => {
    order.push("getPRFiles");
    return [];
  };
  (fake as unknown as Record<string, unknown>)["listIssueTimeline"] = async () => {
    order.push("listIssueTimeline");
    return [{ event: "labeled", label: "automerge", actor: { login: "alice" } }];
  };
  (fake as unknown as Record<string, unknown>)["findStickyIssueComment"] = async () => undefined;
  (fake as unknown as Record<string, unknown>)["getIssue"] = async () => ({ labels: [], number: 12 });
  return fake as unknown as IssueApi;
}

function labelBody(action: string, label: string) {
  return new TextEncoder().encode(
    JSON.stringify({
      action,
      repository: {
        full_name: "kirmanak/demo",
        default_branch: "main",
        html_url: "https://gitea.example.test/kirmanak/demo",
        clone_url: "https://gitea.example.test/kirmanak/demo.git",
      },
      label: { name: label },
      sender: { login: "alice" },
      pull_request: { number: 3 },
    })
  );
}

function policy() {
  return {
    giteaUrl: "https://gitea.example.test",
    allowedOrgs: ["kirmanak"],
    allowedRepos: [] as string[],
    botUsername: "jumi",
    forgeKind: "gitea",
  };
}

describe("automerge admission", () => {
  test("cancel defers: row before the first forge read, zero inline cancel calls", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const store = new MemoryAutomergeReconcileStore();
    const order: string[] = [];
    const seen: string[] = [];
    const origRequest = store.request.bind(store);
    store.request = (async (...args: Parameters<typeof origRequest>) => {
      seen.push("request");
      return origRequest(...args);
    }) as typeof origRequest;
    const res = await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "d1",
      policy() as never,
      {
        queue: { enqueue: async () => ({ queued: true, key: "k" }) },
        api: labelApi(order, { prLabels: [] }),
        automergeReconcile: store,
      } as never
    );
    expect(res.status).toBe(202);
    expect(String((await res.json()).reason)).toContain("cancel-deferred");
    expect([...seen, ...order][0]).toBe("request");
    expect(order).not.toContain("cancelAutoMerge");
    const claimed = await store.claimDue("tok", 60000, 10, Date.now());
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.generation).toBe(1);
  });

  test("duplicate replay makes no new row, effect, or generation", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const store = new MemoryAutomergeReconcileStore();
    const order: string[] = [];
    const deps = {
      queue: { enqueue: async () => ({ queued: true, key: "k" }) },
      api: labelApi(order, { prLabels: [] }),
      automergeReconcile: store,
    } as never;
    const first = await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "d1",
      policy() as never,
      deps
    );
    expect(first.status).toBe(202);
    const callsAfterFirst = order.length;
    const second = await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "d1",
      policy() as never,
      deps
    );
    expect(second.status).toBe(202);
    expect(String((await second.json()).reason)).toContain("duplicate");
    expect(order.length).toBe(callsAfterFirst);
    const claimed = await store.claimDue("tok", 60000, 10, Date.now());
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.generation).toBe(1);
  });

  test("distinct delivery bumps the generation; a stale settle is harmless", async () => {
    const store = new MemoryAutomergeReconcileStore();
    expect((await store.request("o", "r", 3, "d1", 1)).generation).toBe(1);
    expect((await store.request("o", "r", 3, "d2", 2)).generation).toBe(2);
    expect(await store.settle("o", "r", 3, 1)).toBe("stale");
    expect(await store.settle("o", "r", 3, 2)).toBe("deleted");
  });

  test("scheduled outcome settles its generation", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const store = new MemoryAutomergeReconcileStore();
    const order: string[] = [];
    const res = await handleWorkerWebhookEvent(
      labelBody("labeled", "automerge"),
      "pull_request",
      null,
      "d9",
      policy() as never,
      {
        queue: { enqueue: async () => ({ queued: true, key: "k" }) },
        api: labelApi(order, { prLabels: ["automerge"] }),
        automergeReconcile: store,
      } as never
    );
    expect(res.status).toBe(202);
    expect(String((await res.json()).reason)).toContain("scheduled");
    expect(await store.claimDue("tok", 60000, 10, Date.now())).toHaveLength(0);
  });

  test("request failure answers 503 before any forge read", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const store = new MemoryAutomergeReconcileStore();
    store.request = (async () => {
      throw new Error("ledger down");
    }) as never;
    const order: string[] = [];
    const res = await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "dx",
      policy() as never,
      {
        queue: { enqueue: async () => ({ queued: true, key: "k" }) },
        api: labelApi(order, { prLabels: [] }),
        automergeReconcile: store,
      } as never
    );
    expect(res.status).toBe(503);
    expect(order).not.toContain("getPR");
  });

  test("a failing PR re-read still leaves the requested row and falls through", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const store = new MemoryAutomergeReconcileStore();
    const order: string[] = [];
    await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "dg",
      policy() as never,
      {
        queue: { enqueue: async () => ({ queued: true, key: "k" }) },
        api: labelApi(order, { prLabels: [], prFails: true }),
        automergeReconcile: store,
      } as never
    );
    expect(await store.claimDue("tok", 60000, 10, Date.now())).toHaveLength(1);
  });

  test("without the dep, inline cancel behaves as today", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const order: string[] = [];
    const res = await handleWorkerWebhookEvent(
      labelBody("unlabeled", "automerge"),
      "pull_request",
      null,
      "dn",
      policy() as never,
      {
        queue: { enqueue: async () => ({ queued: true, key: "k" }) },
        api: labelApi(order, { prLabels: [] }),
      } as never
    );
    expect(res.status).toBe(202);
    expect(String((await res.json()).reason)).toContain("cancelled");
    expect(order).toContain("cancelAutoMerge");
  });

  test("non-label events leave the table empty", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const store = new MemoryAutomergeReconcileStore();
    const order: string[] = [];
    await handleWorkerWebhookEvent(
      labelBody("opened", "automerge"),
      "pull_request",
      null,
      "dn",
      policy() as never,
      {
        queue: { enqueue: async () => ({ queued: true, key: "k" }) },
        api: labelApi(order, { prLabels: [] }),
        automergeReconcile: store,
      } as never
    );
    expect(await store.claimDue("tok", 60000, 10, Date.now())).toHaveLength(0);
  });

  test("cause identity: header wins, an absent header hashes per forge", () => {
    const body = new TextEncoder().encode("{}");
    expect(automergeCauseId(body, "gitea", "hdr-1")).toBe("hdr-1");
    const gitea = automergeCauseId(body, "gitea", null);
    const github = automergeCauseId(body, "github", null);
    expect(gitea.startsWith("sha256:")).toBe(true);
    expect(github.startsWith("sha256:")).toBe(true);
    expect(gitea).not.toBe(github);
    expect(automergeCauseId(body, "gitea", null)).toBe(gitea);
    expect(automergeCauseId(body, "gitea", undefined)).toBe(gitea);
  });

  test("unreadable policy with a custom label name still requests the row", async () => {
    const { handleWorkerWebhookEvent } = await import("../src/worker_webhook.ts");
    const store = new MemoryAutomergeReconcileStore();
    const order: string[] = [];
    const api = labelApi(order, { prLabels: [] });
    api.getRepoFile = (async () => {
      order.push("getRepoFile");
      throw new Error("settings unreadable");
    }) as never;
    // A custom label matches neither default, and the policy cannot be read
    // to prove it unrelated: the obligation must still be requested.
    await handleWorkerWebhookEvent(
      labelBody("labeled", "my-custom"),
      "pull_request",
      null,
      "dc",
      policy() as never,
      {
        queue: { enqueue: async () => ({ queued: true, key: "k" }) },
        api,
        automergeReconcile: store,
      } as never
    );
    expect(await store.claimDue("tok", 60000, 10, Date.now())).toHaveLength(1);
  });

  test("github route defers the cancel and answers 503 when admission fails", async () => {
    const { handleGithubWebhookEvent } = await import("../src/github_webhook.ts");
    const store = new MemoryAutomergeReconcileStore();
    const order: string[] = [];
    const githubBody = (action: string, label: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          action,
          repository: {
            full_name: "kirmanak/demo",
            default_branch: "main",
            html_url: "https://github.com/kirmanak/demo",
            clone_url: "https://github.com/kirmanak/demo.git",
          },
          label: { name: label },
          sender: { login: "alice", type: "User" },
          pull_request: { number: 3 },
        })
      );
    const githubPolicy = () =>
      ({
        giteaUrl: "https://github.com",
        allowedOrgs: ["kirmanak"],
        allowedRepos: [] as string[],
        botUsername: "jumi",
        forgeKind: "github",
      }) as never;
    const workerDeps = {
      queue: { enqueue: async () => ({ queued: true, key: "k" }) },
      api: labelApi(order, { prLabels: [] }),
      automergeReconcile: store,
    } as never;
    const deferred = await handleGithubWebhookEvent(
      githubBody("labeled", "no-automerge"),
      "pull_request",
      "gh-1",
      githubPolicy(),
      {
        worker: workerDeps,
      } as never
    );
    expect(deferred.status).toBe(202);
    expect(String((await deferred.json()).reason)).toContain("cancel-deferred");
    expect(order).not.toContain("cancelAutoMerge");
    expect(await store.claimDue("tok", 60000, 10, Date.now())).toHaveLength(1);
    const failing = new MemoryAutomergeReconcileStore();
    failing.request = (async () => {
      throw new Error("ledger down");
    }) as never;
    const refused = await handleGithubWebhookEvent(
      githubBody("labeled", "no-automerge"),
      "pull_request",
      "gh-2",
      githubPolicy(),
      {
        worker: {
          queue: { enqueue: async () => ({ queued: true, key: "k" }) },
          api: labelApi(order, { prLabels: [] }),
          automergeReconcile: failing,
        },
      } as never
    );
    expect(refused.status).toBe(503);
  });
});
