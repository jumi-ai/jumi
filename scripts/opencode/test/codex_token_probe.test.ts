import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bearerOf,
  farExpiry,
  nearExpiry,
  probeAccessToken,
  probeIdToken,
  probeJwt,
  sha256Hex,
  tokenOnlyAuth,
} from "../src/codex_token_probe.ts";

function decodePayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("probe JWT minting", () => {
  test("mints three-part tokens with the requested claims", () => {
    const access = probeAccessToken(farExpiry(), "old-token");
    expect(access.split(".")).toHaveLength(3);
    expect(decodePayload(access).jti).toBe("old-token");
    const id = probeIdToken("acc-1");
    expect(id.split(".")).toHaveLength(3);
    expect(JSON.stringify(decodePayload(id))).toContain("acc-1");
    expect(probeJwt({ sub: "x" }).split(".")).toHaveLength(3);
  });

  test("far expiry is weeks out and near expiry is inside the 5-minute refresh window", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(farExpiry()).toBeGreaterThan(now + 7 * 24 * 3600);
    const near = nearExpiry();
    expect(near).toBeGreaterThan(now);
    expect(near).toBeLessThan(now + 5 * 60 + 60);
  });
});

describe("tokenOnlyAuth", () => {
  test("is the token-only shape: empty refresh, far exp, fresh last_refresh", () => {
    const auth = tokenOnlyAuth() as { tokens: Record<string, unknown>; last_refresh: string };
    expect(auth.tokens.refresh_token).toBe("");
    expect(auth.tokens.id_token).toBeDefined();
    expect(auth.tokens.account_id).toBeDefined();
    expect((auth.tokens.access_token as string).split(".")).toHaveLength(3);
    expect(Date.parse(auth.last_refresh)).not.toBeNaN();
  });

  test("omits keys the case asks to drop, so the binary parses what we mean", () => {
    const noRefresh = tokenOnlyAuth() as { tokens: Record<string, unknown> };
    delete noRefresh.tokens.refresh_token;
    expect("refresh_token" in noRefresh.tokens).toBe(false);
    expect("last_refresh" in tokenOnlyAuth({ lastRefresh: null })).toBe(false);
    expect("account_id" in (tokenOnlyAuth({ accountId: null }).tokens as Record<string, unknown>)).toBe(false);
  });
});

describe("helpers", () => {
  test("bearerOf unwraps only Bearer headers", () => {
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf(null)).toBeUndefined();
    expect(bearerOf("(none)")).toBeUndefined();
  });

  test("sha256Hex is stable", () => {
    expect(sha256Hex("a")).toBe(sha256Hex("a"));
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("image verification paths", () => {
  test("runs the token probe in every image verification path", () => {
    const repoRoot = join(process.cwd(), "../..");
    for (const path of [
      ".gitea/scripts/build-reviewer-image.sh",
      ".gitea/scripts/build-worker-image.sh",
      ".github/workflows/jumi-reviewer-image.yml",
      ".github/workflows/jumi-worker-image.yml",
      ".github/workflows/opencode-checks.yml",
    ]) {
      expect(readFileSync(join(repoRoot, path), "utf8")).toContain("bun src/codex_token_probe.ts");
    }
    const checks = readFileSync(join(repoRoot, ".github/workflows/opencode-checks.yml"), "utf8");
    expect(checks.split("bun src/codex_token_probe.ts").length - 1).toBe(2);
  });
});
