import { describe, expect, test } from "bun:test";
import {
  classifyFirstShellRuns,
  type FirstShellRunObservation,
  isWrappedShellResult,
} from "../src/review_first_shell_probe.ts";

const HOME = "/tmp/jumi-first-shell-abc/sandbox-home";

function wrapped(): FirstShellRunObservation {
  return { sandboxHome: HOME, shellResult: `${HOME}\n`, dispatched: true };
}

function unwrapped(): FirstShellRunObservation {
  return { sandboxHome: HOME, shellResult: "/tmp/jumi-first-shell-abc/home\n", dispatched: true };
}

describe("isWrappedShellResult", () => {
  test("a result carrying the sandbox home is wrapped", () => {
    expect(isWrappedShellResult(`${HOME}\n`, HOME)).toBe(true);
  });

  test("a result with the outer home is unwrapped", () => {
    expect(isWrappedShellResult("/tmp/jumi-first-shell-abc/home\n", HOME)).toBe(false);
  });

  test("an empty sandbox home never counts as wrapped", () => {
    expect(isWrappedShellResult("anything", "")).toBe(false);
  });
});

describe("classifyFirstShellRuns", () => {
  test("SAFE when every run produces a wrapped first shell result", () => {
    const judged = classifyFirstShellRuns([wrapped(), wrapped(), wrapped()]);
    expect(judged.verdict).toBe("SAFE");
  });

  test("UNSAFE when any shell result is unwrapped", () => {
    const judged = classifyFirstShellRuns([unwrapped()]);
    expect(judged.verdict).toBe("UNSAFE");
  });

  test("UNSAFE for a mixed run of wrapped and unwrapped results", () => {
    const judged = classifyFirstShellRuns([wrapped(), wrapped(), unwrapped()]);
    expect(judged.verdict).toBe("UNSAFE");
  });

  test("UNSAFE wins over a missing run: the fail-open is already proven", () => {
    const judged = classifyFirstShellRuns([unwrapped(), { sandboxHome: HOME, dispatched: false }]);
    expect(judged.verdict).toBe("UNSAFE");
  });

  test("UNKNOWN when a required shell result is missing", () => {
    const judged = classifyFirstShellRuns([wrapped(), { sandboxHome: HOME, dispatched: true }]);
    expect(judged.verdict).toBe("UNKNOWN");
  });

  test("UNKNOWN when the shell never dispatched", () => {
    const judged = classifyFirstShellRuns([{ sandboxHome: HOME, shellResult: `${HOME}\n`, dispatched: false }]);
    expect(judged.verdict).toBe("UNKNOWN");
  });

  test("UNKNOWN for an empty trace", () => {
    const judged = classifyFirstShellRuns([]);
    expect(judged.verdict).toBe("UNKNOWN");
  });
});
