import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const HARNESS_MODE_ENV = "JUMI_HARNESS_MODE" as const;

export type HarnessMode = "legacy" | "pi";

const LEGACY_HARNESS_MODE: HarnessMode = "legacy";
const PI_HARNESS_MODE: HarnessMode = "pi";

/**
 * Deployment-only harness selector. Unset or empty is `legacy`; explicit
 * `legacy` keeps today's dispatch; `pi` selects the future Pi harness.
 * Anything else fails process start naming the variable. Never inferred
 * from forge, never read from repository settings, never mutated at runtime.
 */
export function parseHarnessMode(raw: unknown): HarnessMode {
  if (raw === undefined || raw === null) return LEGACY_HARNESS_MODE;
  if (typeof raw !== "string") throw new Error(`Invalid ${HARNESS_MODE_ENV}: ${String(raw)}`);
  const trimmed = raw.trim();
  if (trimmed === "") return LEGACY_HARNESS_MODE;
  if (trimmed === LEGACY_HARNESS_MODE) return LEGACY_HARNESS_MODE;
  if (trimmed === PI_HARNESS_MODE) return PI_HARNESS_MODE;
  throw new Error(`Invalid ${HARNESS_MODE_ENV}: ${raw}`);
}

/** Old ledger rows and workdirs predate the stamp and read as `legacy`. */
export function normalizeHarnessMode(value: unknown): HarnessMode {
  if (value === PI_HARNESS_MODE) return PI_HARNESS_MODE;
  return LEGACY_HARNESS_MODE;
}

export class PiHarnessNotImplementedError extends Error {
  constructor() {
    super(`Pi harness not implemented (${HARNESS_MODE_ENV}=pi): refusing to spawn legacy`);
    this.name = "PiHarnessNotImplementedError";
  }
}

/**
 * Until the Pi harness lands, an explicit `pi` factory must fail clearly
 * without spawning the legacy engine. Legacy proceeds; anything else is a
 * programming error (use `parseHarnessMode` at the boundary).
 */
export function throwIfPiHarness(mode: HarnessMode): void {
  if (mode === PI_HARNESS_MODE) throw new PiHarnessNotImplementedError();
}

/** True when the recorded attempt mode matches the process mode. */
export function harnessModeMatches(recorded: unknown, current: HarnessMode): boolean {
  return normalizeHarnessMode(recorded) === current;
}

function harnessModeStampPath(workdir: string): string {
  return join(workdir, ".jumi-tmp", "harness-mode");
}

/** Recorded workdir mode, or undefined for workdirs that predate the stamp. */
export async function readRecordedHarnessMode(workdir: string): Promise<HarnessMode | undefined> {
  try {
    const raw = (await readFile(harnessModeStampPath(workdir), "utf8")).trim();
    if (!raw) return undefined;
    if (raw === PI_HARNESS_MODE) return PI_HARNESS_MODE;
    if (raw === LEGACY_HARNESS_MODE) return LEGACY_HARNESS_MODE;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function writeHarnessModeStamp(workdir: string, mode: HarnessMode): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(workdir, ".jumi-tmp"), { recursive: true });
  await writeFile(harnessModeStampPath(workdir), `${mode}\n`, "utf8");
}

/**
 * Fenced fresh attempt on mode change: never convert a live session.
 * Returns true when the caller may resume (`continueSession`), false when it
 * must start fresh. A mismatch clears the resumable session files and
 * records the new mode; a match (or a first stamp) leaves the decision to
 * the existing `hasResumableSession` check.
 */
export async function gateResumeOnHarnessMode(
  workdir: string,
  current: HarnessMode,
  clearSession: () => Promise<void>
): Promise<boolean> {
  const recorded = await readRecordedHarnessMode(workdir);
  if (recorded === undefined) {
    await writeHarnessModeStamp(workdir, current).catch(() => undefined);
    return false;
  }
  if (recorded !== current) {
    await clearSession().catch(() => undefined);
    await rm(harnessModeStampPath(workdir), { force: true }).catch(() => undefined);
    await writeHarnessModeStamp(workdir, current).catch(() => undefined);
    return false;
  }
  return true;
}
