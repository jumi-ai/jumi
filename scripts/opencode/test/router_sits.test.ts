import { describe, expect, test } from "bun:test";
import { MemoryRouterSitStore, PgRouterSitStore, ROUTER_SIT_LIST_LIMIT } from "../src/router_sits.ts";
import type { SqlClient } from "../src/sql_client.ts";

function recordingSql(): { sql: SqlClient; queries: string[] } {
  const queries: string[] = [];
  const sql: SqlClient = {
    async unsafe(query: string) {
      queries.push(query);
      return [];
    },
    async begin() {
      throw new Error("router sit list does not open a transaction");
    },
  };
  return { sql, queries };
}

describe("router sit list cap", () => {
  test("memory list and listClosedPulls keep the same 500-row prefix Postgres keeps", async () => {
    expect(ROUTER_SIT_LIST_LIMIT).toBe(500);
    const store = new MemoryRouterSitStore();
    // High numbers in an early repo, low numbers in a later repo. Number-only
    // order and insertion order both keep a different prefix than owner, repo, number.
    const kept: { owner: string; repo: string; number: number }[] = [];
    for (let number = 400; number <= 500; number++) kept.push({ owner: "acme", repo: "aaa", number });
    for (let number = 1; number <= 399; number++) kept.push({ owner: "acme", repo: "zzz", number });
    expect(kept).toHaveLength(ROUTER_SIT_LIST_LIMIT);

    await store.remember("zzz", "aaa", 1, "no-closer");
    await store.markPullClosed("zzz", "aaa", 1);
    for (let number = 450; number >= 1; number--) {
      await store.remember("acme", "zzz", number, "draft-wip");
      await store.markPullClosed("acme", "zzz", number);
    }
    for (let number = 500; number >= 400; number--) {
      await store.remember("acme", "aaa", number, "draft-wip");
      await store.markPullClosed("acme", "aaa", number);
    }

    const sits = await store.list();
    expect(sits.map(({ owner, repo, number }) => ({ owner, repo, number }))).toEqual(kept);
    expect(await store.listClosedPulls()).toEqual(kept);

    expect(await store.get("acme", "zzz", 450)).toMatchObject({ repo: "zzz", number: 450, reason: "draft-wip" });
    expect(await store.get("zzz", "aaa", 1)).toMatchObject({ owner: "zzz", reason: "no-closer" });
  });

  test("postgres list and listClosedPulls use the same LIMIT 500 and order", async () => {
    const { sql, queries } = recordingSql();
    const store = new PgRouterSitStore(sql);
    expect(await store.list()).toEqual([]);
    expect(await store.listClosedPulls()).toEqual([]);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toContain("ORDER BY owner ASC, repo ASC, number ASC");
      expect(query).toContain(`LIMIT ${ROUTER_SIT_LIST_LIMIT}`);
    }
  });
});
