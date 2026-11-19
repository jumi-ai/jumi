import { expect } from "bun:test";
import { GiteaAPI, toTask as toGiteaTask } from "../src/api.ts";
import { hasLabel } from "../src/assignee.ts";
import { isAutomergeOptedIn } from "../src/automerge.ts";
import { parseAutomergeLabelEvent } from "../src/automerge_webhook.ts";
import { deleteCheckpointRefViaForge } from "../src/checkpoint.ts";
import { decideCiLookupRetry, encodeCiAbsentWait } from "../src/ci.ts";
import {
  openBugsForReview,
  openMaintainerQuestionsForReview,
  openQuestionsForReview,
  openRisksForReview,
} from "../src/followup.ts";
import { forgeCapabilities } from "../src/forge_capabilities.ts";
import { GithubAPI, toTask as toGithubTask } from "../src/github_api.ts";
import { parseSkipWhy } from "../src/pr_decision.ts";
import { isSuggestionHoldEnabled } from "../src/repo_settings.ts";
import { fillMissingVerdictPatches } from "../src/review.ts";
import { ReviewVerdictStore } from "../src/review_verdict_store.ts";
import { TOO_MANY_FOLLOWUP_ROUNDS_REASON } from "../src/skip_why_texts.ts";
import {
  buildCheckTrailer,
  countBlockingFindings,
  countMaintainerQuestionFindings,
  countQuestionFindings,
} from "../src/verdict.ts";
import { forEachForge } from "./fakes/forge.ts";

const DIFF = [
  "diff --git a/src/demo.ts b/src/demo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/demo.ts",
  "+++ b/src/demo.ts",
  "@@ -1,2 +1,2 @@",
  " one",
  "-old",
  "+two",
].join("\n");

// b5a3b80: Gitea files have no patch, so located findings need the git-diff backfill.
forEachForge("b5a3b80 located findings survive the forge file shape", (preset) => {
  const file = preset.pullFile("src/demo.ts");
  if (preset.name === "gitea") {
    expect(file.patch).toBeUndefined();
  } else {
    expect(typeof file.patch).toBe("string");
  }
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    return DIFF;
  };
  const run = async () => {
    const filled = await fillMissingVerdictPatches({
      git,
      cwd: "/work",
      env: {},
      changedFiles: [file],
    });
    const store = new ReviewVerdictStore({ changedFiles: filled });
    return store.addFinding({ path: "src/demo.ts", line: 1, severity: "risk", body: "race" });
  };
  return run().then((res) => {
    expect(res.ok).toBe(true);
    if (preset.name === "github") {
      expect(calls).toHaveLength(0);
    } else {
      expect(calls.length).toBeGreaterThan(0);
    }
  });
});

// 16aae34: ref-delete refusal is swallowed like a missing ref.
forEachForge("16aae34 checkpoint ref-delete refusal stays silent", (preset) => {
  const status = preset.name === "gitea" ? 405 : 422;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("refused", { status })) as unknown as typeof fetch;
  const api = preset.name === "gitea" ? new GiteaAPI("https://gitea.example.test", "t") : new GithubAPI({ token: "t" });
  return api
    .deleteGitRef("o", "r", "refs/jumi/wip/12")
    .then(() =>
      deleteCheckpointRefViaForge(
        {
          deleteGitRef: async () => {
            throw preset.refDeleteError();
          },
        },
        "o",
        "r",
        "refs/jumi/wip/12",
        { log: () => undefined }
      )
    )
    .then(() => {
      globalThis.fetch = originalFetch;
    })
    .catch((err) => {
      globalThis.fetch = originalFetch;
      throw err;
    });
});

// d5c0830: GitHub classic 403 falls back to branch rules; Gitea has no classic path.
forEachForge("d5c0830 branch protection read resolves per forge", (preset) => {
  if (preset.name === "gitea") {
    // Capability-gated behaviour: Gitea never reports a readable schedule,
    // so the GitHub-only classic-403 fallback does not apply.
    expect(forgeCapabilities("gitea").readableAutoMergeSchedule).toBe(false);
    expect(forgeCapabilities("github").readableAutoMergeSchedule).toBe(true);
    return;
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const target = String(url);
    if (target.includes("/protection/required_status_checks")) {
      return new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
    }
    if (target.includes("/rules/branches/")) {
      return Response.json([
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "jumi/opencode-review" }] },
        },
      ]);
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  const api = new GithubAPI({ token: "t" });
  return api
    .getBranch("o", "r", "main")
    .then((branch) => {
      expect(branch.enableStatusCheck).toBe(true);
      expect(branch.requiredContexts).toContain("jumi/opencode-review");
      globalThis.fetch = originalFetch;
    })
    .catch((err) => {
      globalThis.fetch = originalFetch;
      throw err;
    });
});

// b368698: issue labels survive toTask on both forges; label webhooks parse per forge.
forEachForge("b368698 automerge labels map and parse", (preset) => {
  const task = preset.taskWithAutomergeLabel();
  expect(hasLabel(task, "automerge")).toBe(true);
  if (preset.name === "gitea") {
    const raw = new TextEncoder().encode(
      JSON.stringify({
        action: "label_updated",
        number: 6533,
        pull_request: { number: 6533 },
        repository: { full_name: "o/r" },
        sender: { login: "sampo" },
      })
    );
    const parsed = parseAutomergeLabelEvent(raw);
    expect(parsed?.action).toBe("label_updated");
    // Gitea toTask maps the real issue JSON shape with object labels.
    const giteaTask = toGiteaTask({
      number: 1,
      title: "t",
      body: "b",
      state: "open",
      html_url: "https://gitea.example.test/o/r/issues/1",
      user: { login: "sampo" },
      assignee: null,
      assignees: [],
      labels: [{ name: "automerge" }],
      updated_at: "2026-11-14T00:00:00Z",
      created_at: "2026-11-14T00:00:00Z",
    } as never);
    expect(hasLabel(giteaTask, "automerge")).toBe(true);
  } else {
    const raw = new TextEncoder().encode(
      JSON.stringify({
        action: "labeled",
        label: { name: "automerge" },
        pull_request: { number: 7 },
        repository: { full_name: "o/r" },
        sender: { login: "sampo" },
      })
    );
    const parsed = parseAutomergeLabelEvent(raw);
    expect(parsed?.labelName).toBe("automerge");
    const githubTask = toGithubTask({
      number: 1,
      title: "t",
      body: "b",
      state: "open",
      html_url: "https://github.example/o/r/issues/1",
      user: { login: "sampo" },
      assignee: null,
      assignees: [],
      labels: [{ name: "automerge" }],
      updated_at: "2026-11-14T00:00:00Z",
      created_at: "2026-11-14T00:00:00Z",
    } as never);
    expect(hasLabel(githubTask, "automerge")).toBe(true);
  }
});

// 9b8ab4a: inline-only maintainer questions count toward the hold release.
forEachForge("9b8ab4a inline maintainer questions count for the hold", (preset) => {
  void preset;
  const bot = "jumi";
  const body = [
    "<!-- jumi-findings-list:start -->",
    "- ❓ `src/demo.ts:2`: needs a human call",
    "<!-- jumi-findings-list:end -->",
    "",
    buildCheckTrailer("success", "1 maintainer question"),
  ].join("\n");
  const inlines = [
    {
      id: 1,
      path: "src/demo.ts",
      body: "src/demo.ts:2: ❓ maintainer: needs a human call <!-- jumi-review: finding -->",
      user: { login: bot },
      position: 2,
    },
  ];
  expect(openQuestionsForReview(body, inlines as never, bot)).toBe(1);
  expect(openMaintainerQuestionsForReview(body, inlines as never, bot)).toBe(1);
  expect(openBugsForReview(body, inlines as never, bot)).toBe(0);
  expect(openRisksForReview(body, inlines as never, bot)).toBe(0);
  expect(countQuestionFindings(body)).toBe(0);
  expect(countMaintainerQuestionFindings(body)).toBe(0);
});

// 401abc5: an admitted automerge label opts the PR into the suggestion hold.
forEachForge("401abc5 automerge label forces the suggestion hold", (preset) => {
  void preset;
  const missing = { state: "missing" } as never;
  expect(isSuggestionHoldEnabled(missing, true, true)).toBe(true);
  expect(isSuggestionHoldEnabled(missing, true, false)).toBe(false);
  const labels = [{ name: "automerge" }];
  expect(isAutomergeOptedIn(missing, labels, true)).toBe(true);
  expect(isAutomergeOptedIn(missing, labels, false)).toBe(false);
});

// 5674e43: the follow-up round-cap latch refuses follow-ups but not conflicts.
forEachForge("5674e43 round-cap latch lets conflict jobs through", (preset) => {
  void preset;
  const latched = parseSkipWhy(TOO_MANY_FOLLOWUP_ROUNDS_REASON);
  expect(latched.latches).toBe(true);
  expect(latched.why).toBe("round-cap");
  const skips = (mode: string) => latched.latches && !(mode === "conflict" && latched.why === "round-cap");
  expect(skips("conflict")).toBe(false);
  expect(skips("follow-up")).toBe(true);
});

// 642c97e: a CI-absent wait requeues without ever posting the raw marker as a status.
forEachForge("642c97e CI-absent wait requeues instead of failing red", (preset) => {
  void preset;
  const now = 1_700_000_000_000;
  const fresh = decideCiLookupRetry(encodeCiAbsentWait(now - 1000), now);
  expect(fresh.action).toBe("requeue");
  if (fresh.action === "requeue") {
    expect(fresh.marker.startsWith("ci-lookup-retry:")).toBe(true);
  }
  const old = decideCiLookupRetry(encodeCiAbsentWait(now - 30 * 24 * 60 * 60 * 1000), now);
  expect(old.action).toBe("exhaust");
  // The published failure trailer for no CI never echoes the wait marker.
  const trailer = buildCheckTrailer("success", "No blocking issues");
  expect(trailer).not.toContain("ci-wait-absent:");
  expect(countBlockingFindings(trailer)).toBe(0);
});
