import { afterAll } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFilePath } from "../../src/claim.ts";
import { memorySkipLatchesFor } from "../../src/skip_latches.ts";

const WRITE_METHODS = new Set([
  "createIssueComment",
  "updateIssueComment",
  "createCommitStatus",
  "createPullRequest",
  "closePullRequest",
  "reopenPullRequest",
  "updatePullRequestBody",
  "addIssueLabel",
  "addIssueAssignees",
  "createPullReview",
  "submitPullReview",
  "dismissPullReview",
  "resolvePullComment",
  "unresolvePullComment",
  "deleteGitRef",
  "scheduleAutoMerge",
  "cancelAutoMerge",
]);

const HARNESS_PROPS = new Set(["calls", "callsTo", "comments", "pulls", "commentIndexes"]);

const LEDGER_METHODS = new Set(["markPublished", "setIssueSkipReason", "enqueueIssue"]);

export function normalizeString(input: string): string {
  let out = input;
  const tmp = tmpdir();
  if (tmp && out.includes(tmp)) out = out.split(tmp).join("<tmpdir>");
  out = out.replace(/\/tmp\/[^\s"'`,\]}]*/g, "<tmpdir>");
  out = out.replace(/\/private\/tmp\/[^\s"'`,\]}]*/g, "<tmpdir>");
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<iso>");
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  out = out.replace(/"pid":\s*\d+/g, '"pid":"<pid>"');
  out = out.replace(/\bpid=\d+\b/g, "pid=<pid>");
  return out;
}

export function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      if (typeof entry === "function") continue;
      if ((key === "pid" || key === "ppid") && typeof entry === "number") {
        out[key] = entry === 0 ? 0 : "<pid>";
        continue;
      }
      out[key] = normalizeValue(entry);
    }
    return out;
  }
  return value;
}

function sortedClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      out[key] = sortedClone(entry);
    }
    return out;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortedClone(value), null, 2)}\n`;
}

export function compareObjects(actual: unknown, expected: unknown, label: string): void {
  const actualText = stableStringify(actual);
  const expectedText = stableStringify(expected);
  if (actualText === expectedText) return;
  const actualLines = actualText.split("\n");
  const expectedLines = expectedText.split("\n");
  const length = Math.max(actualLines.length, expectedLines.length);
  let first = 0;
  for (let index = 0; index < length; index++) {
    if (actualLines[index] !== expectedLines[index]) {
      first = index;
      break;
    }
  }
  const start = Math.max(0, first - 3);
  const context: string[] = [];
  for (let index = start; index < Math.min(length, first + 12); index++) {
    const marker = actualLines[index] === expectedLines[index] ? " " : "|";
    context.push(`${marker} expected:${expectedLines[index] ?? "<eof>"}`);
    context.push(`${marker} actual:  ${actualLines[index] ?? "<eof>"}`);
    if (context.length > 40) break;
  }
  throw new Error(`${label} mismatch at line ${first + 1}:\n${context.join("\n")}`);
}

interface TraceContext {
  effects: Array<Record<string, unknown>>;
  reads: Record<string, number>;
  nextSeq: number;
}

interface PendingFile {
  decisions: Map<string, unknown>;
  reads: Map<string, unknown>;
  registered: boolean;
  counter: number;
}

const pendingByFile = new Map<string, PendingFile>();

function goldenDir(): string {
  return import.meta.dir;
}

function baseForFile(testFile: string): string {
  return testFile.replace(/\.test\.ts$/, "");
}

function detectTestFile(): string | undefined {
  const stack = new Error("trace").stack ?? "";
  for (const line of stack.split("\n")) {
    const match = /([^/\\:]+\.test\.ts)/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function pendingFor(file: string): PendingFile {
  let pending = pendingByFile.get(file);
  if (!pending) {
    pending = { decisions: new Map(), reads: new Map(), registered: false, counter: 0 };
    pendingByFile.set(file, pending);
  }
  return pending;
}

export function __peekPending(file: string): PendingFile | undefined {
  return pendingByFile.get(file);
}

export function __resetPending(): void {
  pendingByFile.clear();
}

function extractInput(name: string, args: unknown[]): unknown {
  try {
    if (name === "processWorkerTick") {
      const config = (args[1] as Record<string, unknown> | undefined) ?? {};
      const leasedBy = args[3];
      return normalizeValue({
        leasedBy: typeof leasedBy === "string" ? leasedBy : undefined,
        botUsername: typeof config.botUsername === "string" ? config.botUsername : undefined,
      });
    }
    const opts = (args[0] as Record<string, unknown> | undefined) ?? {};
    const out: Record<string, unknown> = {};
    const job = opts.job as Record<string, unknown> | undefined;
    if (job && typeof job === "object") {
      const trigger = job.trigger as Record<string, unknown> | undefined;
      out.job = {
        mode: job.mode,
        action: job.action,
        triggerEvent: trigger?.event,
        triggerSender: trigger?.sender,
        headSha: job.headSha,
        prNumber: job.prNumber,
        issueNumber: job.issueNumber,
        owner: job.owner,
        repo: job.repo,
      };
    }
    const pr = opts.pr as Record<string, unknown> | undefined;
    if (pr && typeof pr === "object") {
      const head = pr.head as Record<string, unknown> | undefined;
      const base = pr.base as Record<string, unknown> | undefined;
      out.pr = {
        number: pr.number,
        mergeable: (pr as Record<string, unknown>).mergeable,
        state: pr.state,
        headRef: head?.ref,
        headSha: head?.sha,
        baseRef: base?.ref,
        baseSha: base?.sha,
      };
    }
    const row = opts.row as Record<string, unknown> | undefined;
    if (row && typeof row === "object") {
      out.row = {
        owner: row.owner,
        repo: row.repo,
        prNumber: row.prNumber,
        headSha: row.headSha,
        kind: row.kind,
        issueNumber: row.issueNumber,
      };
    }
    if (typeof opts.owner === "string") out.owner = opts.owner;
    if (typeof opts.repo === "string") out.repo = opts.repo;
    if (typeof opts.issueNumber === "number") out.issueNumber = opts.issueNumber;
    if (typeof opts.sha === "string") out.sha = opts.sha;
    if (opts.published && typeof opts.published === "object") {
      out.published = (opts.published as Record<string, unknown>).status;
    }
    if (typeof opts.markdown === "string") out.markdown = opts.markdown;
    return normalizeValue(out);
  } catch {
    return {};
  }
}

function findLatchKey(name: string, args: unknown[]): { owner: string; repo: string; issueNumber: number } | undefined {
  try {
    if (name === "processWorkerTick") return undefined;
    const opts = (args[0] as Record<string, unknown> | undefined) ?? {};
    const job = opts.job as Record<string, unknown> | undefined;
    if (job && typeof job.owner === "string" && typeof job.repo === "string" && typeof job.issueNumber === "number") {
      return { owner: job.owner as string, repo: job.repo as string, issueNumber: job.issueNumber as number };
    }
    if (typeof opts.owner === "string" && typeof opts.repo === "string" && typeof opts.issueNumber === "number") {
      return {
        owner: opts.owner as string,
        repo: opts.repo as string,
        issueNumber: opts.issueNumber as number,
      };
    }
    const row = opts.row as Record<string, unknown> | undefined;
    if (row && typeof row.owner === "string" && typeof row.repo === "string") {
      const issueNumber =
        typeof row.issueNumber === "number"
          ? (row.issueNumber as number)
          : typeof row.prNumber === "number"
            ? (row.prNumber as number)
            : undefined;
      if (issueNumber !== undefined) return { owner: row.owner as string, repo: row.repo as string, issueNumber };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function findHome(name: string, args: unknown[]): string | undefined {
  try {
    if (name === "processWorkerTick") {
      const config = args[1] as Record<string, unknown> | undefined;
      return typeof config?.home === "string" ? (config.home as string) : undefined;
    }
    const opts = args[0] as Record<string, unknown> | undefined;
    return typeof opts?.home === "string" ? (opts.home as string) : undefined;
  } catch {
    return undefined;
  }
}

async function readLatchSnapshot(
  stores: Array<{ get: (key: { owner: string; repo: string; issueNumber: number }) => Promise<unknown> }>,
  key: { owner: string; repo: string; issueNumber: number } | undefined
): Promise<unknown> {
  if (!key) return null;
  for (const store of stores) {
    try {
      const record = await store.get(key);
      return normalizeValue(record);
    } catch {}
  }
  return null;
}

async function claimExists(
  home: string | undefined,
  key: { owner: string; repo: string; issueNumber: number } | undefined
): Promise<boolean | null> {
  if (!home || !key) return null;
  try {
    const path = claimFilePath(home, key.owner, key.repo, key.issueNumber);
    const file = Bun.file(path);
    return await file.exists();
  } catch {
    return null;
  }
}

function proxifyApi<T extends object>(api: T, ctx: TraceContext): T {
  const proxy = new Proxy(api, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (HARNESS_PROPS.has(prop)) return (value as (...a: unknown[]) => unknown).bind(target);
      if (WRITE_METHODS.has(prop)) {
        return (...methodArgs: unknown[]) => {
          const seq = ctx.nextSeq++;
          let result: unknown;
          try {
            result = (value as (...a: unknown[]) => unknown).apply(target, methodArgs);
          } catch (error) {
            ctx.effects.push(
              normalizeValue({ seq, seam: "forge", method: prop, args: methodArgs }) as Record<string, unknown>
            );
            throw error;
          }
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>).then(
              (resolved) => {
                ctx.effects.push(
                  normalizeValue({ seq, seam: "forge", method: prop, args: methodArgs }) as Record<string, unknown>
                );
                return resolved;
              },
              (error) => {
                ctx.effects.push(
                  normalizeValue({ seq, seam: "forge", method: prop, args: methodArgs }) as Record<string, unknown>
                );
                throw error;
              }
            );
          }
          ctx.effects.push(
            normalizeValue({ seq, seam: "forge", method: prop, args: methodArgs }) as Record<string, unknown>
          );
          return result;
        };
      }
      return (...methodArgs: unknown[]) => {
        if (prop !== "constructor") ctx.reads[prop] = (ctx.reads[prop] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(target, methodArgs);
      };
    },
  });
  return proxy;
}

interface PatchHandle {
  restore: () => void;
}

function patchLatchStore(store: { put?: unknown; delete?: unknown }, ctx: TraceContext): PatchHandle {
  if (!store || typeof store !== "object") return { restore: () => undefined };
  const target = store as Record<string, unknown>;
  const originalPut = target.put;
  const originalDelete = target.delete;
  if (typeof originalPut === "function") {
    target.put = async (...methodArgs: unknown[]) => {
      const seq = ctx.nextSeq++;
      const key = (methodArgs[0] as Record<string, unknown> | undefined) ?? {};
      const patch = (methodArgs[1] as Record<string, unknown> | undefined) ?? {};
      const outcome = await (originalPut as (...a: unknown[]) => Promise<unknown>).apply(store, methodArgs);
      ctx.effects.push(
        normalizeValue({
          seq,
          seam: "latch",
          op: "put",
          key: { owner: key.owner, repo: key.repo, issueNumber: key.issueNumber },
          patch,
        }) as Record<string, unknown>
      );
      return outcome;
    };
  }
  if (typeof originalDelete === "function") {
    target.delete = async (...methodArgs: unknown[]) => {
      const seq = ctx.nextSeq++;
      const key = (methodArgs[0] as Record<string, unknown> | undefined) ?? {};
      const outcome = await (originalDelete as (...a: unknown[]) => Promise<unknown>).apply(store, methodArgs);
      ctx.effects.push(
        normalizeValue({
          seq,
          seam: "latch",
          op: "delete",
          key: { owner: key.owner, repo: key.repo, issueNumber: key.issueNumber },
        }) as Record<string, unknown>
      );
      return outcome;
    };
  }
  return {
    restore: () => {
      if (typeof originalPut === "function") target.put = originalPut;
      if (typeof originalDelete === "function") target.delete = originalDelete;
    },
  };
}

function patchLedgerStore(store: Record<string, unknown>, ctx: TraceContext): PatchHandle {
  const originals = new Map<string, unknown>();
  const restores: Array<() => void> = [];
  for (const method of LEDGER_METHODS) {
    const original = store[method];
    if (typeof original !== "function") continue;
    originals.set(method, original);
    store[method] = async (...methodArgs: unknown[]) => {
      const seq = ctx.nextSeq++;
      const outcome = await (original as (...a: unknown[]) => Promise<unknown>).apply(store, methodArgs);
      const summary: Record<string, unknown> = { seq, seam: "ledger", method };
      if (method === "markPublished") {
        const result = (methodArgs[2] as Record<string, unknown> | undefined) ?? {};
        summary.state = result.state;
        summary.reason = result.reason;
      } else if (method === "setIssueSkipReason") {
        summary.owner = methodArgs[0];
        summary.repo = methodArgs[1];
        summary.issueNumber = methodArgs[2];
        summary.reason = methodArgs[3];
      } else if (method === "enqueueIssue") {
        const job = (methodArgs[0] as Record<string, unknown> | undefined) ?? {};
        summary.mode = job.mode;
        summary.headSha = job.headSha;
        summary.prNumber = job.prNumber;
        summary.issueNumber = job.issueNumber;
      }
      ctx.effects.push(normalizeValue(summary) as Record<string, unknown>);
      return outcome;
    };
    restores.push(() => {
      store[method] = original;
    });
  }
  const sits = store.sits as Record<string, unknown> | undefined;
  if (sits && typeof sits === "object") {
    for (const method of ["remember", "clear"]) {
      const original = sits[method];
      if (typeof original !== "function") continue;
      sits[method] = async (...methodArgs: unknown[]) => {
        const seq = ctx.nextSeq++;
        const outcome = await (original as (...a: unknown[]) => Promise<unknown>).apply(sits, methodArgs);
        ctx.effects.push(
          normalizeValue({ seq, seam: "sits", op: method, args: methodArgs }) as Record<string, unknown>
        );
        return outcome;
      };
      restores.push(() => {
        sits[method] = original;
      });
    }
  }
  return {
    restore: () => {
      for (const restore of restores) restore();
    },
  };
}

async function flushFile(testFile: string): Promise<void> {
  const pending = pendingByFile.get(testFile);
  if (!pending || pending.decisions.size === 0) return;
  const base = baseForFile(testFile);
  const decisionsObj: Record<string, unknown> = {};
  for (const key of [...pending.decisions.keys()].sort()) decisionsObj[key] = pending.decisions.get(key);
  const readsObj: Record<string, unknown> = {};
  for (const key of [...pending.reads.keys()].sort()) readsObj[key] = pending.reads.get(key);
  const decisionsText = stableStringify(decisionsObj);
  const readsText = stableStringify(readsObj);
  const decisionsPath = join(goldenDir(), `${base}.decisions.json`);
  const readsPath = join(goldenDir(), `${base}.reads.json`);
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(goldenDir(), { recursive: true });
    await writeFile(decisionsPath, decisionsText);
    await writeFile(readsPath, readsText);
    return;
  }
  let expectedDecisions = "";
  let expectedReads = "";
  try {
    expectedDecisions = await readFile(decisionsPath, "utf8");
  } catch {
    throw new Error(`golden missing: ${decisionsPath}. Run UPDATE_GOLDEN=1 bun test ${testFile} to create it.`);
  }
  try {
    expectedReads = await readFile(readsPath, "utf8");
  } catch {
    throw new Error(`golden missing: ${readsPath}. Run UPDATE_GOLDEN=1 bun test ${testFile} to create it.`);
  }
  compareObjects(JSON.parse(decisionsText), JSON.parse(expectedDecisions), `${base}.decisions.json`);
  compareObjects(JSON.parse(readsText), JSON.parse(expectedReads), `${base}.reads.json`);
}

export function traced<T extends (...args: never[]) => unknown>(name: string, fn: T): T {
  const ownerFile = detectTestFile() ?? "unknown.test.ts";
  if (ownerFile !== "trace.test.ts" && ownerFile.endsWith(".test.ts")) {
    const pending = pendingFor(ownerFile);
    if (!pending.registered) {
      pending.registered = true;
      afterAll(async () => {
        await flushFile(ownerFile);
      });
    }
  }
  const wrapped = (async (...args: never[]) => {
    if (ownerFile === "trace.test.ts") return (fn as (...a: never[]) => unknown)(...args);
    const pending = pendingFor(ownerFile);
    const ordinal = pending.counter + 1;
    pending.counter = ordinal;
    const key = `${ownerFile}::${ordinal}`;
    const ctx: TraceContext = { effects: [], reads: {}, nextSeq: 0 };
    const input = extractInput(name, args as unknown[]);
    const home = findHome(name, args as unknown[]);
    const latchKey = findLatchKey(name, args as unknown[]);
    const latchStores: Array<{ get: (key: { owner: string; repo: string; issueNumber: number }) => Promise<unknown> }> =
      [];
    const patchHandles: PatchHandle[] = [];
    const seenStores = new Set<unknown>();
    const considerLatchStore = (store: unknown) => {
      if (!store || typeof store !== "object" || seenStores.has(store)) return;
      seenStores.add(store);
      latchStores.push(
        store as { get: (key: { owner: string; repo: string; issueNumber: number }) => Promise<unknown> }
      );
      patchHandles.push(patchLatchStore(store as { put?: unknown; delete?: unknown }, ctx));
    };
    let callArgs: never[] = args;
    try {
      if (name === "processWorkerTick") {
        const store = args[0] as Record<string, unknown> | undefined;
        const api = args[2] as Record<string, unknown> | undefined;
        if (store && typeof store === "object") {
          patchHandles.push(patchLedgerStore(store, ctx));
          const ledgerLatches = (store as Record<string, unknown>).skipLatches;
          considerLatchStore(ledgerLatches);
        }
        if (home) {
          try {
            considerLatchStore(memorySkipLatchesFor(home));
          } catch {
            // Ignore latch resolution failures.
          }
        }
        if (api && typeof api === "object") {
          const wrappedApi = proxifyApi(api as object, ctx);
          callArgs = [args[0], args[1], wrappedApi, ...(args.slice(3) as never[])] as never[];
        }
      } else {
        const opts = (args[0] as Record<string, unknown> | undefined) ?? {};
        if (opts.api && typeof opts.api === "object") {
          const wrappedApi = proxifyApi(opts.api as object, ctx);
          callArgs = [{ ...opts, api: wrappedApi } as unknown as never, ...(args.slice(1) as never[])] as never[];
        }
        const directLatch = (callArgs[0] as Record<string, unknown> | undefined)?.skipLatches;
        considerLatchStore(directLatch);
        const ledgerStore = (callArgs[0] as Record<string, unknown> | undefined)?.store;
        if (ledgerStore && typeof ledgerStore === "object") {
          patchHandles.push(patchLedgerStore(ledgerStore as Record<string, unknown>, ctx));
          considerLatchStore((ledgerStore as Record<string, unknown>).skipLatches);
        }
        if (home) {
          try {
            considerLatchStore(memorySkipLatchesFor(home));
          } catch {
            // Ignore latch resolution failures.
          }
        }
      }
      const latchBefore = await readLatchSnapshot(latchStores, latchKey);
      let result: unknown;
      try {
        result = await (fn as (...a: never[]) => unknown)(...callArgs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const latchAfter = await readLatchSnapshot(latchStores, latchKey);
        const exists = await claimExists(home, latchKey);
        pending.decisions.set(
          key,
          normalizeValue({
            name,
            input,
            latchBefore,
            effects: ctx.effects,
            result: { threw: message },
            latchAfter,
            claimExists: exists,
          })
        );
        pending.reads.set(key, { name, reads: ctx.reads });
        throw error;
      }
      const latchAfter = await readLatchSnapshot(latchStores, latchKey);
      const exists = await claimExists(home, latchKey);
      pending.decisions.set(
        key,
        normalizeValue({
          name,
          input,
          latchBefore,
          effects: ctx.effects,
          result,
          latchAfter,
          claimExists: exists,
        })
      );
      pending.reads.set(key, { name, reads: ctx.reads });
      return result;
    } finally {
      for (const handle of patchHandles) {
        try {
          handle.restore();
        } catch {
          // Ignore restore failures.
        }
      }
    }
  }) as T;
  return wrapped;
}
