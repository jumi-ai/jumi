import { spawn } from "node:child_process";
import { OPENCODE_RUNNER_TYPE, type RunnerConfig } from "./runners.ts";
import { durableAuthPath, isXaiModel, readAuthFile, readXaiCredential } from "./xai_auth.ts";

/**
 * Grok device login for one engine or worker ordinal.
 *
 * The login process runs inside the ordinal that owns the auth file, as the
 * container uid, with the same HOME the review and implement child already
 * use. The router is diskless and must not run the login. A write that lands
 * on the ephemeral cache tree is a failure, so HOME must be the durable
 * auth root (config.home, `/data` in the image), never a workspace temp dir.
 *
 * Headless xAI device-code method only: a verification URL plus a user code
 * the operator types into the provider page. The fixed invocation selects
 * the SuperGrok Subscription method without a TUI picker. The API-key method
 * and the localhost browser callback are never used: the pod has no browser
 * and the operator browser cannot reach pod localhost.
 *
 * One in-flight login per ordinal. A second start while waiting returns the
 * same code and does not start another flow. Two device flows writing the
 * same auth file is a failure.
 *
 * The code lives in memory on the ordinal. The board polls it. The code is
 * never persisted. The code, a URL containing the code, and the CLI stdout
 * or stderr after the URL and code have been parsed are never logged:
 * success output can contain credential material.
 */

export const ORDINAL_DEVICE_LOGIN_PORT = 3010;
export const XAI_PROVIDER = "xai";
export const SUPERGROK_SUBSCRIPTION_METHOD = "SuperGrok Subscription";
export const OPENCODE_DEVICE_LOGIN_CMD = [
  "opencode",
  "auth",
  "login",
  "--provider",
  "xai",
  "--method",
  SUPERGROK_SUBSCRIPTION_METHOD,
] as const;

/** Device-code grant lifetime surfaced when the CLI prints no expiry. */
export const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
/** Budget to wait for the CLI to print the URL and code before failing closed. */
export const DEVICE_LOGIN_START_TIMEOUT_MS = 30_000;

export const DEVICE_LOGIN_STATUS_PATH = "/api/device-login/status";
export const DEVICE_LOGIN_START_PATH = "/api/device-login/start";
export const DEVICE_LOGIN_CANCEL_PATH = "/api/device-login/cancel";

export type DeviceLoginStateName = "idle" | "waiting" | "signed-in" | "expired" | "denied" | "error" | "cancelled";

export interface DeviceLoginState {
  state: DeviceLoginStateName;
  url?: string;
  userCode?: string;
  expiresAt?: number;
  error?: string;
}

export interface OrdinalStatus {
  ordinal: string;
  role: "engine" | "worker";
  hasXaiRunner: boolean;
  authPresent: boolean;
  leased: boolean;
  state: DeviceLoginStateName;
  url?: string;
  userCode?: string;
  expiresAt?: number;
  error?: string;
  available?: boolean;
}

export type DeviceLoginResult = "started" | "succeeded" | "expired" | "denied" | "cancelled" | "error";

export interface DeviceLoginRecord {
  actor: string;
  ordinal: string;
  provider: string;
  result: DeviceLoginResult;
}

/**
 * Parse the headless device-code output.
 *
 * The installed binary prints, for the xAI auto method, `Go to: <url>` plus
 * `Open <verification_uri> on any device and enter code: <user_code>`.
 * Generic device flows print `Enter code: <code>`. Only the URL and the user
 * code are returned; everything else is dropped by the caller without logging.
 */
export function parseDeviceLoginOutput(text: string): { url?: string; userCode?: string } {
  let url: string | undefined;
  let userCode: string | undefined;

  const goTo = /Go to:\s*(https?:\/\/[^\s"'<>]+)/i.exec(text);
  if (goTo?.[1]) url = stripTrailingPunct(goTo[1]);
  if (!url) {
    const open = /Open\s+(https?:\/\/[^\s"'<>]+)/i.exec(text);
    if (open?.[1]) url = stripTrailingPunct(open[1]);
  }
  const code = /(?:enter code:\s*|user code:\s*|code:\s*)([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(text);
  if (code?.[1]) userCode = code[1].replace(/[-.,;:]+$/, "").trim() || undefined;
  return { url, userCode };
}

function stripTrailingPunct(value: string): string {
  return value.replace(/[.,;:)"'\]]+$/, "").trim() || value.trim();
}

function isEphemeralHome(home: string): boolean {
  const normalized = home.trim();
  if (normalized === "") return true;
  if (normalized.includes(".jumi-tmp")) return true;
  if (normalized === "/tmp" || normalized.startsWith("/tmp/")) return true;
  return false;
}

/**
 * Status without a login is only whether an xAI oauth object is present or
 * missing. Presence is not a healthy grant. This never calls the provider
 * and never refreshes: a refresh here would race the live grant.
 */
export async function isXaiOAuthPresent(home: string): Promise<boolean> {
  const path = await durableAuthPath(home);
  const auth = await readAuthFile(path);
  const entry = readXaiCredential(auth);
  return entry !== undefined && entry.type === "oauth";
}

export function chainHasOpenCodeXai(config: { runners: Record<string, RunnerConfig>; chain: string[] }): boolean {
  for (const name of config.chain) {
    const runner = config.runners[name];
    if (runner && runner.type === OPENCODE_RUNNER_TYPE && isXaiModel(runner.model)) {
      return true;
    }
  }
  return false;
}

export type SpawnLoginFn = (opts: {
  cmd: readonly string[];
  home: string;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}) => { kill: (signal?: NodeJS.Signals) => void };

export const defaultSpawnLogin: SpawnLoginFn = (opts) => {
  const child = spawn(opts.cmd[0], opts.cmd.slice(1), {
    env: { ...process.env, HOME: opts.home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (data: Buffer) => opts.onStdout(data.toString("utf8")));
  child.stderr?.on("data", (data: Buffer) => opts.onStderr(data.toString("utf8")));
  child.on("exit", (code, signal) => opts.onExit(code, signal));
  return {
    kill: (signal = "SIGTERM") => child.kill(signal),
  };
};

export interface DeviceLoginManagerOptions {
  ordinal: string;
  role: "engine" | "worker";
  home: string;
  hasXaiRunner: boolean;
  isLeased: () => boolean | Promise<boolean>;
  spawnLogin?: SpawnLoginFn;
  logger?: (msg: string) => void;
  onResult?: (entry: DeviceLoginRecord) => Promise<void> | void;
  now?: () => number;
}

export class DeviceLoginManager {
  private state: DeviceLoginState = { state: "idle" };
  private activeProcess?: { kill: (signal?: NodeJS.Signals) => void };
  private activeActor?: string;
  private cancelled = false;
  private recordedTerminal = false;

  constructor(readonly options: DeviceLoginManagerOptions) {}

  getState(): DeviceLoginState {
    return { ...this.state };
  }

  async getStatus(): Promise<OrdinalStatus> {
    const authPresent = await isXaiOAuthPresent(this.options.home).catch(() => false);
    const leased = await Promise.resolve()
      .then(() => this.options.isLeased())
      .catch(() => false);
    const status: OrdinalStatus = {
      ordinal: this.options.ordinal,
      role: this.options.role,
      hasXaiRunner: this.options.hasXaiRunner,
      authPresent,
      leased,
      state: this.state.state,
    };
    if (this.state.url) status.url = this.state.url;
    if (this.state.userCode) status.userCode = this.state.userCode;
    if (this.state.expiresAt != null) status.expiresAt = this.state.expiresAt;
    if (this.state.error) status.error = this.state.error;
    return status;
  }

  private async recordResult(result: DeviceLoginResult): Promise<void> {
    const actor = this.activeActor ?? "";
    try {
      await this.options.onResult?.({
        actor,
        ordinal: this.options.ordinal,
        provider: XAI_PROVIDER,
        result,
      });
    } catch (err) {
      this.options.logger?.(
        `device login record failed ordinal=${this.options.ordinal}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private recordTerminalOnce(result: DeviceLoginResult): void {
    if (this.recordedTerminal) return;
    this.recordedTerminal = true;
    void this.recordResult(result);
  }

  async start(actor: string): Promise<{
    refused: boolean;
    reason?: string;
    state: DeviceLoginStateName;
    url?: string;
    userCode?: string;
    expiresAt?: number;
  }> {
    if (
      await Promise.resolve()
        .then(() => this.options.isLeased())
        .catch(() => false)
    ) {
      return { refused: true, reason: "leased", state: this.state.state };
    }
    if (!this.options.hasXaiRunner) {
      return { refused: true, reason: "no-xai-runner", state: this.state.state };
    }
    if (isEphemeralHome(this.options.home)) {
      this.state = { state: "error", error: "Refusing device login on an ephemeral HOME" };
      return { refused: true, reason: "ephemeral-home", state: this.state.state };
    }
    if (this.state.state === "waiting") {
      return {
        refused: false,
        state: this.state.state,
        url: this.state.url,
        userCode: this.state.userCode,
        expiresAt: this.state.expiresAt,
      };
    }

    this.activeActor = actor;
    this.cancelled = false;
    this.recordedTerminal = false;
    this.state = { state: "idle" };
    await this.recordResult("started");

    const spawnFn = this.options.spawnLogin ?? defaultSpawnLogin;
    const now = this.options.now ?? Date.now;

    return new Promise((resolve) => {
      let resolved = false;
      let preParseBuffer = "";
      // Post-parse output is inspected in memory for denied/expired keywords
      // and never logged: success output can contain credential material.
      let postParseOutput = "";
      let parsed = false;

      const finishStart = (outcome: {
        state: DeviceLoginStateName;
        url?: string;
        userCode?: string;
        expiresAt?: number;
      }) => {
        if (resolved) return;
        resolved = true;
        resolve({ refused: false, ...outcome });
      };

      let child: { kill: (signal?: NodeJS.Signals) => void } | undefined;
      try {
        child = spawnFn({
          cmd: OPENCODE_DEVICE_LOGIN_CMD,
          home: this.options.home,
          onStdout: (chunk) => {
            if (!parsed) {
              preParseBuffer += chunk;
              if (preParseBuffer.length > 64_000) preParseBuffer = preParseBuffer.slice(-64_000);
              const found = parseDeviceLoginOutput(preParseBuffer);
              if (found.url && found.userCode) {
                parsed = true;
                const expiresAt = now() + DEVICE_CODE_TTL_MS;
                this.state = { state: "waiting", url: found.url, userCode: found.userCode, expiresAt };
                // Drop the pre-parse buffer at once: it holds the code and a
                // URL that may contain the code. Never log it.
                preParseBuffer = "";
                postParseOutput = "";
                finishStart({ state: "waiting", url: found.url, userCode: found.userCode, expiresAt });
              }
            } else {
              postParseOutput += chunk;
              if (postParseOutput.length > 16_000) postParseOutput = postParseOutput.slice(-16_000);
            }
          },
          onStderr: (chunk) => {
            if (!parsed) {
              preParseBuffer += chunk;
              if (preParseBuffer.length > 64_000) preParseBuffer = preParseBuffer.slice(-64_000);
              const found = parseDeviceLoginOutput(preParseBuffer);
              if (found.url && found.userCode) {
                parsed = true;
                const expiresAt = now() + DEVICE_CODE_TTL_MS;
                this.state = { state: "waiting", url: found.url, userCode: found.userCode, expiresAt };
                preParseBuffer = "";
                postParseOutput = "";
                finishStart({ state: "waiting", url: found.url, userCode: found.userCode, expiresAt });
              }
            } else {
              postParseOutput += chunk;
              if (postParseOutput.length > 16_000) postParseOutput = postParseOutput.slice(-16_000);
            }
          },
          onExit: (code, _signal) => {
            this.activeProcess = undefined;
            const tail = `${preParseBuffer}\n${postParseOutput}`.toLowerCase();
            preParseBuffer = "";
            postParseOutput = "";
            if (this.cancelled) {
              this.state = { state: "cancelled" };
              this.recordTerminalOnce("cancelled");
              if (!resolved) {
                resolved = true;
                resolve({ refused: false, state: "cancelled" });
              }
              return;
            }
            if (code === 0) {
              this.state = { state: "signed-in" };
              this.recordTerminalOnce("succeeded");
              if (!resolved) {
                resolved = true;
                resolve({ refused: false, state: "signed-in" });
              }
              return;
            }
            if (tail.includes("denied") || tail.includes("authorization_denied") || tail.includes("access_denied")) {
              this.state = { state: "denied", error: "Device authorization denied" };
              this.recordTerminalOnce("denied");
            } else if (tail.includes("expired") || tail.includes("expired_token")) {
              this.state = { state: "expired", error: "Device code expired" };
              this.recordTerminalOnce("expired");
            } else {
              this.state = { state: "error", error: "Login failed" };
              this.recordTerminalOnce("error");
            }
            if (!resolved) {
              resolved = true;
              resolve({ refused: false, state: this.state.state });
            }
          },
        });
      } catch (err) {
        this.state = { state: "error", error: "Login failed to start" };
        this.recordTerminalOnce("error");
        this.options.logger?.(
          `device login spawn failed ordinal=${this.options.ordinal}: ${err instanceof Error ? err.message : String(err)}`
        );
        resolve({ refused: false, state: "error" });
        return;
      }

      this.activeProcess = child;

      setTimeout(() => {
        if (!resolved && !parsed) {
          resolved = true;
          preParseBuffer = "";
          postParseOutput = "";
          try {
            child?.kill("SIGTERM");
          } catch {
            // Best effort: the exit handler settles the state.
          }
          if (this.state.state !== "waiting") {
            this.state = { state: "error", error: "Login start timed out" };
            this.recordTerminalOnce("error");
          }
          resolve({
            refused: false,
            state: this.state.state,
            url: this.state.url,
            userCode: this.state.userCode,
            expiresAt: this.state.expiresAt,
          });
        }
      }, DEVICE_LOGIN_START_TIMEOUT_MS).unref?.();
    });
  }

  cancel(): void {
    if (this.activeProcess) {
      this.cancelled = true;
      try {
        this.activeProcess.kill("SIGTERM");
      } catch {
        // The exit handler still settles the state.
      }
      this.state = { state: "cancelled" };
      this.recordTerminalOnce("cancelled");
    } else if (this.state.state === "waiting") {
      this.state = { state: "cancelled" };
      this.recordTerminalOnce("cancelled");
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Edge identity + same-origin guard, kept identical to `src/board.ts`.
 * The ordinal listener is internal-only (router reaches it server-side after
 * the board edge check); a direct-to-pod route would let a caller
 * self-assert these headers until the chart lands, which is why the router
 * proxy re-checks them too. Keep this in sync with board.ts.
 */
const EDGE_IDENTITY_HEADERS = [
  "x-forwarded-user",
  "x-forwarded-email",
  "x-auth-request-user",
  "x-remote-user",
] as const;

function ordinalBoardUsername(request: Request): string | undefined {
  for (const header of EDGE_IDENTITY_HEADERS) {
    const value = request.headers.get(header);
    if (value != null && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function ordinalBoardPublicOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = (request.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  const host = (request.headers.get("x-forwarded-host") ?? "").split(",")[0].trim();
  const scheme = proto === "http" || proto === "https" ? proto : url.protocol.replace(":", "").toLowerCase();
  const hostPart = host || url.host;
  try {
    return new URL(`${scheme}://${hostPart}`).origin;
  } catch {
    return url.origin;
  }
}

function isOrdinalAllowedBoardOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  return normalized === ordinalBoardPublicOrigin(request);
}

export interface OrdinalDeviceLoginServerOptions extends DeviceLoginManagerOptions {
  host?: string;
  port?: number;
}

/**
 * Ordinal-local listener. Bound on the engine and worker processes only, on
 * the constant {@link ORDINAL_DEVICE_LOGIN_PORT}. Never on the router and
 * never via an environment variable.
 *
 * Paths are `/api/device-login/*`: this is not a kick and never reuses the
 * kick route. Writes require the edge identity header and the same-origin
 * check the board already uses; the actor never comes from a body field and
 * the start control accepts no free-form command. Responses never carry
 * token material.
 */
export function createOrdinalDeviceLoginServer(options: OrdinalDeviceLoginServerOptions): {
  server: ReturnType<typeof Bun.serve>;
  manager: DeviceLoginManager;
} {
  const manager = new DeviceLoginManager(options);
  const port = ORDINAL_DEVICE_LOGIN_PORT;
  const hostname = options.host ?? "0.0.0.0";

  const server = Bun.serve({
    hostname,
    port,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return json(200, { ok: true });
      }
      if (url.pathname === DEVICE_LOGIN_STATUS_PATH || url.pathname === "/status") {
        if (request.method !== "GET") return json(405, { error: "method not allowed" });
        const status = await manager.getStatus();
        return json(200, status);
      }
      if (url.pathname === DEVICE_LOGIN_START_PATH || url.pathname === "/start") {
        if (request.method !== "POST") return json(405, { error: "method not allowed" });
        const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") return json(400, { error: "invalid device login payload" });
        if (!isOrdinalAllowedBoardOrigin(request)) return json(403, { error: "forbidden" });
        // The actor is the existing edge identity, never a field in the body.
        // The body is drained so a reused connection stays usable, then ignored:
        // the start control accepts no free-form command.
        try {
          await request.text();
        } catch {
          return json(400, { error: "invalid device login payload" });
        }
        const actor = ordinalBoardUsername(request) ?? "";
        if (!actor) return json(401, { error: "missing edge identity" });
        const outcome = await manager.start(actor);
        if (outcome.refused) {
          const status = outcome.reason === "leased" ? 409 : 422;
          return json(status, {
            error:
              outcome.reason === "leased"
                ? "Ordinal holds a leased job; refusing login"
                : outcome.reason === "ephemeral-home"
                  ? "Refusing device login on an ephemeral HOME"
                  : "xAI runner not configured in chain",
            code: outcome.reason,
            state: outcome.state,
          });
        }
        return json(200, {
          ok: true,
          ordinal: options.ordinal,
          state: outcome.state,
          url: outcome.url,
          userCode: outcome.userCode,
          expiresAt: outcome.expiresAt,
        });
      }
      if (url.pathname === DEVICE_LOGIN_CANCEL_PATH || url.pathname === "/cancel") {
        if (request.method !== "POST") return json(405, { error: "method not allowed" });
        const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") return json(400, { error: "invalid device login payload" });
        if (!isOrdinalAllowedBoardOrigin(request)) return json(403, { error: "forbidden" });
        try {
          await request.text();
        } catch {
          return json(400, { error: "invalid device login payload" });
        }
        const actor = ordinalBoardUsername(request) ?? "";
        if (!actor) return json(401, { error: "missing edge identity" });
        manager.cancel();
        options.logger?.(`device login cancel actor=${actor} ordinal=${options.ordinal} provider=${XAI_PROVIDER}`);
        return json(200, { ok: true, ordinal: options.ordinal, state: "cancelled" });
      }
      return json(404, { error: "not found" });
    },
  });
  return { server, manager };
}

export function deviceLoginResultLogger(logger: (message: string) => void) {
  return (entry: DeviceLoginRecord): void => {
    logger(
      `device login actor=${entry.actor} ordinal=${entry.ordinal} provider=${entry.provider} result=${entry.result}`
    );
  };
}
