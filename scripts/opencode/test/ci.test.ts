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
  checkDurationMs,
  classifyInfraFlake,
  decideCiLookupRetry,
  dropUnpackNoise,
  encodeCiAbsentWait,
  encodeCiLookupMarker,
  encodeCiPendingWait,
  failureLines,
  flakeExhaustedComment,
  flakeRerunCommentFor,
  flakeRerunFailedComment,
  flakeRerunsCommentFor,
  flakeSkipReason,
  formatCheckDuration,
  hashText,
  infraFlakeReason,
  inspectCi,
  isCheckHandled,
  isFlakeRerunSpent,
  jobMatchesCheck,
  latestStatuses,
  parseCiState,
  needsCiFollowUp as realNeedsCiFollowUp,
  recordCiHandled,
  recordFlakeReruns,
  resolveCiGate,
  resolveRequiredCiContexts,
  reviewSkipReasonForCi,
  splitFlakeBudget,
  summarizeCiChecks,
} from "../src/ci.ts";
import { traced } from "./golden/trace.ts";

const needsCiFollowUp = traced("needsCiFollowUp", realNeedsCiFollowUp);

import { followUpStatePath } from "../src/claim.ts";
import { writeFollowUpState } from "../src/followup.ts";
import type { IssueApi } from "../src/gitea_issues.ts";
import { makeIssueApi } from "./fakes/forge.ts";
import { emptyCiMethods, makeComment, makeIssue, makePR, makeRepo } from "./fixtures.ts";
import { withWorkspace } from "./harness/temp.ts";

function ciApi(overrides: Partial<IssueApi> = {}): IssueApi {
  return makeIssueApi({ ...overrides });
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

  test("failing bun test takes precedence over a later job step flake", () => {
    const log = [
      "(fail) adds numbers [0.03ms]",
      "helm: values.schema.json remote schema 429 Too Many Requests",
      "##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(classifyInfraFlake(log)).toBeUndefined();
  });

  test("split schema and timeout across fail lines is not a flake", () => {
    const log = ["(fail) loads values.schema.json defaults", "(fail) retry gives up after timeout"].join("\n");
    expect(classifyInfraFlake(log)).toBeUndefined();
  });

  test("real test failure next to GitHub 140.82 timeout is not a flake", () => {
    const log = [
      "(fail) adds numbers",
      "##[error]Failed to connect to 140.82.112.4 port 443: Connection timed out",
    ].join("\n");
    expect(classifyInfraFlake(log)).toBeUndefined();
  });

  test("failing test title carrying an infra signature is not a flake", () => {
    const log = [
      "error: expect(received).toBe(expected)",
      "(fail) infraFlakeReason > detects Helm remote-schema 429",
    ].join("\n");
    expect(classifyInfraFlake(log)).toBeUndefined();
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

  test("rerun budget is one per head and check, without the log hash", async () => {
    const { memorySkipLatchesFor } = await import("../src/skip_latches.ts");
    const home = await mkdtemp(join(tmpdir(), "jumi-ci-budget-"));
    try {
      const store = memorySkipLatchesFor(home);
      const key = { owner: "o", repo: "r", issueNumber: 1 };
      const { readCiLatch } = await import("../src/ci.ts");
      let state = await readCiLatch(store, key);
      expect(isFlakeRerunSpent(state, "HEAD", "build")).toBe(false);
      await recordFlakeReruns({
        home,
        owner: "o",
        repo: "r",
        issueNumber: 1,
        prNumber: 2,
        sha: "HEAD",
        checkNames: ["build"],
        skipLatches: store,
      });
      state = await readCiLatch(store, key);
      expect(isFlakeRerunSpent(state, "HEAD", "build")).toBe(true);
      expect(isFlakeRerunSpent(state, "head", "build")).toBe(true);
      expect(isFlakeRerunSpent(state, "HEAD", "lint")).toBe(false);
      expect(isFlakeRerunSpent(state, "OTHER", "build")).toBe(false);
      const split = splitFlakeBudget(state, "HEAD", [
        { name: "build", state: "failure", description: "", capped: "", logHash: "a" },
        { name: "lint", state: "failure", description: "", capped: "", logHash: "b" },
      ]);
      expect(split.toRerun.map((c) => c.name)).toEqual(["lint"]);
      expect(split.exhausted.map((c) => c.name)).toEqual(["build"]);
      expect(parseCiState({ prNumber: 2, handled: [], updatedAt: "" }).flakeReruns).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rerun comments name the check, reason, link, and budget", () => {
    expect(
      flakeRerunCommentFor({ name: "helm-lint", flake: "GitHub 140.82 timeout", targetUrl: "https://ci/job/9" })
    ).toBe("Reran `helm-lint` (GitHub 140.82 timeout) — [rerun](https://ci/job/9). Automatic rerun 1/1.");
    expect(flakeRerunsCommentFor([{ name: "build" }])).toContain("Automatic rerun 1/1");
    expect(
      flakeExhaustedComment([
        { name: "build", state: "failure", description: "", capped: "", logHash: "x", flake: "r" },
      ])
    ).toContain("already failed");
    expect(
      flakeRerunFailedComment(
        [{ name: "build", state: "failure", description: "", capped: "", logHash: "x", flake: "r" }],
        "403 missing"
      )
    ).toContain("Automatic rerun failed: 403 missing");
  });

  test("unittest FAIL header blocks a flake classification", () => {
    const log = [
      "FAIL: test_add (calc.CalcTest)",
      "helm: values.schema.json remote schema 429 Too Many Requests",
      "##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(classifyInfraFlake(log)).toBeUndefined();
  });

  test("pytest FAILED line blocks a flake classification", () => {
    const log = [
      "FAILED chart/tests/test_plan.py::test_talos - AssertionError: dry-run failed",
      "helm: values.schema.json remote schema 429 Too Many Requests",
      "##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(classifyInfraFlake(log)).toBeUndefined();
  });

  test("error-command infra text classifies as a flake", () => {
    const log = [
      "::error::helm values.schema.json remote schema 429 Too Many Requests",
      "##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(classifyInfraFlake(log)).toContain("Helm");
  });
});

describe("failureLines", () => {
  test("returns chart-check error messages without the echoed source or footer", () => {
    const log = [
      "::group::Run chart checks",
      'echo "::error::SSH setup did not succeed"',
      "::error::Failed chart checks: chart-local suites",
      "::error::sampo (unittest) timed out after 1500s (rc=124)",
      "##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(failureLines(log)).toEqual([
      "Failed chart checks: chart-local suites",
      "sampo (unittest) timed out after 1500s (rc=124)",
    ]);
    expect(failureLines(capFailedJobLog(log))).toEqual([
      "Failed chart checks: chart-local suites",
      "sampo (unittest) timed out after 1500s (rc=124)",
    ]);
  });

  test("returns talos error messages without the echoed source or footer", () => {
    const log = [
      "::group::Run talos plan",
      'echo "::error::plan preview"',
      "::error::unknown chart suite completion '9'",
      "::error::Talos dry-run failed (exit code 1)",
      "::error::job talos-plan result=failure (required because paths matched)",
      "##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(failureLines(log)).toEqual([
      "unknown chart suite completion '9'",
      "Talos dry-run failed (exit code 1)",
      "job talos-plan result=failure (required because paths matched)",
    ]);
  });

  test("strips file/line properties and timestamp prefixes", () => {
    const log = [
      "2026-11-15T10:00:00.0000000Z ::error file=deploy.yaml,line=12::Talos dry-run failed (exit code 1)",
      "2026-11-15T10:00:01.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(failureLines(log)).toEqual(["Talos dry-run failed (exit code 1)"]);
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
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("treats in-progress Actions jobs as pending when statuses have not appeared", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("treats completed failed Actions jobs as red when statuses have not appeared", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("treats live failed jobs as red even when a matching forge status is still green", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("completed live success clears a lagging pending forge status", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("green rerun clears a stale failed forge status", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("unmatched pending forge context still keeps CI pending", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("a thrown forge list call is lookupFailed, not empty success", async () => {
    await withWorkspace(async (home) => {
      let listed: { headSha?: string } | undefined;
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("logs why a forge list call threw", async () => {
    await withWorkspace(async (home) => {
      const lines: string[] = [];
      await inspectCi({
        api: ciApi({
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
    });
  });

  test("partial list failure is not green", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("no other checks and no matching jobs is empty", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi(),
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
    });
  });

  test("skipped completed jobs are not pending or red", async () => {
    expect(actionJobCheckState({ id: 1, name: "build", status: "completed", conclusion: "skipped" })).toBe("success");
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("prefers job id from target_url over listActionJobs match", async () => {
    await withWorkspace(async (home) => {
      const requested: number[] = [];
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("matches Gitea 1.27 context via listActionJobs when target_url is missing", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("classifies Helm schema rate limiting in the capped window as a flake", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("does not treat bun fixture rate-limit text as an infra flake", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("fetches logs, caps, and treats unknown red as unhandled", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
          api: ciApi({
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
    });
  });

  test("same sha+check+hash is handled; log hash change is not", async () => {
    await withWorkspace(async (home) => {
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
    });
  });

  test("GitHub failed check-run is unhandled when statuses are only jumi/opencode-review", async () => {
    await withWorkspace(async (home) => {
      const requested: number[] = [];
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("log fetch failure still treats a failed GitHub check-run as unhandled", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
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
    });
  });

  test("pending GitHub check-run sibling skips; skipped jobs are not red", async () => {
    await withWorkspace(async (home) => {
      const pending = await inspectCi({
        api: ciApi({
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
          api: ciApi({
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
        api: ciApi({
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
    });
  });

  test("does not share budget with follow-up comment rounds", async () => {
    await withWorkspace(async (home) => {
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
          api: ciApi({
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
    });
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

  test("requeues a fresh router absent-wait marker anchored to firstSeen", () => {
    const now = 1_000_000;
    const firstSeen = now - 60_000;
    expect(decideCiLookupRetry(encodeCiAbsentWait(firstSeen), now)).toEqual({
      action: "requeue",
      count: 1,
      firstFailAt: firstSeen,
      backoffMs: CI_LOOKUP_BACKOFF_MS[0],
      marker: encodeCiLookupMarker(1, firstSeen),
    });
  });

  test("exhausts a router absent-wait marker past the lookup budget", () => {
    const now = 1_000_000;
    const firstSeen = now - (CI_LOOKUP_BUDGET_MS + 60_000);
    expect(decideCiLookupRetry(encodeCiAbsentWait(firstSeen), now)).toEqual({
      action: "exhaust",
      reason: CI_LOOKUP_FAILED_REASON,
    });
  });

  test("requeues a fresh router pending-wait marker anchored to firstSeen", () => {
    const now = 2_000_000;
    const firstSeen = now - 60_000;
    const decision = decideCiLookupRetry(encodeCiPendingWait(firstSeen), now);
    expect(decision.action).toBe("requeue");
    if (decision.action === "requeue") {
      expect(decision.firstFailAt).toBe(firstSeen);
      expect(decision.marker).toBe(encodeCiLookupMarker(1, firstSeen));
    }
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

describe("ci check summaries", () => {
  test("gitea green head reports deduped non-Jumi checks with duration and url", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
          listCommitStatuses: async () => [
            {
              id: 1,
              context: "check / check (pull_request)",
              status: "failure",
              target_url: "https://gitea.example/owner/repo/actions/runs/1/jobs/1",
              created_at: "2026-11-08T08:00:00.000Z",
              updated_at: "2026-11-08T08:10:00.000Z",
            },
            {
              id: 3,
              context: "check / check (pull_request)",
              status: "success",
              target_url: "https://gitea.example/owner/repo/actions/runs/42037/jobs/92860",
              created_at: "2026-11-08T08:15:00.000Z",
              updated_at: "2026-11-08T08:35:07.000Z",
            },
            {
              id: 2,
              context: "format / format (pull_request)",
              status: "success",
              target_url: "https://gitea.example/owner/repo/actions/runs/42038/jobs/92861",
              created_at: "2026-11-08T08:34:00.000Z",
              updated_at: "2026-11-08T08:34:47.000Z",
            },
            { id: 4, context: "jumi/opencode-review", state: "success" },
          ],
          listActionJobs: async () => [],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(reviewSkipReasonForCi(inspection)).toBeUndefined();
      expect(inspection.checks).toEqual([
        {
          name: "check / check (pull_request)",
          conclusion: "success",
          duration: "20m7s",
          url: "https://gitea.example/owner/repo/actions/runs/42037/jobs/92860",
        },
        {
          name: "format / format (pull_request)",
          conclusion: "success",
          duration: "47s",
          url: "https://gitea.example/owner/repo/actions/runs/42038/jobs/92861",
        },
      ]);
    });
  });

  test("github check runs and statuses share the same shape", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
          listCommitStatuses: async () => [{ id: 1, context: "jumi/opencode-review", state: "success" }],
          listCheckRuns: async () => [
            {
              id: 11,
              context: "checks",
              status: "success",
              target_url: "https://github.com/kirmanak/demo/actions/runs/9/job/11",
              created_at: "2026-11-08T08:00:00.000Z",
              updated_at: "2026-11-08T08:01:02.000Z",
            },
            {
              id: 12,
              context: "image",
              status: "success",
              target_url: "https://github.com/kirmanak/demo/actions/runs/9/job/12",
            },
          ],
          listActionJobs: async () => [],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(reviewSkipReasonForCi(inspection)).toBeUndefined();
      expect(inspection.checks).toEqual([
        {
          name: "checks",
          conclusion: "success",
          duration: "1m2s",
          url: "https://github.com/kirmanak/demo/actions/runs/9/job/11",
        },
        {
          name: "image",
          conclusion: "success",
          url: "https://github.com/kirmanak/demo/actions/runs/9/job/12",
        },
      ]);
    });
  });

  test("summarizeCiChecks keeps non-success entries first and drops the Jumi context", () => {
    expect(
      summarizeCiChecks([
        { id: 2, context: "zzz", status: "success" },
        { id: 3, context: "jumi/opencode-review", state: "success" },
        { id: 1, context: "aaa", status: "warning" },
      ]).map((check) => check.name)
    ).toEqual(["aaa", "zzz"]);
  });

  test("check duration formats hours, minutes, and seconds", () => {
    expect(formatCheckDuration(0)).toBe("0s");
    expect(formatCheckDuration(47_000)).toBe("47s");
    expect(formatCheckDuration(62_000)).toBe("1m2s");
    expect(formatCheckDuration(1_207_000)).toBe("20m7s");
    expect(formatCheckDuration(3_661_000)).toBe("1h1m1s");
    expect(checkDurationMs({})).toBeUndefined();
    expect(
      checkDurationMs({ created_at: "2026-11-08T08:35:07.000Z", updated_at: "2026-11-08T08:15:00.000Z" })
    ).toBeUndefined();
  });
});

describe("required-context pending", () => {
  test("resolveRequiredCiContexts ignores jumi/opencode-review", async () => {
    const api = {
      getBranch: async () => ({
        enableStatusCheck: true,
        requiredContexts: ["jumi/opencode-review", "build"],
      }),
    };
    expect(await resolveRequiredCiContexts(api, { owner: "o", repo: "r", prNumber: 7, baseBranch: "main" })).toEqual([
      "build",
    ]);
  });

  test("resolveRequiredCiContexts falls back when only Jumi is required", async () => {
    const lines: string[] = [];
    const api = {
      getBranch: async () => ({
        enableStatusCheck: true,
        requiredContexts: ["jumi/opencode-review"],
      }),
    };
    expect(
      await resolveRequiredCiContexts(api, {
        owner: "o",
        repo: "r",
        prNumber: 7,
        baseBranch: "main",
        log: (m) => lines.push(m),
      })
    ).toBeUndefined();
    expect(lines).toHaveLength(1);
  });

  test("resolveRequiredCiContexts falls back when getBranch throws or checks are disabled", async () => {
    const throwing = { getBranch: async () => Promise.reject(new Error("boom")) };
    expect(
      await resolveRequiredCiContexts(throwing, { owner: "o", repo: "r", prNumber: 7, baseBranch: "main" })
    ).toBeUndefined();
    const disabled = { getBranch: async () => ({ enableStatusCheck: false, requiredContexts: [] }) };
    expect(
      await resolveRequiredCiContexts(disabled, { owner: "o", repo: "r", prNumber: 7, baseBranch: "main" })
    ).toBeUndefined();
    const missing = {};
    expect(await resolveRequiredCiContexts(missing, { owner: "o", repo: "r", prNumber: 7 })).toBeUndefined();
  });

  test("required success with an optional pending check is not pending", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
          listCommitStatuses: async () => [
            { id: 1, context: "build", status: "success" },
            { id: 2, context: "optional", status: "pending" },
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
        requiredContexts: ["build"],
      });
      expect(inspection.pending).toBe(false);
      expect(inspection.pendingOptional).toEqual(["optional"]);
      expect(reviewSkipReasonForCi(inspection)).toBeUndefined();
    });
  });

  test("a pending required context still waits", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
          listCommitStatuses: async () => [
            { id: 1, context: "build", status: "pending" },
            { id: 2, context: "optional", status: "success" },
          ],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
        requiredContexts: ["build"],
      });
      expect(inspection.pending).toBe(true);
      expect(inspection.pendingOptional).toEqual([]);
    });
  });

  test("a required context that never reported still waits", async () => {
    await withWorkspace(async (home) => {
      const inspection = await inspectCi({
        api: ciApi({
          listCommitStatuses: async () => [{ id: 2, context: "optional", status: "success" }],
        }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
        requiredContexts: ["build"],
      });
      expect(inspection.pending).toBe(true);
      expect(inspection.pendingOptional).toEqual([]);
    });
  });

  test("no required set keeps today's any-check pending behaviour", async () => {
    await withWorkspace(async (home) => {
      const statuses = [{ id: 1, context: "build", status: "success" as const }];
      const pendingOnly = [{ id: 2, context: "optional", status: "pending" as const }];
      const withSet = await inspectCi({
        api: ciApi({ listCommitStatuses: async () => [...statuses, ...pendingOnly] }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
      });
      expect(withSet.pending).toBe(true);
      const narrowed = await inspectCi({
        api: ciApi({ listCommitStatuses: async () => [...statuses, ...pendingOnly] }),
        owner: "kirmanak",
        repo: "demo",
        sha: "headsha",
        home,
        issueNumber: 12,
        requiredContexts: ["build"],
      });
      expect(narrowed.pending).toBe(false);
    });
  });
});

describe("ci gate wait resolution", () => {
  test("no default ref never reads the base branch file", async () => {
    let reads = 0;
    const api = {
      ...emptyCiMethods(),
      getRepo: async () => Promise.reject(new Error("boom")),
      getRepoFile: async () => {
        reads += 1;
        return { found: true, content: "ci_gate:\n  wait: none\n" };
      },
    };
    const gate = await resolveCiGate(api, { owner: "o", repo: "r", prNumber: 7, baseBranch: "main" });
    expect(gate.wait).toBe("required");
    expect(reads).toBe(0);
  });

  test("default branch file decides the mode", async () => {
    const api = {
      ...emptyCiMethods(),
      getRepoFile: async (_o: string, _r: string, _p: string, ref: string) => ({
        found: true,
        content: `ci_gate:\n  wait: none\n# ref ${ref}\n`,
      }),
    };
    const gate = await resolveCiGate(api, { owner: "o", repo: "r", prNumber: 7, defaultBranch: "main" });
    expect(gate.wait).toBe("none");
  });

  test("getRepo resolves the default ref when none is given", async () => {
    const api = {
      ...emptyCiMethods(),
      getRepo: async () => ({ default_branch: "main" }),
      getRepoFile: async () => ({ found: true, content: "ci_gate:\n  wait: all\n" }),
    };
    const gate = await resolveCiGate(api, { owner: "o", repo: "r", prNumber: 7 });
    expect(gate.wait).toBe("all");
  });
});
