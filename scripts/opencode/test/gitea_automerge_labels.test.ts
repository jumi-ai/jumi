import { describe, expect, test } from "bun:test";
import { GiteaAPI, toPull, toTask } from "../src/api.ts";
import { hasLabel } from "../src/assignee.ts";

/** Realistic `GET /repos/{owner}/{repo}/issues/{index}` body (Gitea 1.27). */
function giteaIssueJson() {
  return {
    id: 6532,
    number: 6532,
    title: "Something needs doing",
    body: "please do it",
    state: "open",
    html_url: "https://gitea.example.test/personal/server_configuration/issues/6532",
    user: { id: 2, login: "sampo" },
    assignee: null,
    assignees: [],
    labels: [
      {
        id: 5,
        name: "automerge",
        color: "ee9900",
        description: "",
        url: "https://gitea.example.test/api/v1/repos/personal/server_configuration/labels/5",
      },
    ],
    updated_at: "2026-11-14T00:00:00Z",
    created_at: "2026-11-14T00:00:00Z",
  };
}

/** Realistic Gitea PR body as returned by `GET /repos/{o}/{r}/pulls/{n}`. */
function giteaPrJson(number: number, labels: Array<{ id: number; name: string }>) {
  return {
    id: 9000 + number,
    number,
    title: "Jumi: something",
    body: "Fixes #6532",
    state: "open",
    html_url: `https://gitea.example.test/personal/server_configuration/pulls/${number}`,
    user: { id: 9, login: "jumi" },
    head: {
      label: "personal:feature",
      ref: "jumi/issue-6532-foo",
      sha: "headsha",
      repo: {
        full_name: "personal/server_configuration",
        clone_url: "https://gitea.example.test/personal/server_configuration.git",
      },
    },
    base: { label: "personal:main", ref: "main", sha: "basesha" },
    merged: false,
    labels,
    created_at: "2026-11-14T00:00:00Z",
    updated_at: "2026-11-16T07:19:33Z",
  };
}

/** Realistic `pull_request_label` delivery (Gitea 1.27, X-Gitea-Event-Type). */
function giteaLabelWebhook(action: "label_updated" | "label_cleared", labels: Array<{ id: number; name: string }>) {
  return {
    action,
    number: 6533,
    pull_request: giteaPrJson(6533, labels),
    repository: {
      full_name: "personal/server_configuration",
      default_branch: "main",
      html_url: "https://gitea.example.test/personal/server_configuration",
      clone_url: "https://gitea.example.test/personal/server_configuration.git",
    },
    sender: { id: 2, login: "sampo" },
  };
}

const AUTOMERGE_LABEL = { id: 5, name: "automerge" };
const NO_AUTOMERGE_LABEL = { id: 6, name: "no-automerge" };

describe("gitea automerge label fixtures", () => {
  test("toTask maps labels from real GET issue JSON", async () => {
    const task = toTask(giteaIssueJson() as never);
    expect(hasLabel(task, "automerge")).toBe(true);
  });

  test("opening a PR from an automerge-labelled issue copies the label and schedules (GiteaAPI)", async () => {
    const originalFetch = globalThis.fetch;
    const posted: Array<{ url: string; body: string }> = [];
    try {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url);
        const method = init?.method ?? "GET";
        if (method === "GET" && href.endsWith("/repos/personal/server_configuration/issues/6532")) {
          return Response.json(giteaIssueJson());
        }
        if (method === "GET" && href.includes("/issues/6532/timeline")) {
          return Response.json([{ type: "label", label: { name: "automerge" }, user: { login: "sampo" } }]);
        }
        if (method === "GET" && href.includes("/collaborators/sampo/permission")) {
          return Response.json({ permission: "write", role_name: "write" });
        }
        if (method === "GET" && href.endsWith("/repos/personal/server_configuration")) {
          return Response.json({
            name: "server_configuration",
            full_name: "personal/server_configuration",
            html_url: "https://gitea.example.test/personal/server_configuration",
            clone_url: "https://gitea.example.test/personal/server_configuration.git",
            default_branch: "main",
            owner: { login: "personal" },
          });
        }
        if (method === "GET" && href.includes("/branches/main")) {
          return Response.json({
            name: "main",
            protected: true,
            enable_status_check: true,
            status_check_contexts: ["jumi/opencode-review"],
          });
        }
        if (method === "GET" && href.includes("/contents/.jumi.yml")) {
          return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
        }
        if (method === "GET" && href.includes("/pulls/6533/files")) {
          return Response.json([]);
        }
        if (method === "GET" && href.endsWith("/pulls/6533")) {
          return Response.json(giteaPrJson(6533, [AUTOMERGE_LABEL]));
        }
        if (method === "GET" && href.includes("/issues/6533/comments")) {
          return Response.json([]);
        }
        if (method === "POST" && href.endsWith("/issues/6533/labels")) {
          posted.push({ url: href, body: String(init?.body) });
          return Response.json([{ ...AUTOMERGE_LABEL }]);
        }
        if (method === "POST" && href.endsWith("/pulls/6533/merge")) {
          posted.push({ url: href, body: String(init?.body) });
          return new Response("", { status: 201 });
        }
        if (method === "GET" && href.includes("/issues/6533/timeline")) {
          return Response.json([{ type: "label", label: { name: "automerge" }, user: { login: "jumi" } }]);
        }
        throw new Error(`unexpected fetch ${method} ${href}`);
      }) as unknown as typeof fetch;

      const { scheduleAutomergeForNewPr } = await import("../src/automerge.ts");
      const api = new GiteaAPI("https://gitea.example.test", "token-1");
      const logs: string[] = [];
      const result = await scheduleAutomergeForNewPr({
        api: api as never,
        forgeKind: "gitea",
        owner: "personal",
        repo: "server_configuration",
        prNumber: 6533,
        baseBranch: "main",
        automergeRepos: undefined,
        botUsername: "jumi",
        trustedSenderLogins: ["sampo"],
        issueNumber: 6532,
        log: (m) => logs.push(m),
      });
      expect(result).toEqual({ scheduled: true });
      expect(posted.some((p) => p.url.endsWith("/issues/6533/labels") && p.body.includes("automerge"))).toBe(true);
      expect(posted.some((p) => p.url.endsWith("/pulls/6533/merge"))).toBe(true);
      expect(logs.some((m) => m.includes("copied label"))).toBe(true);
      expect(logs.some((m) => m.includes("automerge scheduled"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("pull_request_label label_updated schedules with a log line", async () => {
    const { parseAutomergeLabelEvent, tryHandleAutomergeLabelEvent } = await import("../src/automerge_webhook.ts");
    const raw = new TextEncoder().encode(JSON.stringify(giteaLabelWebhook("label_updated", [AUTOMERGE_LABEL])));
    const parsed = parseAutomergeLabelEvent(raw);
    expect(parsed?.action).toBe("label_updated");
    expect(parsed?.number).toBe(6533);

    const pr = toPull(giteaPrJson(6533, [AUTOMERGE_LABEL]) as never);
    const calls: string[] = [];
    const api = {
      getPR: async () => {
        calls.push("getPR");
        return pr;
      },
      getRepo: async () => {
        calls.push("getRepo");
        return {
          name: "server_configuration",
          full_name: "personal/server_configuration",
          html_url: "https://gitea.example.test/personal/server_configuration",
          clone_url: "https://gitea.example.test/personal/server_configuration.git",
          default_branch: "main",
          owner: { login: "personal" },
        };
      },
      getBranch: async () => ({
        protected: true,
        enableStatusCheck: true,
        requiredContexts: ["jumi/opencode-review"],
      }),
      getRepoFile: async () => ({ found: true, content: "automerge: false\n" }),
      getPRFiles: async () => [],
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => ({ id: 1 }),
      updateIssueComment: async () => ({ id: 1 }),
      getIssue: async () => ({ labels: [], number: 6532 }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listIssueTimeline: async () => [{ event: "labeled", label: "automerge", actor: { login: "sampo" } }],
      scheduleAutoMerge: async () => {
        calls.push("scheduleAutoMerge");
      },
      cancelAutoMerge: async () => true,
    };
    const logs: string[] = [];
    const handled = await tryHandleAutomergeLabelEvent({
      rawBody: raw,
      policy: {
        giteaUrl: "https://gitea.example.test",
        allowedOrgs: ["personal"],
        allowedRepos: [],
        botUsername: "jumi",
        forgeKind: "gitea",
      },
      api: api as never,
      log: (m) => logs.push(m),
    });
    expect(handled).toEqual({ handled: true, reason: expect.stringContaining("scheduled") });
    expect(calls).toContain("scheduleAutoMerge");
    expect(logs.some((m) => m.includes("automerge scheduled") || m.includes("re-reading"))).toBe(true);
  });

  test("pull_request_label label_cleared cancels with a log line", async () => {
    const { parseAutomergeLabelEvent, tryHandleAutomergeLabelEvent } = await import("../src/automerge_webhook.ts");
    const raw = new TextEncoder().encode(JSON.stringify(giteaLabelWebhook("label_cleared", [])));
    expect(parseAutomergeLabelEvent(raw)?.action).toBe("label_cleared");

    const pr = toPull(giteaPrJson(6533, []) as never);
    const calls: string[] = [];
    const api = {
      getPR: async () => pr,
      getRepo: async () => ({
        name: "server_configuration",
        full_name: "personal/server_configuration",
        html_url: "https://gitea.example.test/personal/server_configuration",
        clone_url: "https://gitea.example.test/personal/server_configuration.git",
        default_branch: "main",
        owner: { login: "personal" },
      }),
      getBranch: async () => ({
        protected: true,
        enableStatusCheck: true,
        requiredContexts: ["jumi/opencode-review"],
      }),
      getRepoFile: async () => ({ found: true, content: "automerge: false\n" }),
      getPRFiles: async () => [],
      findStickyIssueComment: async () => undefined,
      createIssueComment: async () => ({ id: 1 }),
      updateIssueComment: async () => ({ id: 1 }),
      getIssue: async () => ({ labels: [], number: 6532 }),
      getCollaboratorPermission: async () => ({ permission: "write" }),
      listIssueTimeline: async () => [],
      scheduleAutoMerge: async () => {
        calls.push("scheduleAutoMerge");
      },
      cancelAutoMerge: async () => {
        calls.push("cancelAutoMerge");
        return true;
      },
    };
    const logs: string[] = [];
    const handled = await tryHandleAutomergeLabelEvent({
      rawBody: raw,
      policy: {
        giteaUrl: "https://gitea.example.test",
        allowedOrgs: ["personal"],
        allowedRepos: [],
        botUsername: "jumi",
        forgeKind: "gitea",
      },
      api: api as never,
      log: (m) => logs.push(m),
    });
    expect(handled.handled).toBe(true);
    expect(calls).toContain("cancelAutoMerge");
    expect(calls).not.toContain("scheduleAutoMerge");
    expect(logs.length).toBeGreaterThan(0);
    void NO_AUTOMERGE_LABEL;
  });
});
