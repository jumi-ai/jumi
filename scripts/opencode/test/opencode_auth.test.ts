import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOpenCodeWellKnownAuth, opencodeAuthPath, parseOpenCodeWellKnownUrl } from "../src/opencode_auth.ts";

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-opencode-auth-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("OpenCode well-known auth seeding", () => {
  test("uses OpenCode's default HOME data path", () => {
    expect(opencodeAuthPath("/data")).toBe("/data/.local/share/opencode/auth.json");
  });

  test("uses XDG_DATA_HOME when provided", () => {
    expect(opencodeAuthPath("/data", "/xdg-data")).toBe("/xdg-data/opencode/auth.json");
  });

  test("creates a missing auth file with the well-known entry", async () => {
    const home = await tempHome();
    const path = await ensureOpenCodeWellKnownAuth({
      home,
      url: "https://kirmanak.stream",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });

    const auth = JSON.parse(await readFile(path!, "utf8"));
    expect(auth["https://kirmanak.stream"]).toEqual({
      type: "wellknown",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });
    expect((await stat(path!)).mode & 0o777).toBe(0o600);
  });

  test("preserves existing auth providers while adding the remote config entry", async () => {
    const home = await tempHome();
    const path = opencodeAuthPath(home);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ openai: { type: "oauth", refresh: "keep-me" } }));

    await ensureOpenCodeWellKnownAuth({
      home,
      url: "https://kirmanak.stream",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });

    const auth = JSON.parse(await readFile(path, "utf8"));
    expect(auth.openai).toEqual({ type: "oauth", refresh: "keep-me" });
    expect(auth["https://kirmanak.stream"].type).toBe("wellknown");
  });

  test("rewrites an existing well-known entry when key or token differ", async () => {
    const home = await tempHome();
    const path = opencodeAuthPath(home);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        openai: { type: "oauth", refresh: "keep-me" },
        "https://kirmanak.stream": { type: "wellknown", key: "CUSTOM_TOKEN", token: "stale" },
      })
    );

    await ensureOpenCodeWellKnownAuth({
      home,
      url: "https://kirmanak.stream",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "rotated",
    });

    const auth = JSON.parse(await readFile(path, "utf8"));
    expect(auth.openai).toEqual({ type: "oauth", refresh: "keep-me" });
    expect(auth["https://kirmanak.stream"]).toEqual({
      type: "wellknown",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "rotated",
    });
  });

  test("does not rewrite an existing well-known entry when key and token match", async () => {
    const home = await tempHome();
    const path = opencodeAuthPath(home);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        "https://kirmanak.stream": { type: "wellknown", key: "OPENCODE_WELLKNOWN_TOKEN", token: "unused" },
      })
    );

    await ensureOpenCodeWellKnownAuth({
      home,
      url: "https://kirmanak.stream",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });

    const auth = JSON.parse(await readFile(path, "utf8"));
    expect(auth["https://kirmanak.stream"]).toEqual({
      type: "wellknown",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });
  });

  test("does not seed when url is omitted", async () => {
    const home = await tempHome();
    const path = await ensureOpenCodeWellKnownAuth({
      home,
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });

    expect(path).toBeUndefined();
    await expect(readFile(opencodeAuthPath(home), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not seed the disabled sentinel", async () => {
    const home = await tempHome();
    const path = await ensureOpenCodeWellKnownAuth({
      home,
      url: "disabled",
      key: "OPENCODE_WELLKNOWN_TOKEN",
      token: "unused",
    });

    expect(path).toBeUndefined();
    await expect(readFile(opencodeAuthPath(home), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes a leftover disabled well-known entry and preserves other providers", async () => {
    const home = await tempHome();
    const path = opencodeAuthPath(home);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        openai: { type: "api", key: "keep-me" },
        disabled: { type: "wellknown", key: "OPENCODE_WELLKNOWN_TOKEN", token: "unused" },
      })
    );

    expect(
      await ensureOpenCodeWellKnownAuth({
        home,
        key: "OPENCODE_WELLKNOWN_TOKEN",
        token: "unused",
      })
    ).toBeUndefined();

    const auth = JSON.parse(await readFile(path, "utf8"));
    expect(auth.openai).toEqual({ type: "api", key: "keep-me" });
    expect(auth.disabled).toBeUndefined();
  });
});

describe("parseOpenCodeWellKnownUrl", () => {
  test("unset or empty disables well-known", () => {
    expect(parseOpenCodeWellKnownUrl(undefined)).toBeUndefined();
    expect(parseOpenCodeWellKnownUrl("")).toBeUndefined();
    expect(parseOpenCodeWellKnownUrl("  ")).toBeUndefined();
  });

  test("disabled turns well-known off", () => {
    expect(parseOpenCodeWellKnownUrl("disabled")).toBeUndefined();
    expect(parseOpenCodeWellKnownUrl(" disabled ")).toBeUndefined();
  });

  test("accepts an http(s) origin and strips trailing slashes", () => {
    expect(parseOpenCodeWellKnownUrl("https://opencode.example")).toBe("https://opencode.example");
    expect(parseOpenCodeWellKnownUrl("https://opencode.example/")).toBe("https://opencode.example");
    expect(parseOpenCodeWellKnownUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  test("garbage URLs fail closed and do not fall through to the default", () => {
    expect(() => parseOpenCodeWellKnownUrl("not-a-url")).toThrow("Invalid OPENCODE_WELLKNOWN_URL: not-a-url");
    expect(() => parseOpenCodeWellKnownUrl("ftp://example.com")).toThrow("Invalid OPENCODE_WELLKNOWN_URL");
    expect(() => parseOpenCodeWellKnownUrl("Disabled")).toThrow("Invalid OPENCODE_WELLKNOWN_URL");
    expect(() => parseOpenCodeWellKnownUrl("https://")).toThrow("Invalid OPENCODE_WELLKNOWN_URL");
  });
});
