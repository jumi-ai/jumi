import { describe, expect, test } from "bun:test";
import { EngineFailedError, throwIfEngineFailed } from "../src/engine.ts";
import { QUOTA_MESSAGE, QuotaWaitError } from "../src/quota.ts";
import { isResettingQuotaError, isResettingQuotaResult, throwIfQuotaWait } from "../src/quota_wait.ts";

describe("throwIfQuotaWait", () => {
  test("throws wait for resetting quota when fallback is unset", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" },
        model: "opencode/big-pickle",
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("configured pair alone does not skip the wait", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" },
        model: "opencode/big-pickle",
        fallbackModel: "anthropic/claude-sonnet-4-6",
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("waits when the producing runner is last in a mixed chain", () => {
    expect(() =>
      throwIfQuotaWait({
        result: {
          status: "stuck",
          message: QUOTA_MESSAGE,
          quota: "resetting",
          runner: { type: "opencode", model: "anthropic/claude-sonnet-4-6" },
        },
        model: "opencode/big-pickle",
        fallbackModel: "anthropic/claude-sonnet-4-6",
        chain: [{ model: "opencode/big-pickle" }, { model: "anthropic/claude-sonnet-4-6" }],
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("does not wait when a later runner can still take the quota", () => {
    expect(() =>
      throwIfQuotaWait({
        result: {
          status: "stuck",
          message: QUOTA_MESSAGE,
          quota: "resetting",
          runner: { type: "opencode", model: "opencode/big-pickle" },
        },
        model: "opencode/big-pickle",
        chain: [{ model: "opencode/big-pickle" }, { model: "anthropic/claude-sonnet-4-6" }],
        random: () => 0,
      })
    ).not.toThrow();
  });

  test("a refused hop survives throwIfEngineFailed so a later runner does not skip the wait", () => {
    let thrown: unknown;
    try {
      throwIfEngineFailed({
        status: "stuck",
        message: QUOTA_MESSAGE,
        quota: "resetting",
        runner: { type: "opencode", model: "opencode/big-pickle" },
        hopRefused: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(() =>
      throwIfQuotaWait({
        err: thrown,
        model: "opencode/big-pickle",
        chain: [{ model: "opencode/big-pickle" }, { model: "anthropic/claude-sonnet-4-6" }],
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("refused hop waits even when a later runner remains", () => {
    expect(() =>
      throwIfQuotaWait({
        result: {
          status: "stuck",
          message: QUOTA_MESSAGE,
          quota: "resetting",
          runner: { type: "opencode", model: "opencode/big-pickle" },
          hopRefused: true,
        },
        model: "opencode/big-pickle",
        fallbackModel: "anthropic/claude-sonnet-4-6",
        chain: [{ model: "opencode/big-pickle" }, { model: "anthropic/claude-sonnet-4-6" }],
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("stderr quota words on an ordinary engine failure do not wait", () => {
    const echoed = new EngineFailedError(
      `opencode exited with code 1:\n'{"error": "Free usage exceeded", not json'`,
      false
    );
    expect(isResettingQuotaError(echoed)).toBe(false);
    expect(() =>
      throwIfQuotaWait({
        err: echoed,
        model: "opencode/muse-spark",
        random: () => 0,
      })
    ).not.toThrow();
  });

  test("a structured resetting engine failure still waits", () => {
    expect(() =>
      throwIfQuotaWait({
        err: new EngineFailedError("opencode exited with code 1:\nFree usage exceeded", false, {
          quota: "resetting",
        }),
        model: "opencode/muse-spark",
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("does not wait for hard quota", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", message: QUOTA_MESSAGE, quota: "hard" },
        model: "opencode/big-pickle",
        random: () => 0,
      })
    ).not.toThrow();
    expect(isResettingQuotaResult({ status: "stuck", message: QUOTA_MESSAGE, quota: "hard" })).toBe(false);
    expect(isResettingQuotaError(new EngineFailedError(QUOTA_MESSAGE, false, { quota: "hard" }))).toBe(false);
  });

  test("throws wait for Claude resetting usage-limit when fallback is unset", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", exitCode: 1, message: QUOTA_MESSAGE, quota: "resetting" },
        model: "claude-opus-5",
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("a repeated model on the last runner waits when its chain index is stamped", () => {
    const spark = "opencode/muse-spark";
    const grok = "xai/grok-4.6";
    expect(() =>
      throwIfQuotaWait({
        result: {
          status: "stuck",
          message: QUOTA_MESSAGE,
          quota: "resetting",
          runner: { type: "opencode", model: spark },
          chainIndex: 2,
        },
        model: spark,
        chain: [{ model: spark }, { model: grok }, { model: spark }],
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("chain index survives throwIfEngineFailed so a later copy of the model still waits", () => {
    const spark = "opencode/muse-spark";
    const grok = "xai/grok-4.6";
    let thrown: unknown;
    try {
      throwIfEngineFailed({
        status: "stuck",
        message: QUOTA_MESSAGE,
        quota: "resetting",
        runner: { type: "opencode", model: spark },
        chainIndex: 2,
      });
    } catch (err) {
      thrown = err;
    }
    expect(() =>
      throwIfQuotaWait({
        err: thrown,
        model: spark,
        chain: [{ model: spark }, { model: grok }, { model: spark }],
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("quota on the first of two same-provider runners waits even when a later copy can hop", () => {
    const spark = "opencode/muse-spark";
    const grok = "xai/grok-4.6";
    expect(() =>
      throwIfQuotaWait({
        result: {
          status: "stuck",
          message: QUOTA_MESSAGE,
          quota: "resetting",
          runner: { type: "opencode", model: spark },
          chainIndex: 0,
        },
        model: spark,
        chain: [{ model: spark }, { model: spark }, { model: grok }],
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });

  test("stamped chain index still hops when the next runner is a different provider", () => {
    const spark = "opencode/muse-spark";
    const grok = "xai/grok-4.6";
    expect(() =>
      throwIfQuotaWait({
        result: {
          status: "stuck",
          message: QUOTA_MESSAGE,
          quota: "resetting",
          runner: { type: "opencode", model: spark },
          chainIndex: 0,
        },
        model: spark,
        chain: [{ model: spark }, { model: grok }, { model: spark }],
        random: () => 0,
      })
    ).not.toThrow();
  });

  test("same-provider fallback is treated as no hop", () => {
    expect(() =>
      throwIfQuotaWait({
        result: { status: "stuck", message: QUOTA_MESSAGE, quota: "resetting" },
        model: "opencode/big-pickle",
        fallbackModel: "opencode/gpt-5.5",
        random: () => 0,
      })
    ).toThrow(QuotaWaitError);
  });
});
