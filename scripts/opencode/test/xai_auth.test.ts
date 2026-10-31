import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { opencodeAuthPath } from "../src/opencode_auth.ts";
import {
  adoptOrphanXaiSibling,
  CLOCK_MARGIN_MS,
  childAuthFile,
  childXaiCredential,
  coversJob,
  credentialExpiryMs,
  durableAuthPath,
  ensureXaiCredentialForJob,
  jobBudgetMs,
  jwtExpiryMs,
  OPENCODE_REFRESH_SKEW_MS,
  resetXaiAuthStateForTests,
  writeDurableAuth,
  XAI_CHILD_AUTH_SHAPE,
  XAI_CLIENT_ID,
  XAI_TOKEN_URL,
} from "../src/xai_auth.ts";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const tempDirs: string[] = [];

afterEach(async () => {
  resetXaiAuthStateForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tempDir(label: string): Promise<string> {
  // realpath: macOS tmpdir is a symlink, and durableAuthPath resolves symlinks.
  const dir = await realpath(await mkdtemp(join(tmpdir(), `jumi-${label}-`)));
  tempDirs.push(dir);
  return dir;
}

/** A home whose auth file holds a SuperGrok subscription. */
async function seedHome(entry: unknown, extra: Record<string, unknown> = {}): Promise<{ home: string; path: string }> {
  const home = await tempDir("xai-home");
  const path = opencodeAuthPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...extra, xai: entry }, null, 2)}\n`, { mode: 0o600 });
  return { home, path };
}

function oauthEntry(overrides: Record<string, unknown> = {}) {
  return { type: "oauth", access: "access-1", refresh: "refresh-1", expires: NOW + 6 * HOUR_MS, ...overrides };
}

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `header.${payload}.signature`;
}

interface StubCall {
  url: string;
  body: URLSearchParams;
}

function stubToken(responses: Array<{ status: number; body: unknown }>): {
  calls: StubCall[];
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: StubCall[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, body: new URLSearchParams(String(init?.body ?? "")) });
    const next = responses.shift() ?? { status: 500, body: { error: "no stub left" } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

async function readXai(path: string): Promise<Record<string, unknown>> {
  return (JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, unknown>>).xai;
}

describe("xAI token life", () => {
  test("reads the access token's own expiry", () => {
    expect(jwtExpiryMs(jwt(1_700_000_000))).toBe(1_700_000_000_000);
    expect(jwtExpiryMs("not-a-jwt")).toBeUndefined();
    expect(jwtExpiryMs(undefined)).toBeUndefined();
  });

  test("uses the earlier of the token's own expiry and the stored expiry", () => {
    const early = NOW + HOUR_MS;
    const late = NOW + 5 * HOUR_MS;
    expect(credentialExpiryMs({ access: jwt(late / 1000), expires: early })).toBe(early);
    expect(credentialExpiryMs({ access: jwt(early / 1000), expires: late })).toBe(early);
    expect(credentialExpiryMs({ access: "opaque", expires: late })).toBe(late);
    expect(credentialExpiryMs({ access: jwt(late / 1000) })).toBe(late);
  });

  test("budgets a job as its timeout plus OpenCode's refresh skew plus clock margin", () => {
    expect(jobBudgetMs(4 * HOUR_MS)).toBe(4 * HOUR_MS + OPENCODE_REFRESH_SKEW_MS + CLOCK_MARGIN_MS);
    expect(jobBudgetMs(undefined)).toBe(OPENCODE_REFRESH_SKEW_MS + CLOCK_MARGIN_MS);
  });

  test("a credential with no expiry at all does not cover a job", () => {
    expect(coversJob({ access: "opaque" }, jobBudgetMs(15 * 60_000), NOW)).toBe(false);
    expect(coversJob({ access: "opaque", expires: NOW + 6 * HOUR_MS }, jobBudgetMs(4 * HOUR_MS), NOW)).toBe(true);
    // A fresh 6h token does not cover a 4h job once only 3h are left.
    expect(coversJob({ access: "opaque", expires: NOW + 3 * HOUR_MS }, jobBudgetMs(4 * HOUR_MS), NOW)).toBe(false);
  });
});

describe("child credential", () => {
  test("ships the shape OpenCode sends as a bearer", () => {
    // Flipping this is an OpenCode-upgrade decision the image probe forces,
    // not operator config, so it must not drift without that probe changing.
    expect(XAI_CHILD_AUTH_SHAPE).toBe("api");
  });

  test("never carries a refresh token in either shape", () => {
    const entry = { type: "oauth" as const, access: "access-1", refresh: "refresh-1", expires: NOW + HOUR_MS };
    expect(childXaiCredential(entry, "api")).toEqual({ type: "api", key: "access-1" });
    expect(childXaiCredential(entry, "oauth")).toEqual({ type: "oauth", access: "access-1", expires: NOW + HOUR_MS });
    for (const shape of ["api", "oauth"] as const) {
      expect(JSON.stringify(childXaiCredential(entry, shape))).not.toContain("refresh-1");
    }
  });

  test("replaces the parent xAI entry and leaves other providers alone", () => {
    const parent = {
      "https://kirmanak.stream": { type: "wellknown", key: "K", token: "T" },
      xai: oauthEntry(),
    };
    const child = childAuthFile(parent);
    expect(child["https://kirmanak.stream"]).toEqual(parent["https://kirmanak.stream"]);
    expect(child.xai).toEqual({ type: "api", key: "access-1" });
    expect(JSON.stringify(child)).not.toContain("refresh-1");
    // The parent object is not mutated: it is still the durable file's content.
    expect(parent.xai).toEqual(oauthEntry());
  });

  test("passes an xAI API key through untouched", () => {
    const parent = { xai: { type: "api", key: "sk-xai-operator" } };
    expect(childAuthFile(parent)).toEqual(parent);
  });
});

describe("durable auth file", () => {
  test("writes through a symlink onto the file it points at", async () => {
    const retain = await tempDir("xai-retain");
    const home = await tempDir("xai-home");
    const retained = join(retain, "auth.json");
    await writeFile(retained, `${JSON.stringify({ xai: oauthEntry() })}\n`, { mode: 0o600 });
    const link = opencodeAuthPath(home);
    await mkdir(dirname(link), { recursive: true });
    await symlink(retained, link);

    expect(await durableAuthPath(home)).toBe(retained);
    await writeDurableAuth(retained, { xai: oauthEntry({ access: "access-2" }) });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await readXai(retained)).access).toBe("access-2");
    expect((await readXai(link)).access).toBe("access-2");
  });

  test("leaves no sibling behind after a successful write", async () => {
    const dir = await tempDir("xai-durable");
    const path = join(dir, "auth.json");
    await writeDurableAuth(path, { xai: oauthEntry() });
    expect(await readdir(dir)).toEqual(["auth.json"]);
  });
});

describe("ensureXaiCredentialForJob", () => {
  test("does not refresh while the access token covers the job", async () => {
    const { home, path } = await seedHome(oauthEntry());
    const { calls, fetchImpl } = stubToken([]);

    const resolved = await ensureXaiCredentialForJob({
      home,
      timeoutMs: 4 * HOUR_MS,
      now: () => NOW,
      fetchImpl,
    });

    expect(calls).toHaveLength(0);
    expect(resolved?.refreshed).toBe(false);
    expect(resolved?.child).toEqual({ type: "api", key: "access-1" });
    expect((await readXai(path)).refresh).toBe("refresh-1");
  });

  test("refreshes when the remaining life is under the job budget and lands the new pair", async () => {
    const { home, path } = await seedHome(oauthEntry({ expires: NOW + 3 * HOUR_MS }));
    const { calls, fetchImpl } = stubToken([
      { status: 200, body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 21_600 } },
    ]);

    const resolved = await ensureXaiCredentialForJob({
      home,
      timeoutMs: 4 * HOUR_MS,
      now: () => NOW,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(XAI_TOKEN_URL);
    expect(calls[0]?.body.get("grant_type")).toBe("refresh_token");
    expect(calls[0]?.body.get("refresh_token")).toBe("refresh-1");
    expect(calls[0]?.body.get("client_id")).toBe(XAI_CLIENT_ID);
    expect(resolved?.refreshed).toBe(true);
    expect(resolved?.child).toEqual({ type: "api", key: "access-2" });
    // Durable before the child starts, and the refresh token stays on the file.
    expect(await readXai(path)).toEqual({
      type: "oauth",
      access: "access-2",
      refresh: "refresh-2",
      expires: NOW + 6 * HOUR_MS,
    });
  });

  test("keeps the previous refresh token when the response rotates only the access token", async () => {
    const { home, path } = await seedHome(oauthEntry({ expires: NOW + 10 * 60_000 }));
    const { fetchImpl } = stubToken([{ status: 200, body: { access_token: "access-2", expires_in: 21_600 } }]);

    await ensureXaiCredentialForJob({ home, timeoutMs: 15 * 60_000, now: () => NOW, fetchImpl });

    expect((await readXai(path)).refresh).toBe("refresh-1");
  });

  test("fails closed on a rejected grant and never POSTs it twice", async () => {
    const { home, path } = await seedHome(oauthEntry({ expires: NOW + HOUR_MS }));
    const { calls, fetchImpl } = stubToken([
      { status: 400, body: { error: "invalid_grant" } },
      { status: 200, body: { access_token: "must-not-happen", expires_in: 21_600 } },
    ]);
    const opts = { home, timeoutMs: 4 * HOUR_MS, now: () => NOW, fetchImpl };

    await expect(ensureXaiCredentialForJob(opts)).rejects.toThrow(/xAI token refresh failed \(400\)/);
    await expect(ensureXaiCredentialForJob(opts)).rejects.toThrow(/already refused/);

    expect(calls).toHaveLength(1);
    expect((await readXai(path)).access).toBe("access-1");
  });

  for (const status of [503, 429]) {
    test(`fails closed on a ${status} without latching the grant`, async () => {
      const { home, path } = await seedHome(oauthEntry({ expires: NOW + HOUR_MS }));
      const { calls, fetchImpl } = stubToken([
        { status, body: { error: "try_later" } },
        { status: 200, body: { access_token: "access-2", expires_in: 21_600 } },
      ]);
      const opts = { home, timeoutMs: 4 * HOUR_MS, now: () => NOW, fetchImpl };

      await expect(ensureXaiCredentialForJob(opts)).rejects.toThrow(
        new RegExp(`xAI token refresh failed \\(${status}\\)`)
      );
      const resolved = await ensureXaiCredentialForJob(opts);

      expect(calls).toHaveLength(2);
      expect(resolved?.child).toEqual({ type: "api", key: "access-2" });
      expect((await readXai(path)).access).toBe("access-2");
    });
  }

  test("fails closed on a 200 with no access token without latching the grant", async () => {
    const { home, path } = await seedHome(oauthEntry({ expires: NOW + HOUR_MS }));
    const { calls, fetchImpl } = stubToken([
      { status: 200, body: { expires_in: 21_600 } },
      { status: 200, body: { access_token: "access-2", expires_in: 21_600 } },
    ]);
    const opts = { home, timeoutMs: 4 * HOUR_MS, now: () => NOW, fetchImpl };

    await expect(ensureXaiCredentialForJob(opts)).rejects.toThrow(/no access_token/);
    const resolved = await ensureXaiCredentialForJob(opts);

    expect(calls).toHaveLength(2);
    expect(resolved?.child).toEqual({ type: "api", key: "access-2" });
    expect((await readXai(path)).access).toBe("access-2");
  });

  test("does not POST when the auth directory cannot take the rotated pair", async () => {
    const { home, path } = await seedHome(oauthEntry({ expires: NOW + 10 * 60_000 }));
    const { calls, fetchImpl } = stubToken([
      { status: 200, body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 21_600 } },
    ]);
    const opts = { home, timeoutMs: 15 * 60_000, now: () => NOW, fetchImpl };

    // The write is proven before the POST, so the grant on the file stays live.
    await chmod(dirname(path), 0o500);
    try {
      await expect(ensureXaiCredentialForJob(opts)).rejects.toThrow(/cannot write a new xAI credential/);
    } finally {
      await chmod(dirname(path), 0o700);
    }
    expect(calls).toHaveLength(0);
    expect(await readXai(path)).toMatchObject({ access: "access-1", refresh: "refresh-1" });

    const resolved = await ensureXaiCredentialForJob(opts);

    expect(calls).toHaveLength(1);
    expect(resolved?.child).toEqual({ type: "api", key: "access-2" });
    expect(await readXai(path)).toMatchObject({ access: "access-2", refresh: "refresh-2" });
  });

  test("does not start the job when a verified refresh still does not cover it", async () => {
    const { home, path } = await seedHome(oauthEntry({ expires: NOW + HOUR_MS }));
    const { calls, fetchImpl } = stubToken([{ status: 200, body: { access_token: "access-2", expires_in: 600 } }]);

    await expect(
      ensureXaiCredentialForJob({ home, timeoutMs: 4 * HOUR_MS, now: () => NOW, fetchImpl })
    ).rejects.toThrow(/does not cover/);

    expect(calls).toHaveLength(1);
    // The rotated pair is still durable: it is the only one xAI accepts now.
    expect(await readXai(path)).toMatchObject({ access: "access-2", refresh: "refresh-1" });
  });

  test("fails closed when the file has no refresh token to present", async () => {
    const { home } = await seedHome({ type: "oauth", access: "access-1", expires: NOW + HOUR_MS });
    const { calls, fetchImpl } = stubToken([]);

    await expect(
      ensureXaiCredentialForJob({ home, timeoutMs: 4 * HOUR_MS, now: () => NOW, fetchImpl })
    ).rejects.toThrow(/no refresh token/);
    expect(calls).toHaveLength(0);
  });

  test("ignores a home with no xAI subscription", async () => {
    const home = await tempDir("xai-empty");
    const { calls, fetchImpl } = stubToken([]);

    expect(
      await ensureXaiCredentialForJob({ home, timeoutMs: 15 * 60_000, now: () => NOW, fetchImpl })
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("serializes concurrent jobs onto one refresh", async () => {
    const { home } = await seedHome(oauthEntry({ expires: NOW + 10 * 60_000 }));
    const { calls, fetchImpl } = stubToken([
      { status: 200, body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 21_600 } },
    ]);
    const opts = { home, timeoutMs: 15 * 60_000, now: () => NOW, fetchImpl };

    const resolved = await Promise.all([ensureXaiCredentialForJob(opts), ensureXaiCredentialForJob(opts)]);

    expect(calls).toHaveLength(1);
    expect(resolved.map((r) => r?.child)).toEqual([
      { type: "api", key: "access-2" },
      { type: "api", key: "access-2" },
    ]);
  });
});

describe("adoptOrphanXaiSibling", () => {
  test("adopts a newer unrenamed sibling and clears the rest", async () => {
    const { home, path } = await seedHome(oauthEntry({ expires: NOW + HOUR_MS }));
    const newer = `${path}.jumi-completed.tmp`;
    const older = `${path}.jumi-stale.tmp`;
    await writeFile(newer, JSON.stringify({ xai: oauthEntry({ access: "access-2", refresh: "refresh-2" }) }));
    await writeFile(older, JSON.stringify({ xai: oauthEntry({ access: "access-0", expires: NOW - HOUR_MS }) }));

    expect(await adoptOrphanXaiSibling(home)).toBe(true);

    expect(await readXai(path)).toMatchObject({ access: "access-2", refresh: "refresh-2" });
    expect((await readdir(dirname(path))).sort()).toEqual(["auth.json"]);
  });

  test("keeps the file when every sibling is older", async () => {
    const { home, path } = await seedHome(oauthEntry());
    await writeFile(`${path}.jumi-stale.tmp`, JSON.stringify({ xai: oauthEntry({ access: "old", expires: NOW }) }));

    expect(await adoptOrphanXaiSibling(home)).toBe(false);

    expect((await readXai(path)).access).toBe("access-1");
    expect(await readdir(dirname(path))).toEqual(["auth.json"]);
  });

  test("is a no-op with no siblings", async () => {
    const { home } = await seedHome(oauthEntry());
    expect(await adoptOrphanXaiSibling(home)).toBe(false);
  });
});

describe("image verification paths", () => {
  const repoRoot = join(process.cwd(), "../..");

  test("runs the xAI child credential probe in every image verification path", () => {
    // Whether OpenCode refreshes the child's credential is decided inside its
    // provider loader, so an OPENCODE_VERSION bump can silently hand the grant
    // back to the child. Only the probe against the real binary sees that, and
    // `opencode-checks.yml` is the path that gates the bump on pull_request.
    const paths = [
      ".gitea/scripts/build-reviewer-image.sh",
      ".gitea/scripts/build-worker-image.sh",
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
    ];
    expect(existsSync(join(repoRoot, "scripts/opencode/src/xai_child_auth_probe.ts"))).toBe(true);
    for (const path of paths) {
      expect(readFileSync(join(repoRoot, path), "utf8")).toContain("bun src/xai_child_auth_probe.ts");
    }
    // Both pull_request image builds run OpenCode with this grant mounted.
    const checks = readFileSync(join(repoRoot, ".github/workflows/opencode-checks.yml"), "utf8");
    expect(checks.split("bun src/xai_child_auth_probe.ts").length - 1).toBe(2);
  });
});
