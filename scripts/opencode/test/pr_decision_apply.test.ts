import { describe, expect, test } from "bun:test";
import { type ApplyDeps, applyEffects, type Effect } from "../src/pr_decision.ts";

function depsWithSpies(overrides: Partial<ApplyDeps> = {}): ApplyDeps & {
  calls: string[];
  stickyCalls: string[];
} {
  const calls: string[] = [];
  const stickyCalls: string[] = [];
  return {
    calls,
    stickyCalls,
    log: (message: string) => {
      calls.push(`log:${message}`);
    },
    sticky: async (text: string) => {
      calls.push("sticky");
      stickyCalls.push(text);
    },
    recordCiHandled: async () => {
      calls.push("recordCiHandled");
    },
    resolveHeld: async (kind: "completed" | "skipped", reason?: string) => {
      calls.push(`resolveHeld:${kind}${reason ? `:${reason}` : ""}`);
    },
    forgetClaim: async () => {
      calls.push("forgetClaim");
    },
    ...overrides,
  };
}

describe("pr_decision applyEffects", () => {
  test("conflict-cap order is sticky, resolveHeld, forgetClaim", async () => {
    const deps = depsWithSpies();
    const effects: Effect[] = [
      { kind: "sticky", text: "cap sticky" },
      { kind: "resolveHeld", holdKind: "skipped", reason: "conflict cap" },
      { kind: "forgetClaim" },
    ];
    await applyEffects(effects, deps);
    expect(deps.calls).toEqual(["sticky", "resolveHeld:skipped:conflict cap", "forgetClaim"]);
    expect(deps.stickyCalls).toEqual(["cap sticky"]);
  });

  test("recordCiHandled order keeps sticky first", async () => {
    const deps = depsWithSpies();
    const checks = [{ name: "build" }];
    const effects: Effect[] = [
      { kind: "sticky", text: "ci sticky" },
      { kind: "recordCiHandled", checks },
      { kind: "resolveHeld", holdKind: "skipped", reason: "ci" },
      { kind: "forgetClaim" },
    ];
    await applyEffects(effects, deps);
    expect(deps.calls).toEqual(["sticky", "recordCiHandled", "resolveHeld:skipped:ci", "forgetClaim"]);
  });

  test("same-finding log runs first", async () => {
    const deps = depsWithSpies();
    const effects: Effect[] = [
      { kind: "log", message: "same finding repeated (d) on unchanged diff for o/r#1" },
      { kind: "sticky", text: "stuck: same finding repeated (d)" },
      { kind: "resolveHeld", holdKind: "skipped", reason: "same finding" },
      { kind: "forgetClaim" },
    ];
    await applyEffects(effects, deps);
    expect(deps.calls).toEqual([
      "log:same finding repeated (d) on unchanged diff for o/r#1",
      "sticky",
      "resolveHeld:skipped:same finding",
      "forgetClaim",
    ]);
  });

  test("sticky throw aborts resolveHeld and forgetClaim", async () => {
    const failure = new Error("sticky failed");
    const deps = depsWithSpies({
      sticky: async () => {
        throw failure;
      },
    });
    const effects: Effect[] = [
      { kind: "sticky", text: "x" },
      { kind: "resolveHeld", holdKind: "skipped", reason: "conflict cap" },
      { kind: "forgetClaim" },
    ];
    const error = await applyEffects(effects, deps).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(error).toBe(failure);
    expect(deps.calls).toEqual([]);
  });

  test("recordCiHandled throw aborts resolveHeld and forgetClaim", async () => {
    const failure = new Error("record failed");
    const deps = depsWithSpies({
      recordCiHandled: async () => {
        throw failure;
      },
    });
    const effects: Effect[] = [
      { kind: "sticky", text: "x" },
      { kind: "recordCiHandled", checks: [{ name: "build" }] },
      { kind: "resolveHeld", holdKind: "skipped", reason: "ci" },
      { kind: "forgetClaim" },
    ];
    const error = await applyEffects(effects, deps).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(error).toBe(failure);
    expect(deps.calls).toEqual(["sticky"]);
  });

  test("completed hold has no reason", async () => {
    const deps = depsWithSpies();
    const effects: Effect[] = [{ kind: "resolveHeld", holdKind: "completed" }, { kind: "forgetClaim" }];
    await applyEffects(effects, deps);
    expect(deps.calls).toEqual(["resolveHeld:completed", "forgetClaim"]);
  });
});
