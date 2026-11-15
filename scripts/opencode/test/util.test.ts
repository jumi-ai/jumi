import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNotFoundError } from "../src/forge_errors.ts";
import { engineExitMessage } from "../src/util/engine.ts";
import { csvEnv, intEnv, optionalEnv } from "../src/util/env.ts";
import { errorMessage, isAbortError, isEnoent } from "../src/util/error.ts";
import { lstatExists, pathExists } from "../src/util/fs.ts";
import { loginEquals, loginEqualsNonEmpty } from "../src/util/login.ts";
import { isObjectLike, isRecord } from "../src/util/object.ts";

describe("errorMessage", () => {
  test("returns message for Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  test("stringifies non-errors", () => {
    expect(errorMessage("oops")).toBe("oops");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("isAbortError", () => {
  test("matches AbortError name or cancelled message", () => {
    const abort = new Error("stop");
    abort.name = "AbortError";
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(new Error("cancelled"))).toBe(true);
    expect(isAbortError(new Error("nope"))).toBe(false);
    expect(isAbortError("cancelled")).toBe(false);
  });
});

describe("isEnoent", () => {
  test("matches ENOENT code", () => {
    expect(isEnoent({ code: "ENOENT" })).toBe(true);
    expect(isEnoent(new Error("x"))).toBe(false);
    expect(isEnoent(null)).toBe(false);
  });
});

describe("login helpers", () => {
  test("loginEquals is case-insensitive", () => {
    expect(loginEquals("Jumi", "jumi")).toBe(true);
    expect(loginEquals(undefined, "jumi")).toBe(false);
  });
  test("empty strings distinguish the two helpers", () => {
    expect(loginEquals("", "")).toBe(true);
    expect(loginEqualsNonEmpty("", "")).toBe(false);
    expect(loginEqualsNonEmpty("Jumi", "jumi")).toBe(true);
    expect(loginEqualsNonEmpty(undefined, "jumi")).toBe(false);
  });
});

describe("object guards", () => {
  test("arrays distinguish the two guards", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([1])).toBe(false);
    expect(isObjectLike([1])).toBe(true);
    expect(isObjectLike(null)).toBe(false);
  });
});

describe("path helpers", () => {
  test("dangling symlink distinguishes pathExists from lstatExists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "util-fs-"));
    try {
      const target = join(dir, "missing");
      const link = join(dir, "link");
      await symlink(target, link);
      expect(await lstatExists(link)).toBe(true);
      expect(await pathExists(link)).toBe(false);
      const file = join(dir, "file");
      await writeFile(file, "x");
      expect(await pathExists(file)).toBe(true);
      expect(await lstatExists(file)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("engineExitMessage", () => {
  test("formats engine name, code and detail", () => {
    expect(engineExitMessage("agy", 1, "bad")).toBe("agy exited with code 1:\nbad");
    expect(engineExitMessage("claude", null, "")).toBe("claude exited with code null");
  });
});

describe("env helpers", () => {
  test("optionalEnv falls back", () => {
    expect(optionalEnv({ A: "x" }, "A", "d")).toBe("x");
    expect(optionalEnv({}, "A", "d")).toBe("d");
  });
  test("intEnv parses positive integers", () => {
    expect(intEnv({ N: "5" }, "N", 1)).toBe(5);
    expect(intEnv({}, "N", 1)).toBe(1);
    expect(() => intEnv({ N: "0" }, "N", 1)).toThrow();
  });
  test("csvEnv splits and trims", () => {
    expect(csvEnv({ C: "a, b,,c" }, "C")).toEqual(["a", "b", "c"]);
    expect(csvEnv({}, "C")).toEqual([]);
  });
});

describe("isNotFoundError", () => {
  test("matches 404 forge errors", () => {
    expect(isNotFoundError(new Error("Gitea API GET x → 404: no"))).toBe(true);
    expect(isNotFoundError(new Error("Gitea API GET x → 500: no"))).toBe(false);
    expect(isNotFoundError("nope")).toBe(false);
  });
});
