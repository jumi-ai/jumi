import { describe, expect, test } from "bun:test";
import {
  appSlugFromLogin,
  canPush,
  hasWriteAccessFromPermission,
  hasWritePermission,
  pullAuthorCanPush,
  resolvePermissions,
  senderCanSteer,
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

  test("only write, admin, owner, or a maintain/push role is a writer", async () => {
    const as = (permission: string, role_name?: string) => ({
      getCollaboratorPermission: async () => (role_name ? { permission, role_name } : { permission }),
    });
    for (const yes of [as("write"), as("admin"), as("owner"), as("read", "maintain"), as("read", "push")]) {
      expect(await canPush(yes, "o", "r", "alice")).toBe(true);
    }
    for (const no of [as("none"), as("read"), as("read", "triage"), as("")]) {
      expect(await canPush(no, "o", "r", "alice")).toBe(false);
    }
    const missing = { getCollaboratorPermission: async () => undefined as unknown as { permission: string } };
    expect(await canPush(missing, "o", "r", "alice")).toBe(false);
  });

  test("an App whose lookup says none is skipped even when its public record says contents write", async () => {
    const slugs: string[] = [];
    const api = {
      getCollaboratorPermission: async () => ({ permission: "none" }),
      getAppPermissions: async (slug: string): Promise<Record<string, string>> => {
        slugs.push(slug);
        return { contents: "write", pull_requests: "write" };
      },
    };
    expect(await canPush(api, "o", "r", "renovate[bot]")).toBe(false);
    expect(await canPush(api, "o", "r", "mallory")).toBe(false);
    expect(slugs).toEqual([]);
  });

  test("a 404 or a failed App lookup is skipped", async () => {
    const notAUser = async () => {
      throw new Error("GitHub API 404: not a user");
    };
    expect(
      await canPush(
        { getCollaboratorPermission: notAUser, getAppPermissions: async () => ({ contents: "write" }) },
        "o",
        "r",
        "renovate[bot]"
      )
    ).toBe(false);
    expect(
      await canPush(
        {
          getCollaboratorPermission: notAUser,
          getAppPermissions: async () => {
            throw new Error("GitHub API 404");
          },
        },
        "o",
        "r",
        "private-app[bot]"
      )
    ).toBe(false);
    expect(await canPush({ getCollaboratorPermission: notAUser }, "o", "r", "renovate[bot]")).toBe(false);
  });
});

describe("appSlugFromLogin", () => {
  test("strips the [bot] suffix and ignores plain users", () => {
    expect(appSlugFromLogin("renovate[bot]")).toBe("renovate");
    expect(appSlugFromLogin("Kirmanak-Jumi[BOT]")).toBe("Kirmanak-Jumi");
    expect(appSlugFromLogin("alice")).toBeUndefined();
    expect(appSlugFromLogin("[bot]")).toBeUndefined();
    expect(appSlugFromLogin(undefined)).toBeUndefined();
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

  test("a fork head from an App is not proof even when its manifest requests contents write", async () => {
    const api = {
      getCollaboratorPermission: async () => {
        throw new Error("GitHub API 404: not a user");
      },
      getAppPermissions: async () => ({ contents: "write" }),
    };
    const fork = { user: { login: "renovate[bot]" }, head: { repo: { full_name: "renovate/r" } } };
    expect(await pullAuthorCanPush(api, "o", "r", fork)).toBe(false);
  });
});

describe("resolvePermissions", () => {
  test("an App that can push is a writer; a user whose lookup says none is not", async () => {
    const api = {
      getCollaboratorPermission: async (_o: string, _r: string, username: string) => {
        if (username.endsWith("[bot]")) throw new Error("GitHub API 404");
        return { permission: "none" };
      },
      getAppPermissions: async () => ({ contents: "write" }),
    };
    const resolved = await resolvePermissions(api, "o", "r", ["renovate[bot]", "mallory"]);
    expect(resolved.writes.get("renovate[bot]")).toBe(true);
    expect(resolved.detail.get("renovate[bot]")).toBe("write");
    expect(resolved.writes.get("mallory")).toBe(false);
    expect(resolved.detail.get("mallory")).toBe("none");
    expect(resolved.failures).toBe(0);
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

describe("senderCanSteer", () => {
  function countingApi(permission: string, apps: Record<string, Record<string, string>> = {}) {
    const calls: string[] = [];
    return {
      calls,
      getCollaboratorPermission: async (_o: string, _r: string, username: string) => {
        calls.push(`collaborator:${username}`);
        return { permission };
      },
      getAppPermissions: async (slug: string) => {
        calls.push(`app:${slug}`);
        return apps[slug];
      },
    };
  }

  test("a listed login is admitted when the forge says none, without asking the forge", async () => {
    const api = countingApi("none");
    expect(await senderCanSteer(api, "o", "r", "alice", ["alice", "filer[bot]"])).toBe(true);
    expect(await senderCanSteer(api, "o", "r", "filer[bot]", ["alice", "filer[bot]"])).toBe(true);
    expect(await senderCanSteer(undefined, "o", "r", "alice", ["alice"])).toBe(true);
    expect(api.calls).toEqual([]);
  });

  test("an unlisted login is skipped when the list is set, whatever the forge or an app record says", async () => {
    const api = countingApi("admin", { labeler: { contents: "write" } });
    expect(await senderCanSteer(api, "o", "r", "mallory", ["alice"])).toBe(false);
    expect(await senderCanSteer(api, "o", "r", "labeler[bot]", ["alice"])).toBe(false);
    expect(await senderCanSteer(api, "o", "r", undefined, ["alice"])).toBe(false);
    expect(await senderCanSteer(api, "o", "r", " ", ["alice"])).toBe(false);
    expect(api.calls).toEqual([]);
  });

  test("the match is the whole login, case-insensitive, with surrounding space ignored", async () => {
    const list = [" Alice ", "Filer[bot]"];
    expect(await senderCanSteer(undefined, "o", "r", "ALICE", list)).toBe(true);
    expect(await senderCanSteer(undefined, "o", "r", "filer[BOT]", list)).toBe(true);
    expect(await senderCanSteer(undefined, "o", "r", "alic", list)).toBe(false);
    expect(await senderCanSteer(undefined, "o", "r", "alice2", list)).toBe(false);
    expect(await senderCanSteer(undefined, "o", "r", "filer", list)).toBe(false);
    expect(await senderCanSteer(undefined, "o", "r", "other-filer[bot]", list)).toBe(false);
    expect(await senderCanSteer(undefined, "o", "r", "filer-two[bot]", list)).toBe(false);
  });

  test("an unset, empty, or blank list admits only what the collaborator lookup calls a writer", async () => {
    for (const list of [undefined, [], [" ", ""]]) {
      expect(await senderCanSteer(countingApi("write"), "o", "r", "alice", list)).toBe(true);
      expect(await senderCanSteer(countingApi("owner"), "o", "r", "alice", list)).toBe(true);
      expect(await senderCanSteer(countingApi("read"), "o", "r", "alice", list)).toBe(false);
      expect(await senderCanSteer(countingApi("triage"), "o", "r", "alice", list)).toBe(false);
      const app = countingApi("none", { filer: { contents: "write" } });
      expect(await senderCanSteer(app, "o", "r", "filer[bot]", list)).toBe(false);
      expect(app.calls).toEqual(["collaborator:filer[bot]"]);
      const notFound = {
        getCollaboratorPermission: async () => {
          throw new Error("GitHub API 404");
        },
        getAppPermissions: async () => ({ contents: "write" }),
      };
      expect(await senderCanSteer(notFound, "o", "r", "filer[bot]", list)).toBe(false);
      expect(await senderCanSteer(undefined, "o", "r", "alice", list)).toBe(false);
    }
  });

  test("a non-empty list ignores the collaborator result either way", async () => {
    expect(await senderCanSteer(countingApi("none"), "o", "r", "alice", ["alice"])).toBe(true);
    expect(await senderCanSteer(countingApi("write"), "o", "r", "mallory", ["alice"])).toBe(false);
  });
});

describe("trustedPushLogins with a trusted sender list", () => {
  test("keeps listed logins only and never asks the forge", async () => {
    let lookups = 0;
    const api = {
      getCollaboratorPermission: async (_o: string, _r: string, username: string) => {
        lookups += 1;
        return username === "mallory" ? { permission: "write" } : { permission: "none" };
      },
    };
    const trusted = await trustedPushLogins(api, "o", "r", ["Alice", "mallory", undefined], ["alice"]);
    expect([...trusted]).toEqual(["alice"]);
    expect(lookups).toBe(0);
  });
});
