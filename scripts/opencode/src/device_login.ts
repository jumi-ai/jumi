import { spawn } from "node:child_process";
import { isCodexChatGptPresent } from "./codex_auth.ts";
import { CODEX_RUNNER_TYPE, OPENCODE_RUNNER_TYPE, type RunnerConfig } from "./runners.ts";
import { durableAuthPath, isXaiModel, readAuthFile, readXaiCredential } from "./xai_auth.ts";

/**
 * Device login for one engine or worker ordinal, two providers.
 *
 * The login process runs inside the ordinal that owns the auth file, as the
 * container uid, with the same HOME the review and implement child already
 * use. The router is diskless and must not run the login. A write that lands
 * on the ephemeral cache tree is a failure, so HOME must be the durable
 * auth root (config.home, `/data` in the image), never a workspace temp dir.
 *
 * Grok uses the headless xAI device-code method: a verification URL plus a
 * user code the operator types into the provider page. The fixed invocation
 * selects the SuperGrok Subscription method without a TUI picker. The
 * API-key method and the localhost browser callback are never used: the pod
 * has no browser and the operator browser cannot reach pod localhost.
 *
 * Codex uses the stock CLI's headless device-code flow: the fixed invocation
 * is `codex login --device-auth`. It prints `https://auth.openai.com/codex/device`
 * plus a one-time code that expires in 15 minutes, then polls until approved.
 * The API-key and access-token stdin methods and the localhost browser
 * callback are never used. It runs with the same HOME and Codex config
 * location the Codex runner child uses (`$HOME/.codex`), so the credential
 * lands in that ordinal's retained Codex auth directory.
 *
 * One in-flight login per ordinal across both providers. A second start
 * while waiting returns the same code and does not start another flow. Two
 * device flows writing auth files on the same ordinal is a failure.
 *
 * The code lives in memory on the ordinal. The board polls it. The code is
 * never persisted. The code, a URL containing the code, and the CLI stdout
 * or stderr after the URL and code have been parsed are never logged:
 * success output can contain credential material.
 */

export const ORDINAL_DEVICE_LOGIN_PORT = 3010;
export const XAI_PROVIDER = "xai";
export const CODEX_PROVIDER = "codex";
export type DeviceLoginProvider = typeof XAI_PROVIDER | typeof CODEX_PROVIDER;
export const DEVICE_LOGIN_PROVIDERS: readonly DeviceLoginProvider[] = [XAI_PROVIDER, CODEX_PROVIDER];
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
/** Stock CLI headless device-code flow. No API-key/access-token stdin flags, no browser callback. */
export const CODEX_DEVICE_LOGIN_CMD = ["codex", "login", "--device-auth"] as const;
/** Verification link the Codex device flow prints. */
export const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";

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
  hasCodexRunner: boolean;
  authPresent: boolean;
  codexAuthPresent: boolean;
  leased: boolean;
  /** Provider of the in-flight login, when there is one. */
  provider?: DeviceLoginProvider;
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
 * Parse headless device-code output for either provider.
 *
 * The xAI method prints `Go to: <url>` plus
 * `Open <verification_uri> on any device and enter code: <user_code>`, and
 * generic device flows print `Enter code: <code>`. The Codex device flow
 * prints the bare `https://auth.openai.com/codex/device` link plus a
 * one-time code that expires in 15 minutes (`Enter this one-time code ...
 * ABCD-EFGHI`); groups are 4-5 characters each, so no 4-4 shape is assumed.
 * Only the URL and the user code are returned; everything else is dropped by
 * the caller without logging.
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
  if (!url) {
    // The Codex flow prints the bare verification link without a lead-in
    // (`Open this link ... https://auth.openai.com/codex/device`). Prefer a
    // known device URL, otherwise take the first URL in the output.
    const urls = [...text.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map((m) => stripTrailingPunct(m[0]));
    url =
      urls.find((candidate) => candidate.toLowerCase().startsWith(CODEX_DEVICE_URL.toLowerCase())) ??
      urls.find((candidate) => /auth\.x\.ai/i.test(candidate)) ??
      urls[0];
  }
  const code = /(?:enter code:\s*|user code:\s*|code:\s*)([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(text);
  if (code?.[1]) userCode = code[1].replace(/[-.,;:]+$/, "").trim() || undefined;
  if (!userCode) {
    // `Enter this one-time code (expires in 15 minutes) ABCD-EFGHI`: the code
    // follows prose and an optional expiry parenthetical, not a colon. The
    // gap may hold words (`expires in 15 minutes`), so the match requires a
    // dash-shaped device code instead of the next word. Groups are 4-5
    // characters each.
    const oneTime = /one[- ]time code\b[\s\S]{0,120}?([A-Za-z0-9]{4,5}-[A-Za-z0-9]{4,5}(?:-[A-Za-z0-9]{4,5})?)/i.exec(
      text
    );
    if (oneTime?.[1]) userCode = oneTime[1].replace(/[-.,;:]+$/, "").trim() || undefined;
  }
  if (!userCode) {
    // Last resort: a standalone device code token (`XXXX-XXXX` or
    // `XXXX-XXXXX`; groups are 4-5 characters each).
    const bare = /\b([A-Za-z0-9]{4,5}-[A-Za-z0-9]{4,5}(?:-[A-Za-z0-9]{4,5})?)\b/.exec(text);
    if (bare?.[1]) userCode = bare[1].trim() || undefined;
  }
  return { url, userCode };
}

function stripTrailingPunct(value: string): string {
  return value.replace(/[.,;:)"'\]]+$/, "").trim() || value.trim();
}

export function isValidDeviceLoginProvider(value: unknown): value is DeviceLoginProvider {
  return value === XAI_PROVIDER || value === CODEX_PROVIDER;
}

export function normalizeDeviceLoginProvider(value: unknown): DeviceLoginProvider | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (isValidDeviceLoginProvider(trimmed)) return trimmed;
  return undefined;
}

export function deviceLoginCmd(provider: DeviceLoginProvider): readonly string[] {
  return provider === CODEX_PROVIDER ? CODEX_DEVICE_LOGIN_CMD : OPENCODE_DEVICE_LOGIN_CMD;
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

export function chainHasCodex(config: { runners: Record<string, RunnerConfig>; chain: string[] }): boolean {
  for (const name of config.chain) {
    const runner = config.runners[name];
    if (runner && runner.type === CODEX_RUNNER_TYPE) {
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
  hasCodexRunner?: boolean;
  isLeased: () => boolean | Promise<boolean>;
  spawnLogin?: SpawnLoginFn;
  logger?: (msg: string) => void;
  onResult?: (entry: DeviceLoginRecord) => Promise<void> | void;
  now?: () => number;
}

export interface DeviceLoginStartOutcome {
  refused: boolean;
  reason?: string;
  provider?: DeviceLoginProvider;
  state: DeviceLoginStateName;
  url?: string;
  userCode?: string;
  expiresAt?: number;
}

export class DeviceLoginManager {
  private state: DeviceLoginState = { state: "idle" };
  private activeProcess?: { kill: (signal?: NodeJS.Signals) => void };
  private activeActor?: string;
  private activeProvider?: DeviceLoginProvider;
  private cancelled = false;
  private recordedTerminal = false;
  /**
   * Synchronous in-flight guard: set before the first await so concurrent
   * start() callers share one spawn instead of both seeing idle and
   * spawning two flows that write the same retained auth file.
   */
  private pendingStart?: Promise<DeviceLoginStartOutcome>;

  constructor(readonly options: DeviceLoginManagerOptions) {}

  getState(): DeviceLoginState {
    return { ...this.state };
  }

  async getStatus(): Promise<OrdinalStatus> {
    const [authPresent, codexAuthPresent] = await Promise.all([
      isXaiOAuthPresent(this.options.home).catch(() => false),
      isCodexChatGptPresent(this.options.home).catch(() => false),
    ]);
    const leased = await Promise.resolve()
      .then(() => this.options.isLeased())
      .catch(() => false);
    const status: OrdinalStatus = {
      ordinal: this.options.ordinal,
      role: this.options.role,
      hasXaiRunner: this.options.hasXaiRunner,
      hasCodexRunner: this.options.hasCodexRunner === true,
      authPresent,
      codexAuthPresent,
      leased,
      state: this.state.state,
    };
    if (this.activeProvider) status.provider = this.activeProvider;
    if (this.state.url) status.url = this.state.url;
    if (this.state.userCode) status.userCode = this.state.userCode;
    if (this.state.expiresAt != null) status.expiresAt = this.state.expiresAt;
    if (this.state.error) status.error = this.state.error;
    return status;
  }

  private providerOfActive(): DeviceLoginProvider {
    return this.activeProvider ?? XAI_PROVIDER;
  }

  private async recordResult(result: DeviceLoginResult): Promise<void> {
    const actor = this.activeActor ?? "";
    try {
      await this.options.onResult?.({
        actor,
        ordinal: this.options.ordinal,
        provider: this.providerOfActive(),
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

  async start(actor: string, provider: DeviceLoginProvider = XAI_PROVIDER): Promise<DeviceLoginStartOutcome> {
    if (this.state.state === "waiting") {
      return {
        refused: false,
        provider: this.activeProvider ?? XAI_PROVIDER,
        state: this.state.state,
        url: this.state.url,
        userCode: this.state.userCode,
        expiresAt: this.state.expiresAt,
      };
    }
    if (this.pendingStart) return this.pendingStart;
    const task = this.runStart(actor, provider);
    this.pendingStart = task;
    try {
      return await task;
    } finally {
      this.pendingStart = undefined;
    }
  }

  private async runStart(actor: string, provider: DeviceLoginProvider): Promise<DeviceLoginStartOutcome> {
    if (
      await Promise.resolve()
        .then(() => this.options.isLeased())
        .catch(() => false)
    ) {
      return { refused: true, reason: "leased", provider, state: this.state.state };
    }
    if (provider === CODEX_PROVIDER) {
      if (this.options.hasCodexRunner !== true) {
        return { refused: true, reason: "no-codex-runner", provider, state: this.state.state };
      }
    } else if (!this.options.hasXaiRunner) {
      return { refused: true, reason: "no-xai-runner", provider, state: this.state.state };
    }
    if (isEphemeralHome(this.options.home)) {
      this.state = { state: "error", error: "Refusing device login on an ephemeral HOME" };
      return { refused: true, reason: "ephemeral-home", provider, state: this.state.state };
    }
    if (this.state.state === "waiting") {
      return {
        refused: false,
        provider: this.activeProvider ?? provider,
        state: this.state.state,
        url: this.state.url,
        userCode: this.state.userCode,
        expiresAt: this.state.expiresAt,
      };
    }

    this.activeActor = actor;
    this.activeProvider = provider;
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
        resolve({ refused: false, provider, ...outcome });
      };

      let child: { kill: (signal?: NodeJS.Signals) => void } | undefined;
      try {
        child = spawnFn({
          cmd: deviceLoginCmd(provider),
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
                resolve({ refused: false, provider, state: "cancelled" });
              }
              return;
            }
            if (code === 0) {
              this.state = { state: "signed-in" };
              this.recordTerminalOnce("succeeded");
              if (!resolved) {
                resolved = true;
                resolve({ refused: false, provider, state: "signed-in" });
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
              resolve({ refused: false, provider, state: this.state.state });
            }
          },
        });
      } catch (err) {
        this.state = { state: "error", error: "Login failed to start" };
        this.recordTerminalOnce("error");
        this.options.logger?.(
          `device login spawn failed ordinal=${this.options.ordinal}: ${err instanceof Error ? err.message : String(err)}`
        );
        resolve({ refused: false, provider, state: "error" });
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
            provider,
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
  /**
   * Test seam only. Production callers (engine, worker) never set it: the
   * ordinal listener is always on the constant
   * {@link ORDINAL_DEVICE_LOGIN_PORT}, never via an environment variable.
   */
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
/**
 * Provider for an ordinal start/cancel request. The body carries only
 * ordinal + role + provider; the actor never comes from a body field and no
 * free-form command is accepted. Absent means xAI, so older boards keep
 * working. Returns undefined for an unknown provider name.
 */
export function ordinalRequestProvider(
  bodyText: string,
  query: URLSearchParams
): DeviceLoginProvider | undefined | "invalid" {
  let bodyProvider: unknown;
  try {
    const parsed = (bodyText.trim() === "" ? {} : JSON.parse(bodyText)) as Record<string, unknown>;
    bodyProvider = parsed.provider;
  } catch {
    return "invalid";
  }
  const raw = typeof bodyProvider === "string" && bodyProvider.trim() !== "" ? bodyProvider : query.get("provider");
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return undefined;
  return normalizeDeviceLoginProvider(raw) ?? "invalid";
}

export function deviceLoginRefusedMessage(reason: string | undefined, provider: DeviceLoginProvider): string {
  if (reason === "leased") return "Ordinal holds a leased job; refusing login";
  if (reason === "ephemeral-home") return "Refusing device login on an ephemeral HOME";
  if (reason === "no-codex-runner") return "codex runner not configured in chain";
  if (provider === CODEX_PROVIDER && reason !== "no-xai-runner") return "codex runner not configured in chain";
  return "xAI runner not configured in chain";
}

export function createOrdinalDeviceLoginServer(options: OrdinalDeviceLoginServerOptions): {
  server: ReturnType<typeof Bun.serve>;
  manager: DeviceLoginManager;
} {
  const manager = new DeviceLoginManager(options);
  const port = options.port ?? ORDINAL_DEVICE_LOGIN_PORT;
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
        // The in-memory code is served here, so writes and reads share the
        // edge-identity gate; the router already forwards the headers.
        if (!ordinalBoardUsername(request)) return json(401, { error: "missing edge identity" });
        const status = await manager.getStatus();
        return json(200, status);
      }
      if (url.pathname === DEVICE_LOGIN_START_PATH || url.pathname === "/start") {
        if (request.method !== "POST") return json(405, { error: "method not allowed" });
        const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") return json(400, { error: "invalid device login payload" });
        if (!isOrdinalAllowedBoardOrigin(request)) return json(403, { error: "forbidden" });
        // The actor is the existing edge identity, never a field in the body.
        // The body is drained so a reused connection stays usable; only the
        // provider name is read from it. The start control accepts no
        // free-form command.
        let bodyText = "";
        try {
          bodyText = await request.text();
        } catch {
          return json(400, { error: "invalid device login payload" });
        }
        const requested = ordinalRequestProvider(bodyText, url.searchParams);
        if (requested === "invalid") return json(400, { error: "invalid provider" });
        const provider = requested ?? XAI_PROVIDER;
        const actor = ordinalBoardUsername(request) ?? "";
        if (!actor) return json(401, { error: "missing edge identity" });
        const outcome = await manager.start(actor, provider);
        if (outcome.refused) {
          const status = outcome.reason === "leased" ? 409 : 422;
          return json(status, {
            error: deviceLoginRefusedMessage(outcome.reason, outcome.provider ?? provider),
            code: outcome.reason,
            state: outcome.state,
            provider: outcome.provider ?? provider,
          });
        }
        return json(200, {
          ok: true,
          ordinal: options.ordinal,
          provider: outcome.provider ?? provider,
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
        options.logger?.(`device login cancel actor=${actor} ordinal=${options.ordinal}`);
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
