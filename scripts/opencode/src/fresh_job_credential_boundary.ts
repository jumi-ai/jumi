import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Shared credential boundary for fresh-job (one-shot `src/job.ts`) subscription routes.
 *
 * A fresh job starts with an empty `HOME`. The privileged parent owns any
 * official login, serializes refresh/rotation, persists renewed state, and
 * handles revocation. The inference component (the model plus its tools) gets
 * only the minimum authorized capability for one inference request: no forge
 * credential, no reusable login, and no arbitrary refresh authority. The
 * parent is never a request proxy by default.
 *
 * This module is the contract `#935`-`#938` inherit: each of those issues
 * plugs its own credential form into {@link FreshJobCredentialStore} and
 * reuses {@link runFreshJobBoundaryChecks} instead of inventing new checks.
 */

export type CredentialRouteId = "chatgpt-oss-signin" | "claude-signed-in-helper" | "direct-supergrok" | "opencode-go";

export type CredentialRouteVerdict = "allowed" | "blocked" | "needs-human";

export interface CredentialRouteContract {
  id: CredentialRouteId;
  /** Who performs the official login (always a human/operator, never the model). */
  loginOwner: string;
  /** Who serializes refresh/rotation (single owner; concurrent jobs never double-POST). */
  serialization: string;
  /** Where renewed state lands (atomic, durable, verified by re-read). */
  persistence: string;
  /** What makes the credential stop working (revocation fails closed). */
  revocation: string;
  /** The only capability the inference component holds. */
  childCapability: string;
  /** Capabilities the inference component must never hold. */
  forbiddenForChild: readonly string[];
  /** What happens in a fresh job (empty `HOME`). */
  freshJob: string;
  verdict: CredentialRouteVerdict;
  /** First-party evidence for the row (docs, never a mock the author wrote). */
  evidence: readonly string[];
  /** Checks only a human operator can perform (no registration/sign-in/spend here). */
  operatorChecks: readonly string[];
  notes: string;
}

/**
 * One row per route. Finished even though some routes are unresolved: an
 * unresolved route is `blocked` (or `needs-human`) with the missing piece
 * named, never an implicit allow.
 */
export const FRESH_JOB_CREDENTIAL_ROUTES: readonly CredentialRouteContract[] = [
  {
    id: "chatgpt-oss-signin",
    loginOwner:
      "Human operator in a browser (Sign in with ChatGPT): agent names itself, host keeps a stable `ext_agent_host_id`, loopback callback returns an issued `client_id`; the tool stores the record (`issued client_id`, validated identity, tokens, granted scopes) in an app-defined file with owner-only `0600`.",
    serialization:
      "Privileged parent only, one POST per grant attempt; a second job never re-POSTs a grant the provider already refused.",
    persistence:
      "Atomic file write (sibling + fsync + rename + re-read) beside the stored record; rotating access/refresh together, never the access token alone.",
    revocation:
      "Operator disconnects the agent in ChatGPT Settings > Security; any later refresh/inference with the old grant fails closed as provider auth death and the chain hops.",
    childCapability: "None in a fresh job: there is no grant under an empty `HOME` to derive a child credential from.",
    forbiddenForChild: [
      "refresh token",
      "issued client_id registration",
      "arbitrary refresh POST",
      "loopback listener",
    ],
    freshJob:
      "Blocked: an empty `HOME` holds no grant, and copying a grant into the job would be the shared token store this contract forbids. No headless official login exists (browser + loopback required).",
    verdict: "blocked",
    evidence: [
      "https://developers.openai.com/siwc/token-sharing-open-source/sign-in (dynamic_agent_client, ext_agent_host_id, loopback, 0600, scopes chatgpt.tokens.use.direct)",
      "https://opencode.ai/docs/providers/ (ChatGPT sign-in counts against the plan, context caps)",
      "https://learn.chatgpt.com/docs/sign-in-with-chatgpt (app usage counts against the existing plan; per-app weekly limits)",
    ],
    operatorChecks: [
      "Name the agent and approve plan usage in the browser",
      "Confirm the issued client_id is stored per account",
      "Disconnect the agent to revoke",
    ],
    notes:
      "Same-UID jobs cannot isolate a copied grant by file mode: the child reads the parent file and /proc. Missing primitive is a per-job UID or mount namespace; without it this route stays blocked.",
  },
  {
    id: "claude-signed-in-helper",
    loginOwner:
      "Human operator via `claude auth login` (browser) or `claude setup-token` for the long-lived `CLAUDE_CODE_OAUTH_TOKEN`; the unmodified signed-in helper (`apiKeyHelper`) is a shell script the CLI re-runs for fresh keys.",
    serialization:
      "Privileged parent only. The helper itself must never run inside the inference component: a model with shell access could execute it and mint its own keys.",
    persistence:
      "Claude manages `~/.credentials.json` (`0600`, macOS Keychain when available) through `/login`/`/logout`; `CLAUDE_CONFIG_DIR` selects a separate credential entry.",
    revocation:
      "`/logout` removes and revokes the credential; an expired login fails closed (`Login expired`, `Login reached its time limit`) and unattended sessions stop instead of refreshing themselves.",
    childCapability:
      "One static bearer per child: a subscription child keeps exactly `CLAUDE_CODE_OAUTH_TOKEN`, an API-key child gets exactly `ANTHROPIC_API_KEY` (never both, never `ANTHROPIC_AUTH_TOKEN`, never the operator variable name).",
    forbiddenForChild: [
      "apiKeyHelper script execution",
      "credentials.json write",
      "/login or setup-token",
      "second credential via precedence",
    ],
    freshJob:
      "Blocked for the unmodified helper: the helper file and the credential file are readable/executable by the same UID, so an offline file-mode boundary is not evidence of isolation. The static `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` child shape stays allowed where the operator mounts it as env.",
    verdict: "blocked",
    evidence: [
      "https://code.claude.com/docs/en/authentication (0600/Keychain storage, apiKeyHelper re-run rules, setup-token, precedence, expiry, unattended sessions stop)",
    ],
    operatorChecks: [
      "Run /login or setup-token in a browser session",
      "Confirm /status names the intended credential",
      "Run /logout to revoke",
    ],
    notes:
      "Unmodified means the helper the vendor ships semantics for: any script that can mint a key is renewal authority. Under one UID the child can run it directly, so this route needs a per-job user or a parent-side signer (a proxy, forbidden by default) before it can move.",
  },
  {
    id: "direct-supergrok",
    loginOwner:
      "Human operator via headless device code (`opencode auth login xai --method 'SuperGrok Subscription' --standalone` on the ordinal that owns the durable auth root); the operator types the user code into the provider page.",
    serialization:
      "Long-lived parent only (`src/xai_auth.ts` per-process queue): at most one refresh POST per grant; a refused grant latches so no later job re-POSTs it; a POST success held only in memory retries the write, never a second POST.",
    persistence:
      "Durable auth file sibling + fsync + rename + re-read before the child starts; orphan siblings adopted on startup; the write follows the Retain symlink so a human login keeps reaching the same file.",
    revocation:
      "A 400/401 from the token endpoint latches the grant; the job fails closed as provider auth death (never starts a run that will 401 with no recovery).",
    childCapability:
      'Refresh-less bearer only: the isolated child auth gets `{"type": "api", "key": "<access>"}` (never the refresh token), which the installed binary sends without entering its own refresh path.',
    forbiddenForChild: ["refresh token", "token-endpoint POST", "durable file write", "grant adoption"],
    freshJob:
      "Blocked in job mode: `HOME` is empty, so there is no grant to own, and `src/job_requirements.ts` refuses any chain that needs xAI OAuth. Standing pods with a retained HOME stay allowed via the parent-owned path above; gated by #938 on the Pi subscription route.",
    verdict: "blocked",
    evidence: [
      "src/xai_auth.ts + src/device_login.ts in this tree (parent-owned grant, device-code login, fail-closed refresh)",
      "https://docs.x.ai/developers/pricing + https://x.ai/pricing (subscription pool vs per-token API billing; top-ups are spend)",
    ],
    operatorChecks: [
      "Complete the device-code login on the ordinal with durable HOME",
      "Confirm the refreshed token covers the job budget before start",
      "Re-run /connect when the grant latches as refused",
    ],
    notes:
      "Rotation does not revoke an already-issued access token, so no lock is held across the run; the accepted loss is a kill between provider answer and durable write. Copying the grant into an empty-HOME job would be a shared token store, so the refusal stays.",
  },
  {
    id: "opencode-go",
    loginOwner:
      "Human operator subscribes in the OpenCode console (Go / Go Plus / Go Teams), adds billing, and copies a static API key; no browser flow inside the job.",
    serialization:
      "No refresh to serialize: the key is static. The parent re-reads `OPENCODE_API_KEY_FILE` fresh on every spawn so a rotation applies to the next child with no restart.",
    persistence:
      "Kubernetes Secret mounted as files (not `subPath`) so kubelet updates it in place; the value lives only in the child env, never in logs, the workdir, statuses, or the board.",
    revocation:
      "Operator rotates/deletes the key; a missing/unreadable/empty file with no env fallback fails the run closed as provider auth death (hop applies). A 401 without a valid key and a 403 without a Go subscription are distinct from quota.",
    childCapability:
      "Static `OPENCODE_API_KEY` bearer for inference plus the required `x-opencode-session` stable session id per conversation (routing/prompt-cache affinity). Validated clients (OpenCode, Claude Code, Codex, Pi, and others on the Go page) send it; decision/embedding requests need no session id and bill at list price.",
    forbiddenForChild: ["refresh POST", "console billing changes", "Extra Usage toggle", "service-account management"],
    freshJob:
      "Allowed: empty-HOME jobs carry no grant to rotate, the key arrives per spawn, and a rotated key reaches the next child without a restart.",
    verdict: "allowed",
    evidence: [
      "https://opencode.ai/docs/console/go/ (validated clients + session header, 5h/weekly/monthly limits, Extra Usage fallback, decision/embedding need no session id, usage endpoint, 401 vs 403 EntitlementError)",
      "https://opencode.ai/docs/providers/ (Go connect + opencode-go/<model> selection)",
    ],
    operatorChecks: [
      "Subscribe (Go / Go Plus / Go Teams) and mount the key as OPENCODE_API_KEY_FILE (files, not subPath)",
      "Confirm Pi builds send session information (update older installs)",
      "Decide on Extra Usage yourself: it spends console balance past the limits and stays off unless you turn it on (on by default only for Go Teams)",
    ],
    notes:
      "Named Pi support (a validated session-header client) is the allowed lane; unattended embedding/decision calls are allowed only at list price without the Go discount. Subscription limits (rolling/weekly/monthly) block with rate-limited status; paid overage (Extra Usage) is spend and needs-human.",
  },
];

export function routeVerdict(id: CredentialRouteId): CredentialRouteVerdict {
  const found = FRESH_JOB_CREDENTIAL_ROUTES.find((route) => route.id === id);
  if (!found) throw new Error(`unknown credential route: ${id}`);
  return found.verdict;
}

/** Dummy credential shape the offline harness uses. Never a real grant. */
export interface DummyCredential {
  /** Bearer the inference component may hold. */
  access: string;
  /** Renewal authority the inference component must never hold. */
  refresh: string;
  /** Provider generation: rotation bumps it, revocation flips `revoked`. */
  generation: number;
  revoked: boolean;
}

export interface ChildView {
  /** Exactly what a tool context may observe (access bearer only). */
  access: string;
  /** Argv the child was spawned with (must carry no credential). */
  argv: string[];
  /** Env the child was spawned with (must carry no refresh/renewal authority). */
  env: Record<string, string>;
  /** Credential/helper files the child can read (dummy paths + redacted contents). */
  files: Record<string, string>;
  /** Refresh/control endpoint URLs the child can name (must grant nothing). */
  endpoints: string[];
}

export interface BoundaryProbeResult {
  inferenceOk: boolean;
  restartOk: boolean;
  concurrentOk: boolean;
  revocationOk: boolean;
  exposureOk: boolean;
  refreshPosts: number;
}

/**
 * Reusable offline store with dummy credentials. `#935`-`#938` inherit this
 * shape for their own credential form: keep the method set, replace the
 * persistence (file) and the POST (fetch) doubles.
 *
 * Semantics mirror production: rotation does not revoke an already-issued
 * access token; only revocation (or expiry) fails inference closed.
 */
export class FreshJobCredentialStore {
  private current: DummyCredential;
  /** Every access bearer ever issued and not revoked: rotation never invalidates one. */
  private issued: Set<string>;
  private queue: Promise<unknown> = Promise.resolve();
  private inflight: Promise<DummyCredential> | undefined;
  private refreshPosts = 0;
  private readonly dir: string;
  private readonly postRefresh: (refresh: string) => Promise<{ access: string; refresh: string }>;

  constructor(
    dir: string,
    seed: DummyCredential = { access: "dummy-access-1", refresh: "dummy-refresh-1", generation: 1, revoked: false },
    postRefresh?: (refresh: string) => Promise<{ access: string; refresh: string }>
  ) {
    this.dir = dir;
    this.current = { ...seed };
    this.issued = new Set([seed.access]);
    this.postRefresh =
      postRefresh ??
      (async (refresh: string) => {
        this.refreshPosts += 1;
        return { access: `dummy-access-rotated-${refresh.length}-${this.refreshPosts}`, refresh: `${refresh}-next` };
      });
  }

  get posts(): number {
    return this.refreshPosts;
  }

  private get path(): string {
    return join(this.dir, "credential.json");
  }

  private sibling(): string {
    return join(this.dir, `credential.json.jumi-${crypto.randomUUID()}.tmp`);
  }

  /** Durable write: sibling + fsync + rename + re-read, like `writeDurableAuth`. */
  async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = this.sibling();
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ current: this.current, issued: [...this.issued] }, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    await chmod(this.path, 0o600).catch(() => undefined);
    const reread = JSON.parse(await readFile(this.path, "utf8")) as {
      current: DummyCredential;
      issued: string[];
    };
    if (reread.current.access !== this.current.access || reread.current.refresh !== this.current.refresh) {
      throw new Error("credential did not survive a re-read");
    }
  }

  /** Restart: re-read the durable file, then adopt a newer orphan sibling left by an interrupted write. */
  async restart(): Promise<void> {
    try {
      const reread = JSON.parse(await readFile(this.path, "utf8")) as {
        current: DummyCredential;
        issued: string[];
      };
      this.current = { ...reread.current };
      this.issued = new Set(reread.issued ?? [reread.current.access]);
    } catch {
      return;
    }
    const base = basename(this.path);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const orphans = names.filter((name) => name.startsWith(`${base}.jumi-`) && name.endsWith(".tmp"));
    for (const orphan of orphans) {
      try {
        const candidate = JSON.parse(await readFile(join(this.dir, orphan), "utf8")) as {
          current: DummyCredential;
        };
        if (!candidate.current?.refresh || candidate.current.revoked) continue;
        if (candidate.current.generation > this.current.generation) {
          this.current = { ...candidate.current };
          this.issued.add(candidate.current.access);
        }
      } catch {
        // Unreadable sibling: ignore, then remove below.
      }
      await rm(join(this.dir, orphan), { force: true }).catch(() => undefined);
    }
  }

  /**
   * Serialized renewal, like the parent queue: concurrent callers share the
   * one in-flight POST, so renewal cannot invalidate the other job.
   */
  refresh(): Promise<DummyCredential> {
    if (this.inflight) return this.inflight;
    const run = this.queue.then(
      () => this.refreshLocked(),
      () => this.refreshLocked()
    );
    this.inflight = run;
    const clear = () => {
      if (this.inflight === run) this.inflight = undefined;
    };
    void run.then(clear, clear);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async refreshLocked(): Promise<DummyCredential> {
    if (this.current.revoked) throw new Error("grant revoked: re-login required");
    const rotated = await this.postRefresh(this.current.refresh);
    this.current = {
      access: rotated.access,
      refresh: rotated.refresh,
      generation: this.current.generation + 1,
      revoked: false,
    };
    this.issued.add(this.current.access);
    await this.persist();
    return { ...this.current };
  }

  revoke(): void {
    this.current = { ...this.current, revoked: true };
  }

  /** Permitted inference: any issued, unrevoked access bearer succeeds. */
  inference(access: string): boolean {
    if (this.current.revoked) return false;
    if (!access) return false;
    return this.issued.has(access);
  }

  /** The only view a tool context may observe. Refresh never appears here. */
  childView(argv: string[] = ["inference", "--standalone"]): ChildView {
    return {
      access: this.current.access,
      argv: [...argv],
      env: { DUMMY_INFERENCE_KEY: this.current.access, HOME: "/empty-job-home", PATH: "/usr/bin:/bin" },
      files: { "credential.json": JSON.stringify({ access: this.current.access }) },
      endpoints: ["https://provider.example.com/inference (bearer only; no refresh endpoint published)"],
    };
  }

  snapshot(): DummyCredential {
    return { ...this.current };
  }
}

function childViewLeaks(view: ChildView, secret: DummyCredential): string | undefined {
  const haystacks = [...Object.values(view.env), ...view.argv, ...Object.values(view.files), ...view.endpoints];
  for (const hay of haystacks) {
    if (secret.refresh && hay.includes(secret.refresh)) return "refresh token reachable from tool context";
  }
  if (view.env["DUMMY_REFRESH"] !== undefined) return "renewal authority in tool env";
  if (Object.keys(view.env).some((key) => /FORGE|GITEA|GITHUB|WEBHOOK|SECRETS/.test(key))) {
    return "forge credential in tool env";
  }
  return undefined;
}

/**
 * The reusable offline proof. Runs against dummy credentials only:
 * permitted inference succeeds; a fresh job survives restart; concurrent
 * renewal shares one POST and cannot invalidate the other job; revocation
 * fails closed; and the tool-context view (files/helper state, env/argv,
 * endpoints, plus shell and non-shell outputs, logs, session exports modeled
 * as strings over the view) exposes no usable credential or renewal
 * authority.
 */
export async function runFreshJobBoundaryChecks(store: FreshJobCredentialStore): Promise<BoundaryProbeResult> {
  await store.persist();

  const before = store.snapshot();
  const inferenceOk = store.inference(before.access) && !store.inference("wrong-bearer");

  await store.restart();
  const afterRestart = store.snapshot();
  const restartOk = afterRestart.access === before.access && store.inference(afterRestart.access);

  const [first, second] = await Promise.all([store.refresh(), store.refresh()]);
  const concurrentOk =
    store.posts === 1 &&
    store.inference(first.access) === store.inference(second.access) &&
    store.inference(second.access);

  const exposedSecret = store.snapshot();
  const exposedView = store.childView();
  const leak = childViewLeaks(exposedView, exposedSecret);
  const shellOutput = `${exposedView.access}`;
  const logLine = `inference with ${exposedView.access}`;
  const sessionExport = JSON.stringify(exposedView);
  const exposureOk =
    leak === undefined &&
    !shellOutput.includes(exposedSecret.refresh) &&
    !logLine.includes(exposedSecret.refresh) &&
    !sessionExport.includes(exposedSecret.refresh);

  store.revoke();
  const revocationOk = !store.inference(second.access) && !store.inference("wrong-bearer");

  return { inferenceOk, restartOk, concurrentOk, revocationOk, exposureOk, refreshPosts: store.posts };
}
