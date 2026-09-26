import { createBunSqlClient, type SqlClient, wrapSqlError } from "./sql_client.ts";

/**
 * Why Jumi is sitting still for one pull or issue.
 *
 * The router mailbox accepts a deliberate refusal as 202-skip (counted in
 * `jumi_webhooks_total{result="skipped"}`) and then forgets it. The board
 * cannot show that state, so the router remembers the last closed reason per
 * object in `router_sits` — one current record per pull or issue.
 *
 * - Sits live outside `review_jobs`. The in-flight uniqueness index on
 *   `review_jobs(job_key)` must never fight a watching row.
 * - Reason codes are a closed set shared with later kick work. An unknown
 *   reason never creates a sit, so it can never grow a kick button.
 * - No reconciler: no periodic scan invents or expires rows. `decided_at`
 *   keeps the age of the decision visible for the board.
 * - Push events are out of scope and never touch sits.
 */

export const ROUTER_SIT_REASONS = [
  "ci-not-completed",
  "draft-wip",
  "foreign-branch",
  "no-closer",
  "implement-latch",
  "no-changes",
  "terminal-result",
  "repo-mutex",
  "no-write-access",
  "not-labeled",
] as const;

export type RouterSitReason = (typeof ROUTER_SIT_REASONS)[number];

const REASON_SET = new Set<string>(ROUTER_SIT_REASONS);

export function isKickableSitReason(reason: string | null | undefined): reason is RouterSitReason {
  return typeof reason === "string" && REASON_SET.has(reason);
}

export interface RouterSitRecord {
  owner: string;
  repo: string;
  number: number;
  reason: RouterSitReason;
  /** Epoch ms when the router last decided this sit. Visible age for the board. */
  decidedAt: number;
  updatedAt: number;
}

export const ROUTER_SITS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS router_sits (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  reason TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner, repo, number)
);
`;

/**
 * Map a router-computed skip string to a closed sit code.
 * Returns undefined for unknown reasons (no kick button) and for skips that
 * must never create a record: ping, bad signature (handled before routing),
 * unsupported actions/events, repository policy refusals, malformed payloads,
 * and closes/merges that clear instead of sitting.
 *
 * The input must be the reason the router already computed, never a new guess.
 */
export function normalizeSitReason(reason: string | null | undefined): RouterSitReason | undefined {
  if (!reason) return undefined;
  const text = reason.trim();
  if (!text) return undefined;

  // Never sit on these: no kick, no record.
  if (text === "ping") return undefined;
  if (text.startsWith("unsupported action ")) return undefined;
  if (text.startsWith("unsupported event ")) return undefined;
  if (text === "repository not allowed") return undefined;
  if (text.includes("is not allowed")) return undefined;
  if (text.includes("does not match configured Gitea origin")) return undefined;
  if (text.startsWith("malformed ")) return undefined;
  if (text === "malformed workflow_job payload" || text === "malformed status payload") return undefined;
  if (text === "malformed push payload" || text === "malformed check_run payload") return undefined;
  if (text === "no matching pull request") return undefined;
  if (text === "not an in-scope jumi pull request") return undefined;
  if (text === "no managed jumi PRs") return undefined;
  if (text === "no blocked issues to wake") return undefined;
  if (text === "no waiting issues to wake") return undefined;
  if (text === "no open jumi closing PR") return undefined;
  if (text === "bot still assigned") return undefined;
  if (text === "sender is bot") return undefined;
  if (text === "sender ignored") return undefined;
  if (text === "empty comment body") return undefined;
  if (text === "jumi internal comment") return undefined;
  if (text === "jumi review status") return undefined;
  if (text === "not a pull request comment") return undefined;
  if (text === "pull request issue") return undefined;
  if (text === "unlabeled other label") return undefined;
  // Closes / merges / head moves clear instead of sitting.
  if (text === "pull request not open") return undefined;
  if (text === "issue not open") return undefined;
  if (text === "issue is closed") return undefined;
  if (text.startsWith("PR is ")) return undefined;
  if (text === "PR is already merged") return undefined;
  if (text.startsWith("PR head changed from ")) return undefined;
  if (text.startsWith("Incomplete review:")) return undefined;
  if (text === "head moved") return undefined;
  if (text === "unassigned") return undefined;
  if (text === "round cap") return undefined;
  if (text === "incomplete") return undefined;
  if (text === "success trailer") return undefined;
  if (text === "comment already handled") return undefined;
  if (text === "no unhandled feedback") return undefined;
  if (text.startsWith("stuck: too many")) return undefined;
  if (text === "failed to load issue") return undefined;
  if (text.startsWith("failed to load ")) return undefined;
  if (text.startsWith("failed to re-check")) return undefined;
  if (text.startsWith("failed to set dependency")) return undefined;
  if (text.startsWith("failed to load candidate")) return undefined;
  if (text.startsWith("failed to load dependencies")) return undefined;

  // CI not completed: the router saw a sibling check that has not finished.
  if (text === "CI still pending") return "ci-not-completed";
  if (text.startsWith("workflow_job ")) return "ci-not-completed";
  if (text === "workflow_job not completed") return "ci-not-completed";
  if (text.startsWith("status ")) return "ci-not-completed";
  if (text === "status not completed") return "ci-not-completed";
  if (text.startsWith("check_run ")) return "ci-not-completed";
  if (text === "check_run not completed") return "ci-not-completed";

  // Draft / WIP.
  if (text === "draft or WIP pull request") return "draft-wip";
  if (text === "PR title disables review") return "draft-wip";

  // Foreign branch.
  if (text === "fork pull request") return "foreign-branch";

  // No closer.
  if (text === "no closer") return "no-closer";
  if (text === "no closing issue") return "no-closer";
  if (text === "closing issue mismatch") return "no-closer";

  // Implement latch (closing issue already owned by the issue job) or stuck latch.
  if (text === "closing issue already assigned") return "implement-latch";
  if (text.startsWith("stuck:")) return "implement-latch";
  if (text === "claim is live") return "repo-mutex";

  // No changes: implement finished with nothing to ship.
  if (text === "no-changes") return "no-changes";

  // Sender without write access.
  if (text === "sender lacks write access") return "no-write-access";

  // Not labeled / not assigned: the object is not picked up.
  if (text === "not labeled jumi") return "not-labeled";
  if (text === "not assigned to bot") return "not-labeled";
  if (text === "labeled other label") return "not-labeled";
  if (text === "not a jumi pull request") return "not-labeled";

  return undefined;
}

export interface RouterSitStore {
  migrate(): Promise<void>;
  remember(owner: string, repo: string, number: number, reason: RouterSitReason): Promise<void>;
  clear(owner: string, repo: string, number: number): Promise<void>;
  get(owner: string, repo: string, number: number): Promise<RouterSitRecord | undefined>;
  list(): Promise<RouterSitRecord[]>;
}

export class MemoryRouterSitStore implements RouterSitStore {
  private readonly rows = new Map<string, RouterSitRecord>();

  private key(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${number}`;
  }

  async migrate(): Promise<void> {}

  async remember(owner: string, repo: string, number: number, reason: RouterSitReason): Promise<void> {
    if (!isKickableSitReason(reason)) return;
    if (!owner || !repo || !Number.isFinite(number)) return;
    const now = Date.now();
    this.rows.set(this.key(owner, repo, number), { owner, repo, number, reason, decidedAt: now, updatedAt: now });
  }

  async clear(owner: string, repo: string, number: number): Promise<void> {
    this.rows.delete(this.key(owner, repo, number));
  }

  async get(owner: string, repo: string, number: number): Promise<RouterSitRecord | undefined> {
    const row = this.rows.get(this.key(owner, repo, number));
    return row ? { ...row } : undefined;
  }

  async list(): Promise<RouterSitRecord[]> {
    return [...this.rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => {
        if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
        if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
        return a.number - b.number;
      });
  }
}

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  throw new Error(`expected number, got ${typeof value}`);
}

function epoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export class PgRouterSitStore implements RouterSitStore {
  constructor(private readonly sql: SqlClient) {}

  async migrate(): Promise<void> {
    try {
      await this.sql.unsafe(ROUTER_SITS_SCHEMA_SQL);
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async remember(owner: string, repo: string, number: number, reason: RouterSitReason): Promise<void> {
    if (!isKickableSitReason(reason)) return;
    if (!owner || !repo || !Number.isFinite(number)) return;
    try {
      await this.sql.unsafe(
        `INSERT INTO router_sits (owner, repo, number, reason, decided_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (owner, repo, number)
         DO UPDATE SET reason = EXCLUDED.reason, decided_at = NOW(), updated_at = NOW()`,
        [owner, repo, number, reason]
      );
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async clear(owner: string, repo: string, number: number): Promise<void> {
    try {
      await this.sql.unsafe(`DELETE FROM router_sits WHERE owner = $1 AND repo = $2 AND number = $3`, [
        owner,
        repo,
        number,
      ]);
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async get(owner: string, repo: string, number: number): Promise<RouterSitRecord | undefined> {
    try {
      const rows = asRows<{
        owner: unknown;
        repo: unknown;
        number: unknown;
        reason: unknown;
        decided_at: unknown;
        updated_at: unknown;
      }>(
        await this.sql.unsafe(
          `SELECT owner, repo, number, reason, decided_at, updated_at FROM router_sits WHERE owner = $1 AND repo = $2 AND number = $3`,
          [owner, repo, number]
        )
      );
      const row = rows[0];
      if (!row) return undefined;
      const reason = String(row.reason);
      if (!isKickableSitReason(reason)) return undefined;
      return {
        owner: String(row.owner),
        repo: String(row.repo),
        number: num(row.number),
        reason,
        decidedAt: epoch(row.decided_at),
        updatedAt: epoch(row.updated_at),
      };
    } catch (err) {
      wrapSqlError(err);
    }
  }

  async list(): Promise<RouterSitRecord[]> {
    try {
      const rows = asRows<{
        owner: unknown;
        repo: unknown;
        number: unknown;
        reason: unknown;
        decided_at: unknown;
        updated_at: unknown;
      }>(
        await this.sql.unsafe(
          `SELECT owner, repo, number, reason, decided_at, updated_at FROM router_sits ORDER BY owner ASC, repo ASC, number ASC LIMIT 500`
        )
      );
      const out: RouterSitRecord[] = [];
      for (const row of rows) {
        const reason = String(row.reason);
        if (!isKickableSitReason(reason)) continue;
        out.push({
          owner: String(row.owner),
          repo: String(row.repo),
          number: num(row.number),
          reason,
          decidedAt: epoch(row.decided_at),
          updatedAt: epoch(row.updated_at),
        });
      }
      return out;
    } catch (err) {
      wrapSqlError(err);
    }
  }
}

export async function createPgRouterSitStore(databaseUrl: string, sql?: SqlClient): Promise<PgRouterSitStore> {
  const store = new PgRouterSitStore(sql ?? createBunSqlClient(databaseUrl));
  await store.migrate();
  return store;
}

/** Best-effort sit remember for background paths (engine/worker/handover). Webhook paths fail closed instead. */
export async function rememberSitBestEffort(
  sits: RouterSitStore | undefined,
  owner: string,
  repo: string,
  number: number,
  reasonText: string | null | undefined,
  logger?: (message: string) => void
): Promise<void> {
  if (!sits) return;
  const code = normalizeSitReason(reasonText);
  if (!code) return;
  try {
    await sits.remember(owner, repo, number, code);
  } catch (err) {
    logger?.(`sit remember failed ${owner}/${repo}#${number}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Best-effort sit clear for background paths. */
export async function clearSitBestEffort(
  sits: RouterSitStore | undefined,
  owner: string,
  repo: string,
  number: number,
  logger?: (message: string) => void
): Promise<void> {
  if (!sits) return;
  try {
    await sits.clear(owner, repo, number);
  } catch (err) {
    logger?.(`sit clear failed ${owner}/${repo}#${number}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
