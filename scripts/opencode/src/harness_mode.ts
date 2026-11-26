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

/** Old ledger rows predate the stamp and read as `legacy`. */
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
