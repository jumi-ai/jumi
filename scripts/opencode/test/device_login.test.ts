import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCodexChatGptCredential, isCodexChatGptPresent } from "../src/codex_auth.ts";
import {
  CODEX_DEVICE_LOGIN_CMD,
  CODEX_DEVICE_URL,
  chainHasCodex,
  chainHasOpenCodeXai,
  createOrdinalDeviceLoginServer,
  DeviceLoginManager,
  isXaiOAuthPresent,
  OPENCODE_DEVICE_LOGIN_CMD,
  ORDINAL_DEVICE_LOGIN_PORT,
  parseDeviceLoginOutput,
  SUPERGROK_SUBSCRIPTION_METHOD,
} from "../src/device_login.ts";

describe("device login parsing", () => {
  test("parses Go to plus Enter code", () => {
    const parsed = parseDeviceLoginOutput("Go to: https://auth.x.ai/activate\nEnter code: ABCD-1234\n");
    expect(parsed.url).toBe("https://auth.x.ai/activate");
    expect(parsed.userCode).toBe("ABCD-1234");
  });

  test("parses xAI Open instruction", () => {
    const parsed = parseDeviceLoginOutput("Open https://auth.x.ai/activate on any device and enter code: XY-99\n");
    expect(parsed.url).toBe("https://auth.x.ai/activate");
    expect(parsed.userCode).toBe("XY-99");
  });

  test("parses Codex device output with a 4-4 code", () => {
    const parsed = parseDeviceLoginOutput(
      "Open this link in your browser and sign in to your account https://auth.openai.com/codex/device\nEnter this one-time code (expires in 15 minutes) ABCD-EFGH\n"
    );
    expect(parsed.url).toBe(CODEX_DEVICE_URL);
    expect(parsed.userCode).toBe("ABCD-EFGH");
  });

  test("parses Codex device output with a 4-5 code", () => {
    const parsed = parseDeviceLoginOutput(
      "Open this link in your browser and sign in to your account https://auth.openai.com/codex/device\nEnter this one-time code (expires in 15 minutes) XXXX-XXXXX\n"
    );
    expect(parsed.url).toBe("https://auth.openai.com/codex/device");
    expect(parsed.userCode).toBe("XXXX-XXXXX");
  });

  test("fixed invocation uses SuperGrok method without browser callback", () => {
    expect(ORDINAL_DEVICE_LOGIN_PORT).toBe(3010);
    expect(SUPERGROK_SUBSCRIPTION_METHOD).toBe("SuperGrok Subscription");
    expect([...OPENCODE_DEVICE_LOGIN_CMD]).toEqual([
      "opencode",
      "auth",
      "login",
      "--provider",
      "xai",
      "--method",
      "SuperGrok Subscription",
    ]);
    expect(OPENCODE_DEVICE_LOGIN_CMD.join(" ")).not.toContain("localhost");
    expect(OPENCODE_DEVICE_LOGIN_CMD.join(" ")).not.toContain("api-key");
  });

  test("fixed Codex invocation is the headless device flow without stdin methods", () => {
    expect([...CODEX_DEVICE_LOGIN_CMD]).toEqual(["codex", "login", "--device-auth"]);
    expect(CODEX_DEVICE_LOGIN_CMD.join(" ")).not.toContain("localhost");
    expect(CODEX_DEVICE_LOGIN_CMD.join(" ")).not.toContain("api-key");
    expect(CODEX_DEVICE_LOGIN_CMD.join(" ")).not.toContain("access-token");
    expect(CODEX_DEVICE_URL).toBe("https://auth.openai.com/codex/device");
  });

  test("chain gate needs an OpenCode xAI runner", () => {
    expect(chainHasOpenCodeXai({ runners: { a: { type: "opencode", model: "xai/grok-4.6" } }, chain: ["a"] })).toBe(
      true
    );
    expect(chainHasOpenCodeXai({ runners: { a: { type: "opencode", model: "openai/gpt-5.5" } }, chain: ["a"] })).toBe(
      false
    );
    expect(chainHasOpenCodeXai({ runners: { a: { type: "claude", model: "xai/grok-4.6" } }, chain: ["a"] })).toBe(
      false
    );
  });

  test("chain gate needs a codex runner for the Codex control", () => {
    expect(chainHasCodex({ runners: { c: { type: "codex", model: "gpt-5.5", effort: "high" } }, chain: ["c"] })).toBe(
      true
    );
    expect(chainHasCodex({ runners: { a: { type: "opencode", model: "xai/grok-4.6" } }, chain: ["a"] })).toBe(false);
    expect(chainHasCodex({ runners: { a: { type: "opencode", model: "openai/gpt-5.5" } }, chain: ["a"] })).toBe(false);
  });

  test("both providers can coexist on one ordinal", () => {
    expect(
      chainHasOpenCodeXai({
        runners: {
          g: { type: "opencode", model: "xai/grok-4.6" },
          c: { type: "codex", model: "gpt-5.5", effort: "high" },
        },
        chain: ["g", "c"],
      })
    ).toBe(true);
    expect(
      chainHasCodex({
        runners: {
          g: { type: "opencode", model: "xai/grok-4.6" },
          c: { type: "codex", model: "gpt-5.5", effort: "high" },
        },
        chain: ["g", "c"],
      })
    ).toBe(true);
  });
});

describe("device login status", () => {
  test("presence is oauth object only, no provider call", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-device-home-"));
    try {
      expect(await isXaiOAuthPresent(home)).toBe(false);
      const dir = join(home, ".local", "share", "opencode");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "auth.json"),
        JSON.stringify({ xai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600_000 } })
      );
      expect(await isXaiOAuthPresent(home)).toBe(true);
      await writeFile(join(dir, "auth.json"), JSON.stringify({ xai: { type: "api", key: "k" } }));
      expect(await isXaiOAuthPresent(home)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("codex credential presence", () => {
  test("tokens count, api key alone does not", () => {
    expect(hasCodexChatGptCredential({ tokens: { access_token: "a", refresh_token: "r", id_token: "i" } })).toBe(true);
    expect(hasCodexChatGptCredential({ OPENAI_API_KEY: "sk-x" })).toBe(false);
    expect(hasCodexChatGptCredential({})).toBe(false);
    expect(hasCodexChatGptCredential(undefined)).toBe(false);
  });

  test("reads $HOME/.codex/auth.json without calling the provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "jumi-codex-home-"));
    try {
      expect(await isCodexChatGptPresent(home)).toBe(false);
      const dir = join(home, ".codex");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
      expect(await isCodexChatGptPresent(home)).toBe(false);
      await writeFile(
        join(dir, "auth.json"),
        JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", id_token: "i" } })
      );
      expect(await isCodexChatGptPresent(home)).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function deferredSpawn(script: Array<"url" | "exit">, code: number | null = 0) {
  const calls: string[][] = [];
  const kills: string[] = [];
  let handlers: { onStdout: (c: string) => void; onExit: (c: number | null, s: string | null) => void } | undefined;
  const spawnLogin = (opts: {
    cmd: readonly string[];
    home: string;
    onStdout: (c: string) => void;
    onStderr: (c: string) => void;
    onExit: (c: number | null, s: string | null) => void;
  }) => {
    calls.push([...opts.cmd]);
    handlers = { onStdout: opts.onStdout, onExit: opts.onExit };
    for (const step of script) {
      if (step === "url") {
        queueMicrotask(() => handlers?.onStdout("Go to: https://auth.x.ai/activate\nEnter code: CODE-1\n"));
      }
    }
    if (code !== null || script.includes("exit")) {
      queueMicrotask(() => handlers?.onExit(code, null));
    }
    return { kill: (_signal?: NodeJS.Signals) => void kills.push("killed") };
  };
  return { calls, kills, spawnLogin };
}

describe("device login manager", () => {
  test("second start while waiting returns same code without a second flow", async () => {
    let spawns = 0;
    const manager = new DeviceLoginManager({
      ordinal: "worker-0",
      role: "worker",
      home: "/data",
      hasXaiRunner: true,
      isLeased: () => false,
      spawnLogin: (opts) => {
        spawns += 1;
        queueMicrotask(() => opts.onStdout("Go to: https://auth.x.ai/activate\nEnter code: SAME-1\n"));
        return { kill: () => {} };
      },
      now: () => 1_000,
    });
    const first = await manager.start("operator");
    expect(first.state).toBe("waiting");
    expect(first.userCode).toBe("SAME-1");
    const second = await manager.start("operator");
    expect(second.state).toBe("waiting");
    expect(second.userCode).toBe("SAME-1");
    expect(spawns).toBe(1);
    manager.cancel();
  });

  test("leased ordinal refuses without spawning", async () => {
    let spawns = 0;
    const manager = new DeviceLoginManager({
      ordinal: "engine-0",
      role: "engine",
      home: "/data",
      hasXaiRunner: true,
      isLeased: () => true,
      spawnLogin: () => {
        spawns += 1;
        return { kill: () => {} };
      },
    });
    const outcome = await manager.start("operator");
    expect(outcome.refused).toBe(true);
    expect(outcome.reason).toBe("leased");
    expect(spawns).toBe(0);
  });

  test("ordinal without xAI runner refuses", async () => {
    const manager = new DeviceLoginManager({
      ordinal: "worker-1",
      role: "worker",
      home: "/data",
      hasXaiRunner: false,
      isLeased: () => false,
      spawnLogin: () => {
        throw new Error("must not spawn");
      },
    });
    const outcome = await manager.start("operator");
    expect(outcome.refused).toBe(true);
    expect(outcome.reason).toBe("no-xai-runner");
  });

  test("success records without logging code or url", async () => {
    const logs: string[] = [];
    const records: Array<{ actor: string; ordinal: string; provider: string; result: string }> = [];
    const manager = new DeviceLoginManager({
      ordinal: "worker-0",
      role: "worker",
      home: "/data",
      hasXaiRunner: true,
      isLeased: () => false,
      logger: (m) => void logs.push(m),
      onResult: (e) => void records.push({ ...e }),
      spawnLogin: (opts) => {
        queueMicrotask(() => opts.onStdout("Go to: https://auth.x.ai/activate\nEnter code: SECRET-1\n"));
        queueMicrotask(() => opts.onExit(0, null));
        return { kill: () => {} };
      },
    });
    const started = await manager.start("alice");
    expect(started.state).toBe("waiting");
    await Bun.sleep(10);
    expect(manager.getState().state).toBe("signed-in");
    expect(records.map((r) => r.result)).toEqual(["started", "succeeded"]);
    expect(records[0]).toMatchObject({ actor: "alice", ordinal: "worker-0", provider: "xai" });
    const dumped = JSON.stringify({ logs, records });
    expect(dumped).not.toContain("SECRET-1");
    expect(dumped).not.toContain("https://auth.x.ai/activate");
  });

  test("denied and expired map from CLI tail without logging it", async () => {
    for (const [tail, state, result] of [
      ["xAI device authorization was denied", "denied", "denied"],
      ["xAI device code expired - please re-run login", "expired", "expired"],
    ] as const) {
      const logs: string[] = [];
      const records: string[] = [];
      const manager = new DeviceLoginManager({
        ordinal: "o",
        role: "engine",
        home: "/data",
        hasXaiRunner: true,
        isLeased: () => false,
        logger: (m) => void logs.push(m),
        onResult: (e) => void records.push(e.result),
        spawnLogin: (opts) => {
          queueMicrotask(() => opts.onStdout("Go to: https://auth.x.ai/activate\nEnter code: C-1\n"));
          queueMicrotask(() => {
            opts.onStderr(`${tail}\n`);
            opts.onExit(1, null);
          });
          return { kill: () => {} };
        },
      });
      await manager.start("op");
      await Bun.sleep(10);
      expect(manager.getState().state).toBe(state);
      expect(records).toContain(result);
      expect(logs.join("\n")).not.toContain("C-1");
    }
  });

  test("cancel kills only the login process and records once", async () => {
    const kills: string[] = [];
    const records: string[] = [];
    const manager = new DeviceLoginManager({
      ordinal: "worker-0",
      role: "worker",
      home: "/data",
      hasXaiRunner: true,
      isLeased: () => false,
      spawnLogin: (opts) => {
        queueMicrotask(() => opts.onStdout("Go to: https://auth.x.ai/activate\nEnter code: CANCEL-1\n"));
        return {
          kill: (_signal?: NodeJS.Signals) => {
            kills.push("killed");
          },
        };
      },
      onResult: (e) => void records.push(e.result),
    });
    const started = await manager.start("op");
    expect(started.state).toBe("waiting");
    manager.cancel();
    await Bun.sleep(5);
    expect(kills).toHaveLength(1);
    expect(manager.getState().state).toBe("cancelled");
    expect(records.filter((r) => r === "cancelled")).toHaveLength(1);
  });

  test("ephemeral HOME refuses without spawning", async () => {
    let spawns = 0;
    const manager = new DeviceLoginManager({
      ordinal: "worker-0",
      role: "worker",
      home: "/work/.jumi-tmp/x",
      hasXaiRunner: true,
      isLeased: () => false,
      spawnLogin: () => {
        spawns += 1;
        return { kill: () => {} };
      },
    });
    const outcome = await manager.start("op");
    expect(outcome.refused).toBe(true);
    expect(spawns).toBe(0);
  });

  test("codex start runs the fixed device invocation and records provider codex", async () => {
    const calls: string[][] = [];
    const records: Array<{ actor: string; ordinal: string; provider: string; result: string }> = [];
    const manager = new DeviceLoginManager({
      ordinal: "worker-0",
      role: "worker",
      home: "/data",
      hasXaiRunner: false,
      hasCodexRunner: true,
      isLeased: () => false,
      onResult: (e) => void records.push({ ...e }),
      spawnLogin: (opts) => {
        calls.push([...opts.cmd]);
        expect(opts.home).toBe("/data");
        queueMicrotask(() =>
          opts.onStdout(
            "Open this link in your browser and sign in to your account https://auth.openai.com/codex/device\nEnter this one-time code (expires in 15 minutes) ABCD-EFGHI\n"
          )
        );
        return { kill: () => {} };
      },
      now: () => 1_000,
    });
    const started = await manager.start("alice", "codex");
    expect(started.refused).toBe(false);
    expect(started.state).toBe("waiting");
    expect(started.provider).toBe("codex");
    expect(started.userCode).toBe("ABCD-EFGHI");
    expect(calls).toEqual([["codex", "login", "--device-auth"]]);
    expect(records[0]).toMatchObject({ actor: "alice", ordinal: "worker-0", provider: "codex", result: "started" });
    const status = await manager.getStatus();
    expect(status.provider).toBe("codex");
    expect(status.hasCodexRunner).toBe(true);
    manager.cancel();
  });

  test("second start for the other provider during the wait shares the flow", async () => {
    let spawns = 0;
    const manager = new DeviceLoginManager({
      ordinal: "worker-0",
      role: "worker",
      home: "/data",
      hasXaiRunner: true,
      hasCodexRunner: true,
      isLeased: () => false,
      spawnLogin: (opts) => {
        spawns += 1;
        queueMicrotask(() => opts.onStdout("Go to: https://auth.x.ai/activate\nEnter code: SAME-1\n"));
        return { kill: () => {} };
      },
      now: () => 1_000,
    });
    const first = await manager.start("operator", "xai");
    expect(first.state).toBe("waiting");
    const second = await manager.start("operator", "codex");
    expect(second.state).toBe("waiting");
    expect(second.userCode).toBe("SAME-1");
    expect(spawns).toBe(1);
    manager.cancel();
  });

  test("ordinal without codex runner refuses codex but keeps grok", async () => {
    const manager = new DeviceLoginManager({
      ordinal: "worker-1",
      role: "worker",
      home: "/data",
      hasXaiRunner: true,
      hasCodexRunner: false,
      isLeased: () => false,
      spawnLogin: () => {
        throw new Error("must not spawn");
      },
    });
    const refused = await manager.start("op", "codex");
    expect(refused.refused).toBe(true);
    expect(refused.reason).toBe("no-codex-runner");
  });

  test("leased ordinal refuses codex without spawning", async () => {
    let spawns = 0;
    const manager = new DeviceLoginManager({
      ordinal: "engine-0",
      role: "engine",
      home: "/data",
      hasXaiRunner: false,
      hasCodexRunner: true,
      isLeased: () => true,
      spawnLogin: () => {
        spawns += 1;
        return { kill: () => {} };
      },
    });
    const outcome = await manager.start("operator", "codex");
    expect(outcome.refused).toBe(true);
    expect(outcome.reason).toBe("leased");
    expect(spawns).toBe(0);
  });
});

describe("ordinal listener", () => {
  test("actor comes from edge headers, never the body, with origin check", async () => {
    const { server } = createOrdinalDeviceLoginServer({
      ordinal: "test-ordinal",
      role: "worker",
      home: "/data",
      hasXaiRunner: false,
      isLeased: () => false,
      logger: () => {},
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const noIdentity = await fetch(`${base}/api/device-login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ordinal: "x", actor: "mallory" }),
      });
      expect(noIdentity.status).toBe(401);
      const foreign = await fetch(`${base}/api/device-login/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-User": "operator",
          Origin: "https://evil.example",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "board.example",
        },
        body: JSON.stringify({}),
      });
      expect(foreign.status).toBe(403);
      const badType = await fetch(`${base}/api/device-login/start`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Forwarded-User": "operator" },
        body: "{}",
      });
      expect(badType.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("ordinal start honors provider: codex refused without a codex runner, invalid rejected", async () => {
    const { server } = createOrdinalDeviceLoginServer({
      ordinal: "test-ordinal",
      role: "worker",
      home: "/data",
      hasXaiRunner: true,
      hasCodexRunner: false,
      isLeased: () => false,
      logger: () => {},
      // Test seam: this sandbox already holds the constant 3010, so bind a
      // free port. Production engine/worker callers never set it.
      port: 31011,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { "Content-Type": "application/json", "X-Forwarded-User": "operator" };
      const codex = await fetch(`${base}/api/device-login/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ provider: "codex" }),
      });
      expect(codex.status).toBe(422);
      const codexBody = (await codex.json()) as Record<string, unknown>;
      expect(codexBody.code).toBe("no-codex-runner");
      const invalid = await fetch(`${base}/api/device-login/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ provider: "claude" }),
      });
      expect(invalid.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });
});
