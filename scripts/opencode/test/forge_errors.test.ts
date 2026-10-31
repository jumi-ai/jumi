import { describe, expect, test } from "bun:test";
import {
  FORGE_ERROR_BODY_MAX_CHARS,
  forgeRequestError,
  isForgeRequestError,
  isForgeRequestErrorMessage,
} from "../src/forge_errors.ts";
import { stickyFailureDetail } from "../src/sticky_failure.ts";

describe("forgeRequestError", () => {
  test("keeps a short body and scrubs the token before the cut", () => {
    const token = `ghs_${"s".repeat(300)}`;
    const err = forgeRequestError({
      service: "GitHub API",
      method: "GET",
      url: `https://example.test/${token}/repos`,
      status: 401,
      body: `${token} denied tail`,
      secrets: [token],
    });
    expect(err.message).toContain("GitHub API GET https://example.test/***/repos → 401:");
    expect(err.message).toContain("*** denied tail");
    expect(err.message).not.toContain(token);
    expect(err.message).not.toContain(token.slice(0, 40));
    expect(isForgeRequestErrorMessage(err.message)).toBe(true);
  });

  test("scrubs the encoded token and caps the body", () => {
    const token = "ghs_abc+def/ghi";
    const encoded = encodeURIComponent(token);
    const err = forgeRequestError({
      service: "Gitea API",
      method: "POST",
      url: "https://gitea.example/api/v1/repos/o/r/pulls",
      status: 500,
      body: `see ${encoded} ${"a".repeat(FORGE_ERROR_BODY_MAX_CHARS)}`,
      secrets: [token],
    });
    expect(err.message).not.toContain(token);
    expect(err.message).not.toContain(encoded);
    expect(err.message).toContain("see ***");
    const excerpt = err.message.split("→ 500: ")[1] ?? "";
    expect(Array.from(excerpt).length).toBe(FORGE_ERROR_BODY_MAX_CHARS + 1);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  test("a permission miss without a request URL is not a request error", () => {
    expect(isForgeRequestErrorMessage("GitHub API 404: not a user")).toBe(false);
    expect(isForgeRequestError(new Error("GitHub API 404: not a user"))).toBe(false);
  });

  test("scrubs other PATs, JWTs, and access_token values before the cut", () => {
    const pat = `ghp_${"a".repeat(36)}`;
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const access = "accessvalue_long_enough_xxxx";
    const err = forgeRequestError({
      service: "GitHub attachment",
      method: "GET",
      url: `https://files.example/a?access_token=${access}`,
      status: 401,
      body: `pat ${pat} bearer ${jwt} again ${access} ${"z".repeat(400)}`,
      secrets: ["ghs_parent_only"],
    });
    expect(err.message).not.toContain(pat);
    expect(err.message).not.toContain(jwt);
    expect(err.message).not.toContain(access);
    expect(err.message).toContain("access_token=***");
    expect(err.message).toContain("→ 401:");
    expect(err.message.endsWith("…")).toBe(true);
    expect(isForgeRequestError(err)).toBe(true);
  });

  test("scrubs a signed-url credential echoed without the rest of the location", () => {
    const sig = "sigvalue_that_is_long_enough_123456";
    const location = `https://blob.example/log?sig=${encodeURIComponent(sig)}&sp=r`;
    const sha = "b".repeat(40);
    const err = forgeRequestError({
      service: "GitHub API",
      method: "GET",
      url: "https://api.github.com/repos/o/r/actions/jobs/1/logs",
      status: 500,
      body: `stored at ${sig} head ${sha}`,
      secrets: ["ghs_parent", location],
    });
    expect(err.message).not.toContain(sig);
    expect(err.message).toContain("stored at ***");
    expect(err.message).toContain(sha);
    expect(err.message).toContain("→ 500:");
  });

  test("scrubs a userinfo password and keeps the access_tokens path", () => {
    const err = forgeRequestError({
      service: "GitHub API",
      method: "POST",
      url: "https://bot:s3cret-password@api.github.com/app/installations/1/access_tokens",
      status: 401,
      body: "bad credentials",
    });
    expect(err.message).toContain("https://bot:***@api.github.com/app/installations/1/access_tokens → 401:");
    expect(err.message).not.toContain("s3cret-password");
  });

  test("a forge URL with a space is still a request error", () => {
    const err = forgeRequestError({
      service: "Gitea API",
      method: "GET",
      url: "https://gitea.example/proxy path/api/v1/repos/o/r",
      status: 500,
      body: "leaked",
    });
    expect(isForgeRequestErrorMessage(err.message)).toBe(true);
    expect(isForgeRequestError(err)).toBe(true);
    expect(stickyFailureDetail(err)).toBe("forge API request failed");
  });
});

describe("stickyFailureDetail", () => {
  test("drops the forge request string and still redacts other failures", () => {
    const token = "ghs_parent_secret_value";
    const forge = forgeRequestError({
      service: "Gitea API",
      method: "POST",
      url: "https://gitea.example/api/v1/repos/o/r/pulls",
      status: 500,
      body: `leaked ${token}`,
      secrets: [token],
    });
    expect(stickyFailureDetail(forge, [token])).toBe("forge API request failed");
    expect(stickyFailureDetail(new Error("opencode exploded"), [token])).toBe("opencode exploded");
    expect(stickyFailureDetail(new Error(`push failed ${token}`), [token])).toBe("push failed ***");
    expect(stickyFailureDetail(new Error("GitHub attachment GET https://example.test/file → 403: nope"), [token])).toBe(
      "forge API request failed"
    );
  });
});
