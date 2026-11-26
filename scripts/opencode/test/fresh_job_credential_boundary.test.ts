import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CredentialRouteId,
  FRESH_JOB_CREDENTIAL_ROUTES,
  FreshJobCredentialStore,
  routeVerdict,
  runFreshJobBoundaryChecks,
} from "../src/fresh_job_credential_boundary.ts";

/**
 * Shared offline proof for the fresh-job credential boundary (#931).
 * `#935`-`#938` inherit this file for their own credential form: keep the
 * five checks, replace only the store construction (seed + POST double).
 * Dummy credentials only: no registration, sign-in, or spend.
 */
describe("fresh-job credential boundary", () => {
  test("permitted inference succeeds, restart survives, concurrent renewal shares one POST, revocation fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-fresh-boundary-"));
    try {
      const store = new FreshJobCredentialStore(dir);
      const result = await runFreshJobBoundaryChecks(store);
      expect(result.inferenceOk).toBe(true);
      expect(result.restartOk).toBe(true);
      expect(result.concurrentOk).toBe(true);
      expect(result.revocationOk).toBe(true);
      expect(result.exposureOk).toBe(true);
      expect(result.refreshPosts).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rotation does not revoke an already-issued access token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-fresh-rotation-"));
    try {
      const store = new FreshJobCredentialStore(dir);
      await store.persist();
      const before = store.snapshot().access;
      const rotated = await store.refresh();
      expect(rotated.access).not.toBe(before);
      expect(store.inference(before)).toBe(true);
      expect(store.inference(rotated.access)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tool context never observes the refresh grant or a forge credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-fresh-exposure-"));
    try {
      const store = new FreshJobCredentialStore(dir);
      const secret = store.snapshot();
      const view = store.childView();
      expect(JSON.stringify(view)).not.toContain(secret.refresh);
      expect(Object.keys(view.env).join(" ")).not.toMatch(/GITEA|GITHUB|WEBHOOK|SECRETS/);
      expect(view.argv.join(" ")).not.toContain(secret.refresh);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("orphan sibling from an interrupted durable write is adopted on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jumi-fresh-orphan-"));
    try {
      const store = new FreshJobCredentialStore(dir);
      await store.persist();
      const before = store.snapshot();
      const orphan = {
        current: {
          access: "dummy-access-newer",
          refresh: "dummy-refresh-newer",
          generation: before.generation + 1,
          revoked: false,
        },
        issued: [before.access, "dummy-access-newer"],
      };
      await writeFile(join(dir, "credential.json.jumi-orphan.tmp"), JSON.stringify(orphan));
      await store.restart();
      expect(store.snapshot().access).toBe("dummy-access-newer");
      expect(store.inference("dummy-access-newer")).toBe(true);
      expect(store.inference(before.access)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contract finishes every route with a verdict, evidence, and operator-only checks", () => {
    const ids = FRESH_JOB_CREDENTIAL_ROUTES.map((route) => route.id).sort();
    expect(ids).toEqual(["chatgpt-oss-signin", "claude-signed-in-helper", "direct-supergrok", "opencode-go"]);
    for (const route of FRESH_JOB_CREDENTIAL_ROUTES) {
      expect(route.loginOwner.trim()).not.toBe("");
      expect(route.serialization.trim()).not.toBe("");
      expect(route.persistence.trim()).not.toBe("");
      expect(route.revocation.trim()).not.toBe("");
      expect(route.childCapability.trim()).not.toBe("");
      expect(route.forbiddenForChild.length).toBeGreaterThan(0);
      expect(route.freshJob.trim()).not.toBe("");
      expect(route.evidence.length).toBeGreaterThan(0);
      expect(route.operatorChecks.length).toBeGreaterThan(0);
      for (const link of route.evidence) {
        if (link.startsWith("src/")) continue;
        expect(link).toMatch(/^https:\/\//);
      }
    }
  });

  test("verdicts: Go allowed, the three grant/refresh routes blocked, overage needs a human", () => {
    const verdictOf = (id: CredentialRouteId) => routeVerdict(id);
    expect(verdictOf("opencode-go")).toBe("allowed");
    expect(verdictOf("chatgpt-oss-signin")).toBe("blocked");
    expect(verdictOf("claude-signed-in-helper")).toBe("blocked");
    expect(verdictOf("direct-supergrok")).toBe("blocked");
    const go = FRESH_JOB_CREDENTIAL_ROUTES.find((route) => route.id === "opencode-go");
    expect(go?.notes ?? "").toContain("needs-human");
    expect(() => routeVerdict("no-such-route" as CredentialRouteId)).toThrow();
  });

  test("single-UID design cannot enforce the boundary by file mode: blocked rows say so", () => {
    const blocked = FRESH_JOB_CREDENTIAL_ROUTES.filter((route) => route.verdict === "blocked");
    expect(blocked.length).toBeGreaterThan(0);
    for (const route of blocked) {
      expect(`${route.notes} ${route.freshJob}`.toLowerCase()).toMatch(
        /same-uid|single-uid|uid|mount namespace|shared token store/
      );
    }
  });
});
