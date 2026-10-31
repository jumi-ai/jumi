import { afterEach, describe, expect, test } from "bun:test";
import { recordJobCompleted, resetControlMetricsForTests } from "../src/control_metrics.ts";
import { type Engine, EngineFailedError } from "../src/engine.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";
import {
  type NewRunUsageRow,
  renderLedgerMetrics,
  resetActiveRunUsageRecordingForTests,
  setActiveRunUsageRecording,
  withLedgerRunUsage,
} from "../src/run_usage.ts";
import { type ModelTokenUsage, recordClaudeUsage, resetTokenMetricsForTests } from "../src/token_metrics.ts";
import { makeIssueJob, makeJob } from "./fixtures.ts";

afterEach(() => {
  resetControlMetricsForTests();
  resetTokenMetricsForTests();
  resetActiveRunUsageRecordingForTests();
});

function usage(
  tokens: Partial<Record<"input" | "cached_input" | "output" | "cache_write" | "reasoning", number>>
): ModelTokenUsage {
  return new Map([
    [
      "xai/grok-4.6",
      {
        input: tokens.input ?? 0,
        cached_input: tokens.cached_input ?? 0,
        output: tokens.output ?? 0,
        cache_write: tokens.cache_write ?? 0,
        reasoning: tokens.reasoning ?? 0,
      },
    ],
  ]);
}

function okEngine(run: (opts: Parameters<Engine>[0]) => void = () => {}): Engine {
  return async (opts) => {
    run(opts);
    return { status: "ok", exitCode: 0, durationMs: 90_000 };
  };
}

describe("withLedgerRunUsage", () => {
  test("records per-run tokens, exit class, and timing against the leased job", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    const row = (await store.lease("engine-1", 60_000))!;
    const recorded: NewRunUsageRow[] = [];
    setActiveRunUsageRecording({
      context: { jobId: row.id, jobKey: row.jobKey, kind: row.kind },
      recordRunUsageRows: async (rows) => {
        recorded.push(...rows);
        await store.recordRunUsageRows(rows);
      },
    });

    const engine = withLedgerRunUsage(okEngine(() => recordClaudeUsage(usage({ input: 10, output: 3 }))));
    const result = await engine({ type: "claude", model: "claude-opus-5", workdir: "/work/x" });
    expect(result.status).toBe("ok");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      jobId: row.id,
      jobKey: row.jobKey,
      kind: "review",
      runner: "claude",
      model: "xai/grok-4.6",
      tokensInput: 10,
      tokensOutput: 3,
      sessions: 1,
      exitClass: "ok",
    });
    expect(recorded[0]!.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(recorded[0]!.endedAt.getTime()).toBeGreaterThanOrEqual(recorded[0]!.startedAt.getTime());
  });

  test("a run with no usage still records exit class and duration", async () => {
    const store = new MemoryReviewJobStore();
    const recorded: NewRunUsageRow[] = [];
    setActiveRunUsageRecording({
      context: { jobId: 7, jobKey: "implement:o/r#1", kind: "implement" },
      recordRunUsageRows: async (rows) => {
        recorded.push(...rows);
      },
    });
    const engine = withLedgerRunUsage(async () => ({ status: "timeout", exitCode: 143, durationMs: 5_000 }));
    await engine({ model: "openai/gpt-5.5", workdir: "/work/x" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      runner: "opencode",
      model: "openai/gpt-5.5",
      exitClass: "timeout",
      sessions: 0,
    });
  });

  test("a failed metric write does not fail the job", async () => {
    setActiveRunUsageRecording({
      context: { jobId: 1, jobKey: "k", kind: "review" },
      recordRunUsageRows: async () => {
        throw new Error("ledger down");
      },
    });
    const engine = withLedgerRunUsage(okEngine(() => recordClaudeUsage(usage({ input: 1 }))));
    const result = await engine({ type: "claude", model: "m", workdir: "/work/x" });
    expect(result.status).toBe("ok");
  });

  test("aborted runs with no usage write nothing", async () => {
    const recorded: NewRunUsageRow[] = [];
    setActiveRunUsageRecording({
      context: { jobId: 1, jobKey: "k", kind: "review" },
      recordRunUsageRows: async (rows) => {
        recorded.push(...rows);
      },
    });
    const abort = new AbortController();
    abort.abort();
    const engine = withLedgerRunUsage(okEngine());
    await engine({ model: "m", workdir: "/work/x", abortSignal: abort.signal });
    expect(recorded).toHaveLength(0);
  });

  test("aborted runs still record token/session cells as incomplete", async () => {
    const recorded: NewRunUsageRow[] = [];
    setActiveRunUsageRecording({
      context: { jobId: 1, jobKey: "k", kind: "review" },
      recordRunUsageRows: async (rows) => {
        recorded.push(...rows);
      },
    });
    const abort = new AbortController();
    abort.abort();
    const engine = withLedgerRunUsage(okEngine(() => recordClaudeUsage(usage({ input: 10, output: 3 }))));
    const result = await engine({ type: "claude", model: "m", workdir: "/work/x", abortSignal: abort.signal });
    expect(result.status).toBe("ok");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      runner: "claude",
      tokensInput: 10,
      tokensOutput: 3,
      sessions: 1,
      exitClass: "incomplete",
    });
  });

  test("aborted throws still record tokens and rethrow", async () => {
    const recorded: NewRunUsageRow[] = [];
    setActiveRunUsageRecording({
      context: { jobId: 1, jobKey: "k", kind: "review" },
      recordRunUsageRows: async (rows) => {
        recorded.push(...rows);
      },
    });
    const abort = new AbortController();
    abort.abort();
    const engine = withLedgerRunUsage(async () => {
      recordClaudeUsage(usage({ input: 7 }));
      const err = new Error("cancelled");
      err.name = "AbortError";
      throw err;
    });
    await expect(engine({ type: "claude", model: "m", workdir: "/work/x", abortSignal: abort.signal })).rejects.toThrow(
      "cancelled"
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ runner: "claude", tokensInput: 7, exitClass: "incomplete" });
  });

  test("thrown engine failures record an exit class and rethrow", async () => {
    const recorded: NewRunUsageRow[] = [];
    setActiveRunUsageRecording({
      context: { jobId: 1, jobKey: "k", kind: "review" },
      recordRunUsageRows: async (rows) => {
        recorded.push(...rows);
      },
    });
    const engine = withLedgerRunUsage(async () => {
      throw new EngineFailedError("nope", false, { auth: true });
    });
    await expect(engine({ type: "claude", model: "m", workdir: "/work/x" })).rejects.toThrow("nope");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ runner: "claude", exitClass: "auth" });
  });

  test("without an ambient recorder the engine passes through untouched", async () => {
    const engine = withLedgerRunUsage(okEngine(() => recordClaudeUsage(usage({ input: 5 }))));
    const result = await engine({ type: "claude", model: "m", workdir: "/work/x" });
    expect(result.status).toBe("ok");
  });
});

describe("renderLedgerMetrics", () => {
  test("reports durable totals that survive an in-process reset", async () => {
    const store = new MemoryReviewJobStore();
    await store.enqueue(makeJob());
    await store.enqueueIssue(makeIssueJob({ action: "assigned" }));
    const review = (await store.lease("e1", 60_000))!;
    await store.markPublished(review.id, "e1", { state: "succeeded" });
    const worker = (await store.lease("w1", 60_000, undefined, ["implement", "follow-up", "conflict"]))!;
    await store.markPublished(worker.id, "w1", { state: "skipped", reason: "no-changes" });
    await store.recordRunUsageRows([
      {
        jobId: review.id,
        jobKey: review.jobKey,
        kind: "review",
        runner: "opencode",
        model: "xai/grok-4.6",
        agentInstance: "jumi",
        tokensInput: 15,
        tokensCacheRead: 120,
        tokensOutput: 4,
        tokensCacheWrite: 1,
        tokensReasoning: 6,
        sessions: 2,
        exitClass: "ok",
        startedAt: new Date(1_000_000),
        endedAt: new Date(1_090_000),
        durationSeconds: 90,
      },
    ]);

    // In-process counters (if any) reset on restart; the ledger export is unaffected.
    recordJobCompleted("review", "succeeded");
    resetControlMetricsForTests();

    const text = await renderLedgerMetrics(store);
    expect(text).toContain(
      'ai_tokens_total{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="input"} 15'
    );
    expect(text).toContain(
      'ai_tokens{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6",token_type="output"} 4'
    );
    expect(text).toContain(
      'ai_sessions{agent_instance="jumi",source="opencode",profile="default",model="xai/grok-4.6"} 2'
    );
    expect(text).toContain('jumi_jobs_completed_total{kind="review",result="succeeded"} 1');
    expect(text).toContain('jumi_jobs_completed_total{kind="implement",result="skipped"} 1');
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="ok"} 1');
    expect(text).toContain('jumi_opencode_exits_total{kind="implement",class="ok"} 0');
    expect(text).toContain('jumi_job_duration_seconds_bucket{kind="review",result="ok",le="60"} 0');
    expect(text).toContain('jumi_job_duration_seconds_bucket{kind="review",result="ok",le="120"} 1');
    expect(text).toContain('jumi_job_duration_seconds_count{kind="review",result="ok"} 1');
    expect(text).toContain('jumi_job_duration_seconds_sum{kind="review",result="ok"} 90');
  });

  test("emits zero series with no runs, like the old exporter", async () => {
    const store = new MemoryReviewJobStore();
    const text = await renderLedgerMetrics(store);
    expect(text).toContain('jumi_jobs_completed_total{kind="review",result="succeeded"} 0');
    expect(text).toContain('jumi_opencode_exits_total{kind="review",class="ok"} 0');
    expect(text).not.toContain("jumi_job_duration_seconds_bucket");
    expect(text).not.toContain("ai_tokens_total{");
  });
});
