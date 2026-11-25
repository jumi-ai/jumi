import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCodex } from "../src/codex.ts";
import {
  cleanupCodexJobHomes,
  codexJobDir,
  codexRetainedHome,
  hasCodexSessionState,
  readCodexHomeKind,
} from "../src/codex_home.ts";
import { codexThreadPath, hasResumableSession } from "../src/fallback.ts";
import { fakeBin, withFakeBins } from "./harness/bins.ts";

const THREAD = JSON.stringify({ type: "thread.started", thread_id: "thread-9" });
const AGENT = JSON.stringify({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text: "done" },
});

async function argLines(argsLog: string): Promise<string[]> {
  try {
    return (await readFile(argsLog, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function homeLines(logPath: string): Promise<string[]> {
  try {
    return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Stub Codex child: first spawn writes a rollout session file and snapshots
 * its config; a resume spawn fails loudly with `no rollout found` unless the
 * first spawn's session file is present in the same CODEX_HOME.
 */
function sessionBin(): string {
  return fakeBin(
    "codex",
    `printf '%s\\n' "$CODEX_HOME" >> "$CODEX_HOMES_LOG"
SESSION_FILE="$CODEX_HOME/sessions/2026/11/25/rollout-thread-9.jsonl"
if [ -n "$CODEX_HOME" ]; then
  case " $* " in
    *" resume "*)
      if [ ! -f "$SESSION_FILE" ]; then printf 'Error: thread/resume failed: no rollout found for thread id thread-9 (code -32600)\\n' >&2; exit 1; fi
      cp "$CODEX_HOME/config.toml" "$SNAPSHOT_DIR/config-resume.toml"
      ;;
    *)
      mkdir -p "$CODEX_HOME/sessions/2026/11/25"
      printf '{"thread":"thread-9"}\\n' > "$SESSION_FILE"
      cp "$CODEX_HOME/config.toml" "$SNAPSHOT_DIR/config-first.toml"
      ;;
  esac
fi
printf '%s\\n' '${THREAD}'
printf '%s\\n' '${AGENT}'`
  );
}

async function seedAuth(home: string, content: string): Promise<void> {
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), content);
}

describe("codex retained home", () => {
  test("review retry resumes in the same session store with rebuilt per-spawn files", async () => {
    await withFakeBins({ codex: sessionBin() }, async ({ workdir, home, argsLog }) => {
      const snapshotDir = join(home, "snapshots");
      const homesLog = join(home, "homes.log");
      await mkdir(snapshotDir, { recursive: true });
      const extraEnv = { ARGS_LOG: argsLog, CODEX_HOMES_LOG: homesLog, SNAPSHOT_DIR: snapshotDir };
      try {
        await seedAuth(home, "auth-one");
        const base = {
          type: "codex" as const,
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv,
          trace: { kind: "review" as const, owner: "o", repo: "r" },
          reviewMcp: { url: "http://127.0.0.1:1/mcp", token: "tok-first" },
        };
        expect((await runCodex(base)).status).toBe("ok");
        await seedAuth(home, "auth-two");
        expect(
          (
            await runCodex({
              ...base,
              continueSession: true,
              reviewMcp: { url: "http://127.0.0.1:1/mcp", token: "tok-second" },
            })
          ).status
        ).toBe("ok");

        const lines = await argLines(argsLog);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain("resume thread-9");

        // Same session store both spawns: the resume saw the first spawn's file.
        const homes = await homeLines(homesLog);
        expect(homes).toHaveLength(2);
        expect(homes[0]).toBeTruthy();
        expect(homes[1]).toBe(homes[0]);
        expect(homes[0]).toContain("jumi-codex-job-");
        expect(homes[0]).not.toContain(workdir);

        // Per-spawn rebuild: exactly one review-MCP entry carrying the second
        // spawn's token, plus current hooks and auth.
        const first = Bun.TOML.parse(await readFile(join(snapshotDir, "config-first.toml"), "utf8")) as {
          mcp_servers?: Record<string, { http_headers?: Record<string, string> }>;
        };
        expect(Object.keys(first.mcp_servers ?? {})).toEqual(["jumi-review"]);
        const resume = Bun.TOML.parse(await readFile(join(snapshotDir, "config-resume.toml"), "utf8")) as {
          mcp_servers?: Record<string, { url?: unknown; http_headers?: Record<string, string> }>;
        };
        expect(Object.keys(resume.mcp_servers ?? {})).toEqual(["jumi-review"]);
        expect(resume.mcp_servers?.["jumi-review"]?.url).toBe("http://127.0.0.1:1/mcp");
        expect(resume.mcp_servers?.["jumi-review"]?.http_headers?.Authorization).toBe("Bearer tok-second");

        const retained = codexRetainedHome(workdir, "review");
        expect(await readFile(join(retained, "hooks.json"), "utf8")).toContain("PreToolUse");
        // Auth was relinked/copied fresh for the second spawn, not left stale.
        expect(await readFile(join(retained, "auth.json"), "utf8")).toBe("auth-two");
        // The first spawn's session file carried over.
        expect(
          await readFile(join(retained, "sessions", "2026", "11", "25", "rollout-thread-9.jsonl"), "utf8")
        ).toContain("thread-9");
        expect(await readCodexHomeKind(workdir)).toBe("review");
        expect(await hasCodexSessionState(workdir, "review", "thread-9")).toBe(true);
        expect(await hasResumableSession(workdir)).toBe(true);
      } finally {
        await cleanupCodexJobHomes(workdir);
      }
      expect(await Bun.file(codexJobDir(workdir)).exists()).toBe(false);
    });
  });

  test("worker follow-up re-run resumes in the retained worker home", async () => {
    await withFakeBins({ codex: sessionBin() }, async ({ workdir, home, argsLog }) => {
      const snapshotDir = join(home, "snapshots");
      const homesLog = join(home, "homes.log");
      await mkdir(snapshotDir, { recursive: true });
      const extraEnv = { ARGS_LOG: argsLog, CODEX_HOMES_LOG: homesLog, SNAPSHOT_DIR: snapshotDir };
      try {
        await seedAuth(home, "worker-auth-one");
        const base = {
          type: "codex" as const,
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv,
          trace: { kind: "follow-up" as const, owner: "o", repo: "r" },
          workerMcp: { url: "http://127.0.0.1:1/mcp", token: "wtok-first" },
        };
        expect((await runCodex(base)).status).toBe("ok");
        await seedAuth(home, "worker-auth-two");
        expect(
          (
            await runCodex({
              ...base,
              continueSession: true,
              workerMcp: { url: "http://127.0.0.1:1/mcp", token: "wtok-second" },
            })
          ).status
        ).toBe("ok");

        const lines = await argLines(argsLog);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain("resume thread-9");
        const homes = await homeLines(homesLog);
        expect(homes).toHaveLength(2);
        expect(homes[1]).toBe(homes[0]);
        expect(homes[0]).toContain("codex-worker-home");

        const resume = Bun.TOML.parse(await readFile(join(snapshotDir, "config-resume.toml"), "utf8")) as {
          mcp_servers?: Record<string, { http_headers?: Record<string, string> }>;
        };
        expect(Object.keys(resume.mcp_servers ?? {})).toEqual(["jumi-worker"]);
        expect(resume.mcp_servers?.["jumi-worker"]?.http_headers?.Authorization).toBe("Bearer wtok-second");

        const retained = codexRetainedHome(workdir, "worker");
        expect(await readFile(join(retained, "auth.json"), "utf8")).toBe("worker-auth-two");
        expect(await readCodexHomeKind(workdir)).toBe("worker");
        expect(await hasResumableSession(workdir)).toBe(true);
      } finally {
        await cleanupCodexJobHomes(workdir);
      }
      expect(await Bun.file(codexJobDir(workdir)).exists()).toBe(false);
    });
  });

  test("review and worker homes stay separate: no resume across kinds", async () => {
    await withFakeBins({ codex: sessionBin() }, async ({ workdir, home, argsLog }) => {
      const snapshotDir = join(home, "snapshots");
      const homesLog = join(home, "homes.log");
      await mkdir(snapshotDir, { recursive: true });
      const extraEnv = { ARGS_LOG: argsLog, CODEX_HOMES_LOG: homesLog, SNAPSHOT_DIR: snapshotDir };
      try {
        const review = {
          type: "codex" as const,
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv,
          trace: { kind: "review" as const, owner: "o", repo: "r" },
          reviewMcp: { url: "http://127.0.0.1:1/mcp", token: "t" },
        };
        expect((await runCodex(review)).status).toBe("ok");
        // A worker spawn in the same worktree must not resume the review thread.
        const worker = await runCodex({
          type: "codex" as const,
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv,
          trace: { kind: "follow-up" as const, owner: "o", repo: "r" },
          workerMcp: { url: "http://127.0.0.1:1/mcp", token: "t" },
          continueSession: true,
        });
        expect(worker.status).toBe("ok");
        const lines = await argLines(argsLog);
        expect(lines).toHaveLength(2);
        expect(lines[1]).not.toContain("resume");
      } finally {
        await cleanupCodexJobHomes(workdir);
      }
    });
  });

  test("missing session: thread id without session state never spawns resume", async () => {
    await withFakeBins({ codex: sessionBin() }, async ({ workdir, home, argsLog }) => {
      const snapshotDir = join(home, "snapshots");
      const homesLog = join(home, "homes.log");
      await mkdir(snapshotDir, { recursive: true });
      const extraEnv = { ARGS_LOG: argsLog, CODEX_HOMES_LOG: homesLog, SNAPSHOT_DIR: snapshotDir };
      try {
        await mkdir(join(workdir, ".jumi-tmp"), { recursive: true });
        await writeFile(codexThreadPath(workdir), "thread-9\n");
        await writeFile(join(workdir, ".jumi-tmp", "codex-home-kind"), "review\n");
        expect(await hasResumableSession(workdir)).toBe(false);
        const result = await runCodex({
          type: "codex" as const,
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv,
          trace: { kind: "review" as const, owner: "o", repo: "r" },
          reviewMcp: { url: "http://127.0.0.1:1/mcp", token: "t" },
          continueSession: true,
        });
        expect(result.status).toBe("ok");
        const lines = await argLines(argsLog);
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain("resume");
      } finally {
        await cleanupCodexJobHomes(workdir);
      }
    });
  });

  test("a second job in a new worktree starts empty and never resumes the first job's thread", async () => {
    await withFakeBins({ codex: sessionBin() }, async ({ workdir, home, argsLog }) => {
      const snapshotDir = join(home, "snapshots");
      const homesLog = join(home, "homes.log");
      await mkdir(snapshotDir, { recursive: true });
      const extraEnv = { ARGS_LOG: argsLog, CODEX_HOMES_LOG: homesLog, SNAPSHOT_DIR: snapshotDir };
      const base = {
        type: "codex" as const,
        prompt: "p",
        model: "gpt-6-sol",
        workdir,
        home,
        sanitizeEnv: true,
        extraEnv,
        trace: { kind: "review" as const, owner: "o", repo: "r" },
        reviewMcp: { url: "http://127.0.0.1:1/mcp", token: "t" },
      };
      expect((await runCodex(base)).status).toBe("ok");
      expect(await hasResumableSession(workdir)).toBe(true);
      // Job ends: the retained home is gone with the rest of the harness temp.
      await cleanupCodexJobHomes(workdir);
      expect(await Bun.file(codexJobDir(workdir)).exists()).toBe(false);

      // A new worktree (new job) starts with an empty home: the old thread id
      // alone is not resumable there.
      await mkdir(join(workdir, "next"), { recursive: true });
      const next = join(workdir, "next");
      expect(codexJobDir(next)).not.toBe(codexJobDir(workdir));
      expect(await Bun.file(codexJobDir(next)).exists()).toBe(false);
      await mkdir(join(next, ".jumi-tmp"), { recursive: true });
      await writeFile(codexThreadPath(next), "thread-9\n");
      await writeFile(join(next, ".jumi-tmp", "codex-home-kind"), "review\n");
      expect(await hasResumableSession(next)).toBe(false);
      await cleanupCodexJobHomes(next);
    });
  });

  test("a run without a Jumi-owned home still uses $HOME/.codex and resumes as today", async () => {
    await withFakeBins({ codex: sessionBin() }, async ({ workdir, home, argsLog }) => {
      const snapshotDir = join(home, "snapshots");
      const homesLog = join(home, "homes.log");
      await mkdir(snapshotDir, { recursive: true });
      const extraEnv = { ARGS_LOG: argsLog, CODEX_HOMES_LOG: homesLog, SNAPSHOT_DIR: snapshotDir };
      try {
        const base = {
          type: "codex" as const,
          prompt: "p",
          model: "gpt-6-sol",
          workdir,
          home,
          sanitizeEnv: true,
          extraEnv,
          trace: { kind: "implement" as const, owner: "o", repo: "r" },
        };
        expect((await runCodex(base)).status).toBe("ok");
        expect(await hasResumableSession(workdir)).toBe(true);
        expect((await runCodex({ ...base, continueSession: true })).status).toBe("ok");
        const lines = await argLines(argsLog);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toContain("resume thread-9");
        // No Jumi-owned home: the child saw no CODEX_HOME override.
        const rawHomes = await readFile(homesLog, "utf8");
        const homeEntries = rawHomes.split("\n").slice(0, -1);
        expect(homeEntries).toHaveLength(2);
        expect(homeEntries.every((line) => line === "")).toBe(true);
        // And no job dir was keyed to the worktree.
        expect(await Bun.file(codexJobDir(workdir)).exists()).toBe(false);
      } finally {
        await cleanupCodexJobHomes(workdir);
        await rm(join(workdir, ".jumi-tmp"), { recursive: true, force: true });
      }
    });
  });
});
