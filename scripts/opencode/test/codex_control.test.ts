import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoRefreshToken,
  buildTokenOnlyAuth,
  CODEX_REFRESH_THRESHOLD_FRACTION,
  CodexLoginDeadError,
  codexAccessExpiryMs,
  codexAccessRemainingMs,
  codexLoginDeadNotice,
  codexLoginDeathReason,
  codexTokenLifetimeMs,
  getCodexControlSnapshot,
  isPublishableCodexAuth,
  postCodexRefresh,
  publishTokenOnlyAuth,
  readCodexAuthFile,
  renderCodexControlMetrics,
  resetCodexControlMetricsForTests,
  shouldRefreshCodex,
  writeCodexAuthDurably,
} from "../src/codex_control.ts";
import { probeAccessToken, probeIdToken, tokenOnlyAuth } from "../src/codex_token_probe.ts";
import { newControlRuntimeState, publishCurrentToken, runControlTick } from "../src/control.ts";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "none" })}.${b64url(claims)}.sig`;
}

function fullAuth(opts: {
  accessExp: number;
  refresh?: string;
  lastRefresh?: string;
  accountId?: string;
  idToken?: string;
}): Record<string, unknown> {
  const access = jwtWithClaims({ exp: opts.accessExp, iat: opts.accessExp - 3600 });
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: access,
      refresh_token: opts.refresh ?? "refresh-live",
      id_token: opts.idToken ?? probeIdToken(opts.accountId ?? "acc-1"),
      account_id: opts.accountId ?? "acc-1",
    },
    last_refresh: opts.lastRefresh ?? new Date((opts.accessExp - 3600) * 1000).toISOString(),
  };
}

describe("codex refresh threshold is a fraction", () => {
  test("fraction constant is not a hardcoded day count", () => {
    expect(CODEX_REFRESH_THRESHOLD_FRACTION).toBeGreaterThan(0);
    expect(CODEX_REFRESH_THRESHOLD_FRACTION).toBeLessThan(1);
  });

  test("far-expiry token does not refresh; near-expiry does", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const farExp = nowSec + 3600;
    const far = fullAuth({ accessExp: farExp });
    expect(shouldRefreshCodex(far, nowSec * 1000)).toBe(false);

    // Remaining 5min of a 1h lifetime: 5/60 < 0.25 → refresh.
    const nearExp = nowSec + 5 * 60;
    const near = fullAuth({ accessExp: nearExp });
    expect(shouldRefreshCodex(near, nowSec * 1000)).toBe(true);
  });

  test("short-lived token uses the same fraction", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // 60s lifetime, 10s remaining: 10/60 < 0.25 → refresh.
    const exp = nowSec + 10;
    const auth = fullAuth({ accessExp: exp, lastRefresh: new Date((exp - 60) * 1000).toISOString() });
    expect(codexTokenLifetimeMs(auth)).toBe(60_000);
    expect(codexAccessRemainingMs(auth, nowSec * 1000)).toBe(10_000);
    expect(shouldRefreshCodex(auth, nowSec * 1000)).toBe(true);

    // Same 60s lifetime, 50s remaining: 50/60 > 0.25 → no refresh.
    const freshExp = nowSec + 50;
    const fresh = fullAuth({
      accessExp: freshExp,
      lastRefresh: new Date((freshExp - 60) * 1000).toISOString(),
    });
    expect(shouldRefreshCodex(fresh, nowSec * 1000)).toBe(false);
  });

  test("missing expiry refreshes; missing refresh token never posts", () => {
    const auth = {
      auth_mode: "chatgpt",
      tokens: { access_token: "not-a-jwt", refresh_token: "r", id_token: probeIdToken(), account_id: "a" },
      last_refresh: new Date().toISOString(),
    };
    expect(shouldRefreshCodex(auth, Date.now())).toBe(true);
    const noRefresh = fullAuth({ accessExp: Math.floor(Date.now() / 1000) + 10, refresh: "" });
    // Empty refresh means the token-only shape: control must never POST it.
    expect(shouldRefreshCodex(noRefresh, Date.now())).toBe(false);
  });
});

describe("codex rotation write", () => {
  test("writes the rotated pair durably and re-reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-rotate-"));
    try {
      const home = join(dir, "home");
      await mkdir(join(home, ".codex"), { recursive: true });
      const path = join(home, ".codex", "auth.json");
      const nowSec = Math.floor(Date.now() / 1000);
      await writeFile(path, JSON.stringify(fullAuth({ accessExp: nowSec + 3600 })), "utf8");

      const nextAccess = probeAccessToken(nowSec + 3600, "rotated");
      const next = {
        ...(await readCodexAuthFile(path)),
        tokens: {
          ...((await readCodexAuthFile(path)).tokens as Record<string, unknown>),
          access_token: nextAccess,
          refresh_token: "refresh-rotated",
        },
        last_refresh: new Date().toISOString(),
      };
      await writeCodexAuthDurably(path, next);
      const reread = await readCodexAuthFile(path);
      expect((reread.tokens as Record<string, unknown>).access_token).toBe(nextAccess);
      expect((reread.tokens as Record<string, unknown>).refresh_token).toBe("refresh-rotated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("codex publish shape", () => {
  test("token-only doc passes the probe shape and carries no refresh", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const full = fullAuth({ accessExp: nowSec + 3600 });
    const doc = buildTokenOnlyAuth(full);
    expect(isPublishableCodexAuth(doc)).toBe(true);
    expect((doc.tokens as Record<string, unknown>).refresh_token).toBe("");
    expect(doc.auth_mode).toBe("chatgpt");
    assertNoRefreshToken(doc, "refresh-live");
    // The published JSON text itself must not contain the real refresh token.
    expect(JSON.stringify(doc)).not.toContain("refresh-live");
  });

  test("refuses documents that fail the shape", () => {
    expect(isPublishableCodexAuth(tokenOnlyAuth())).toBe(false); // no auth_mode
    const good = buildTokenOnlyAuth(fullAuth({ accessExp: Math.floor(Date.now() / 1000) + 3600 }));
    expect(isPublishableCodexAuth(good)).toBe(true);
    const missingKey = structuredClone(good) as Record<string, unknown>;
    delete (missingKey.tokens as Record<string, unknown>).refresh_token;
    expect(isPublishableCodexAuth(missingKey)).toBe(false);
    const withRefresh = structuredClone(good) as Record<string, unknown>;
    (withRefresh.tokens as Record<string, unknown>).refresh_token = "secret";
    expect(isPublishableCodexAuth(withRefresh)).toBe(false);
    expect(() => assertNoRefreshToken(withRefresh, "secret")).toThrow();
    const badId = structuredClone(good) as Record<string, unknown>;
    (badId.tokens as Record<string, unknown>).id_token = "only.two";
    expect(isPublishableCodexAuth(badId)).toBe(false);
    const noLast = structuredClone(good) as Record<string, unknown>;
    delete noLast.last_refresh;
    expect(isPublishableCodexAuth(noLast)).toBe(false);
  });

  test("no published document can contain a refresh token", async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: probeAccessToken(Math.floor(Date.now() / 1000) + 3600),
            refresh_token: "refresh-new",
            id_token: probeIdToken(),
          }),
          { status: 200 }
        );
      }
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ metadata: { resourceVersion: "1" } }), { status: 200 });
      }
      const body = String(init?.body ?? "");
      seen.push(body);
      // Decode the Secret payload and prove the refresh key is empty.
      const parsed = JSON.parse(body) as { data?: Record<string, string> };
      const authJson = Buffer.from(parsed.data?.["auth.json"] ?? "", "base64").toString("utf8");
      expect(authJson).not.toContain("refresh-live");
      expect(authJson).not.toContain("refresh-new");
      expect(JSON.parse(authJson).tokens.refresh_token).toBe("");
      return new Response(JSON.stringify({ metadata: { resourceVersion: "1" } }), { status: 200 });
    };
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-pub-"));
    try {
      const home = join(dir, "home");
      await mkdir(join(home, ".codex"), { recursive: true });
      const nowSec = Math.floor(Date.now() / 1000);
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify(
          fullAuth({ accessExp: nowSec + 60, lastRefresh: new Date((nowSec - 3540) * 1000).toISOString() })
        ),
        "utf8"
      );
      resetCodexControlMetricsForTests();
      const state = newControlRuntimeState();
      const result = await runControlTick(state, {
        home,
        now: () => nowSec * 1000,
        fetchImpl,
        k8sApiUrl: "https://k8s.example",
        k8sNamespace: "ns",
        k8sSecretName: "codex-token",
        k8sToken: "sa-token",
        k8sFetchImpl: fetchImpl,
      });
      expect(result.refreshed).toBe(true);
      expect(result.published).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("codex publish retry and login death", () => {
  test("a failed publish is retried and then succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-retry-"));
    try {
      const home = join(dir, "home");
      await mkdir(join(home, ".codex"), { recursive: true });
      const nowSec = Math.floor(Date.now() / 1000);
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify(fullAuth({ accessExp: nowSec + 3600 })),
        "utf8"
      );
      resetCodexControlMetricsForTests();
      let calls = 0;
      const k8sFetch: (input: string, init?: RequestInit) => Promise<Response> = async (input, init) => {
        calls += 1;
        if (String(input).includes("/oauth/token")) throw new Error("must not refresh on startup publish");
        if ((init?.method ?? "GET") === "GET") return new Response("not found", { status: 404 });
        if (calls === 2) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({}), { status: 201 });
      };
      // Startup publish fails once...
      await expect(
        publishCurrentToken({
          home,
          k8sApiUrl: "https://k8s.example",
          k8sNamespace: "ns",
          k8sSecretName: "s",
          k8sToken: "t",
          k8sFetchImpl: k8sFetch,
        })
      ).rejects.toThrow();
      // ...and the retry succeeds.
      await publishCurrentToken({
        home,
        k8sApiUrl: "https://k8s.example",
        k8sNamespace: "ns",
        k8sSecretName: "s",
        k8sToken: "t",
        k8sFetchImpl: k8sFetch,
      });
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refresh_token_reused and invalid_refresh_token are login death", async () => {
    expect(codexLoginDeathReason(401, '{"error":"refresh_token_reused"}')).toBe("refresh_token_reused");
    expect(codexLoginDeathReason(401, "invalid_refresh_token")).toBe("invalid_refresh_token");
    expect(codexLoginDeathReason(401, "refresh_token_invalidated")).toBe("refresh_token_invalidated");
    expect(codexLoginDeathReason(500, "refresh_token_reused")).toBeUndefined();

    for (const body of ['{"error":"refresh_token_reused"}', "invalid_refresh_token"]) {
      const fetchImpl = async (input: string): Promise<Response> => {
        if (String(input).includes("/oauth/token")) return new Response(body, { status: 401 });
        return new Response(JSON.stringify({}), { status: 200 });
      };
      const dir = await mkdtemp(join(tmpdir(), "jumi-codex-dead-"));
      try {
        const home = join(dir, "home");
        await mkdir(join(home, ".codex"), { recursive: true });
        const nowSec = Math.floor(Date.now() / 1000);
        await writeFile(
          join(home, ".codex", "auth.json"),
          JSON.stringify(
            fullAuth({ accessExp: nowSec + 60, lastRefresh: new Date((nowSec - 3540) * 1000).toISOString() })
          ),
          "utf8"
        );
        resetCodexControlMetricsForTests();
        const state = newControlRuntimeState();
        const first = await runControlTick(state, {
          home,
          now: () => nowSec * 1000,
          fetchImpl,
          k8sApiUrl: "https://k8s.example",
          k8sNamespace: "ns",
          k8sSecretName: "s",
          k8sToken: "t",
          k8sFetchImpl: fetchImpl,
        });
        expect(first.loginDead).toBe(true);
        expect(state.loginDead).toBe(true);
        // Second tick with the same grant does not POST again.
        let posts = 0;
        const counting = async (input: string): Promise<Response> => {
          if (String(input).includes("/oauth/token")) posts += 1;
          return fetchImpl(input);
        };
        const second = await runControlTick(state, {
          home,
          now: () => nowSec * 1000 + 1000,
          fetchImpl: counting,
          k8sApiUrl: "https://k8s.example",
          k8sNamespace: "ns",
          k8sSecretName: "s",
          k8sToken: "t",
          k8sFetchImpl: counting,
        });
        expect(second.loginDead).toBe(true);
        expect(posts).toBe(0);
        // Surfaced in metrics and on the board notice, without tokens.
        const metrics = renderCodexControlMetrics();
        expect(metrics).toContain("codex_login_dead");
        expect(metrics).not.toContain("refresh-live");
        const notice = codexLoginDeadNotice();
        expect(notice).toContain("Codex login dead");
        expect(notice).not.toContain("refresh-live");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("postCodexRefresh throws CodexLoginDeadError without logging tokens", async () => {
    const fetchImpl = async () => new Response('{"error":"refresh_token_reused"}', { status: 401 });
    try {
      await postCodexRefresh("super-secret-refresh", { fetchImpl });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CodexLoginDeadError);
      expect(String((err as Error).message)).not.toContain("super-secret-refresh");
    }
  });

  test("metrics export remaining, lifetime, and last refresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-codex-metrics-"));
    try {
      const home = join(dir, "home");
      await mkdir(join(home, ".codex"), { recursive: true });
      const nowSec = Math.floor(Date.now() / 1000);
      await writeFile(
        join(home, ".codex", "auth.json"),
        JSON.stringify(fullAuth({ accessExp: nowSec + 1800 })),
        "utf8"
      );
      resetCodexControlMetricsForTests();
      const before = getCodexControlSnapshot();
      expect(before.remainingSeconds).toBeUndefined();
      await runControlTick(newControlRuntimeState(), { home, now: () => nowSec * 1000, publish: false });
      const metrics = renderCodexControlMetrics();
      expect(metrics).toContain("codex_access_token_seconds_remaining");
      expect(metrics).toContain("codex_access_token_lifetime_seconds");
      expect(metrics).toContain("codex_last_refresh_timestamp_seconds");
      expect(codexAccessExpiryMs("bad")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
