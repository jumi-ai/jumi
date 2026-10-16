import { describe, expect, test } from "bun:test";
import {
  codePointLength,
  GITEA_STATUS_DESCRIPTION_MAX_BYTES,
  omitClaudeConfigWarning,
  omitOpenCodeStderr,
  truncateStatusDescription,
} from "../src/status_description.ts";

describe("truncateStatusDescription", () => {
  test("counts GitHub's limit in characters and includes the ellipsis", () => {
    const exact = "y".repeat(140);
    expect(truncateStatusDescription(exact, { maxChars: 140 })).toBe(exact);

    const over = truncateStatusDescription("x".repeat(141), { maxChars: 140 });
    expect(codePointLength(over)).toBe(140);
    expect(over.endsWith("…")).toBe(true);
    expect(over).toBe(`${"x".repeat(139)}…`);

    const giteaCap = truncateStatusDescription("x".repeat(255), { maxChars: 140 });
    expect(codePointLength(giteaCap)).toBe(140);
    expect(giteaCap).not.toBe("x".repeat(255));
  });

  test("does not use the 255-byte cap when only the character limit is set", () => {
    const euros = truncateStatusDescription("€".repeat(141), { maxChars: 140 });
    expect(codePointLength(euros)).toBe(140);
    expect(euros.startsWith("€".repeat(139))).toBe(true);
    expect(new TextEncoder().encode(euros).byteLength).toBeGreaterThan(GITEA_STATUS_DESCRIPTION_MAX_BYTES);
  });

  test("keeps Gitea at a 255-byte cap without splitting UTF-8 characters", () => {
    const euros = truncateStatusDescription("€".repeat(200), { maxBytes: GITEA_STATUS_DESCRIPTION_MAX_BYTES });
    expect(euros.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(euros).byteLength).toBeLessThanOrEqual(GITEA_STATUS_DESCRIPTION_MAX_BYTES);
    expect(codePointLength(euros)).toBeLessThanOrEqual(140);
  });

  test("does not leave a dangling combining mark", () => {
    const fitted = truncateStatusDescription(`hello${"\u0301".repeat(20)}`, { maxChars: 10 });
    expect(fitted.endsWith("…")).toBe(true);
    expect(fitted).not.toMatch(/\p{Mark}$/u);
    expect(codePointLength(fitted)).toBeLessThanOrEqual(10);
  });

  test("does not split a surrogate pair", () => {
    const fitted = truncateStatusDescription("😀".repeat(141), { maxChars: 140 });
    expect(codePointLength(fitted)).toBe(140);
    expect(fitted.endsWith("…")).toBe(true);
    expect(fitted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("omitOpenCodeStderr", () => {
  test("replaces an OpenCode stderr dump with a short hostname status", () => {
    const stderr = `invalid_grant ${"x".repeat(400)}`;
    const description = omitOpenCodeStderr(`Jumi review failed: opencode exited with code 143:\n${stderr}`, "pod-a");
    expect(description).toBe("Jumi review failed: pod-a: opencode exited with code 143");
    expect(description).not.toContain(stderr);
    expect(description).toContain("pod-a");
  });

  test("leaves auth-death text and short errors unchanged", () => {
    const auth = "pod-a: provider auth death";
    expect(omitOpenCodeStderr(`Jumi review failed: ${auth}`, "other")).toBe(`Jumi review failed: ${auth}`);
    expect(omitOpenCodeStderr("Jumi review failed: model unavailable", "pod-a")).toBe(
      "Jumi review failed: model unavailable"
    );
  });

  test("strips the Claude config warning so the cause line shows", () => {
    const description =
      "Jumi review failed: claude exited with code 1:\nClaude configuration file not found at: /data/.claude.json\nRestoring configuration from backup\nFailed to authenticate: OAuth session expired and could not be refreshed";
    const cleaned = omitOpenCodeStderr(description, "pod-a");
    expect(cleaned).toContain("Failed to authenticate: OAuth session expired");
    expect(cleaned).not.toContain("configuration file not found");
    expect(cleaned).not.toContain("/data/.claude.json");
    expect(omitClaudeConfigWarning("Claude configuration file not found at: /data/.claude.json\nok")).toBe("ok");
  });
});
