import { describe, expect, test } from "bun:test";
import {
  canPush,
  hasWriteAccessFromPermission,
  hasWritePermission,
  pullAuthorCanPush,
  resolvePermissions,
  trustedPushLogins,
} from "../src/permissions.ts";

describe("hasWritePermission", () => {
  test("allows write, admin, owner, and maintain/push role names", () => {
    expect(hasWritePermission("write")).toBe(true);
    expect(hasWritePermission("admin")).toBe(true);
    expect(hasWritePermission("owner")).toBe(true);
    expect(hasWritePermission("WRITE")).toBe(true);
    expect(hasWritePermission("read", "maintain")).toBe(true);
    expect(hasWritePermission("read", "push")).toBe(true);
    expect(hasWritePermission("write", "read")).toBe(true);
  });

  test("denies read, triage, none, and unknown", () => {
    expect(hasWritePermission("read")).toBe(false);
    expect(hasWritePermission("none")).toBe(false);
    expect(hasWritePermission("maintain")).toBe(false);
    expect(hasWritePermission("read", "triage")).toBe(false);
    expect(hasWritePermission("read", "read")).toBe(false);
    expect(hasWritePermission(undefined)).toBe(false);
    expect(hasWritePermission("", "")).toBe(false);
    expect(hasWritePermission("custom", "custom")).toBe(false);
  });
});

describe("hasWriteAccessFromPermission", () => {
  test("uses permission and role_name, not roleName", () => {
    expect(hasWriteAccessFromPermission({ permission: "write", role_name: "maintain" })).toBe(true);
    expect(hasWriteAccessFromPermission({ permission: "read", role_name: "maintain" })).toBe(true);
    expect(hasWriteAccessFromPermission({ permission: "", role_name: "maintain" })).toBe(true);
    expect(hasWriteAccessFromPermission({ permission: "maintain" })).toBe(false);
    expect(hasWriteAccessFromPermission({ permission: "read" })).toBe(false);
    expect(hasWriteAccessFromPermission({ permission: "read", roleName: "maintain" } as { permission: string })).toBe(
      false
    );
    expect(hasWriteAccessFromPermission(undefined)).toBe(false);
  });
});

describe("canPush", () => {
  test("fail-closes when the API is missing or throws", async () => {
    expect(await canPush(undefined, "o", "r", "alice")).toBe(false);
    expect(await canPush({}, "o", "r", "alice")).toBe(false);
    expect(
      await canPush(
        {
          getCollaboratorPermission: async () => {
            throw new Error("forge 500");
          },
        },
        "o",
        "r",
        "alice"
      )
    ).toBe(false);
    expect(
      await canPush({ getCollaboratorPermission: async () => ({ permission: "write" }) }, "o", "r", undefined)
    ).toBe(false);
  });

  test("uses collaborator permission, not org membership", async () => {
    const api = {
      getCollaboratorPermission: async (_o: string, _r: string, username: string) =>
        username === "alice" ? { permission: "write" } : { permission: "read" },
    };
    expect(await canPush(api, "o", "r", "alice")).toBe(true);
    expect(await canPush(api, "o", "r", "mallory")).toBe(false);
  });

  test("an App is held to its own collaborator lookup, whatever the factory App may write", async () => {
    const api = {
      getCollaboratorPermission: async (_o: string, _r: string, username: string) => {
        if (username === "private-app[bot]") throw new Error("GitHub API 404: not a user");
        return username === "filer[bot]"
          ? { permission: "none", user: { permissions: { push: true } } }
          : { permission: "none" };
      },
    };
    expect(await canPush(api, "o", "r", "filer[bot]")).toBe(true);
    expect(await canPush(api, "o", "r", "labeler[bot]")).toBe(false);
    expect(await canPush(api, "o", "r", "github-actions[bot]")).toBe(false);
    expect(await canPush(api, "o", "r", "private-app[bot]")).toBe(false);
    expect(await canPush(api, "o", "r", "mallory")).toBe(false);
  });

  test("an effective push grant counts even when the flat permission is none", async () => {
    const api = {
      getCollaboratorPermission: async () => ({ permission: "none", user: { permissions: { push: true } } }),
    };
    expect(await canPush(api, "o", "r", "alice")).toBe(true);
    const denied = {
      getCollaboratorPermission: async () => ({ permission: "none", user: { permissions: { push: false } } }),
    };
    expect(await canPush(denied, "o", "r", "mallory")).toBe(false);
  });
});

describe("pullAuthorCanPush", () => {
  const readOnly = {
    getCollaboratorPermission: async (_o: string, _r: string, username: string) =>
      username === "alice" ? { permission: "write" } : { permission: "none" },
  };

  test("a head branch on the base repository is proof, whoever the author is", async () => {
    const pr = { user: { login: "renovate[bot]" }, head: { repo: { full_name: "O/R" } } };
    expect(await pullAuthorCanPush(readOnly, "o", "r", pr)).toBe(true);
    expect(await pullAuthorCanPush(undefined, "o", "r", pr)).toBe(true);
  });

  test("a fork head needs an author who can push to the base", async () => {
    const fork = (login: string) => ({ user: { login }, head: { repo: { full_name: `${login}/r` } } });
    expect(await pullAuthorCanPush(readOnly, "o", "r", fork("alice"))).toBe(true);
    expect(await pullAuthorCanPush(readOnly, "o", "r", fork("mallory"))).toBe(false);
    expect(await pullAuthorCanPush(readOnly, "o", "r", { user: { login: "mallory" }, head: { repo: null } })).toBe(
      false
    );
  });

  test("a fork head from an App is not proof", async () => {
    const api = {
      getCollaboratorPermission: async () => {
        throw new Error("GitHub API 404: not a user");
      },
    };
    const fork = { user: { login: "renovate[bot]" }, head: { repo: { full_name: "renovate/r" } } };
    expect(await pullAuthorCanPush(api, "o", "r", fork)).toBe(false);
  });
});

describe("resolvePermissions", () => {
  test("a bot the forge reports none for stays none; one with an effective push grant is a writer", async () => {
    const api = {
      getCollaboratorPermission: async (_o: string, _r: string, username: string) =>
        username === "filer[bot]"
          ? { permission: "none", user: { permissions: { push: true } } }
          : { permission: "none" },
    };
    const resolved = await resolvePermissions(api, "o", "r", ["filer[bot]", "tapio[bot]", "mallory"]);
    expect(resolved.writes.get("filer[bot]")).toBe(true);
    expect(resolved.writes.get("tapio[bot]")).toBe(false);
    expect(resolved.detail.get("tapio[bot]")).toBe("none");
    expect(resolved.writes.get("mallory")).toBe(false);
    expect(resolved.detail.get("mallory")).toBe("none");
    expect(resolved.failures).toBe(0);
  });

  test("a failed lookup is counted and stays none", async () => {
    const api = {
      getCollaboratorPermission: async () => {
        throw new Error("GitHub API 404");
      },
    };
    const resolved = await resolvePermissions(api, "o", "r", ["renovate[bot]"]);
    expect(resolved.writes.get("renovate[bot]")).toBe(false);
    expect(resolved.detail.get("renovate[bot]")).toBe("none");
    expect(resolved.failures).toBe(1);
  });
});

describe("trustedPushLogins", () => {
  test("returns only writers, lower-cased and de-duplicated", async () => {
    const api = {
      getCollaboratorPermission: async (_o: string, _r: string, username: string) =>
        username.toLowerCase() === "alice" ? { permission: "write" } : { permission: "read" },
    };
    const trusted = await trustedPushLogins(api, "o", "r", ["Alice", "ALICE", "mallory", undefined, ""]);
    expect([...trusted].sort()).toEqual(["alice"]);
  });
});
