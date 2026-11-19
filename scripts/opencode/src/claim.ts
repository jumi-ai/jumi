import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CLAIM_STALE_MS = 2 * 60 * 1000;

export interface ClaimRecord {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  worktree: string;
  branch: string;
  issueUpdatedAt: string;
  headShaAtStart: string;
  /** True after no-changes or a recorded failure. Setup/crash uses pid 0 without this. */
  terminal?: boolean;
}

export function claimFilePath(home: string, owner: string, repo: string, issueNumber: number): string {
  return join(home, "worker", "jobs", owner, repo, `${issueNumber}.json`);
}

export function followUpStatePath(home: string, owner: string, repo: string, issueNumber: number): string {
  return join(home, "worker", "jobs", owner, repo, `${issueNumber}.followup.json`);
}

export function conflictStatePath(home: string, owner: string, repo: string, issueNumber: number): string {
  return join(home, "worker", "jobs", owner, repo, `${issueNumber}.conflict.json`);
}

export function ciStatePath(home: string, owner: string, repo: string, issueNumber: number): string {
  return join(home, "worker", "jobs", owner, repo, `${issueNumber}.ci.json`);
}

export function stuckStatePath(home: string, owner: string, repo: string, issueNumber: number): string {
  return join(home, "worker", "jobs", owner, repo, `${issueNumber}.stuck.json`);
}

export function skipLatchGenerationPath(home: string, owner: string, repo: string, issueNumber: number): string {
  return join(home, "worker", "jobs", owner, repo, `${issueNumber}.latch.json`);
}

export function reviewStuckStatePath(home: string, owner: string, repo: string, prNumber: number): string {
  return join(home, "reviewer", "jobs", owner, repo, `${prNumber}.stuck.json`);
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isClaimLive(
  claim: ClaimRecord,
  nowMs = Date.now(),
  pidAlive: (pid: number) => boolean = isPidAlive,
  staleMs = CLAIM_STALE_MS
): boolean {
  if (!Number.isInteger(claim.pid) || claim.pid <= 0) return false;
  const heartbeatMs = Date.parse(claim.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return false;
  if (nowMs - heartbeatMs >= staleMs) return false;
  return pidAlive(claim.pid);
}

export async function readClaim(path: string): Promise<ClaimRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const claim = parsed as ClaimRecord;
    if (typeof claim.pid !== "number" || typeof claim.heartbeatAt !== "string") return undefined;
    return claim;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function writeClaim(path: string, claim: ClaimRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(claim, null, 2)}\n`);
}

export async function deleteClaim(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}

export async function readSkipLatchGeneration(path: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as { generation?: unknown }).generation === "number") {
      return (parsed as { generation: number }).generation;
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return 0;
  }
  return 0;
}

async function writeSkipLatchGeneration(path: string, generation: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ generation }, null, 2)}\n`);
}

export async function syncHomeSkipLatch(
  home: string,
  owner: string,
  repo: string,
  issueNumber: number,
  generation: number
): Promise<void> {
  const path = skipLatchGenerationPath(home, owner, repo, issueNumber);
  const current = await readSkipLatchGeneration(path);
  if (current === generation) return;
  await deleteClaim(followUpStatePath(home, owner, repo, issueNumber));
  await deleteClaim(conflictStatePath(home, owner, repo, issueNumber));
  await deleteClaim(ciStatePath(home, owner, repo, issueNumber));
  await deleteClaim(stuckStatePath(home, owner, repo, issueNumber));
  await writeSkipLatchGeneration(path, generation);
}

export async function acquireClaim(
  path: string,
  claim: ClaimRecord,
  opts: {
    nowMs?: number;
    pidAlive?: (pid: number) => boolean;
    staleMs?: number;
  } = {}
): Promise<boolean> {
  const existing = await readClaim(path);
  if (existing && isClaimLive(existing, opts.nowMs, opts.pidAlive, opts.staleMs)) {
    return false;
  }
  if (existing?.terminal && existing.issueUpdatedAt === claim.issueUpdatedAt) {
    return false;
  }
  await writeClaim(path, claim);
  return true;
}
