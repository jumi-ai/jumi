import type { SqlClient } from "../../src/sql_client.ts";

export interface RecordingSqlOptions {
  insertRows?: unknown[];
  inflightRows?: unknown[];
  doneRows?: unknown[];
  /** When true, `begin` throws (the `router_sits` tripwire: list paths never open a transaction). */
  throwOnBegin?: boolean;
}

/**
 * Shared recording SQL double. `unsafe` replays the `review_jobs` row sets by
 * query shape (`INSERT`, non-`SKIP LOCKED` `FOR UPDATE`, `succeeded`) and
 * records every query; `begin` runs through the same double unless
 * `throwOnBegin` preserves the `router_sits` assertion that list paths never
 * open a transaction.
 */
export function recordingSql(opts: RecordingSqlOptions = {}): { sql: SqlClient; queries: string[] } {
  const queries: string[] = [];
  const sql: SqlClient = {
    async unsafe(query: string) {
      queries.push(query);
      if (query.includes("INSERT")) return (opts.insertRows ?? []) as unknown;
      if (query.includes("FOR UPDATE") && !query.includes("SKIP LOCKED")) return (opts.inflightRows ?? []) as unknown;
      if (query.includes("succeeded")) return (opts.doneRows ?? []) as unknown;
      return [] as unknown;
    },
    async begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      if (opts.throwOnBegin) throw new Error("router sit list does not open a transaction");
      return fn(sql);
    },
  };
  return { sql, queries };
}
