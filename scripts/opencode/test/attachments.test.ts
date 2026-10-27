import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACHMENTS_DIR,
  ATTACHMENTS_MANIFEST,
  buildAttachmentsMarkdown,
  extractBodyAttachmentUrls,
  sanitizeAttachmentName,
  sha256Hex,
  stageIssueAttachments,
} from "../src/attachments.ts";
import {
  isAttachmentsPath,
  isScratchIgnoredPath,
  STAGE_ALL_ARGS,
  stripSentinels,
  withoutEngineTempPorcelain,
} from "../src/claimed_worktree.ts";
import { ensureEngineScratchIgnored, ATTACHMENTS_DIR as SCRATCH_ATTACHMENTS_DIR } from "../src/engine_scratch.ts";
import { IMPLEMENT_PROMPT } from "../src/git.ts";

async function withWorkdir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "jumi-attachments-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("attachments staging", () => {
  test("stages three issue attachments with matching sha256", async () => {
    await withWorkdir(async (dir) => {
      const payloads = new Map([
        ["https://gitea.example/attachments/a1", bytes("dataset-one")],
        ["https://gitea.example/attachments/b2", bytes("expected-fixture")],
        ["https://gitea.example/attachments/c3", bytes("checker-script")],
      ]);
      const api = {
        async listIssueAttachments() {
          return [
            {
              id: 1,
              uuid: "a1",
              name: "data.csv",
              size: 11,
              browser_download_url: "https://gitea.example/attachments/a1",
            },
            {
              id: 2,
              uuid: "b2",
              name: "expected.json",
              size: 16,
              browser_download_url: "https://gitea.example/attachments/b2",
            },
            {
              id: 3,
              uuid: "c3",
              name: "check.sh",
              size: 14,
              browser_download_url: "https://gitea.example/attachments/c3",
            },
          ];
        },
        async downloadAttachmentBytes(url: string) {
          const hit = payloads.get(url);
          if (!hit) throw new Error(`missing ${url}`);
          return hit;
        },
      };
      const result = await stageIssueAttachments({
        api,
        owner: "o",
        repo: "r",
        indexes: [12],
        bodies: ["see https://gitea.example/attachments/a1"],
        worktree: dir,
        log: () => undefined,
      });
      expect(result.stagedCount).toBe(3);
      expect(result.records.length).toBe(3);
      for (const record of result.records) {
        expect(record.staged).toBe(true);
        const onDisk = await readFile(join(dir, ATTACHMENTS_DIR, record.name));
        expect(sha256Hex(new Uint8Array(onDisk))).toBe(record.sha256);
        expect(
          payloads.get(record.url) ?? payloads.get(`https://gitea.example/attachments/${record.name}`) ?? onDisk
        ).toBeDefined();
      }
      const manifest = await readFile(join(dir, ATTACHMENTS_MANIFEST), "utf8");
      expect(manifest).toContain("data.csv");
      expect(manifest).toContain("sha256:");
      expect(manifest).toContain(".jumi-attachments/");
      expect(manifest).toContain("https://gitea.example/attachments/a1");
    });
  });

  test("follow-up merges issue and PR attachments and dedupes by uuid", async () => {
    await withWorkdir(async (dir) => {
      const api = {
        calls: [] as number[],
        async listIssueAttachments(_owner: string, _repo: string, index: number) {
          this.calls.push(index);
          if (index === 12) {
            return [
              {
                id: 1,
                uuid: "same",
                name: "shared.txt",
                size: 3,
                browser_download_url: "https://gitea.example/attachments/same",
              },
            ];
          }
          return [
            {
              id: 1,
              uuid: "same",
              name: "shared.txt",
              size: 3,
              browser_download_url: "https://gitea.example/attachments/same",
            },
            {
              id: 2,
              uuid: "pr-only",
              name: "pr.txt",
              size: 2,
              browser_download_url: "https://gitea.example/attachments/pr-only",
            },
          ];
        },
        async downloadAttachmentBytes(url: string) {
          return bytes(`contents-of-${url}`);
        },
      };
      const result = await stageIssueAttachments({
        api,
        owner: "o",
        repo: "r",
        indexes: [12, 34],
        bodies: ["issue body", "pr body"],
        worktree: dir,
        log: () => undefined,
      });
      expect(api.calls).toEqual([12, 34]);
      expect(result.stagedCount).toBe(2);
      expect(result.records.map((r) => r.name).sort()).toEqual(["pr.txt", "shared.txt"]);
    });
  });

  test("caps list over-limit attachments as not staged with reasons", async () => {
    await withWorkdir(async (dir) => {
      const api = {
        async listIssueAttachments() {
          return [
            {
              id: 1,
              uuid: "big",
              name: "big.bin",
              size: 10 * 1024 * 1024,
              browser_download_url: "https://gitea.example/attachments/big",
            },
            {
              id: 2,
              uuid: "ok",
              name: "ok.txt",
              size: 2,
              browser_download_url: "https://gitea.example/attachments/ok",
            },
          ];
        },
        async downloadAttachmentBytes() {
          return bytes("ok");
        },
      };
      const result = await stageIssueAttachments({
        api,
        owner: "o",
        repo: "r",
        indexes: [7],
        bodies: [],
        worktree: dir,
        log: () => undefined,
        maxFiles: 1,
        maxBytesPerFile: 4,
        maxTotalBytes: 1024,
      });
      // big.bin exceeds per-file cap, ok.txt fits but count cap is 1 so second is over count.
      expect(result.records.length).toBe(2);
      const big = result.records.find((r) => r.url.includes("big"))!;
      expect(big.staged).toBe(false);
      expect(big.reason).toMatch(/per-file cap/);
      const manifest = await readFile(join(dir, ATTACHMENTS_MANIFEST), "utf8");
      expect(manifest).toContain("NOT STAGED");
    });
  });

  test("github user-attachment urls without a download api are documented as not supported", async () => {
    await withWorkdir(async (dir) => {
      const api = {};
      const body = "see https://github.com/user-attachments/assets/abc-123 for input";
      const result = await stageIssueAttachments({
        api,
        owner: "o",
        repo: "r",
        indexes: [9],
        bodies: [body],
        worktree: dir,
        log: () => undefined,
      });
      expect(extractBodyAttachmentUrls([body])).toEqual(["https://github.com/user-attachments/assets/abc-123"]);
      expect(result.records.length).toBe(1);
      expect(result.records[0]!.staged).toBe(false);
      expect(result.records[0]!.reason).toMatch(/not supported/);
      const manifest = await readFile(join(dir, ATTACHMENTS_MANIFEST), "utf8");
      expect(manifest).toContain("not supported");
      expect(manifest).toContain("https://github.com/user-attachments/assets/abc-123");
    });
  });

  test("sanitizes traversal names and dedupes", () => {
    const used = new Set<string>();
    expect(sanitizeAttachmentName("../../etc/passwd", used)).toBe("passwd");
    expect(sanitizeAttachmentName("a.txt", used)).toBe("a.txt");
    expect(sanitizeAttachmentName("a.txt", used)).toBe("a-2.txt");
  });

  test("manifest lists name, size, sha256 and url", () => {
    const markdown = buildAttachmentsMarkdown(
      [{ name: "data.csv", size: 11, sha256: "abc", url: "https://gitea.example/attachments/a1", staged: true }],
      ["o/r#12"]
    );
    expect(markdown).toContain("data.csv");
    expect(markdown).toContain("11 bytes");
    expect(markdown).toContain("sha256:abc");
    expect(markdown).toContain("https://gitea.example/attachments/a1");
  });

  test("no attachments writes no manifest or directory", async () => {
    await withWorkdir(async (dir) => {
      const result = await stageIssueAttachments({
        api: {},
        owner: "o",
        repo: "r",
        indexes: [1],
        bodies: [],
        worktree: dir,
        log: () => undefined,
      });
      expect(result.records).toEqual([]);
      expect(result.manifest).toBeUndefined();
      await expect(readFile(join(dir, ATTACHMENTS_MANIFEST), "utf8")).rejects.toThrow();
    });
  });
});

describe("attachments never ship", () => {
  test("stage args exclude the attachments dir and porcelain ignores it", () => {
    expect(STAGE_ALL_ARGS).toContain(`:(exclude)${ATTACHMENTS_DIR}`);
    expect(isAttachmentsPath(".jumi-attachments/a.txt")).toBe(true);
    expect(isScratchIgnoredPath(".jumi-attachments/a.txt")).toBe(true);
    expect(withoutEngineTempPorcelain("?? .jumi-attachments/a.txt\n M src/a.ts\n")).toBe("M src/a.ts");
    expect(SCRATCH_ATTACHMENTS_DIR).toBe(ATTACHMENTS_DIR);
  });

  test("stripSentinels removes the attachments dir and manifest", async () => {
    await withWorkdir(async (dir) => {
      await mkdir(join(dir, ATTACHMENTS_DIR), { recursive: true });
      await writeFile(join(dir, ATTACHMENTS_DIR, "a.txt"), "x");
      await writeFile(join(dir, ATTACHMENTS_MANIFEST), "manifest");
      await stripSentinels(dir, [ATTACHMENTS_MANIFEST]);
      await expect(readFile(join(dir, ATTACHMENTS_DIR, "a.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(join(dir, ATTACHMENTS_MANIFEST), "utf8")).rejects.toThrow();
    });
  });

  test("ensureEngineScratchIgnored also ignores the attachments dir", async () => {
    await withWorkdir(async (dir) => {
      const { spawnSync } = await import("node:child_process");
      const run = (args: string[]) => {
        const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
        if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
      };
      run(["init", "-q", "-b", "main"]);
      expect(await ensureEngineScratchIgnored(dir)).toBe(true);
      const { readFile: readExclude } = await import("node:fs/promises");
      const { engineScratchExcludePath } = await import("../src/engine_scratch.ts");
      const excludePath = await engineScratchExcludePath(dir);
      expect(excludePath).toBeDefined();
      const text = await readExclude(excludePath!, "utf8");
      expect(text).toContain(".jumi-tmp/");
      expect(text).toContain(".jumi-attachments/");
    });
  });

  test("worker prompt mentions the attachments manifest", () => {
    expect(IMPLEMENT_PROMPT).toContain("JUMI_ATTACHMENTS.md");
    expect(IMPLEMENT_PROMPT).toContain(".jumi-attachments/");
  });
});
