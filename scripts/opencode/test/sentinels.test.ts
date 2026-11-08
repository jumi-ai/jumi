import { describe, expect, test } from "bun:test";
import { JUMI_SENTINEL_FILES, sentinelTrackedReason, tipAddedSentinels } from "../src/sentinels.ts";
import type { GitRunner } from "../src/workspace.ts";

function gitRunnerFor(calls: { args: string[]; result: string }[]): GitRunner {
  return async (args) => {
    const plain = [...args];
    while (plain[0] === "-c") plain.splice(0, 2);
    const match = calls.find((call) => JSON.stringify(call.args) === JSON.stringify(plain));
    if (!match) throw new Error(`unexpected git ${plain.join(" ")}`);
    return match.result;
  };
}

describe("sentinels", () => {
  test("shared list covers every root file Jumi writes or injects", () => {
    expect([...JUMI_SENTINEL_FILES].sort()).toEqual(
      [
        "JUMI_ATTACHMENTS.md",
        "JUMI_CI.md",
        "JUMI_CONFLICT.md",
        "JUMI_FEEDBACK.md",
        "JUMI_HANDOFF.md",
        "JUMI_PR.md",
        "JUMI_QUEUE.md",
        "JUMI_TASK.md",
      ].sort()
    );
  });

  test("reason names the branch and the added files", () => {
    const reason = sentinelTrackedReason("jumi/issue-12-fix-the-thing", ["JUMI_PR.md", "JUMI_HANDOFF.md"]);
    expect(reason).toContain("jumi/issue-12-fix-the-thing");
    expect(reason).toContain("JUMI_HANDOFF.md");
    expect(reason).toContain("JUMI_PR.md");
  });

  test("tipAddedSentinels reports files the branch adds", async () => {
    const git = gitRunnerFor([
      { args: ["merge-base", "origin/main", "HEAD"], result: "basesha" },
      {
        args: ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...JUMI_SENTINEL_FILES],
        result: "JUMI_HANDOFF.md\0",
      },
      { args: ["ls-tree", "-r", "-z", "--name-only", "basesha", "--", ...JUMI_SENTINEL_FILES], result: "" },
    ]);
    await expect(tipAddedSentinels(git, { cwd: "/work", env: {}, defaultBranch: "main" })).resolves.toEqual([
      "JUMI_HANDOFF.md",
    ]);
  });

  test("tipAddedSentinels ignores files already on the default branch", async () => {
    const git = gitRunnerFor([
      { args: ["merge-base", "origin/main", "HEAD"], result: "basesha" },
      {
        args: ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...JUMI_SENTINEL_FILES],
        result: "JUMI_HANDOFF.md\0",
      },
      {
        args: ["ls-tree", "-r", "-z", "--name-only", "basesha", "--", ...JUMI_SENTINEL_FILES],
        result: "JUMI_HANDOFF.md\0",
      },
    ]);
    await expect(tipAddedSentinels(git, { cwd: "/work", env: {}, defaultBranch: "main" })).resolves.toEqual([]);
  });

  test("tipAddedSentinels is empty when the merge base is unknown", async () => {
    const git: GitRunner = async (args) => {
      if (args[0] === "merge-base") throw new Error("no merge base");
      throw new Error(`unexpected git ${args.join(" ")}`);
    };
    await expect(tipAddedSentinels(git, { cwd: "/work", env: {}, defaultBranch: "main" })).resolves.toEqual([]);
  });
});
