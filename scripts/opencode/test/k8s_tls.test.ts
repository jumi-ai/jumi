import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishTokenOnlyAuth } from "../src/codex_control.ts";
import { loadControlConfig } from "../src/control_config.ts";
import { k8sCreateJob } from "../src/dispatch.ts";
import { defaultK8sCaFile, readK8sCa, resetK8sCaCacheForTests, withK8sCa } from "../src/k8s_ca.ts";

function openssl(args: string[], cwd: string): void {
  execFileSync("openssl", args, { cwd, stdio: "pipe" });
}

async function makeThrowawayCa(): Promise<{
  dir: string;
  ca: string;
  cert: string;
  key: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-k8s-ca-"));
  openssl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      "ca.key",
      "-out",
      "ca.crt",
      "-days",
      "2",
      "-nodes",
      "-subj",
      "/CN=jumi-test-ca",
    ],
    dir
  );
  openssl(
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=127.0.0.1"],
    dir
  );
  await writeFile(join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n", "utf8");
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "srv.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "srv.crt",
      "-days",
      "2",
      "-extfile",
      "ext.cnf",
    ],
    dir
  );
  const [ca, cert, key] = await Promise.all([
    readFile(join(dir, "ca.crt"), "utf8"),
    readFile(join(dir, "srv.crt"), "utf8"),
    readFile(join(dir, "srv.key"), "utf8"),
  ]);
  return { dir, ca, cert, key };
}

function tokenOnlyDoc(): Record<string, unknown> {
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: "aaa.bbb.ccc",
      access_token: "ddd.eee.fff",
      refresh_token: "",
      account_id: "acc-1",
    },
    last_refresh: new Date().toISOString(),
  };
}

describe("k8s cluster CA", () => {
  test("ca file defaults next to the token file", () => {
    expect(defaultK8sCaFile("/var/run/secrets/kubernetes.io/serviceaccount/token")).toBe(
      "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    );
    expect(defaultK8sCaFile("/custom/token")).toBe("/custom/ca.crt");
  });

  test("CONTROL_K8S_CA_FILE overrides the default", () => {
    const def = loadControlConfig({ JUMI_ROLE: "control" } as Record<string, string>);
    expect(def.k8sCaFile).toBe("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
    const custom = loadControlConfig({
      JUMI_ROLE: "control",
      CONTROL_K8S_TOKEN_FILE: "/custom/token",
    } as Record<string, string>);
    expect(custom.k8sCaFile).toBe("/custom/ca.crt");
    const explicit = loadControlConfig({
      JUMI_ROLE: "control",
      CONTROL_K8S_CA_FILE: "/explicit/ca.pem",
    } as Record<string, string>);
    expect(explicit.k8sCaFile).toBe("/explicit/ca.pem");
  });

  test("readK8sCa reads once (cached)", async () => {
    resetK8sCaCacheForTests();
    const dir = await mkdtemp(join(tmpdir(), "jumi-k8s-ca-cache-"));
    try {
      const file = join(dir, "ca.crt");
      await writeFile(file, "cached-ca\n", "utf8");
      const first = await readK8sCa(file);
      await writeFile(file, "changed-ca\n", "utf8");
      const second = await readK8sCa(file);
      expect(first).toBe("cached-ca");
      expect(second).toBe("cached-ca");
      resetK8sCaCacheForTests();
      expect(await readK8sCa(file)).toBe("changed-ca");
      expect(await readK8sCa(join(dir, "missing.crt"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
      resetK8sCaCacheForTests();
    }
  });

  test("publish and Job create trust the cluster CA and fail without it", async () => {
    const { dir, ca, cert, key } = await makeThrowawayCa();
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { cert, key },
        fetch: async (req) => {
          const url = new URL(req.url);
          const auth = req.headers.get("authorization") ?? "";
          if (auth !== "Bearer sa-token") {
            return new Response("unauthorized", { status: 401 });
          }
          if (url.pathname === "/api/v1/namespaces/default/secrets/codex-token" && req.method === "GET") {
            return new Response("not found", { status: 404 });
          }
          if (url.pathname === "/api/v1/namespaces/default/secrets" && req.method === "POST") {
            return new Response(JSON.stringify({ metadata: { name: "codex-token" } }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.pathname === "/apis/batch/v1/namespaces/default/jobs" && req.method === "POST") {
            const manifest = (await req.json()) as { metadata?: { name?: string } };
            return new Response(JSON.stringify({ metadata: { name: manifest.metadata?.name ?? "job" } }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      });
      try {
        const baseUrl = `https://127.0.0.1:${server.port}`;
        const trusted = withK8sCa(fetch, ca);

        await publishTokenOnlyAuth(tokenOnlyDoc(), {
          apiUrl: baseUrl,
          namespace: "default",
          secretName: "codex-token",
          token: "sa-token",
          fetchImpl: trusted,
        });

        await k8sCreateJob({
          apiUrl: baseUrl,
          namespace: "default",
          token: "sa-token",
          manifest: { metadata: { name: "jumi-worker-1-g0-a0" } },
          fetchImpl: trusted,
        });

        await expect(
          publishTokenOnlyAuth(tokenOnlyDoc(), {
            apiUrl: baseUrl,
            namespace: "default",
            secretName: "codex-token",
            token: "sa-token",
          })
        ).rejects.toThrow();

        await expect(
          k8sCreateJob({
            apiUrl: baseUrl,
            namespace: "default",
            token: "sa-token",
            manifest: { metadata: { name: "jumi-worker-2-g0-a0" } },
          })
        ).rejects.toThrow();
      } finally {
        server.stop(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
