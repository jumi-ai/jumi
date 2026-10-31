import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineFailedError } from "../src/engine.ts";
import {
  clampQuotaWaitMs,
  classifyQuotaText,
  decideQuotaRetry,
  encodeQuotaWaitMarker,
  hasQuotaInEvents,
  hasQuotaInLogDir,
  hasQuotaInLogText,
  hasQuotaRetryInDb,
  inspectQuotaHit,
  inspectQuotaInEvents,
  inspectQuotaInLogText,
  isHardQuotaText,
  isQuotaError,
  isQuotaLiveText,
  isQuotaLogLine,
  isQuotaText,
  isQuotaWaitMarker,
  isResettingQuotaText,
  parseRetryAfterMs,
  QUOTA_MESSAGE,
  QUOTA_STUCK_TEXT,
  QUOTA_WAIT_BUDGET_MS,
  QUOTA_WAIT_DEFAULT_MS,
  QUOTA_WAIT_MAX_ATTEMPTS,
  QuotaCooldown,
} from "../src/quota.ts";
import {
  cancelReviewWork,
  clearQuotaStuck,
  isQuotaStuck,
  isReviewQuotaStuck,
  markQuotaStuck,
  REVIEW_QUOTA_TTL_MS,
  readStuckState,
} from "../src/stuck.ts";

describe("isQuotaText", () => {
  test("matches Free/Go quota class", () => {
    expect(isQuotaText("FreeUsageLimitError")).toBe(true);
    expect(isQuotaText("GoUsageLimitError")).toBe(true);
    expect(isQuotaText("Free usage exceeded, subscribe to Go")).toBe(true);
    expect(isQuotaText("Free limit reached")).toBe(true);
    expect(isQuotaText("Go limit reached")).toBe(true);
    expect(isQuotaText('{"reason":"free_tier_limit"}')).toBe(true);
    expect(isQuotaText('{"reason":"account_rate_limit"}')).toBe(true);
    expect(isQuotaText("Rate limit exceeded. Please try again later.")).toBe(true);
    expect(isQuotaText("Insufficient balance")).toBe(true);
    expect(isQuotaText(QUOTA_STUCK_TEXT)).toBe(true);
  });

  test("ignores ordinary short-window 429s", () => {
    expect(isQuotaText("429 Too Many Requests")).toBe(false);
    expect(isQuotaText("Provider is overloaded")).toBe(false);
    expect(isQuotaText("Rate limit exceeded")).toBe(false);
    expect(isQuotaText("")).toBe(false);
    expect(isQuotaText(null)).toBe(false);
    expect(isQuotaText(undefined)).toBe(false);
  });

  test("requires a Free/Go distinguisher, not bare usage-limit text", () => {
    expect(isQuotaText("Usage limit reached. It will reset in 1 hour")).toBe(false);
    expect(isQuotaText("my-model usage limit reached")).toBe(false);
  });

  test("isQuotaError checks messages", () => {
    expect(isQuotaError(new Error("opencode stuck: usage limit exceeded"))).toBe(true);
    expect(isQuotaError(new Error("429 Too Many Requests"))).toBe(false);
    expect(isQuotaError(new Error("Free usage exceeded"))).toBe(true);
  });

  test("engine failure quota comes from the structured field or the authored prefix", () => {
    const echoed = new EngineFailedError(
      `opencode exited with code 1:\n'{"error": "Free usage exceeded", not json'`,
      false
    );
    expect(isQuotaError(echoed)).toBe(false);
    expect(isQuotaError(new EngineFailedError(QUOTA_MESSAGE, false))).toBe(true);
    expect(isQuotaError(new EngineFailedError(`${QUOTA_MESSAGE}\nFree usage exceeded`, false))).toBe(true);
    expect(
      isQuotaError(new EngineFailedError("opencode exited with code 1:\nbad things", false, { quota: "resetting" }))
    ).toBe(true);
    expect(
      isQuotaError(new EngineFailedError("opencode exited with code 1:\nbad things", false, { quota: "hard" }))
    ).toBe(true);
  });
});

describe("hasQuotaRetryInDb", () => {
  test("returns false for missing DB", () => {
    expect(hasQuotaRetryInDb("/nonexistent/opencode-session.db")).toBe(false);
    expect(hasQuotaRetryInDb(null)).toBe(false);
    expect(hasQuotaRetryInDb(undefined)).toBe(false);
  });

  test("detects quota in part retry payload without loading transcripts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({ role: "assistant", modelID: "m", providerID: "opencode" })
      );
      db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        "p1",
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({
          type: "retry",
          attempt: 3,
          message: "Free usage exceeded, subscribe to Go",
          action: { reason: "free_tier_limit", provider: "opencode" },
        })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores ordinary retries and empty DB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        "p1",
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({ type: "retry", attempt: 1, message: "429 Too Many Requests" })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects persisted RetryPart error shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        "p1",
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({
          type: "retry",
          attempt: 2,
          error: { name: "FreeUsageLimitError", message: "Free usage exceeded, subscribe to Go" },
          time: { created: 1 },
        })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores user-message rows quoting quota strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
      );
      // Task/feedback text legitimately quotes the error class; it must not
      // kill a healthy run.
      db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({ role: "user", content: "Abort when FreeUsageLimitError hits, see Free usage exceeded" })
      );
      db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        "p1",
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({ type: "text", text: "Handle FreeUsageLimitError in the parent" })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores bare usage-limit text without a Free/Go distinguisher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
        "p1",
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({ type: "retry", attempt: 1, message: "my-model usage limit reached, retry in 5s" })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects assistant error records in message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
      db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        "msg1",
        "ses1",
        1,
        2,
        JSON.stringify({ role: "assistant", error: { name: "GoUsageLimitError", message: "Go limit reached" } })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects quota in V2 session_message retry and error records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-v2-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session_v2 (id TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, type TEXT, seq INTEGER, data TEXT)"
      );
      db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "msg1",
        "ses1",
        1,
        2,
        "message",
        1,
        JSON.stringify({
          role: "assistant",
          error: { message: "Free usage exceeded, subscribe to Go" },
        })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects quota in V2 session_message part retry payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-v2-part-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session_v2 (id TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, type TEXT, seq INTEGER, data TEXT)"
      );
      db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "p1",
        "ses1",
        1,
        2,
        "part",
        2,
        JSON.stringify({
          type: "retry",
          attempt: 2,
          message: "Go limit reached",
          action: { reason: "account_rate_limit" },
        })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores user-message in V2 session_message quoting quota strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-v2-user-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session_v2 (id TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, type TEXT, seq INTEGER, data TEXT)"
      );
      db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "msg1",
        "ses1",
        1,
        2,
        "message",
        1,
        JSON.stringify({ role: "user", content: "Abort on FreeUsageLimitError" })
      );
      db.close();
      expect(hasQuotaRetryInDb(dbPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("inspectQuotaInEvents", () => {
  test("detects quota from JSON events array and JSONL stream", () => {
    const events = [
      { type: "step_start" },
      { type: "step_finish", part: { error: "Free usage exceeded, subscribe to Go retry-after: 3600" } },
    ];
    const hit = inspectQuotaInEvents(events);
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("resetting");
    expect(hit?.retryAfterMs).toBe(3_600_000);

    const jsonl = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "error", error: "Go limit reached" }),
    ].join("\n");
    const jsonlHit = inspectQuotaInEvents(jsonl);
    expect(jsonlHit).toBeDefined();
    expect(jsonlHit?.kind).toBe("hard");
  });

  test("returns undefined for events without quota", () => {
    const events = [
      { type: "step_start" },
      { type: "tool_use", name: "shell", input: { command: "ls" } },
      { type: "step_finish" },
    ];
    expect(inspectQuotaInEvents(events)).toBeUndefined();
    expect(hasQuotaInEvents(events)).toBe(false);
  });

  test("inspectQuotaHit prioritizes events when provided", () => {
    const events = [{ type: "step_finish", part: { error: "Free usage exceeded, subscribe to Go" } }];
    const hit = inspectQuotaHit("/nonexistent.db", "/nonexistent", events);
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("resetting");
  });
});

describe("quota stuck state", () => {
  test("blocks until kill-switch deletes the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-stuck-"));
    try {
      const path = join(dir, "12.stuck.json");
      expect(isQuotaStuck(await readStuckState(path))).toBe(false);
      await markQuotaStuck(path, QUOTA_STUCK_TEXT);
      const state = await readStuckState(path);
      expect(isQuotaStuck(state)).toBe(true);
      expect(state.quota?.reason).toBe(QUOTA_STUCK_TEXT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("live quota pattern", () => {
  test("drops the parent stuck dialect from the stream scan", () => {
    expect(isQuotaLiveText(QUOTA_STUCK_TEXT)).toBe(false);
    expect(isQuotaLiveText("FreeUsageLimitError")).toBe(true);
    expect(isQuotaLiveText("Free usage exceeded, subscribe to Go")).toBe(true);
    expect(isQuotaLiveText("Rate limit exceeded. Please try again later.")).toBe(true);
    expect(isQuotaLiveText("Insufficient balance")).toBe(true);
    expect(isQuotaLiveText("my-model usage limit reached")).toBe(false);
    expect(isQuotaLiveText("429 Too Many Requests")).toBe(false);
    expect(isQuotaLiveText("Rate limit exceeded")).toBe(false);
  });

  test("requires stream-error retry context in log lines", () => {
    expect(
      isQuotaLogLine(
        'timestamp=2026-09-14T00:00:00.000Z level=ERROR run=abc message="stream error" error.error="AI_APICallError: Free usage exceeded, subscribe to Go"'
      )
    ).toBe(true);
    // Permission lines echoing the tool command must not match.
    expect(
      isQuotaLogLine(
        'timestamp=2026-09-14T00:00:00.000Z level=INFO run=abc message="evaluated permission=bash" pattern="grep FreeUsageLimitError"'
      )
    ).toBe(false);
    // Quota string without retry context must not match.
    expect(isQuotaLogLine("FreeUsageLimitError")).toBe(false);
    expect(isQuotaLogLine("stream error: 429 Too Many Requests")).toBe(false);
    expect(isQuotaLogLine('message="stream error" error.error="Rate limit exceeded"')).toBe(false);
  });

  test("matches captured Zen stream-error log lines", () => {
    const insufficient =
      'message="stream error" providerID=opencode modelID=gpt-5.4-nano small=true agent=title error.error="AI_APICallError: Insufficient balance. Manage your billing here: https://opencode.ai/workspace/example/billing"';
    const rateLimit =
      'message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free small=false agent=build error.error="AI_APICallError: Rate limit exceeded. Please try again later."';
    expect(isQuotaLogLine(insufficient)).toBe(true);
    expect(isQuotaLogLine(rateLimit)).toBe(true);
    expect(hasQuotaInLogText(`${insufficient}\n`)).toBe(true);
    expect(hasQuotaInLogText(`${rateLimit}\n`)).toBe(true);
  });

  test("scans log text line-wise", () => {
    expect(
      hasQuotaInLogText(
        'level=INFO message="evaluated permission=bash" pattern="grep FreeUsageLimitError"\nlevel=ERROR message="stream error" error="FreeUsageLimitError"\n'
      )
    ).toBe(true);
    expect(hasQuotaInLogText('level=INFO pattern="grep FreeUsageLimitError"\n')).toBe(false);
    expect(hasQuotaInLogText(null)).toBe(false);
  });

  test("scans the isolated log dir in both layouts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-log-"));
    try {
      const logDir = join(dir, "log");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(logDir, { recursive: true });
      expect(hasQuotaInLogDir(logDir)).toBe(false);
      expect(hasQuotaInLogDir(join(dir, "missing"))).toBe(false);
      await writeFile(
        join(logDir, "opencode.log"),
        'level=INFO ok\nlevel=ERROR run=abc message="stream error" error="GoUsageLimitError"\n'
      );
      expect(hasQuotaInLogDir(logDir)).toBe(true);
      await rm(join(logDir, "opencode.log"));
      expect(hasQuotaInLogDir(logDir)).toBe(false);
      await writeFile(
        join(logDir, "2026-09-14T000000.log"),
        'level=ERROR run=abc message="stream error" error="free_tier_limit"\n'
      );
      expect(hasQuotaInLogDir(logDir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("reviewer quota TTL", () => {
  test("expires after the TTL instead of blocking forever", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-review-quota-"));
    try {
      const path = join(dir, "37.stuck.json");
      await markQuotaStuck(path, QUOTA_STUCK_TEXT);
      const fresh = await readStuckState(path);
      expect(isReviewQuotaStuck(fresh)).toBe(true);
      // Worker flag stays permanent.
      expect(isQuotaStuck(fresh)).toBe(true);
      const expiredAt = Date.now() + REVIEW_QUOTA_TTL_MS + 1000;
      expect(isReviewQuotaStuck(fresh, expiredAt)).toBe(false);
      await clearQuotaStuck(path);
      const cleared = await readStuckState(path);
      expect(isReviewQuotaStuck(cleared)).toBe(false);
      expect(isQuotaStuck(cleared)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reviewer cancel clears the flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-review-cancel-"));
    try {
      const home = dir;
      const { reviewStuckStatePath } = await import("../src/claim.ts");
      const { writeFile } = await import("node:fs/promises");
      const { mkdir } = await import("node:fs/promises");
      const stuckPath = reviewStuckStatePath(home, "o", "r", 37);
      await mkdir(join(home, "reviewer", "jobs", "o", "r"), { recursive: true });
      await markQuotaStuck(stuckPath, QUOTA_STUCK_TEXT);
      expect(isReviewQuotaStuck(await readStuckState(stuckPath))).toBe(true);
      await cancelReviewWork({ home, owner: "o", repo: "r", prNumber: 37 });
      expect(isReviewQuotaStuck(await readStuckState(stuckPath))).toBe(false);
      // Idempotent.
      await writeFile(stuckPath, "junk").catch(() => undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resetting vs hard quota", () => {
  test("Free/Zen class is resetting; Go and balance are hard", () => {
    expect(isResettingQuotaText("FreeUsageLimitError")).toBe(true);
    expect(isResettingQuotaText("Free usage exceeded, subscribe to Go")).toBe(true);
    expect(isResettingQuotaText("Rate limit exceeded. Please try again later.")).toBe(true);
    expect(isResettingQuotaText("free_tier_limit")).toBe(true);
    expect(isHardQuotaText("Insufficient balance")).toBe(true);
    expect(isHardQuotaText("GoUsageLimitError")).toBe(true);
    expect(isHardQuotaText("Go limit reached")).toBe(true);
    expect(isResettingQuotaText("Insufficient balance")).toBe(false);
    expect(isResettingQuotaText(QUOTA_STUCK_TEXT)).toBe(false);
    expect(classifyQuotaText("FreeUsageLimitError")).toBe("resetting");
    expect(classifyQuotaText("Insufficient balance")).toBe("hard");
  });

  test("inspectQuotaInLogText classifies the matching stream-error line", () => {
    const hit = inspectQuotaInLogText(
      'level=ERROR message="stream error" error.error="AI_APICallError: Free usage exceeded" retry-after=3600\n'
    );
    expect(hit?.kind).toBe("resetting");
    expect(hit?.retryAfterMs).toBe(3_600_000);
    expect(
      inspectQuotaInLogText(
        'message="stream error" error.error="AI_APICallError: Insufficient balance. Manage your billing"\n'
      )?.kind
    ).toBe("hard");
  });
});

describe("quota wait delay", () => {
  test("parses retry-after seconds, ms, and human units", () => {
    expect(parseRetryAfterMs("retry-after: 7200")).toBe(7_200_000);
    expect(parseRetryAfterMs("retryAfter=3600000")).toBe(3_600_000);
    expect(parseRetryAfterMs("retry in 2 hours")).toBe(7_200_000);
    expect(parseRetryAfterMs("no hint")).toBeUndefined();
  });

  test("clamps parsed waits to 1h-24h", () => {
    expect(clampQuotaWaitMs(5_000)).toBe(QUOTA_WAIT_DEFAULT_MS);
    expect(clampQuotaWaitMs(48 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
    expect(clampQuotaWaitMs(2 * 60 * 60 * 1000)).toBe(2 * 60 * 60 * 1000);
  });

  test("requeues until the 30h wall-clock budget then exhausts", () => {
    const first = decideQuotaRetry(null, 1_000, undefined, () => 0);
    expect(first.action).toBe("requeue");
    if (first.action !== "requeue") return;
    expect(first.count).toBe(1);
    expect(first.backoffMs).toBe(QUOTA_WAIT_DEFAULT_MS);
    expect(isQuotaWaitMarker(first.marker)).toBe(true);
    const later = decideQuotaRetry(first.marker, 1_000 + QUOTA_WAIT_BUDGET_MS, undefined, () => 0);
    expect(later).toEqual({ action: "exhaust", reason: QUOTA_STUCK_TEXT });
  });

  test("caps attempts so a bad clock cannot loop forever", () => {
    const marker = encodeQuotaWaitMarker(QUOTA_WAIT_MAX_ATTEMPTS - 1, Date.now());
    expect(decideQuotaRetry(marker, Date.now(), undefined, () => 0).action).toBe("exhaust");
  });
});

describe("QuotaCooldown", () => {
  test("blocks leasing until the wait timestamp", () => {
    const cool = new QuotaCooldown();
    expect(cool.canLease(0)).toBe(true);
    cool.recordWaitUntil(1_000);
    expect(cool.canLease(999)).toBe(false);
    expect(cool.canLease(1_000)).toBe(true);
  });

  test("takeLog fires once per wait window", () => {
    const cool = new QuotaCooldown();
    expect(cool.takeLog(0)).toBe(false);
    cool.recordWaitUntil(1_000);
    expect(cool.takeLog(0)).toBe(true);
    expect(cool.takeLog(0)).toBe(false);
    expect(cool.takeLog(999)).toBe(false);
    expect(cool.takeLog(1_000)).toBe(false);
    cool.recordWaitUntil(2_000);
    expect(cool.takeLog(1_000)).toBe(true);
    expect(cool.takeLog(1_500)).toBe(false);
  });
});
