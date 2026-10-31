import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionJobCheckState,
  buildCiMarkdown,
  CI_ABSENT_REASON,
  CI_FAILED_REASON,
  CI_LOOKUP_BACKOFF_MS,
  CI_LOOKUP_BUDGET_MS,
  CI_LOOKUP_FAILED_REASON,
  CI_LOOKUP_MAX_ATTEMPTS,
  capFailedJobLog,
  classifyInfraFlake,
  decideCiLookupRetry,
  dropUnpackNoise,
  encodeCiLookupMarker,
  flakeSkipReason,
  hashText,
  infraFlakeReason,
  inspectCi,
  isCheckHandled,
  jobMatchesCheck,
  latestStatuses,
  needsCiFollowUp,
  recordCiHandled,
  reviewSkipReasonForCi,
} from "../src/ci.ts";
import { followUpStatePath } from "../src/claim.ts";
import { writeFollowUpState } from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { emptyCiMethods, makeComment, makeIssue, makePR, makeRepo } from "./fixtures.ts";

function makeApi(overrides: Partial<IssueApi> = {}): IssueApi {
  const defaults: IssueApi = {
    getRepo: async () => makeRepo(),
    getCollaboratorPermission: async () => ({ permission: "write", role_name: "write" }),
    getIssue: async () => makeIssue(),
    getPR: async (_owner, _repo, index) => makePR({ number: index }),
    listOpenPulls: async () => [],
    createPullRequest: async (_owner, _repo, pull) => makePR({ title: pull.title, body: pull.body }),
    closePullRequest: async (_owner, _repo, index) => makePR({ number: index, state: "closed" }),
    updatePullRequestBody: async (_owner, _repo, index, body) => makePR({ number: index, body }),
    findStickyIssueComment: async () => undefined,
    createIssueComment: async (_owner, _repo, _index, body) => makeComment({ body }),
    updateIssueComment: async (_owner, _repo, _id, body) => makeComment({ body }),
    listIssueComments: async () => [],
    listPullReviewComments: async () => [],
    listPullReviews: async () => [],
    ...emptyCiMethods(),
  };
  return { ...defaults, ...overrides };
}

describe("latestStatuses", () => {
  test("keeps the highest id per context and ignores jumi review when classifying later", () => {
    const latest = latestStatuses([
      { id: 1, context: "build", status: "pending" },
      { id: 3, context: "build", status: "failure" },
      { id: 2, context: "jumi/opencode-review", state: "success" },
    ]);
    expect(latest.find((s) => s.context === "build")?.status).toBe("failure");
    expect(latest.find((s) => s.context === "jumi/opencode-review")?.state).toBe("success");
  });
});

describe("capFailedJobLog", () => {
  test("keeps the last actions error plus nearby lines and drops unpack noise", () => {
    const lines = [
      "Unpacking foo (1.0)",
      "  inflating: bar",
      ...Array.from({ length: 40 }, (_, i) => `before ${i}`),
      "##[error]Failed to find package 'platforms;android-37'",
      ...Array.from({ length: 40 }, (_, i) => `after ${i}`),
    ];
    const capped = capFailedJobLog(lines.join("\n"));
    expect(capped).toContain("##[error]Failed to find package 'platforms;android-37'");
    expect(capped).toContain("before 39");
    expect(capped).toContain("after 0");
    expect(capped).not.toContain("Unpacking foo");
    expect(capped).not.toContain("inflating: bar");
  });

  test("dropUnpackNoise removes package-unpack lines only", () => {
    const cleaned = dropUnpackNoise("Unpacking a\nreal error\nExtracting b");
    expect(cleaned).toBe("real error");
  });
});

describe("infraFlakeReason", () => {
  test("detects GitHub checkout cache unreachable", () => {
    expect(infraFlakeReason("Failed to connect to 140.82.112.4 port 443: Connection timed out")).toContain("140.82");
  });

  test("detects Helm chart schema rate limiting", () => {
    expect(infraFlakeReason("helm: values.schema.json remote schema 429 Too Many Requests")).toContain("Helm");
  });

  test("helm install waiting condition is not a flake", () => {
    expect(
      infraFlakeReason("helm install my-release --timeout 5m\nError: timed out waiting for the condition")
    ).toBeUndefined();
  });

  test("detects GARM package unpack device mismatch", () => {
    expect(infraFlakeReason("dpkg: error processing archive: Invalid cross-device link")).toContain("GARM");
  });

  test("detects tofu remote state contention", () => {
    expect(infraFlakeReason("tofu Error acquiring the state lock on s3")).toContain("S3");
  });

  test("detects Docker Hub anonymous pull throttling", () => {
    expect(
      infraFlakeReason(
        "reading manifest bookworm-slim in docker.io/library/debian: toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit"
      )
    ).toContain("Docker Hub");
  });

  test("unknown red is not a flake", () => {
    expect(infraFlakeReason("##[error]Failed to find package 'platforms;android-37'")).toBeUndefined();
  });

  test("bun failing test with rate-limit only in fixture text is not a flake", () => {
    const log = [
      "bun test v1.2.3",
      "fixture: values.schema.json remote schema 429 Too Many Requests",
      "(pass) detects Helm remote-schema 429",
      "error: expect(received).toBe(expected)",
      "  Expected: 2",
      "  Received: 1",
      "(fail) adds numbers [0.03ms]",
    ].join("\n");
    expect(classifyInfraFlake(log)).toBeUndefined();
    expect(classifyInfraFlake(capFailedJobLog(log))).toBeUndefined();
  });

  test("timestamped bun failing test with rate-limit only in fixture text is not a flake", () => {
    const log = [
      "2026-09-12T10:59:26.0000000Z bun test v1.2.3",
      "2026-09-12T10:59:26.0000000Z fixture: values.schema.json remote schema 429 Too Many Requests",
      "2026-09-12T10:59:26.0000000Z (pass) detects Helm remote-schema 429",
      "2026-09-12T10:59:26.0000000Z error: expect(received).toBe(expected)",
      "2026-09-12T10:59:26.0000000Z   Expected: 2",
      "2026-09-12T10:59:26.0000000Z   Received: 1",
      "2026-09-12T10:59:26.0000000Z (fail) adds numbers [0.03ms]",
    ].join("\n");
    expect(classifyInfraFlake(log)).toBeUndefined();
    expect(classifyInfraFlake(capFailedJobLog(log))).toBeUndefined();
  });

  test("pass line with schema tokens is ignored", () => {
    expect(classifyInfraFlake("(pass) detects Helm remote-schema 429")).toBeUndefined();
    expect(
      classifyInfraFlake(
        [
          "bun test v1.2.3",
          "fixture: values.schema.json remote schema 429 Too Many Requests",
          "(pass) detects Helm remote-schema 429 [0.03ms]",
        ].join("\n")
      )
    ).toBeUndefined();
  });

  test("pass title mentioning fail does not hide a later job step flake", () => {
    const log = [
      "(pass) bun fail log with rate-limit only in fixture text is not a flake",
      "helm: values.schema.json remote schema 429 Too Many Requests",
      "##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(classifyInfraFlake(log)).toContain("Helm");
  });

  test("failing bun test does not hide a later job step flake", () => {
    const log = [
      "(fail) adds numbers [0.03ms]",
      "helm: values.schema.json remote schema 429 Too Many Requests",
      "##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(classifyInfraFlake(log)).toContain("Helm");
  });

  test("true positives still match from unprefixed signatures plus actions error", () => {
    const processCompleted = "##[error]Process completed with exit code 1.";
    expect(
      classifyInfraFlake(
        ["Failed to connect to 140.82.112.4 port 443: Connection timed out", processCompleted].join("\n")
      )
    ).toContain("140.82");
    expect(
      classifyInfraFlake(["helm: values.schema.json remote schema 429 Too Many Requests", processCompleted].join("\n"))
    ).toContain("Helm");
    expect(
      classifyInfraFlake(["dpkg: error processing archive: Invalid cross-device link", processCompleted].join("\n"))
    ).toContain("GARM");
    expect(classifyInfraFlake(["tofu Error acquiring the state lock on s3", processCompleted].join("\n"))).toContain(
      "S3"
    );
    expect(
      classifyInfraFlake(
        [
          "reading manifest bookworm-slim in docker.io/library/debian: toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit",
          processCompleted,
        ].join("\n")
      )
    ).toContain("Docker Hub");
    expect(
      classifyInfraFlake(
        [
          "Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit",
          processCompleted,
        ].join("\n")
      )
    ).toContain("Docker Hub");
    expect(
      classifyInfraFlake(
        [
          "ERROR: failed to solve: toomanyrequests: You have reached your unauthenticated pull rate limit",
          processCompleted,
        ].join("\n")
      )
    ).toContain("Docker Hub");
  });

  test("skip reason includes the matcher class", () => {
    expect(
      flakeSkipReason([
        {
          name: "build",
          state: "failure",
          description: "",
          capped: "",
          logHash: "x",
          flake: "Helm remote-schema timeout/429",
        },
      ])
    ).toBe("CI infra flake: Helm remote-schema timeout/429");
  });
});

describe("jobMatchesCheck", () => {
  test("matches workflow / job context", () => {
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "ci.yml / build", "abc")).toBe(true);
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "build", "abc")).toBe(true);
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "zzz" }, "build", "abc")).toBe(false);
  });

  test("matches Gitea 1.27 context with event suffix", () => {
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "ci.yml / build (pull_request)", "abc")).toBe(
      true
    );
    expect(jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "Build image / build (push)", "abc")).toBe(true);
    expect(
      jobMatchesCheck({ id: 1, name: "build", head_sha: "abc" }, "ci.yml / build-android (pull_request)", "abc")
    ).toBe(false);
  });
});

describe("inspectCi", () => {
  test("ignores jumi/opencode-review, skips when another context is pending", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [
            { id: 1, context: "jumi/opencode-review", status: "failure" },
            { id: 2, context: "build", status: "failure" },
            { id: 3, context: "test", status: "pending" },
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(true);
      expect(inspection.failed.map((c) => c.name)).toEqual(["build"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("treats in-progress Actions jobs as pending when statuses have not appeared", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha", status: "in_progress" }],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(true);
      expect(inspection.empty).toBe(false);
      expect(inspection.failed).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("treats completed failed Actions jobs as red when statuses have not appeared", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listActionJobs: async () => [
            { id: 9, name: "build", head_sha: "headsha", status: "completed", conclusion: "failure" },
          ],
          getActionJobLogs: async () => "##[error]boom\n",
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.empty).toBe(false);
      expect(inspection.failed.map((c) => c.name)).toEqual(["build"]);
      expect(reviewSkipReasonForCi(inspection)).toBe(CI_FAILED_REASON);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("treats live failed jobs as red even when a matching forge status is still green", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "ci.yml / build (pull_request)", status: "success" }],
          listActionJobs: async () => [
            { id: 9, name: "build", head_sha: "headsha", status: "completed", conclusion: "failure" },
          ],
          getActionJobLogs: async () => "##[error]boom\n",
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.empty).toBe(false);
      expect(inspection.failed.map((c) => c.name)).toEqual(["ci.yml / build (pull_request)"]);
      expect(reviewSkipReasonForCi(inspection)).toBe(CI_FAILED_REASON);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("completed live success clears a lagging pending forge status", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [
            { id: 1, context: "ci.yml / build (pull_request)", status: "pending" },
            { id: 2, context: "codecov", status: "success" },
          ],
          listActionJobs: async () => [
            { id: 9, name: "build", head_sha: "headsha", status: "completed", conclusion: "success" },
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.failed).toEqual([]);
      expect(reviewSkipReasonForCi(inspection)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("green rerun clears a stale failed forge status", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "ci.yml / build (pull_request)", status: "failure" }],
          listActionJobs: async () => [
            { id: 9, name: "build", head_sha: "headsha", status: "completed", conclusion: "failure" },
            { id: 12, name: "build", head_sha: "headsha", status: "completed", conclusion: "success" },
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.failed).toEqual([]);
      expect(reviewSkipReasonForCi(inspection)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("unmatched pending forge context still keeps CI pending", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "codecov", status: "pending" }],
          listActionJobs: async () => [
            { id: 9, name: "build", head_sha: "headsha", status: "completed", conclusion: "success" },
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a thrown forge list call is lookupFailed, not empty success", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      let listed: { headSha?: string } | undefined;
      const inspection = await inspectCi({
        api: makeApi({
          listActionJobs: async (_owner, _repo, opts) => {
            listed = opts;
            throw new Error("rate limited");
          },
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(listed).toEqual({ headSha: "headsha" });
      expect(inspection.empty).toBe(true);
      expect(inspection.lookupFailed).toBe(true);
      expect(reviewSkipReasonForCi(inspection)).toBe(CI_LOOKUP_FAILED_REASON);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("logs why a forge list call threw", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const lines: string[] = [];
      await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => {
            throw new Error("statuses → 500");
          },
          listActionJobs: async () => {
            throw new Error("Gitea actions jobs list is incomplete: fetched 2000 of 3823");
          },
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
        log: (message) => lines.push(message),
      });
      expect(lines).toEqual([
        "CI lookup failed for kirmanak/demo#12: statuses → 500",
        "CI lookup failed for kirmanak/demo#12: Gitea actions jobs list is incomplete: fetched 2000 of 3823",
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("partial list failure is not green", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
          listActionJobs: async () => {
            throw new Error("rate limited");
          },
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.empty).toBe(false);
      expect(inspection.lookupFailed).toBe(true);
      expect(inspection.pending).toBe(false);
      expect(inspection.failed).toEqual([]);
      expect(reviewSkipReasonForCi(inspection)).toBe(CI_LOOKUP_FAILED_REASON);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("no other checks and no matching jobs is empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi(),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.empty).toBe(true);
      expect(inspection.lookupFailed).toBeFalsy();
      expect(reviewSkipReasonForCi(inspection)).toBe(CI_ABSENT_REASON);
      expect(inspection.failed).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("skipped completed jobs are not pending or red", async () => {
    expect(actionJobCheckState({ id: 1, name: "build", status: "completed", conclusion: "skipped" })).toBe("success");
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listActionJobs: async () => [
            { id: 9, name: "build", head_sha: "headsha", status: "completed", conclusion: "skipped" },
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.empty).toBe(false);
      expect(inspection.failed).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("prefers job id from target_url over listActionJobs match", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const requested: number[] = [];
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [
            {
              id: 1,
              context: "ci.yml / build (pull_request)",
              status: "failure",
              target_url: "https://gitea.example/owner/repo/actions/runs/3/jobs/42",
            },
          ],
          listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha", conclusion: "failure" }],
          getActionJobLogs: async (_owner, _repo, jobId) => {
            requested.push(jobId);
            return jobId === 42 ? "##[error]latest attempt\n" : "##[error]stale attempt\n";
          },
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(requested).toEqual([42]);
      expect(inspection.unhandled[0]?.capped).toContain("latest attempt");
      expect(inspection.unhandled[0]?.jobId).toBe(42);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("matches Gitea 1.27 context via listActionJobs when target_url is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "ci.yml / build (pull_request)", status: "failure" }],
          listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha", conclusion: "failure" }],
          getActionJobLogs: async () => "##[error]from jobs list\n",
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.unhandled[0]?.capped).toContain("from jobs list");
      expect(inspection.unhandled[0]?.jobId).toBe(9);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("classifies Helm schema rate limiting in the capped window as a flake", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "deploy", status: "failure" }],
          listActionJobs: async () => [{ id: 9, name: "deploy", head_sha: "headsha", conclusion: "failure" }],
          getActionJobLogs: async () =>
            "helm: values.schema.json remote schema 429 Too Many Requests\n##[error]Process completed with exit code 1.\n",
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.unhandled[0]?.flake).toContain("Helm");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not treat bun fixture rate-limit text as an infra flake", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "test", status: "failure" }],
          listActionJobs: async () => [{ id: 9, name: "test", head_sha: "headsha", conclusion: "failure" }],
          getActionJobLogs: async () =>
            [
              "bun test v1.2.3",
              "fixture: values.schema.json remote schema 429 Too Many Requests",
              "(pass) detects Helm remote-schema 429",
              "error: expect(received).toBe(expected)",
              "(fail) adds numbers [0.03ms]",
            ].join("\n"),
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.unhandled).toHaveLength(1);
      expect(inspection.unhandled[0]?.flake).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fetches logs, caps, and treats unknown red as unhandled", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure", target_url: "/jobs/9" }],
          listActionJobs: async () => [{ id: 9, name: "build", head_sha: "headsha", conclusion: "failure" }],
          getActionJobLogs: async () => "##[error]Failed to find package 'platforms;android-37'\n",
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.unhandled).toHaveLength(1);
      expect(inspection.unhandled[0]?.capped).toContain("platforms;android-37");
      expect(inspection.unhandled[0]?.flake).toBeUndefined();
      expect(
        await needsCiFollowUp({
          api: makeApi({
            listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
            getActionJobLogs: async () => "##[error]boom\n",
          }),
          owner: "kirmanak",
          repo: "demo",
          sha: "headsha",
          home,
          issueNumber: 12,
        })
      ).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("same sha+check+hash is handled; log hash change is not", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const check = {
        name: "build",
        state: "failure" as const,
        description: "",
        capped: "##[error]a",
        logHash: hashText("##[error]a"),
      };
      await recordCiHandled({
        home,
        owner: "kirmanak",
        repo: "demo",
        issueNumber: 12,
        prNumber: 127,
        sha: "headsha",
        checks: [check],
      });
      expect(
        isCheckHandled(
          { prNumber: 127, handled: [{ sha: "headsha", checkName: "build", logHash: check.logHash }], updatedAt: "" },
          "headsha",
          "build",
          check.logHash
        )
      ).toBe(true);
      expect(
        isCheckHandled(
          { prNumber: 127, handled: [{ sha: "headsha", checkName: "build", logHash: check.logHash }], updatedAt: "" },
          "headsha",
          "build",
          hashText("##[error]b")
        )
      ).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("GitHub failed check-run is unhandled when statuses are only jumi/opencode-review", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const requested: number[] = [];
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "jumi/opencode-review", state: "success" }],
          listCheckRuns: async () => [
            {
              id: 4,
              context: "checks",
              status: "failure",
              description: "Process completed with exit code 1.",
              target_url: "https://github.com/kirmanak/jumi/actions/runs/9/job/4",
              jobId: 4,
            },
            { id: 5, context: "image", status: "success" },
          ],
          getActionJobLogs: async (_owner, _repo, jobId) => {
            requested.push(jobId);
            return "##[error]lint/typecheck/tests, exit 1\n";
          },
        }),
        owner: "kirmanak",
        repo: "jumi",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.unhandled.map((c) => c.name)).toEqual(["checks"]);
      expect(inspection.unhandled[0]?.capped).toContain("lint/typecheck/tests");
      expect(requested).toEqual([4]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("log fetch failure still treats a failed GitHub check-run as unhandled", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const inspection = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "jumi/opencode-review", state: "success" }],
          listCheckRuns: async () => [
            {
              id: 4,
              context: "checks",
              status: "failure",
              description: "Process completed with exit code 1.",
              target_url: "https://github.com/kirmanak/jumi/actions/runs/9/job/4",
              jobId: 4,
            },
          ],
          getActionJobLogs: async () => {
            throw new Error("Must have admin rights to Repository");
          },
        }),
        owner: "kirmanak",
        repo: "jumi",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.unhandled).toHaveLength(1);
      expect(inspection.unhandled[0]?.name).toBe("checks");
      expect(inspection.unhandled[0]?.capped).toContain("Process completed with exit code 1.");
      expect(inspection.unhandled[0]?.capped).toContain("https://github.com/kirmanak/jumi/actions/runs/9/job/4");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("pending GitHub check-run sibling skips; skipped jobs are not red", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      const pending = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "jumi/opencode-review", state: "success" }],
          listCheckRuns: async () => [
            { id: 4, context: "checks", status: "failure", jobId: 4 },
            { id: 5, context: "image", status: "pending" },
          ],
        }),
        owner: "kirmanak",
        repo: "jumi",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(pending.pending).toBe(true);
      expect(pending.failed.map((c) => c.name)).toEqual(["checks"]);
      expect(
        await needsCiFollowUp({
          api: makeApi({
            listCommitStatuses: async () => [{ id: 1, context: "jumi/opencode-review", state: "success" }],
            listCheckRuns: async () => [
              { id: 4, context: "checks", status: "failure", jobId: 4 },
              { id: 5, context: "image", status: "pending" },
            ],
          }),
          owner: "kirmanak",
          repo: "jumi",
          sha: "headsha",
          home,
          issueNumber: 12,
        })
      ).toBe(false);

      const done = await inspectCi({
        api: makeApi({
          listCommitStatuses: async () => [{ id: 1, context: "jumi/opencode-review", state: "success" }],
          listCheckRuns: async () => [
            { id: 4, context: "checks", status: "failure", jobId: 4 },
            { id: 5, context: "image", status: "success" },
          ],
          getActionJobLogs: async () => "##[error]lint failed\n",
        }),
        owner: "kirmanak",
        repo: "jumi",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(done.pending).toBe(false);
      expect(done.unhandled.map((c) => c.name)).toEqual(["checks"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not share budget with follow-up comment rounds", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-"));
    try {
      await writeFollowUpState(followUpStatePath(home, "kirmanak", "demo", 12), {
        prNumber: 127,
        round: 3,
        lastHeadSha: "old",
        handledCommentIds: [55],
        handledReviewIds: [],
        handledReviewFindings: [],
        updatedAt: "2026-05-23T00:00:00Z",
      });
      expect(
        await needsCiFollowUp({
          api: makeApi({
            listCommitStatuses: async () => [{ id: 1, context: "build", status: "failure" }],
            getActionJobLogs: async () => "##[error]boom\n",
          }),
          owner: "kirmanak",
          repo: "demo",
          sha: "headsha",
          home,
          issueNumber: 12,
        })
      ).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("decideCiLookupRetry", () => {
  test("grows backoff then exhausts on the attempt cap", () => {
    const first = decideCiLookupRetry(null, 1_000);
    expect(first).toEqual({
      action: "requeue",
      count: 1,
      firstFailAt: 1_000,
      backoffMs: CI_LOOKUP_BACKOFF_MS[0],
      marker: encodeCiLookupMarker(1, 1_000),
    });
    const second = decideCiLookupRetry(first.action === "requeue" ? first.marker : null, 2_000);
    expect(second.action).toBe("requeue");
    if (second.action === "requeue" && first.action === "requeue") {
      expect(second.backoffMs).toBe(CI_LOOKUP_BACKOFF_MS[1]);
      expect(second.backoffMs).toBeGreaterThan(first.backoffMs);
    }
    expect(decideCiLookupRetry(encodeCiLookupMarker(CI_LOOKUP_MAX_ATTEMPTS - 1, 1_000), 2_000)).toEqual({
      action: "exhaust",
      reason: CI_LOOKUP_FAILED_REASON,
    });
  });

  test("exhausts when the wall-clock budget elapses", () => {
    expect(decideCiLookupRetry(encodeCiLookupMarker(1, 1_000), 1_000 + CI_LOOKUP_BUDGET_MS)).toEqual({
      action: "exhaust",
      reason: CI_LOOKUP_FAILED_REASON,
    });
  });
});

describe("buildCiMarkdown", () => {
  test("includes head sha and capped logs", () => {
    const md = buildCiMarkdown({
      sha: "abc",
      checks: [
        {
          name: "build",
          state: "failure",
          description: "",
          capped: "##[error]nope",
          logHash: "x",
        },
      ],
    });
    expect(md).toContain("Head SHA: abc");
    expect(md).toContain("## build");
    expect(md).toContain("##[error]nope");
    expect(md).toContain("Do not call tea");
  });
});
