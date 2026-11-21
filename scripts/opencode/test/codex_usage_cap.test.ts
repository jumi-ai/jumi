import { describe, expect, test } from "bun:test";
import { buildCodexSpans, shouldCollectCodexTrace } from "../src/codex_tracing.ts";
import {
  CODEX_ERROR_MAX_BYTES,
  CODEX_ITEM_MAX_BYTES,
  CODEX_TEXT_MAX_BYTES,
  CODEX_TRACE_MAX_BYTES,
  CODEX_TRACE_MAX_EVENTS,
  CodexStreamParser,
} from "../src/codex_usage.ts";

function feed(parser: CodexStreamParser, lines: string[]): void {
  parser.push(new TextEncoder().encode(`${lines.join("\n")}\n`));
  parser.end();
}

describe("CodexStreamParser retention bounds", () => {
  test("very large command output is truncated but verdict, errors, and usage match uncapped", () => {
    const big = "x".repeat(200_000);
    const verdict = "final verdict text";
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-cap" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "ls", aggregated_output: big, status: "completed" },
      }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: verdict } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 20 },
        model: "gpt-6-sol",
      }),
    ];
    const capped = new CodexStreamParser();
    feed(capped, lines);
    const uncapped = new CodexStreamParser({
      maxTextBytes: 10_000_000,
      maxErrorBytes: 10_000_000,
      maxTraceEvents: 100_000,
      maxTraceBytes: 20_000_000,
      maxItemBytes: 10_000_000,
    });
    feed(uncapped, lines);

    expect(capped.text()).toBe(uncapped.text());
    expect(capped.text()).toContain(verdict);
    expect(capped.errors()).toBe(uncapped.errors());
    expect(capped.threadIdValue()).toBe("thread-cap");
    expect(capped.usage("fallback")).toEqual(uncapped.usage("fallback"));
    expect(capped.threadTotal()).toEqual(uncapped.threadTotal());

    const retained = capped.retainedBytes();
    expect(retained).toBeLessThanOrEqual(CODEX_TEXT_MAX_BYTES + CODEX_ERROR_MAX_BYTES + CODEX_TRACE_MAX_BYTES + 8_000);
    const uncappedBytes = uncapped.retainedBytes();
    expect(uncappedBytes).toBeGreaterThan(200_000);
    expect(retained).toBeLessThan(uncappedBytes);

    const item = capped.traceEvents().find((event) => event.item?.type === "command_execution")?.item;
    expect(item?.aggregatedOutput).toContain("[truncated at");
    expect(byteLength(item?.aggregatedOutput ?? "")).toBeLessThanOrEqual(CODEX_ITEM_MAX_BYTES + 100);
  });

  test("many events stay within the event and byte caps", () => {
    const lines: string[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      lines.push(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: `cmd-${i}`, aggregated_output: "y".repeat(2_000) },
        })
      );
    }
    lines.push(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 50, output_tokens: 5 } }));
    const parser = new CodexStreamParser();
    feed(parser, lines);
    expect(parser.traceEvents().length).toBeLessThanOrEqual(CODEX_TRACE_MAX_EVENTS);
    expect(parser.retainedBytes()).toBeLessThanOrEqual(
      CODEX_TEXT_MAX_BYTES + CODEX_ERROR_MAX_BYTES + CODEX_TRACE_MAX_BYTES + 8_000
    );
    expect(parser.usage("fallback")?.get("unknown") ?? parser.usage("fallback")?.values().next().value).toBeDefined();
  });

  test("with tracing disabled no trace items are retained but results still are", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-nt" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "ls", aggregated_output: "ok" },
      }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "verdict" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } }),
    ];
    const parser = new CodexStreamParser({ collectTrace: false });
    feed(parser, lines);
    expect(parser.traceEvents()).toEqual([]);
    expect(parser.text()).toContain("verdict");
    expect(parser.threadIdValue()).toBe("thread-nt");
    expect(parser.usage("fallback")).toBeDefined();
  });

  test("short runs are unchanged with tracing enabled", () => {
    const item = { type: "command_execution", command: "ls", aggregated_output: "ok", status: "completed" };
    const parser = new CodexStreamParser();
    feed(parser, [`{"type":"item.completed","item":${JSON.stringify(item)}}`]);
    expect(parser.traceEvents()).toHaveLength(1);
    expect(parser.traceEvents()[0]?.item).toEqual({
      type: "command_execution",
      command: "ls",
      aggregatedOutput: "ok",
      status: "completed",
    });
    expect(parser.text()).toBe("");
    const spans = buildCodexSpans(parser.traceEvents(), undefined, "gpt-6-sol");
    expect(spans.length).toBeGreaterThan(0);
  });

  test("tracing gate follows trace context and endpoint", () => {
    delete process.env.PHOENIX_OTLP_ENDPOINT;
    expect(shouldCollectCodexTrace(undefined)).toBe(false);
    expect(shouldCollectCodexTrace({ kind: "review", owner: "o", repo: "r" })).toBe(false);
    process.env.PHOENIX_OTLP_ENDPOINT = "http://phoenix.internal:6006";
    expect(shouldCollectCodexTrace({ kind: "review", owner: "o", repo: "r" })).toBe(true);
    expect(shouldCollectCodexTrace(undefined)).toBe(false);
    delete process.env.PHOENIX_OTLP_ENDPOINT;
  });
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
