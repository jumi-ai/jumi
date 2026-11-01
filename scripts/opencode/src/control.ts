import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import {
  buildTokenOnlyAuth,
  type CodexAuthFile,
  CodexLoginDeadError,
  codexAccessRemainingMs,
  codexRefreshTokenUrl,
  codexTokenLifetimeMs,
  durableCodexAuthPath,
  getCodexControlSnapshot,
  isPublishableCodexAuth,
  postCodexRefresh,
  publishTokenOnlyAuth,
  readCodexAuthFile,
  renderCodexControlMetrics,
  resetCodexControlMetricsForTests,
  setCodexControlSnapshot,
  shouldRefreshCodex,
  writeCodexAuthDurably,
} from "./codex_control.ts";
import { scrubSecretEnv } from "./config.ts";
import { type ControlConfig, loadControlConfig } from "./control_config.ts";
import { createOrdinalDeviceLoginServer, deviceLoginResultLogger, ORDINAL_DEVICE_LOGIN_PORT } from "./device_login.ts";
import { installProcessShutdown } from "./shutdown.ts";

function log(message: string) {
  console.log(`[control] ${message}`);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export interface ControlRuntimeState {
  loginDead: boolean;
  loginDeadReason?: string;
  deadRefreshHash?: string;
}

export function newControlRuntimeState(): ControlRuntimeState {
  return { loginDead: false };
}

function refreshHash(refresh: string): string {
  return createHash("sha256").update(refresh).digest("hex");
}

function readTokensRefresh(auth: CodexAuthFile): string | undefined {
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return undefined;
  const refresh = (tokens as Record<string, unknown>).refresh_token;
  return typeof refresh === "string" && refresh ? refresh : undefined;
}

export interface ControlTickDeps {
  home: string;
  now?: () => number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  tokenUrl?: string;
  k8sApiUrl?: string;
  k8sNamespace?: string;
  k8sSecretName?: string;
  k8sToken?: string;
  /** Projected service-account token file; re-read per tick so rotation is picked up. */
  k8sTokenFile?: string;
  k8sFetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  publish?: boolean;
  logger?: (message: string) => void;
}

export interface ControlTickResult {
  refreshed: boolean;
  published: boolean;
  loginDead: boolean;
  loginDeadReason?: string;
}

async function readK8sToken(tokenFile: string): Promise<string> {
  try {
    return (await readFile(tokenFile, "utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * Projected service-account tokens rotate (default ~1h): re-read the file on
 * every tick/publish instead of closing over the startup value, or the Secret
 * publish 401/403s until the pod restarts. Falls back to the explicit dep
 * token (tests, local/dev without a token file).
 */
async function resolveK8sToken(deps: Pick<ControlTickDeps, "k8sToken" | "k8sTokenFile">): Promise<string> {
  if (deps.k8sTokenFile) {
    const fresh = await readK8sToken(deps.k8sTokenFile);
    if (fresh) return fresh;
  }
  return deps.k8sToken ?? "";
}

function isK8sAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("(401)") || message.includes("(403)");
}

/**
 * One control tick: refresh when the remaining access-token life drops below
 * the lifetime fraction, write the rotated pair durably, then publish the
 * token-only Secret. Login death stops refresh retries; a new device login
 * (different refresh token) clears it.
 */
export async function runControlTick(state: ControlRuntimeState, deps: ControlTickDeps): Promise<ControlTickResult> {
  const logger = deps.logger ?? (() => {});
  const now = deps.now?.() ?? Date.now();
  const path = await durableCodexAuthPath(deps.home);
  const auth = await readCodexAuthFile(path);
  const remainingMs = codexAccessRemainingMs(auth, now);
  const lifetimeMs = codexTokenLifetimeMs(auth);
  setCodexControlSnapshot({
    remainingSeconds: remainingMs == null ? undefined : Math.floor(remainingMs / 1000),
    lifetimeSeconds: lifetimeMs == null ? undefined : Math.floor(lifetimeMs / 1000),
  });

  const currentRefresh = readTokensRefresh(auth);
  if (state.loginDead) {
    // A new device login writes a different refresh token: clear the death.
    if (currentRefresh && state.deadRefreshHash && refreshHash(currentRefresh) !== state.deadRefreshHash) {
      state.loginDead = false;
      state.loginDeadReason = undefined;
      state.deadRefreshHash = undefined;
      setCodexControlSnapshot({ loginDead: false, loginDeadReason: undefined });
      logger("control: new Codex login detected; clearing login death");
    } else {
      setCodexControlSnapshot({ loginDead: true, loginDeadReason: state.loginDeadReason });
      return { refreshed: false, published: false, loginDead: true, loginDeadReason: state.loginDeadReason };
    }
  }

  if (!currentRefresh) {
    // No grant to refresh (missing or token-only file): never POST.
    return { refreshed: false, published: false, loginDead: false };
  }

  if (!shouldRefreshCodex(auth, now)) {
    return { refreshed: false, published: false, loginDead: false };
  }

  let refreshed: { accessToken: string; refreshToken?: string; idToken?: string };
  try {
    refreshed = await postCodexRefresh(currentRefresh, { fetchImpl: deps.fetchImpl, tokenUrl: deps.tokenUrl });
  } catch (err) {
    if (err instanceof CodexLoginDeadError) {
      state.loginDead = true;
      state.loginDeadReason = err.reason;
      state.deadRefreshHash = refreshHash(currentRefresh);
      setCodexControlSnapshot({ loginDead: true, loginDeadReason: err.reason });
      logger(`control: Codex login dead (${err.reason}); run Codex sign-in on control to restore`);
      return { refreshed: false, published: false, loginDead: true, loginDeadReason: err.reason };
    }
    throw err;
  }

  const tokens = auth.tokens as Record<string, unknown>;
  const next: CodexAuthFile = {
    ...auth,
    tokens: {
      ...(tokens ?? {}),
      access_token: refreshed.accessToken,
      ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
      ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
    },
    last_refresh: new Date(now).toISOString(),
  };
  await writeCodexAuthDurably(path, next);
  const lastRefreshSec = Math.floor(now / 1000);
  setCodexControlSnapshot({ lastRefreshTimestampSeconds: lastRefreshSec });
  logger(`control: refreshed the Codex access token on ${path} before publishing`);

  if (deps.publish === false) {
    return { refreshed: true, published: false, loginDead: false };
  }

  const k8sToken = await resolveK8sToken(deps);
  if (!deps.k8sApiUrl || !deps.k8sNamespace || !deps.k8sSecretName || !k8sToken) {
    logger("control: K8s publish skipped (no API, namespace, name, or token)");
    return { refreshed: true, published: false, loginDead: false };
  }

  const tokenOnly = buildTokenOnlyAuth(next, new Date(now).toISOString());
  if (!isPublishableCodexAuth(tokenOnly)) {
    throw new Error("control: refusing to publish a Codex document that fails the token-only shape");
  }
  const publishWith = async (token: string): Promise<void> => {
    await publishTokenOnlyAuth(tokenOnly, {
      apiUrl: deps.k8sApiUrl as string,
      namespace: deps.k8sNamespace as string,
      secretName: deps.k8sSecretName as string,
      token,
      fetchImpl: deps.k8sFetchImpl ?? deps.fetchImpl,
    });
  };
  try {
    await publishWith(k8sToken);
  } catch (err) {
    // The token file may have rotated between the tick's read and the Secret
    // write: re-read once and retry before counting a publish failure.
    if (deps.k8sTokenFile && isK8sAuthFailure(err)) {
      const retried = await resolveK8sToken(deps);
      if (retried && retried !== k8sToken) {
        try {
          await publishWith(retried);
          setCodexControlSnapshot({
            lastPublishTimestampSeconds: Math.floor((deps.now?.() ?? Date.now()) / 1000),
          });
          return { refreshed: true, published: true, loginDead: false };
        } catch (retryErr) {
          const snap = getCodexControlSnapshot();
          setCodexControlSnapshot({ publishFailures: snap.publishFailures + 1 });
          throw retryErr;
        }
      }
    }
    const snap = getCodexControlSnapshot();
    setCodexControlSnapshot({ publishFailures: snap.publishFailures + 1 });
    throw err;
  }
  setCodexControlSnapshot({ lastPublishTimestampSeconds: Math.floor((deps.now?.() ?? Date.now()) / 1000) });
  return { refreshed: true, published: true, loginDead: false };
}

/** Publish the current token-only Secret without refreshing (startup). */
export async function publishCurrentToken(deps: ControlTickDeps): Promise<boolean> {
  const logger = deps.logger ?? (() => {});
  const path = await durableCodexAuthPath(deps.home);
  const auth = await readCodexAuthFile(path);
  const tokens = auth.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens.access_token !== "string") {
    logger("control: no Codex access token to publish at startup");
    return false;
  }
  const k8sToken = await resolveK8sToken(deps);
  if (!deps.k8sApiUrl || !deps.k8sNamespace || !deps.k8sSecretName || !k8sToken) {
    logger("control: K8s publish skipped at startup (no API, namespace, name, or token)");
    return false;
  }
  const tokenOnly = buildTokenOnlyAuth(auth);
  if (!isPublishableCodexAuth(tokenOnly)) {
    logger("control: refusing to publish a Codex document that fails the token-only shape");
    return false;
  }
  const publishWith = async (token: string): Promise<void> => {
    await publishTokenOnlyAuth(tokenOnly, {
      apiUrl: deps.k8sApiUrl as string,
      namespace: deps.k8sNamespace as string,
      secretName: deps.k8sSecretName as string,
      token,
      fetchImpl: deps.k8sFetchImpl ?? deps.fetchImpl,
    });
  };
  try {
    await publishWith(k8sToken);
  } catch (err) {
    if (deps.k8sTokenFile && isK8sAuthFailure(err)) {
      const retried = await resolveK8sToken(deps);
      if (retried && retried !== k8sToken) {
        try {
          await publishWith(retried);
          setCodexControlSnapshot({ lastPublishTimestampSeconds: Math.floor((deps.now?.() ?? Date.now()) / 1000) });
          return true;
        } catch (retryErr) {
          const snap = getCodexControlSnapshot();
          setCodexControlSnapshot({ publishFailures: snap.publishFailures + 1 });
          throw retryErr;
        }
      }
    }
    const snap = getCodexControlSnapshot();
    setCodexControlSnapshot({ publishFailures: snap.publishFailures + 1 });
    throw err;
  }
  setCodexControlSnapshot({ lastPublishTimestampSeconds: Math.floor((deps.now?.() ?? Date.now()) / 1000) });
  return true;
}

export function createControlFetchHandler(opts: {
  logger?: (message: string) => void;
  getStatus?: () => Promise<Record<string, unknown>>;
}): (request: Request) => Promise<Response> {
  const logger = opts.logger ?? log;
  void logger;
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (url.pathname === "/metrics") {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" });
      return new Response(renderCodexControlMetrics(), {
        status: 200,
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/control/status") {
      if (request.method !== "GET") return json(405, { error: "method not allowed" });
      const snap = getCodexControlSnapshot();
      const extra = opts.getStatus ? await opts.getStatus().catch(() => ({})) : {};
      return json(200, { ok: true, role: "control", ...snap, ...extra });
    }
    return json(404, { error: "not found" });
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true }
    );
  });
}

export async function startControl(
  config: ControlConfig = loadControlConfig(),
  deps: {
    logger?: (message: string) => void;
    signal?: AbortSignal;
    listen?: boolean;
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    tokenUrl?: string;
    now?: () => number;
  } = {}
): Promise<{ stop: () => void }> {
  const logger = deps.logger ?? log;
  const state = newControlRuntimeState();
  resetCodexControlMetricsForTests();

  const startupToken = await readK8sToken(config.k8sTokenFile);
  if (!startupToken) {
    logger("control: no K8s service account token; Secret publish will be skipped until the volume mounts");
  }
  const tickDeps = (): ControlTickDeps => ({
    home: config.home,
    now: deps.now,
    fetchImpl: deps.fetchImpl,
    tokenUrl: deps.tokenUrl ?? codexRefreshTokenUrl(),
    k8sApiUrl: config.k8sApiUrl,
    k8sNamespace: config.secretNamespace,
    k8sSecretName: config.secretName,
    // Re-read per tick via k8sTokenFile (projected tokens rotate); the
    // startup read above is only for this log line, never for publishing.
    k8sTokenFile: config.k8sTokenFile,
    k8sFetchImpl: deps.fetchImpl,
    logger,
  });

  // Publish at startup: job pods mount the Secret, so a fresh control must
  // publish even before the first refresh threshold is reached.
  try {
    await publishCurrentToken(tickDeps());
    logger("control: published the token-only Codex Secret at startup");
  } catch (err) {
    // A failed publish is retried on the loop; startup still continues.
    logger(`control: startup publish failed (will retry): ${err instanceof Error ? err.message : String(err)}`);
  }

  let server: ReturnType<typeof Bun.serve> | undefined;
  let deviceLoginServer: ReturnType<typeof Bun.serve> | undefined;
  if (deps.listen !== false) {
    server = Bun.serve({
      hostname: config.host,
      port: config.port,
      fetch: createControlFetchHandler({ logger }),
    });
    logger(`listening on ${server.hostname}:${server.port} role=control`);
    try {
      const ordinal = hostname();
      const created = createOrdinalDeviceLoginServer({
        ordinal,
        role: "control",
        home: config.home,
        // Control owns the Codex login unconditionally: it is the only
        // process that holds the refresh token, independent of any runner
        // chain on engine/worker ordinals.
        hasXaiRunner: false,
        hasCodexRunner: true,
        isLeased: () => false,
        isLoginDead: () => (state.loginDead ? { dead: true, reason: state.loginDeadReason } : { dead: false }),
        logger,
        onResult: deviceLoginResultLogger(logger),
      });
      deviceLoginServer = created.server;
      logger(
        `device login listening on ${deviceLoginServer.hostname}:${ORDINAL_DEVICE_LOGIN_PORT} role=control ordinal=${ordinal}`
      );
    } catch (err) {
      logger(`device login unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const shutdown = new AbortController();
  const onAbort = () => {
    if (!shutdown.signal.aborted) shutdown.abort();
  };
  deps.signal?.addEventListener("abort", onAbort, { once: true });

  const run = async () => {
    while (!shutdown.signal.aborted && !deps.signal?.aborted) {
      try {
        await runControlTick(state, tickDeps());
      } catch (err) {
        if (shutdown.signal.aborted || deps.signal?.aborted) return;
        // Login death is already recorded; transport/refresh/publish errors
        // retry on the next poll. Never log tokens.
        logger(`control tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(config.pollMs, shutdown.signal).catch(() => undefined);
      if (deps.signal?.aborted) return;
    }
  };
  void run();

  return {
    stop: () => {
      onAbort();
      try {
        deviceLoginServer?.stop(true);
      } catch {
        // Best-effort.
      }
      try {
        server?.stop(true);
      } catch {
        // Best-effort.
      }
      deps.signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function main() {
  const config = loadControlConfig();
  scrubSecretEnv();
  const shutdown = new AbortController();
  installProcessShutdown(shutdown, log);
  await startControl(config, { signal: shutdown.signal });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[control] Fatal error:", err);
    process.exit(1);
  });
}
