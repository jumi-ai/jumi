import { SQL } from "bun";

export class QueueUnavailableError extends Error {
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : cause ? String(cause) : "queue unavailable");
    this.name = "QueueUnavailableError";
    this.cause = cause;
  }
}

export function isQueueUnavailable(err: unknown): err is QueueUnavailableError {
  return err instanceof QueueUnavailableError;
}

export type SqlClient = {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close?: () => Promise<void>;
};

const PG_TEXT_ARRAY_ELEMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Bun `SQL.unsafe` stringifies JS arrays as `"a,b"`. Postgres then rejects
 * `ANY($n::text[])` with 22P02 (`malformed array literal: "review"`).
 */
export function pgTextArrayLiteral(values: readonly string[]): string {
  if (values.length === 0) return "{}";
  for (const value of values) {
    if (!PG_TEXT_ARRAY_ELEMENT.test(value)) {
      throw new Error(`refusing to bind ${JSON.stringify(value)} as a postgres text[] element`);
    }
  }
  return `{${values.join(",")}}`;
}

function bindUnsafeParams(params?: unknown[]): unknown[] | undefined {
  if (!params) return params;
  return params.map((value) => (Array.isArray(value) ? pgTextArrayLiteral(value.map(String)) : value));
}

export function wrapSqlError(err: unknown): never {
  if (err instanceof QueueUnavailableError) throw err;
  throw new QueueUnavailableError(err);
}

export function wrapClient(client: SqlClient): SqlClient {
  return {
    async unsafe(query, params) {
      try {
        return await client.unsafe(query, bindUnsafeParams(params));
      } catch (err) {
        wrapSqlError(err);
      }
    },
    async begin(fn) {
      try {
        return await client.begin((tx) => fn(wrapClient(tx)));
      } catch (err) {
        wrapSqlError(err);
      }
    },
    close: client.close ? () => client.close?.() ?? Promise.resolve() : undefined,
  };
}

export function createBunSqlClient(databaseUrl: string, opts?: { max?: number }): SqlClient {
  const sql = opts?.max != null ? new SQL(databaseUrl, { max: opts.max }) : new SQL(databaseUrl);
  return wrapClient(sql as unknown as SqlClient);
}
