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
    expect(isValidDeviceRole("control")).toBe(true);
    expect(isValidDeviceRole("router")).toBe(false);
  });

  test("sanitize drops token material", () => {
    const status = sanitizeDeviceLoginStatus(
      {
        ordinal: "w-0",
        role: "worker",
        hasXaiRunner: true,
        hasCodexRunner: true,
        authPresent: false,
        codexAuthPresent: false,
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

  test("sanitize keeps both provider flags and the active provider", () => {
    const status = sanitizeDeviceLoginStatus(
      {
        ordinal: "w-0",
        role: "worker",
        hasXaiRunner: true,
        hasCodexRunner: true,
        authPresent: true,
        codexAuthPresent: false,
        leased: false,
        provider: "codex",
        state: "waiting",
        url: "https://auth.openai.com/codex/device",
        userCode: "XXXX-XXXXX",
      },
      "w-0",
      "worker"
    );
    expect(status?.hasXaiRunner).toBe(true);
    expect(status?.hasCodexRunner).toBe(true);
    expect(status?.authPresent).toBe(true);
    expect(status?.codexAuthPresent).toBe(false);
    expect(status?.provider).toBe("codex");
    expect(status?.userCode).toBe("XXXX-XXXXX");
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
    expect(seenBody).toBe(JSON.stringify({ provider: "xai" }));
    expect(seenHeaders["x-forwarded-user"]).toBe("operator");
    expect(seenBody).not.toContain("mallory");
    expect(seenBody).not.toContain("rm -rf");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.url).toBe("https://auth.x.ai/activate");
    expect(JSON.stringify(body)).not.toContain("mallory");
  });

  test("codex start forwards only the provider and maps no-codex-runner", async () => {
    const store = new MemoryReviewJobStore();
    let seenBody = "";
    const fetchFn = async (_input: string, init?: RequestInit): Promise<Response> => {
      seenBody = (init?.body as string) ?? "";
      return new Response(JSON.stringify({ code: "no-codex-runner", state: "idle" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
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
        body: JSON.stringify({ ordinal: "jumi-worker-0", role: "worker", provider: "codex" }),
      })
    );
    expect(res.status).toBe(422);
    expect(seenBody).toBe(JSON.stringify({ provider: "codex" }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("no-codex-runner");
    expect(body.error).toContain("codex runner not configured in chain");
  });

  test("invalid provider is rejected", async () => {
    const store = new MemoryReviewJobStore();
    const handler = createBoardFetchHandler({ store, forge: "gitea", logger: () => {} });
    const res = await handler(
      new Request("https://board.test/api/board/device-login/start", {
        method: "POST",
        headers: new Headers({
          "Content-Type": "application/json",
          "X-Forwarded-User": "operator",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "board.example",
        }),
        body: JSON.stringify({ ordinal: "jumi-worker-0", role: "worker", provider: "claude" }),
      })
    );
    expect(res.status).toBe(400);
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

  test("board page sends Codex to control instead of a typed ordinal", () => {
    const html = renderBoardPage("catalog123");
    expect(html).toContain("Codex sign-in");
    expect(html).toContain("codex-link");
    expect(html).toContain("codex-code");
    expect(html).toContain("codex-expiry");
    expect(html).toContain("control");
    expect(html).toContain("Start Codex sign-in on");
    // Grok keeps the per-ordinal flow; Codex targets the always-on control role.
    expect(html).toContain("Grok sign-in");
    expect(html).toContain("write control's retained Codex auth file");
  });
});

const LEASED = "That ordinal holds a leased job; sign-in is refused until the job finishes.";
const HOST_HINT = "Enter the ordinal host (for example jumi-worker-0).";
const DEVICE_URL = "https://auth.example/device";
const USER_CODE = "ABCD-EFGH";
const TERMINAL_STATES = ["signed-in", "expired", "denied", "error", "cancelled"] as const;

type ProviderName = "grok" | "codex";

type ProviderCase = {
  id: ProviderName;
  label: string;
  provider?: "codex";
  runnerField: "hasXaiRunner" | "hasCodexRunner";
  otherRunnerField: "hasXaiRunner" | "hasCodexRunner";
  authField: "authPresent" | "codexAuthPresent";
  otherAuthField: "authPresent" | "codexAuthPresent";
  unavailable: string;
  authNote: string;
  effect: string;
  fixedOrdinal?: string;
  fixedRole?: string;
};

const PROVIDERS: readonly ProviderCase[] = [
  {
    id: "grok",
    label: "Grok",
    runnerField: "hasXaiRunner",
    otherRunnerField: "hasCodexRunner",
    authField: "authPresent",
    otherAuthField: "codexAuthPresent",
    unavailable: "Grok sign-in is unavailable on this ordinal (no OpenCode xAI runner in its chain).",
    authNote: "That ordinal already holds an xAI oauth entry (presence is not a healthy grant).",
    effect: "This will: run a Grok device login on that pod and write that pod's Grok auth file.",
  },
  {
    id: "codex",
    label: "Codex",
    provider: "codex",
    runnerField: "hasCodexRunner",
    otherRunnerField: "hasXaiRunner",
    authField: "codexAuthPresent",
    otherAuthField: "authPresent",
    unavailable: "Codex sign-in is unavailable on control (the control role owns the Codex login).",
    authNote: "Control already holds a Codex ChatGPT credential (presence is not a healthy grant).",
    effect: "This will: run a Codex device login on control and write control's retained Codex auth file.",
    fixedOrdinal: "control",
    fixedRole: "control",
  },
];

type Listener = (ev: { target?: FakeEl; key?: string; stopPropagation: () => void }) => void;

class FakeEl {
  children: FakeEl[] = [];
  className = "";
  id = "";
  type = "";
  value = "";
  href = "";
  title = "";
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  style: { display: string } = { display: "" };
  private text = "";
  private listeners: Record<string, Listener[]> = {};

  constructor(readonly tag: string) {}

  get textContent(): string {
    if (this.children.length === 0) return this.text;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.children = [];
    this.text = value == null ? "" : String(value);
  }

  appendChild(node: FakeEl): FakeEl {
    this.children.push(node);
    return node;
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners[type] ?? [];
    list.push(fn);
    this.listeners[type] = list;
  }

  emit(type: string, ev: Partial<Parameters<Listener>[0]> = {}): void {
    const event = { stopPropagation: () => {}, ...ev };
    for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
  }

  querySelector(sel: string): FakeEl | null {
    for (const child of this.children) {
      const classes = child.className.split(/\s+/);
      if (sel === "button.primary" && child.tag === "button" && classes.includes("primary")) return child;
      const found = child.querySelector(sel);
      if (found) return found;
    }
    return null;
  }

  focus(): void {}
}

type FetchCall = { url: string; init?: RequestInit };

type Endpoint = { http: number; body: Record<string, unknown>; throw: boolean };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function baseStatus(): Record<string, unknown> {
  return {
    available: true,
    state: "idle",
    hasXaiRunner: true,
    hasCodexRunner: true,
    authPresent: false,
    codexAuthPresent: false,
    leased: false,
  };
}

function startedBody(): Record<string, unknown> {
  return { state: "waiting", url: DEVICE_URL, userCode: USER_CODE, expiresAt: 1_700_000_000_000 };
}

function providerFromBody(body: BodyInit | null | undefined): ProviderName {
  return typeof body === "string" && body.includes('"provider":"codex"') ? "codex" : "grok";
}

function pageScript(html: string): string {
  const start = html.indexOf("<script>");
  const end = html.lastIndexOf("</script>");
  if (start < 0 || end < 0) throw new Error("board page is missing its script");
  return html.slice(start + "<script>".length, end);
}

function bootBoard(forge: string) {
  const byId = new Map<string, FakeEl>();
  const hidden = new Set(["load-error", "catalog-mismatch", "grant", "grok-result", "codex-result", "sheet-wrap"]);
  const ids = [
    "forge-switch",
    "refresh",
    "sheet-backdrop",
    "sheet-wrap",
    "sheet",
    "load-error",
    "catalog-mismatch",
    "grant",
    "inspector",
    "inprogress",
    "sitting",
    "grok",
    "grok-role",
    "grok-ordinal",
    "grok-check",
    "grok-start",
    "grok-cancel",
    "grok-note",
    "grok-result",
    "grok-link",
    "grok-code",
    "grok-expiry",
    "grok-state",
    "codex",
    "codex-role",
    "codex-ordinal",
    "codex-check",
    "codex-start",
    "codex-cancel",
    "codex-note",
    "codex-result",
    "codex-link",
    "codex-code",
    "codex-expiry",
    "codex-state",
  ];
  for (const id of ids) {
    const el = new FakeEl("div");
    el.id = id;
    el.hidden = hidden.has(id);
    if (id === "forge-switch") el.value = "gitea";
    if (id.endsWith("-role")) el.value = "worker";
    byId.set(id, el);
  }
  const documentStub = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => {
      const node = new FakeEl("#text");
      node.textContent = text;
      return node;
    },
    addEventListener: (_type: string, _fn: Listener) => {},
  };
  const windowStub = {
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  };
  const calls: FetchCall[] = [];
  const statusSpec: Record<ProviderName, Endpoint> = {
    grok: { http: 200, body: baseStatus(), throw: false },
    codex: { http: 200, body: baseStatus(), throw: false },
  };
  const startSpec: Record<ProviderName, Endpoint> = {
    grok: { http: 200, body: startedBody(), throw: false },
    codex: { http: 200, body: startedBody(), throw: false },
  };
  const cancelSpec: Record<ProviderName, Endpoint> = {
    grok: { http: 200, body: { ok: true }, throw: false },
    codex: { http: 200, body: { ok: true }, throw: false },
  };
  const timers: { id: number; ms: number; fn: () => void }[] = [];
  const owners = new Map<number, ProviderName>();
  let nextTimer = 1;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/board") {
      return jsonResponse(200, {
        forge,
        catalog: "catalog123",
        in_progress: [],
        sitting: [],
        needs_kick: [],
        grant: "",
      });
    }
    if (url.startsWith("/api/board/device-login/status")) {
      const id: ProviderName = url.includes("provider=codex") ? "codex" : "grok";
      const spec = statusSpec[id];
      if (spec.throw) throw new Error("network");
      return jsonResponse(spec.http, spec.body);
    }
    if (url === "/api/board/device-login/start" || url === "/api/board/device-login/cancel") {
      const id = providerFromBody(init?.body);
      const spec = url.endsWith("/start") ? startSpec[id] : cancelSpec[id];
      if (spec.throw) throw new Error("network");
      return jsonResponse(spec.http, spec.body);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const run = new Function(
    "document",
    "window",
    "fetch",
    "setInterval",
    "clearInterval",
    pageScript(renderBoardPage("catalog123"))
  );
  run(
    documentStub,
    windowStub,
    fetchImpl,
    (fn: () => void, ms: number) => {
      const id = nextTimer++;
      timers.push({ id, ms, fn });
      return id;
    },
    (id: number) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    }
  );
  const el = (id: string) => {
    const found = byId.get(id);
    if (!found) throw new Error(`missing #${id}`);
    return found;
  };
  const sheet = () => el("sheet");
  return {
    calls,
    el,
    async settle() {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    press(target: FakeEl) {
      target.emit("click");
    },
    chooseForge(next: string) {
      const forgeSwitch = el("forge-switch");
      forgeSwitch.value = next;
      forgeSwitch.emit("change", { target: forgeSwitch });
    },
    setStatus(id: ProviderName, body: Record<string, unknown>, http = 200) {
      statusSpec[id] = { http, body, throw: false };
    },
    setStatusThrow(id: ProviderName) {
      statusSpec[id] = { http: 200, body: baseStatus(), throw: true };
    },
    setStart(id: ProviderName, http: number, body: Record<string, unknown> = startedBody()) {
      startSpec[id] = { http, body, throw: false };
    },
    setStartThrow(id: ProviderName) {
      startSpec[id] = { http: 200, body: startedBody(), throw: true };
    },
    setCancel(id: ProviderName, http: number) {
      cancelSpec[id] = { http, body: { ok: true }, throw: false };
    },
    setCancelThrow(id: ProviderName) {
      cancelSpec[id] = { http: 200, body: { ok: true }, throw: true };
    },
    pollIds() {
      return timers.filter((timer) => timer.ms === 5000).map((timer) => timer.id);
    },
    notePoll(id: ProviderName, before: ReadonlySet<number>) {
      const added = this.pollIds().filter((timerId) => !before.has(timerId));
      expect(added).toHaveLength(1);
      const timerId = added[0];
      if (timerId === undefined) throw new Error("missing poll id");
      owners.set(timerId, id);
    },
    pollsFor(id: ProviderName) {
      return timers.filter((timer) => timer.ms === 5000 && owners.get(timer.id) === id).length;
    },
    async firePolls() {
      const fns = timers.filter((timer) => timer.ms === 5000).map((timer) => timer.fn);
      for (const fn of fns) fn();
      await this.settle();
    },
    primary() {
      const button = sheet().querySelector("button.primary");
      if (!button) throw new Error("confirm sheet has no primary button");
      return button;
    },
    message() {
      const subs = sheet().children.filter((child) => child.className === "sub");
      const msg = subs[subs.length - 1];
      if (!msg) throw new Error("confirm sheet has no message");
      return msg;
    },
  };
}

function statusCalls(calls: FetchCall[], id: ProviderName): FetchCall[] {
  return calls.filter((call) => {
    if (!call.url.startsWith("/api/board/device-login/status?")) return false;
    const codex = call.url.includes("provider=codex");
    return id === "codex" ? codex : !codex;
  });
}

function writeCalls(calls: FetchCall[], path: string, id: ProviderName): FetchCall[] {
  return calls.filter((call) => call.url === path && providerFromBody(call.init?.body) === id);
}

describe("board device login page client", () => {
  test("the page ships one device-login client and still posts kicks", () => {
    const script = pageScript(renderBoardPage("catalog123"));
    expect(script.match(/setInterval\(/g)).toHaveLength(2);
    expect(script.match(/\["signed-in", "expired", "denied", "error", "cancelled"\]/g)).toHaveLength(1);
    expect(script.match(/signed-in/g)).toHaveLength(1);
    expect(script.match(/mountDeviceLogin\(/g)).toHaveLength(3);
    expect(script.match(/\/api\/board\/device-login\/start/g)).toHaveLength(1);
    expect(script.match(/\/api\/board\/device-login\/cancel/g)).toHaveLength(1);
    expect(script.match(/provider: "codex"/g)).toHaveLength(1);
    expect(script).toContain('runnerField: "hasXaiRunner"');
    expect(script).toContain('runnerField: "hasCodexRunner"');
    expect(script).toContain('authField: "authPresent"');
    expect(script).toContain('authField: "codexAuthPresent"');
    expect(script).toContain('"/api/board/kick"');
    expect(script).not.toContain("fetchGrokStatus");
    expect(script).not.toContain("fetchCodexStatus");
  });

  test("github hides both sections, including when only the loaded forge is github", async () => {
    const gitea = bootBoard("gitea");
    await gitea.settle();
    expect(gitea.el("grok").style.display).toBe("");
    expect(gitea.el("codex").style.display).toBe("");
    gitea.chooseForge("github");
    expect(gitea.el("grok").style.display).toBe("none");
    expect(gitea.el("codex").style.display).toBe("none");
    gitea.chooseForge("gitea");
    expect(gitea.el("grok").style.display).toBe("");
    expect(gitea.el("codex").style.display).toBe("");

    const github = bootBoard("github");
    await github.settle();
    expect(github.el("grok").style.display).toBe("none");
    expect(github.el("codex").style.display).toBe("none");
    github.chooseForge("gitea");
    expect(github.el("grok").style.display).toBe("none");
    expect(github.el("codex").style.display).toBe("none");
  });

  test("each provider keeps its own fields, confirm sheet, and shared stop list", async () => {
    const page = bootBoard("gitea");
    await page.settle();

    for (const provider of PROVIDERS) {
      const ordinal = page.el(`${provider.id}-ordinal`);
      const role = page.el(`${provider.id}-role`);
      const note = page.el(`${provider.id}-note`);
      const start = page.el(`${provider.id}-start`);
      const result = page.el(`${provider.id}-result`);

      ordinal.value = "";
      page.press(start);
      if (provider.fixedOrdinal) {
        // Codex targets control: no typed ordinal, so empty input still opens control confirm.
        expect(page.el("sheet-wrap").hidden).toBe(false);
        const sheetEl = page.el("sheet");
        const closeBtn = sheetEl.children.find((child) => child.tag === "button" && child.className === "secondary");
        if (!closeBtn) throw new Error("missing close button");
        page.press(closeBtn);
        expect(page.el("sheet-wrap").hidden).toBe(true);
        const beforeCheck = page.calls.length;
        page.press(page.el(`${provider.id}-check`));
        await page.settle();
        const check = page.calls[beforeCheck];
        if (!check) throw new Error("missing status request");
        expect(check.url).toBe("/api/board/device-login/status?ordinal=control&role=control&provider=codex");
      } else {
        expect(note.textContent).toBe(HOST_HINT);
        expect(page.el("sheet-wrap").hidden).toBe(true);
        page.press(page.el(`${provider.id}-check`));
        expect(note.textContent).toBe(HOST_HINT);
        page.press(page.el(`${provider.id}-cancel`));
        expect(note.textContent).toBe("Enter the ordinal host first.");
        expect(statusCalls(page.calls, provider.id)).toHaveLength(0);
        expect(writeCalls(page.calls, "/api/board/device-login/start", provider.id)).toHaveLength(0);
        expect(writeCalls(page.calls, "/api/board/device-login/cancel", provider.id)).toHaveLength(0);
      }

      if (provider.fixedOrdinal) {
        ordinal.value = "ignored-ordinal";
        role.value = "ignored-role";
        const beforeCheck = page.calls.length;
        page.press(page.el(`${provider.id}-check`));
        await page.settle();
        const check = page.calls[beforeCheck];
        if (!check) throw new Error("missing status request");
        expect(check.url).toBe("/api/board/device-login/status?ordinal=control&role=control&provider=codex");
        expect(check.init?.method).toBeUndefined();
        expect(check.init?.cache).toBe("no-store");
        expect(check.init?.credentials).toBe("same-origin");
        expect(check.init?.headers).toEqual({ Accept: "application/json" });

        role.value = "engine";
        role.emit("change");
        await page.settle();
        const roleCheck = statusCalls(page.calls, provider.id).at(-1);
        expect(roleCheck?.url).toContain("role=control");
        expect(roleCheck?.url).toContain("ordinal=control");
      } else {
        ordinal.value = "  jumi-worker-0  ";
        role.value = "nope";
        const beforeCheck = page.calls.length;
        page.press(page.el(`${provider.id}-check`));
        await page.settle();
        const check = page.calls[beforeCheck];
        if (!check) throw new Error("missing status request");
        expect(check.url).toBe("/api/board/device-login/status?ordinal=jumi-worker-0&role=worker");
        expect(check.init?.method).toBeUndefined();
        expect(check.init?.cache).toBe("no-store");
        expect(check.init?.credentials).toBe("same-origin");
        expect(check.init?.headers).toEqual({ Accept: "application/json" });
        expect(check.url.includes("provider=xai")).toBe(false);

        role.value = "engine";
        role.emit("change");
        await page.settle();
        const roleCheck = statusCalls(page.calls, provider.id).at(-1);
        expect(roleCheck?.url).toContain("role=engine");
        expect(roleCheck?.url).toContain("ordinal=jumi-worker-0");
      }

      page.setStatus(provider.id, {
        ...baseStatus(),
        [provider.runnerField]: false,
        [provider.otherRunnerField]: true,
      });
      page.press(page.el(`${provider.id}-check`));
      await page.settle();
      expect(note.textContent).toBe(provider.unavailable);
      expect(start.style.display).toBe("none");
      expect(result.hidden).toBe(true);

      page.setStatus(provider.id, {
        ...baseStatus(),
        [provider.runnerField]: true,
        [provider.authField]: false,
        [provider.otherAuthField]: true,
        state: "idle",
      });
      page.press(page.el(`${provider.id}-check`));
      await page.settle();
      expect(note.textContent).toBe("");
      expect(start.style.display).toBe("");
      expect(result.hidden).toBe(false);
      expect(page.el(`${provider.id}-link`).style.display).toBe("none");
      expect(page.el(`${provider.id}-code`).style.display).toBe("none");

      page.setStatus(provider.id, {
        ...baseStatus(),
        [provider.runnerField]: true,
        state: "waiting",
      });
      page.press(page.el(`${provider.id}-check`));
      await page.settle();
      expect(note.textContent).toBe("");
      expect(page.el(`${provider.id}-state`).textContent).toBe("State: waiting");

      page.setStatus(provider.id, {
        ...baseStatus(),
        [provider.runnerField]: true,
        [provider.authField]: true,
        leased: true,
        state: "waiting",
      });
      page.press(page.el(`${provider.id}-check`));
      await page.settle();
      expect(note.textContent).toBe(LEASED);

      page.setStatus(provider.id, {
        ...baseStatus(),
        [provider.runnerField]: true,
        [provider.authField]: true,
        leased: false,
        state: "idle",
      });
      page.press(page.el(`${provider.id}-check`));
      await page.settle();
      expect(note.textContent).toBe(provider.authNote);

      page.setStatus(provider.id, { ...baseStatus(), state: "idle" }, 401);
      page.press(page.el(`${provider.id}-check`));
      await page.settle();
      expect(note.textContent).toBe("Sign in via the edge proxy, then check again.");

      page.setStatus(provider.id, { ...baseStatus() }, 502);
      page.press(page.el(`${provider.id}-check`));
      await page.settle();
      expect(note.textContent).toBe("Ordinal unavailable (502). The router reaches it once the chart change lands.");
      expect(result.hidden).toBe(true);

      page.setStatusThrow(provider.id);
      page.press(page.el(`${provider.id}-check`));
      await page.settle();
      expect(note.textContent).toBe("Ordinal unavailable. The router reaches it once the chart change lands.");

      page.setStatus(provider.id, { ...baseStatus(), state: "idle" });
      if (provider.fixedOrdinal) {
        ordinal.value = "ignored-ordinal";
        role.value = "ignored-role";
      } else {
        ordinal.value = "jumi-worker-0";
        role.value = "engine";
      }
      page.press(start);
      expect(page.el("sheet-wrap").hidden).toBe(false);
      const sheet = page.el("sheet");
      const expectedTarget = provider.fixedOrdinal ?? "jumi-worker-0";
      expect(sheet.children.find((child) => child.tag === "h2")?.textContent).toBe(
        `Start ${provider.label} sign-in on ${expectedTarget}?`
      );
      expect(sheet.children.find((child) => child.className === "sub")?.textContent).toBe(
        provider.fixedOrdinal ? "control role" : "engine ordinal jumi-worker-0"
      );
      expect(sheet.children.find((child) => child.className === "consequence")?.textContent).toBe(provider.effect);
      const primaryButtons = sheet.children.filter((child) => child.tag === "button" && child.className === "primary");
      const closeButtons = sheet.children.filter((child) => child.tag === "button" && child.className === "secondary");
      expect(primaryButtons).toHaveLength(1);
      expect(closeButtons).toHaveLength(1);
      expect(primaryButtons[0]?.textContent).toBe(`Start ${provider.label} sign-in on ${expectedTarget}`);
      expect(primaryButtons[0]?.type).toBe("button");
      expect(closeButtons[0]?.textContent).toBe("Close");
      page.press(closeButtons[0] as FakeEl);
      expect(page.el("sheet-wrap").hidden).toBe(true);

      page.press(start);
      const errors: Array<{ status: number; message: string; throw?: boolean }> = [
        { status: 409, message: LEASED },
        { status: 422, message: provider.unavailable },
        { status: 401, message: "Sign in via the edge proxy, then try again." },
        { status: 403, message: "Forbidden origin." },
        { status: 500, message: "Sign-in did not start (500)." },
        { status: 0, message: "Sign-in did not start.", throw: true },
      ];
      for (const error of errors) {
        const before = writeCalls(page.calls, "/api/board/device-login/start", provider.id).length;
        if (error.throw) page.setStartThrow(provider.id);
        else page.setStart(provider.id, error.status);
        const beforePolls = new Set(page.pollIds());
        page.press(page.primary());
        page.press(page.primary());
        await page.settle();
        const writes = writeCalls(page.calls, "/api/board/device-login/start", provider.id);
        expect(writes).toHaveLength(before + 1);
        expect(page.pollIds().filter((id) => !beforePolls.has(id))).toHaveLength(0);
        expect(page.el("sheet-wrap").hidden).toBe(false);
        expect(page.message().textContent).toBe(error.message);
        expect(page.primary().disabled).toBe(false);
      }
      const startCall = writeCalls(page.calls, "/api/board/device-login/start", provider.id).at(-1);
      expect(startCall?.init?.method).toBe("POST");
      expect(startCall?.init?.credentials).toBe("same-origin");
      expect(startCall?.init?.headers).toEqual({ "Content-Type": "application/json", Accept: "application/json" });
      expect(JSON.parse(String(startCall?.init?.body))).toEqual(
        provider.fixedOrdinal
          ? { ordinal: "control", role: "control", provider: "codex" }
          : provider.provider
            ? { ordinal: "jumi-worker-0", role: "engine", provider: "codex" }
            : { ordinal: "jumi-worker-0", role: "engine" }
      );

      page.setStart(provider.id, 200);
      const beforePolls = new Set(page.pollIds());
      page.press(page.primary());
      await page.settle();
      page.notePoll(provider.id, beforePolls);
      expect(page.el("sheet-wrap").hidden).toBe(true);
      expect(page.message().textContent).toBe("Working\u2026");
      expect(page.pollsFor(provider.id)).toBe(1);
      expect(result.hidden).toBe(false);
      expect(start.style.display).toBe("");
      expect(page.el(`${provider.id}-link`).href).toBe(DEVICE_URL);
      expect(page.el(`${provider.id}-link`).textContent).toBe("Open provider page");
      expect(page.el(`${provider.id}-code`).textContent).toBe(USER_CODE);
      expect(page.el(`${provider.id}-expiry`).textContent.startsWith("Code expires ")).toBe(true);
      expect(page.el(`${provider.id}-state`).textContent).toBe("State: waiting");
      expect(note.textContent).not.toBe(provider.unavailable);
      expect(note.textContent).not.toBe(provider.authNote);

      page.setCancel(provider.id, 500);
      page.press(page.el(`${provider.id}-cancel`));
      await page.settle();
      expect(note.textContent).toBe("Cancel did not land (500).");
      expect(page.pollsFor(provider.id)).toBe(1);
      page.setCancelThrow(provider.id);
      page.press(page.el(`${provider.id}-cancel`));
      await page.settle();
      expect(note.textContent).toBe("Cancel did not land.");
      expect(page.pollsFor(provider.id)).toBe(1);

      page.setCancel(provider.id, 200);
      page.setStatus(provider.id, { ...baseStatus(), state: "waiting", url: DEVICE_URL, userCode: USER_CODE });
      page.press(page.el(`${provider.id}-cancel`));
      await page.settle();
      const cancelCall = writeCalls(page.calls, "/api/board/device-login/cancel", provider.id).at(-1);
      expect(cancelCall?.init?.method).toBe("POST");
      expect(cancelCall?.init?.credentials).toBe("same-origin");
      expect(cancelCall?.init?.headers).toEqual({ "Content-Type": "application/json", Accept: "application/json" });
      expect(JSON.parse(String(cancelCall?.init?.body))).toEqual(
        provider.fixedOrdinal
          ? { ordinal: "control", role: "control", provider: "codex" }
          : provider.provider
            ? { ordinal: "jumi-worker-0", role: "engine", provider: "codex" }
            : { ordinal: "jumi-worker-0", role: "engine" }
      );
      expect(page.pollsFor(provider.id)).toBe(0);
      expect(note.textContent).toBe("Sign-in cancelled.");
    }

    for (const provider of PROVIDERS) {
      page.el(`${provider.id}-ordinal`).value = "jumi-worker-0";
      page.el(`${provider.id}-role`).value = "worker";
      page.setStart(provider.id, 200);
      page.press(page.el(`${provider.id}-start`));
      const beforePolls = new Set(page.pollIds());
      page.press(page.primary());
      await page.settle();
      page.notePoll(provider.id, beforePolls);
    }
    expect(page.pollsFor("grok")).toBe(1);
    expect(page.pollsFor("codex")).toBe(1);

    for (const provider of PROVIDERS) {
      const other: ProviderName = provider.id === "grok" ? "codex" : "grok";
      for (const state of [...TERMINAL_STATES, "waiting", "idle", "pending"]) {
        if (page.pollsFor(provider.id) === 0) {
          page.press(page.el(`${provider.id}-start`));
          const beforePolls = new Set(page.pollIds());
          page.press(page.primary());
          await page.settle();
          page.notePoll(provider.id, beforePolls);
        }
        page.setStatus(provider.id, { ...baseStatus(), state, url: DEVICE_URL, userCode: USER_CODE });
        page.setStatus(other, { ...baseStatus(), state: "waiting", url: DEVICE_URL, userCode: USER_CODE });
        const otherPolls = page.pollsFor(other);
        await page.firePolls();
        const stopped = (TERMINAL_STATES as readonly string[]).includes(state);
        expect({ provider: provider.id, state, polls: page.pollsFor(provider.id) }).toEqual({
          provider: provider.id,
          state,
          polls: stopped ? 0 : 1,
        });
        expect(page.pollsFor(other)).toBe(otherPolls);
      }
    }

    page.setStatus("grok", { ...baseStatus(), state: "waiting", url: DEVICE_URL, userCode: USER_CODE });
    const note = page.el("grok-note");
    note.textContent = "keep me";
    page.setStatus("grok", { ...baseStatus() }, 401);
    await page.firePolls();
    expect(note.textContent).toBe("keep me");
    expect(page.pollsFor("grok")).toBe(1);
    page.setStatusThrow("grok");
    await page.firePolls();
    expect(note.textContent).toBe("keep me");
    expect(page.pollsFor("grok")).toBe(1);
    expect(page.el("grok-result").hidden).toBe(true);
  });
});
