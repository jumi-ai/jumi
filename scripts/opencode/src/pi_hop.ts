/**
 * Bounded Pi hop across two scripted routes (jumi#939).
 *
 * The driver tries at most two named routes in order. Before each attempt it
 * re-evaluates privacy (scope via `checkPiHandoff`), funding (deployment
 * allowlist plus repo narrowing), and the destination state (lease held,
 * not cancelled, worktree safe). A quota-exhausted pool is never retried
 * through an alias: the second route is skipped when it shares the exhausted
 * `fundingPool`. Authentication stays distinct from quota (auth never hops
 * as quota and never records a quota reset). Only a reset the provider
 * actually stated is recorded (`quota.resetAtMs`, else `nowMs +
 * retryAfterMs`); anything else stays unknown, never guessed.
 *
 * Fresh provider session per attempt: the driver mints a new session id for
 * every invoke and never replays opaque tool ids or ambiguous side effects
 * (callers must not forward previous tool-call ids; validated edits stay in
 * the checkout and contributor stamps accumulate in `attempts`). A Pi
 * failure never starts a legacy process: this module never imports the
 * legacy engine and returns a terminal result instead.
 */

import { buildPiAttemptStamp, type PiAttemptRole, type PiAttemptStamp } from "./pi_attempt.ts";
import {
  checkPiHandoff,
  type PiAdapterKind,
  type PiAdapterResult,
  type PiDataScope,
  type PiProfileCatalog,
  type PiResolvedRoute,
} from "./pi_profiles.ts";

/** Maximum routes per hop. Bounded: never more than two scripted routes. */
export const PI_HOP_MAX_ROUTES = 2 as const;

export interface PiHopLease {
  /** True while this process still holds the ledger lease. */
  isLeaseHeld: () => boolean | Promise<boolean>;
  /** True when the router cancelled the job (stop, never hop). */
  isCancelled: () => boolean | Promise<boolean>;
  /** True when the destination worktree is safe to run in. */
  isWorktreeSafe: () => boolean | Promise<boolean>;
}

export interface PiHopRequest {
  /** One or two named routes in attempt order. */
  routes: readonly [string] | readonly [string, string];
  catalog: PiProfileCatalog;
  deploymentAllowlist: readonly string[];
  repoAllowed?: readonly string[];
  scope?: PiDataScope;
  role: PiAttemptRole | string;
  lease: PiHopLease;
  /**
   * One inference call against the resolved route. Receives a fresh
   * `sessionId` per attempt; implementations must start a new provider
   * session with it and must not replay previous opaque tool ids.
   */
  invoke: (
    route: PiResolvedRoute,
    ctx: { sessionId: string; attemptIndex: number }
  ) => Promise<PiAdapterResult> | PiAdapterResult;
  /** Clock for `retryAfterMs` resolution. Defaults to `Date.now`. */
  nowMs?: () => number;
  /** Fresh session ids. Defaults to `crypto.randomUUID` with a fallback. */
  newSessionId?: () => string;
}

export interface PiHopAttempt {
  route: string;
  sessionId: string;
  stamp: PiAttemptStamp;
  kind: PiAdapterKind;
}

export type PiHopStatus = "ok" | "refused" | "failed";

export interface PiHopResult {
  status: PiHopStatus;
  /** The route that produced the terminal result, when any ran. */
  route?: PiResolvedRoute;
  /** The terminal adapter result, when any ran. */
  result?: PiAdapterResult;
  /** Stamp for the terminal attempt, when any ran. */
  stamp?: PiAttemptStamp;
  /** Stamps for every attempt that ran (contributor stamps accumulate here). */
  attempts: PiHopAttempt[];
  /** Only a reset the provider actually stated (never guessed). */
  quotaResetAtMs?: number;
  /** Machine-readable refusal/failure reason (never provider content). */
  reason?: string;
  /** Funding pools exhausted by quota on this hop (aliases share one pool). */
  exhaustedPools: string[];
}

function hopSessionId(factory: PiHopRequest["newSessionId"]): string {
  try {
    const custom = factory?.();
    if (typeof custom === "string" && custom.trim()) return custom.trim();
  } catch {}
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === "string" && uuid) return uuid;
  } catch {}
  return `pi-hop-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
}

/** Resolve `retryAfterMs` against `nowMs`. Returns undefined when unstated. */
export function resolvePiHopResetAtMs(result: PiAdapterResult, nowMs: number = Date.now()): number | undefined {
  if (result.kind !== "quota") return undefined;
  const quota = result.quota;
  if (!quota) return undefined;
  if (typeof quota.resetAtMs === "number" && Number.isFinite(quota.resetAtMs)) return quota.resetAtMs;
  if (typeof quota.retryAfterMs === "number" && Number.isFinite(quota.retryAfterMs)) {
    return nowMs + quota.retryAfterMs;
  }
  return undefined;
}

function isAllowedOutcomeForHop(kind: PiAdapterKind, retryable: boolean | undefined): boolean {
  // Hop only on capacity/transport problems that a different pool could fix.
  // Auth, denial, cancellation, and terminal stamps never hop.
  if (kind === "quota") return true;
  if (kind === "provider-failure") return retryable === true;
  return false;
}

/**
 * Drive the bounded hop. All destination checks run before every attempt,
 * including the second: privacy, funding, lease, cancellation, and worktree
 * are re-evaluated at the destination, never cached from selection time.
 */
export async function runPiHop(request: PiHopRequest): Promise<PiHopResult> {
  const names = [...request.routes];
  if (names.length < 1 || names.length > PI_HOP_MAX_ROUTES) {
    throw new Error(`pi hop needs 1-${PI_HOP_MAX_ROUTES} routes, got ${names.length}`);
  }
  const nowMs = request.nowMs ?? Date.now;
  const attempts: PiHopAttempt[] = [];
  const exhaustedPools = new Set<string>();
  const role = String(request.role ?? "").trim();

  for (let index = 0; index < names.length; index++) {
    const name = (names[index] as string).trim();
    if (!name) {
      return { status: "refused", attempts, exhaustedPools: [...exhaustedPools], reason: "refused:empty-route" };
    }
    // Destination re-evaluation: privacy + funding through the handoff
    // check (repo narrowing applies at the destination, never widens).
    let route: PiResolvedRoute;
    try {
      route = checkPiHandoff(name, request.catalog, request.deploymentAllowlist, {
        ...(request.repoAllowed !== undefined ? { repoAllowed: request.repoAllowed } : {}),
        ...(request.scope !== undefined ? { scope: request.scope } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A denied destination is skipped, not retried: the next scripted
      // route gets its own handoff check (for example a non-contributor
      // route can still serve a private scope the contributor route
      // refused). When nothing remains the hop is refused.
      if (index + 1 < names.length) continue;
      return {
        status: "refused",
        attempts,
        exhaustedPools: [...exhaustedPools],
        reason: `refused:handoff:${message.slice(0, 160)}`,
      };
    }
    // An exhausted pool is never retried through an alias: same
    // `fundingPool` means the same quota bucket even when the profile,
    // credential ref, or effort differ.
    if (exhaustedPools.has(route.fundingPool)) {
      if (index + 1 < names.length) continue;
      return {
        status: "failed",
        attempts,
        exhaustedPools: [...exhaustedPools],
        reason: `failed:pool-exhausted:${route.fundingPool.slice(0, 80)}`,
      };
    }
    // Destination state: lease, cancellation, and worktree are re-checked
    // before every invoke. Any failure refuses the hop without inference.
    try {
      if (await request.lease.isCancelled()) {
        return { status: "refused", attempts, exhaustedPools: [...exhaustedPools], reason: "refused:cancelled" };
      }
      if (!(await request.lease.isLeaseHeld())) {
        return { status: "refused", attempts, exhaustedPools: [...exhaustedPools], reason: "refused:lease-lost" };
      }
      if (!(await request.lease.isWorktreeSafe())) {
        return {
          status: "refused",
          attempts,
          exhaustedPools: [...exhaustedPools],
          reason: "refused:unsafe-worktree",
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "refused",
        attempts,
        exhaustedPools: [...exhaustedPools],
        reason: `refused:destination-check:${message.slice(0, 120)}`,
      };
    }
    // Fresh provider session per attempt: never replay opaque tool ids or
    // ambiguous side effects from a previous attempt.
    const sessionId = hopSessionId(request.newSessionId);
    let result: PiAdapterResult;
    try {
      result = await request.invoke(route, { sessionId, attemptIndex: index });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stamp = buildPiAttemptStamp({
        route,
        role: role as PiAttemptRole,
        outcome: "provider-failure",
      });
      attempts.push({ route: route.name, sessionId, stamp, kind: "provider-failure" });
      return {
        status: "failed",
        route,
        result: { kind: "provider-failure", message: message.slice(0, 500), retryable: false },
        stamp,
        attempts,
        exhaustedPools: [...exhaustedPools],
        reason: "failed:invoke-threw",
      };
    }
    const kind: PiAdapterKind = result.kind;
    const stamp = buildPiAttemptStamp({
      route,
      role: role as PiAttemptRole,
      outcome: kind,
      usage: result.usage ?? undefined,
    });
    attempts.push({ route: route.name, sessionId, stamp, kind });
    if (kind === "ok") {
      return { status: "ok", route, result, stamp, attempts, exhaustedPools: [...exhaustedPools] };
    }
    if (kind === "quota") {
      // Record only the stated reset (absolute or retry-after resolved
      // against now); never guess. The pool is exhausted for this hop.
      const resetAtMs = resolvePiHopResetAtMs(result, nowMs());
      exhaustedPools.add(route.fundingPool);
      if (index + 1 < names.length) {
        const next: { result?: PiAdapterResult; stamp?: PiAttemptStamp } = { result, stamp };
        void next;
        continue;
      }
      return {
        status: "failed",
        route,
        result,
        stamp,
        attempts,
        exhaustedPools: [...exhaustedPools],
        ...(resetAtMs !== undefined ? { quotaResetAtMs: resetAtMs } : {}),
        reason: "failed:quota",
      };
    }
    if (kind === "auth-expired") {
      // Authentication stays distinct from quota: never a quota reset, never
      // retried as capacity. No hop: the credential (not the pool) failed.
      return {
        status: "failed",
        route,
        result,
        stamp,
        attempts,
        exhaustedPools: [...exhaustedPools],
        reason: "failed:auth",
      };
    }
    if (kind === "cancelled") {
      return {
        status: "failed",
        route,
        result,
        stamp,
        attempts,
        exhaustedPools: [...exhaustedPools],
        reason: "failed:cancelled",
      };
    }
    if (kind === "denied") {
      // Denial (scope, endpoint, entitlement) is terminal for this route;
      // the next scripted route still gets its own handoff check.
      if (index + 1 < names.length) continue;
      return {
        status: "refused",
        route,
        result,
        stamp,
        attempts,
        exhaustedPools: [...exhaustedPools],
        reason: "refused:denied",
      };
    }
    // provider-failure: hop only when retryable (transient 5xx/529); a
    // permanent failure is terminal and never becomes a legacy process.
    if (isAllowedOutcomeForHop(kind, result.retryable) && index + 1 < names.length) continue;
    return {
      status: "failed",
      route,
      result,
      stamp,
      attempts,
      exhaustedPools: [...exhaustedPools],
      reason: "failed:provider",
    };
  }
  return { status: "refused", attempts, exhaustedPools: [...exhaustedPools], reason: "refused:exhausted" };
}
