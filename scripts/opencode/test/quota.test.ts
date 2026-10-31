import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineFailedError } from "../src/engine.ts";
import {
  checkQuotaDbSchema,
  clampQuotaWaitMs,
  classifyQuotaText,
  decideQuotaRetry,
  encodeQuotaWaitMarker,
  hasQuotaRetryInDb,
  inspectQuotaSleepInDb,
  isHardQuotaText,
  isQuotaError,
  isQuotaLiveText,
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
  quotaSchemaErrors,
  resetQuotaSchemaErrorsForTests,
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

/** Runs `check` against a DB with OpenCode's `session_message` columns. */
async function withMessages(rows: Array<[type: string, data: string]>, check: (dbPath: string) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-quota-"));
  try {
    const dbPath = join(dir, "opencode-session.db");
    const db = new Database(dbPath);
    db.exec(
      "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)"
    );
    rows.forEach(([type, data], index) => {
      db.query("INSERT INTO session_message VALUES (?, 'ses1', ?, ?, 1, 2, ?)").run(`m${index}`, type, index, data);
    });
    db.close();
    check(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("checkQuotaDbSchema", () => {
  async function withDb(sql: string | undefined, check: (dbPath: string) => void): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-schema-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      if (sql !== undefined) {
        const db = new Database(dbPath);
        db.exec(sql);
        db.close();
      }
      check(dbPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const columns =
    "id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT";

  test("accepts the columns the quota reads need", async () => {
    resetQuotaSchemaErrorsForTests();
    await withDb(`CREATE TABLE session_message (${columns})`, (dbPath) => {
      expect(checkQuotaDbSchema(dbPath)).toBeUndefined();
    });
    expect(quotaSchemaErrors()).toBe(0);
  });

  test("names a renamed column and counts it", async () => {
    resetQuotaSchemaErrorsForTests();
    const renamed = columns.replace("session_id", "sessionID");
    await withDb(`CREATE TABLE session_message (${renamed})`, (dbPath) => {
      expect(checkQuotaDbSchema(dbPath)).toBe("session_message has no session_id column");
      // The same drift makes the live read fail, and that read swallows it.
      expect(inspectQuotaSleepInDb(dbPath, 0)).toBeUndefined();
    });
    expect(quotaSchemaErrors()).toBe(1);
  });

  test("names a missing table once the DB has others", async () => {
    resetQuotaSchemaErrorsForTests();
    await withDb("CREATE TABLE session_v3 (id TEXT)", (dbPath) => {
      expect(checkQuotaDbSchema(dbPath)).toBe("no session_message table");
    });
    expect(quotaSchemaErrors()).toBe(1);
  });

  test("a child that never got as far as the DB is not drift", async () => {
    resetQuotaSchemaErrorsForTests();
    await withDb(undefined, (dbPath) => expect(checkQuotaDbSchema(dbPath)).toBeUndefined());
    await withDb("PRAGMA user_version = 1", (dbPath) => expect(checkQuotaDbSchema(dbPath)).toBeUndefined());
    expect(checkQuotaDbSchema(undefined)).toBeUndefined();
    expect(quotaSchemaErrors()).toBe(0);
  });
});

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

  test("ignores ordinary errors and an empty DB", async () => {
    await withMessages([], (dbPath) => expect(hasQuotaRetryInDb(dbPath)).toBe(false));
    await withMessages(
      [["assistant", JSON.stringify({ error: { type: "provider.rate-limit", message: "429 Too Many Requests" } })]],
      (dbPath) => expect(hasQuotaRetryInDb(dbPath)).toBe(false)
    );
  });

  test("ignores rows that only quote quota strings", async () => {
    // Task/feedback text and tool output legitimately quote the error class;
    // neither is the assistant row's own error.
    await withMessages(
      [
        ["user", JSON.stringify({ text: "Abort when FreeUsageLimitError hits", error: "Free usage exceeded" })],
        ["assistant", JSON.stringify({ content: [{ type: "text", text: '"error": "FreeUsageLimitError"' }] })],
        [
          "assistant",
          JSON.stringify({
            content: [{ type: "tool", state: { status: "error", error: { message: "grep Go limit reached" } } }],
          }),
        ],
      ],
      (dbPath) => expect(hasQuotaRetryInDb(dbPath)).toBe(false)
    );
  });

  test("ignores bare usage-limit text without a Free/Go distinguisher", async () => {
    await withMessages(
      [["assistant", JSON.stringify({ error: { message: "my-model usage limit reached" } })]],
      (dbPath) => expect(hasQuotaRetryInDb(dbPath)).toBe(false)
    );
  });

  test("detects assistant error records", async () => {
    await withMessages(
      [["assistant", JSON.stringify({ error: { type: "GoUsageLimitError", message: "Go limit reached" } })]],
      (dbPath) => expect(hasQuotaRetryInDb(dbPath)).toBe(true)
    );
  });

  test("a malformed row does not hide a real quota error", async () => {
    await withMessages(
      [
        ["assistant", '{"error": "Free usage exceeded", not json'],
        ["assistant", JSON.stringify({ error: { message: "Free usage exceeded, subscribe to Go" } })],
      ],
      (dbPath) => expect(hasQuotaRetryInDb(dbPath)).toBe(true)
    );
  });

  test("sees an assistant sleeping on a quota retry-after while the child is alive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-sleep-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)"
      );
      const insert = db.query("INSERT INTO session_message VALUES (?, 'ses1', ?, ?, 1000, ?)");
      insert.run("m1", "user", 1, JSON.stringify({ text: "quote: account_rate_limit" }));
      db.close();
      expect(inspectQuotaSleepInDb(dbPath, 0)).toBeUndefined();

      const writer = new Database(dbPath);
      writer.query("INSERT INTO session_message VALUES (?, 'ses1', ?, ?, 1000, ?)").run(
        "m2",
        "assistant",
        2,
        JSON.stringify({
          content: [],
          retry: {
            attempt: 2,
            at: 1_793_429_821_499,
            error: {
              type: "provider.rate-limit",
              message: "Rate limit exceeded. Please try again later.",
              status: 429,
              response: { body: '{"error":{"code":"account_rate_limit"}}' },
              retryAfterMs: 7_200_000,
            },
          },
        })
      );
      writer.close();
      const hit = inspectQuotaSleepInDb(dbPath, 0);
      expect(hit?.kind).toBe("resetting");
      expect(hit?.retryAfterMs).toBe(7_200_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a malformed row does not hide a sibling session's sleep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-schema-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const writer = new Database(dbPath);
      writer.exec(
        "CREATE TABLE session_message (session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)"
      );
      const insert = writer.query("INSERT INTO session_message VALUES (?, 'assistant', 1, 1000, ?)");
      insert.run("corrupt", "{not json");
      insert.run(
        "sleeping",
        JSON.stringify({
          retry: { error: { type: "provider.rate-limit", status: 429, response: { body: "account_rate_limit" } } },
        })
      );
      writer.close();
      expect(inspectQuotaSleepInDb(dbPath, 0)?.kind).toBe("resetting");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sees a sleeping session behind an older session with higher seq numbers", async () => {
    // OpenCode numbers `seq` per session, so a subagent or a resumed run starts
    // low again while the session before it sits at a high number.
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-sessions-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)"
      );
      const insert = db.query("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, 1000, ?)");
      for (let seq = 20; seq < 48; seq += 4) insert.run(`old${seq}`, "ses_old", seq, JSON.stringify({ content: [] }));
      insert.run(
        "live",
        "ses_new",
        5,
        JSON.stringify({
          retry: {
            attempt: 1,
            at: 1,
            error: { type: "provider.rate-limit", status: 429, response: { body: "account_rate_limit" } },
          },
        })
      );
      db.close();
      expect(inspectQuotaSleepInDb(dbPath, 0)?.kind).toBe("resetting");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a retry the same session has moved past is not a quota sleep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-moved-on-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)"
      );
      const insert = db.query("INSERT INTO session_message VALUES (?, 'ses1', 'assistant', ?, 1000, ?)");
      insert.run(
        "m1",
        1,
        JSON.stringify({ retry: { attempt: 1, at: 1, error: { status: 429, message: "account_rate_limit" } } })
      );
      insert.run("m2", 2, JSON.stringify({ content: [] }));
      db.close();
      expect(inspectQuotaSleepInDb(dbPath, 0)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a retry left behind by a killed child does not read as this child's sleep", async () => {
    // A hard kill of the whole process tree (OOM) leaves `retry` on the row, in
    // a DB the next `--continue` run reuses. Only `sinceMs` tells them apart.
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-stale-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.query("INSERT INTO session_message VALUES ('m1', 'ses_sub', 'assistant', 3, 1000, ?)").run(
        JSON.stringify({ retry: { attempt: 2, at: 9, error: { status: 429, message: "account_rate_limit" } } })
      );
      db.close();
      expect(inspectQuotaSleepInDb(dbPath, 1001)).toBeUndefined();
      expect(inspectQuotaSleepInDb(dbPath, 1000)?.kind).toBe("resetting");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a retry on an ordinary short rate limit is not a quota sleep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-short-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.query("INSERT INTO session_message VALUES (?, 'ses1', ?, ?, 1000, ?)").run(
        "m1",
        "assistant",
        1,
        JSON.stringify({
          retry: {
            attempt: 2,
            at: 1,
            error: { type: "provider.rate-limit", message: "Too many requests", status: 429 },
          },
        })
      );
      db.close();
      expect(inspectQuotaSleepInDb(dbPath, 0)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a persisted quota error from an earlier run does not read as a live sleep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-quota-old-"));
    try {
      const dbPath = join(dir, "opencode-session.db");
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_updated INTEGER, data TEXT)"
      );
      db.query("INSERT INTO session_message VALUES (?, 'ses1', ?, ?, 1000, ?)").run(
        "m1",
        "assistant",
        1,
        JSON.stringify({ error: { message: "Free usage exceeded" } })
      );
      db.close();
      expect(inspectQuotaSleepInDb(dbPath, 0)).toBeUndefined();
      expect(hasQuotaRetryInDb(dbPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads OpenCode's retryAfterMs as milliseconds", () => {
    expect(parseRetryAfterMs('{"status":429,"retryAfterMs":90000}')).toBe(90_000);
    expect(parseRetryAfterMs('{"retry-after":"90"}')).toBe(90_000);
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
  test("drops the parent stuck dialect from the retry poll", () => {
    expect(isQuotaLiveText(QUOTA_STUCK_TEXT)).toBe(false);
    expect(isQuotaLiveText("FreeUsageLimitError")).toBe(true);
    expect(isQuotaLiveText("Free usage exceeded, subscribe to Go")).toBe(true);
    expect(isQuotaLiveText("Rate limit exceeded. Please try again later.")).toBe(true);
    expect(isQuotaLiveText("Insufficient balance")).toBe(true);
    expect(isQuotaLiveText("my-model usage limit reached")).toBe(false);
    expect(isQuotaLiveText("429 Too Many Requests")).toBe(false);
    expect(isQuotaLiveText("Rate limit exceeded")).toBe(false);
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
