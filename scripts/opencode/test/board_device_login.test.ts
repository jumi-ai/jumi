import { describe, expect, test } from "bun:test";
import { createBoardFetchHandler, renderBoardPage } from "../src/board.ts";
import {
  DEVICE_LOGIN_BOARD_CANCEL_PATH,
  DEVICE_LOGIN_BOARD_START_PATH,
  DEVICE_LOGIN_BOARD_STATUS_PATH,
  isValidDeviceRole,
  isValidOrdinalHost,
  sanitizeDeviceLoginStatus,
} from "../src/board_device_login.ts";
import { MemoryReviewJobStore } from "../src/review_jobs.ts";

describe("board device login proxy", () => {
  test("paths are not the kick route", () => {
    expect(DEVICE_LOGIN_BOARD_START_PATH).not.toContain("/kick");
    expect(DEVICE_LOGIN_BOARD_CANCEL_PATH).not.toContain("/kick");
    expect(DEVICE_LOGIN_BOARD_STATUS_PATH).not.toContain("/kick");
  });

  test("ordinal host validation rejects scheme, port, path, and IP", () => {
    expect(isValidOrdinalHost("jumi-worker-0")).toBe(true);
    expect(isValidOrdinalHost("jumi-worker-0.svc.cluster.local")).toBe(true);
    expect(isValidOrdinalHost("http://jumi-worker-0")).toBe(false);
    expect(isValidOrdinalHost("jumi-worker-0:3010")).toBe(false);
    expect(isValidOrdinalHost("jumi-worker-0/evil")).toBe(false);
    expect(isValidOrdinalHost("10.0.0.1")).toBe(false);
    expect(isValidOrdinalHost("")).toBe(false);
    expect(isValidOrdinalHost("a..b")).toBe(false);
    expect(isValidDeviceRole("engine")).toBe(true);
    expect(isValidDeviceRole("worker")).toBe(true);
    expect(isValidDeviceRole("router")).toBe(false);
  });

  test("sanitize drops token material", () => {
    const status = sanitizeDeviceLoginStatus(
      {
        ordinal: "w-0",
        role: "worker",
        hasXaiRunner: true,
        authPresent: false,
        leased: false,
        state: "waiting",
        url: "https://auth.x.ai/activate",
        userCode: "CODE-1",
        expiresAt: 123,
        access: "secret-access",
        refresh: "secret-refresh",
        token: "secret-token",
        key: "secret-key",
        auth: { xai: "secret" },
      },
      "w-0",
      "worker"
    );
    expect(status).toBeDefined();
    const raw = JSON.stringify(status);
    expect(raw).not.toContain("secret-access");
    expect(raw).not.toContain("secret-refresh");
    expect(raw).not.toContain("secret-token");
    expect(status?.url).toBe("https://auth.x.ai/activate");
    expect(status?.userCode).toBe("CODE-1");
  });

  test("peer factory has no device login control", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createBoardFetchHandler({ store, forge: "github", peerToken: "t", logger: () => {} });
    for (const path of [
      DEVICE_LOGIN_BOARD_STATUS_PATH,
      DEVICE_LOGIN_BOARD_START_PATH,
      DEVICE_LOGIN_BOARD_CANCEL_PATH,
    ]) {
      const res = await handler(
        new Request(`https://board.test${path}?ordinal=w-0&role=worker`, {
          headers: new Headers({ Authorization: "Bearer t" }),
        })
      );
      expect(res.status).toBe(404);
    }
  });

  test("start proxies without forwarding actor or command fields", async () => {
    const store = new MemoryReviewJobStore();
    let seenUrl = "";
    let seenBody = "";
    let seenHeaders: Record<string, string> = {};
    const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
      seenUrl = input;
      seenBody = (init?.body as string) ?? "";
      seenHeaders = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
      return new Response(
        JSON.stringify({ state: "waiting", url: "https://auth.x.ai/activate", userCode: "C-1", expiresAt: 7 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };
    const handler = createBoardFetchHandler({ store, forge: "gitea", logger: () => {}, fetchFn });
    const res = await handler(
      new Request("https://board.test/api/board/device-login/start", {
        method: "POST",
        headers: new Headers({
          "Content-Type": "application/json",
          "X-Forwarded-User": "operator",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "board.example",
        }),
        body: JSON.stringify({ ordinal: "jumi-worker-0", role: "worker", actor: "mallory", command: "rm -rf /" }),
      })
    );
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("http://jumi-worker-0:3010/api/device-login/start");
    expect(seenBody).toBe("{}");
    expect(seenHeaders["x-forwarded-user"]).toBe("operator");
    expect(seenBody).not.toContain("mallory");
    expect(seenBody).not.toContain("rm -rf");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.url).toBe("https://auth.x.ai/activate");
    expect(JSON.stringify(body)).not.toContain("mallory");
  });

  test("board page has tappable link, selectable code, expiry, and ordinal confirm", () => {
    const html = renderBoardPage("catalog123");
    expect(html).toContain("Grok sign-in");
    expect(html).toContain("grok-link");
    expect(html).toContain("grok-code");
    expect(html).toContain("grok-expiry");
    expect(html).toContain("user-select: all");
    expect(html).toContain("write that pod's Grok auth file");
    expect(html).not.toContain("Start Grok sign-in on <ordinal>");
  });
});
