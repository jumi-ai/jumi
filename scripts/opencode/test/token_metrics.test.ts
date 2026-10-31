import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordOpenCodeDb, renderTokenMetrics, resetTokenMetricsForTests } from "../src/token_metrics.ts";

afterEach(() => {
  resetTokenMetricsForTests();
});

function writeSessionDb(
  path: string,
  rows: Array<{ model: string; input: number; cached: number; output: number; cacheWrite: number; reasoning: number }>
): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE session_v2 (
      model TEXT,
      tokens_input INTEGER,
      tokens_cache_read INTEGER,
      tokens_output INTEGER,
      tokens_cache_write INTEGER,
      tokens_reasoning INTEGER
    )
  `);
  const insert = db.prepare(
    "INSERT INTO session_v2 (model, tokens_input, tokens_cache_read, tokens_output, tokens_cache_write, tokens_reasoning) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const row of rows) {
    insert.run(row.model, row.input, row.cached, row.output, row.cacheWrite, row.reasoning);
  }
  db.close();
}

describe("renderTokenMetrics", () => {
  test("serves health gauges with no token series before any review", () => {
    const text = renderTokenMetrics();
    expect(text).toContain("# TYPE ai_token_exporter_up gauge");
    expect(text).toContain('ai_token_exporter_up{agent_instance="jumi"} 1');
    expect(text).toContain("# TYPE ai_tokens_total counter");
    expect(text).not.toContain("ai_tokens_total{");
  });
});

describe("recordOpenCodeDb", () => {
  test("adds session token sums and normalizes OpenCode model JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-tokens-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      writeSessionDb(dbPath, [
        {
          model: JSON.stringify({ id: "grok-4.6", providerID: "xai" }),
          input: 10,
          cached: 100,
          output: 3,
          cacheWrite: 1,
          reasoning: 2,
        },
        {
          model: JSON.stringify({ id: "grok-4.6", providerID: "xai" }),
          input: 5,
          cached: 20,
          output: 1,
          cacheWrite: 0,
          reasoning: 4,
        },
      ]);
      recordOpenCodeDb(dbPath);
      const text = renderTokenMetrics();
      expect(text).toContain(
        'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="input"} 15'
      );
      expect(text).toContain(
        'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="cached_input"} 120'
      );
      expect(text).toContain(
        'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="output"} 4'
      );
      expect(text).toContain(
        'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="cache_write"} 1'
      );
      expect(text).toContain(
        'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="reasoning"} 6'
      );
      expect(text).toContain(
        'ai_sessions{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6"} 2'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accumulates totals across reviews", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-tokens-"));
    try {
      const first = join(dir, "a.db");
      const second = join(dir, "b.db");
      writeSessionDb(first, [{ model: "xai/grok-4.6", input: 10, cached: 0, output: 1, cacheWrite: 0, reasoning: 0 }]);
      writeSessionDb(second, [{ model: "xai/grok-4.6", input: 7, cached: 0, output: 2, cacheWrite: 0, reasoning: 0 }]);
      recordOpenCodeDb(first);
      recordOpenCodeDb(second);
      const text = renderTokenMetrics();
      expect(text).toContain(
        'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="input"} 17'
      );
      expect(text).toContain(
        'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="output"} 3'
      );
      expect(text).toContain(
        'ai_sessions{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6"} 2'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing database is skipped without incrementing errors", () => {
    expect(() => recordOpenCodeDb("/no/such/opencode-session.db")).not.toThrow();
    const text = renderTokenMetrics();
    expect(text).toContain('ai_token_exporter_errors{agent_instance="jumi"} 0');
    expect(text).not.toContain("ai_tokens_total{");
  });

  test("unreadable database increments errors without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-tokens-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      await writeFile(dbPath, "not a sqlite database");
      expect(() => recordOpenCodeDb(dbPath)).not.toThrow();
      expect(renderTokenMetrics()).toContain('ai_token_exporter_errors{agent_instance="jumi"} 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads WAL journals left after a killed writer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-tokens-"));
    const livePath = join(dir, "live.db");
    const dbPath = join(dir, "opencode-session.db");
    try {
      const live = new Database(livePath);
      try {
        live.run("PRAGMA journal_mode = WAL");
        live.run("PRAGMA wal_autocheckpoint = 0");
        live.run(`
          CREATE TABLE session_v2 (
            model TEXT,
            tokens_input INTEGER,
            tokens_cache_read INTEGER,
            tokens_output INTEGER,
            tokens_cache_write INTEGER,
            tokens_reasoning INTEGER
          )
        `);
        live.run("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)", ["xai/grok-4.6", 42, 0, 9, 0, 1]);
        const wal = `${livePath}-wal`;
        expect(existsSync(wal)).toBe(true);
        copyFileSync(livePath, dbPath);
        copyFileSync(wal, `${dbPath}-wal`);
      } finally {
        live.close();
      }
      const shm = `${dbPath}-shm`;
      if (existsSync(shm)) unlinkSync(shm);
      recordOpenCodeDb(dbPath);
      const text = renderTokenMetrics();
      expect(text).toContain('ai_token_exporter_errors{agent_instance="jumi"} 0');
      expect(text).toContain(
        'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="input"} 42'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unrecognized schema in database fails soft and returns false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-tokens-unknown-"));
    const dbPath = join(dir, "opencode-session.db");
    try {
      const db = new Database(dbPath);
      db.run("CREATE TABLE unknown_table (foo TEXT)");
      db.close();
      expect(recordOpenCodeDb(dbPath)).toBe(false);
      const text = renderTokenMetrics();
      expect(text).toContain('ai_token_exporter_errors{agent_instance="jumi"} 0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
