import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptOpenCodeDbCredentials } from "../src/opencode_credentials.ts";

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jumi-opencode-credentials-"));
  tempDirs.push(dir);
  await mkdir(join(dir, ".local", "share", "opencode"), { recursive: true });
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

interface Row {
  id: string;
  integration: string;
  value: unknown;
  updated: number;
  active?: boolean | null;
}

function writeDb(home: string, rows: Row[]): void {
  const db = new Database(join(home, ".local", "share", "opencode", "opencode.db"));
  db.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER)"
  );
  for (const row of rows) {
    db.run("INSERT INTO credential VALUES (?, ?, 'x', ?, ?, ?)", [
      row.id,
      row.integration,
      JSON.stringify(row.value),
      row.active == null ? null : row.active ? 1 : 0,
      row.updated,
    ]);
  }
  db.close();
}

const authPath = (home: string) => join(home, ".local", "share", "opencode", "auth.json");
const readAuth = async (home: string) => JSON.parse(await readFile(authPath(home), "utf8"));

describe("adoptOpenCodeDbCredentials", () => {
  test("does nothing and creates nothing when no OpenCode 2 database exists", async () => {
    const home = await tempHome();
    expect(await adoptOpenCodeDbCredentials(home)).toEqual([]);
    expect(await Bun.file(authPath(home)).exists()).toBe(false);
  });

  test("copies a device grant in the shape the parent owns, without touching other entries", async () => {
    const home = await tempHome();
    await writeFile(authPath(home), JSON.stringify({ "https://origin": { type: "wellknown", key: "K", token: "t" } }));
    await utimes(authPath(home), 1, 1);
    writeDb(home, [
      {
        id: "cre_1",
        integration: "xai",
        value: { type: "oauth", methodID: "device", refresh: "R", access: "A", expires: 123 },
        updated: Date.now(),
      },
    ]);
    expect(await adoptOpenCodeDbCredentials(home)).toEqual(["xai"]);
    expect(await readAuth(home)).toEqual({
      "https://origin": { type: "wellknown", key: "K", token: "t" },
      xai: { type: "oauth", refresh: "R", access: "A", expires: 123 },
    });
  });

  test("converts API keys and keeps OAuth account metadata", async () => {
    const home = await tempHome();
    writeDb(home, [
      { id: "cre_1", integration: "anthropic", value: { type: "key", key: "K" }, updated: 5 },
      {
        id: "cre_2",
        integration: "openai",
        value: {
          type: "oauth",
          methodID: "chatgpt-browser",
          refresh: "R",
          access: "A",
          expires: 1,
          metadata: { accountID: "acct" },
        },
        updated: 5,
      },
    ]);
    await adoptOpenCodeDbCredentials(home);
    const auth = await readAuth(home);
    expect(auth.anthropic).toEqual({ type: "api", key: "K" });
    expect(auth.openai).toEqual({ type: "oauth", refresh: "R", access: "A", expires: 1, accountId: "acct" });
  });

  test("a parent rotation newer than the DB row wins over the stale row", async () => {
    const home = await tempHome();
    await writeFile(authPath(home), JSON.stringify({ xai: { type: "oauth", refresh: "ROTATED", access: "A" } }));
    writeDb(home, [
      {
        id: "cre_1",
        integration: "xai",
        value: { type: "oauth", methodID: "device", refresh: "OLD", access: "A", expires: 1 },
        updated: 1,
      },
    ]);
    expect(await adoptOpenCodeDbCredentials(home)).toEqual([]);
    expect((await readAuth(home)).xai.refresh).toBe("ROTATED");
  });

  test("prefers the account OpenCode marks active, and skips what auth.json cannot hold", async () => {
    const home = await tempHome();
    writeDb(home, [
      { id: "cre_1", integration: "xai", value: { type: "key", key: "ACTIVE" }, updated: 1, active: true },
      { id: "cre_2", integration: "xai", value: { type: "key", key: "NEWER" }, updated: 9, active: false },
      { id: "cre_3", integration: "https://origin", value: { type: "key", key: "K" }, updated: 9 },
      { id: "cre_4", integration: "gitlab", value: { type: "external" }, updated: 9 },
    ]);
    expect(await adoptOpenCodeDbCredentials(home)).toEqual(["xai"]);
    expect(await readAuth(home)).toEqual({ xai: { type: "api", key: "ACTIVE" } });
  });

  test("a database it cannot read is not a startup failure", async () => {
    const home = await tempHome();
    await writeFile(join(home, ".local", "share", "opencode", "opencode.db"), "not sqlite");
    const logs: string[] = [];
    expect(await adoptOpenCodeDbCredentials(home, (message) => logs.push(message))).toEqual([]);
    expect(logs.join("\n")).toContain("OpenCode credential store");
    expect(logs.join("\n")).not.toContain("not sqlite");
  });
});
