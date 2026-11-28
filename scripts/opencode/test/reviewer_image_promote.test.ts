import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Candidate image tag for a commit SHA. The reviewer workflow builds and
 * pushes this non-release tag first, probes that exact digest, then records
 * a `jumi/candidate-reviewer` commit status carrying the digest and baked
 * version — so a failed probe leaves no public tags pointing at an
 * unverified image, and pushes never move `:vX.Y.Z` / `:latest` at all. The
 * nightly release workflow promotes the tested digests after its own gate.
 * Lives here (not in `src`) because the `sha-<hex>` shape is defined by the
 * workflow shell (`CANDIDATE_TAG=sha-${GITHUB_SHA}`) and no production
 * caller uses these helpers.
 */
function reviewerCandidateTag(sha: string): string {
  return `sha-${sha.trim().toLowerCase()}`;
}

/** Public release tags the candidate must never collide with (`latest` or `vX.Y.Z`). */
function isPublicReleaseTag(tag: string): boolean {
  const trimmed = tag.trim();
  if (trimmed === "latest") return true;
  return /^v\d+\.\d+\.\d+$/.test(trimmed);
}

/** Candidate tags derived from a commit SHA (`sha-<hex>`), never a release tag. */
function isReviewerCandidateTag(tag: string): boolean {
  return /^sha-[0-9a-f]{4,64}$/.test(tag.trim().toLowerCase());
}

const repoRoot = join(process.cwd(), "../..");
const workflowPath = join(repoRoot, ".github/workflows/jumi-reviewer-image.yml");

async function workflow(): Promise<string> {
  return readFile(workflowPath, "utf8");
}

function stepBlock(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`workflow step not found: ${name}`);
  const next = text.indexOf("\n      - name: ", start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

/**
 * Simulated nightly promotion: only the nightly workflow moves the public
 * tags, and only at the exact tested candidate digest after its gate passes.
 * A failing gate (or a missing digest) moves nothing.
 */
function promoteIfVerified(opts: {
  probesPassed: boolean;
  candidateDigest: string;
  version: string;
  registry: Map<string, string>;
}): { moved: boolean } {
  if (!opts.probesPassed) return { moved: false };
  if (!opts.candidateDigest) throw new Error("missing candidate digest");
  opts.registry.set(`ghcr.io/jumi-ai/jumi-reviewer:${opts.version}`, opts.candidateDigest);
  opts.registry.set("ghcr.io/jumi-ai/jumi-reviewer:latest", opts.candidateDigest);
  return { moved: true };
}

describe("reviewer candidate tag helpers", () => {
  test("candidate derives from the commit SHA and is never a release tag", () => {
    const candidate = reviewerCandidateTag("ABC123DEF456");
    expect(candidate).toBe("sha-abc123def456");
    expect(isReviewerCandidateTag(candidate)).toBe(true);
    expect(isPublicReleaseTag(candidate)).toBe(false);
    expect(isPublicReleaseTag("latest")).toBe(true);
    expect(isPublicReleaseTag("v1.2.3")).toBe(true);
    expect(isPublicReleaseTag("sha-abc123")).toBe(false);
  });
});

describe("reviewer image promote-before-probe ordering", () => {
  test("build pushes only the candidate tag", async () => {
    const text = await workflow();
    const build = stepBlock(text, "Build and push candidate reviewer image");
    const tagsIndex = build.indexOf("tags: |");
    expect(tagsIndex).toBeGreaterThan(-1);
    const argsIndex = build.indexOf("build-args:", tagsIndex);
    expect(argsIndex).toBeGreaterThan(tagsIndex);
    const tagsBlock = build.slice(tagsIndex, argsIndex);
    expect(tagsBlock).toContain("$" + "{{ env.CANDIDATE_TAG }}");
    expect(tagsBlock).not.toContain(":latest");
    expect(tagsBlock).not.toContain("$" + "{{ env.VERSION }}");
    // The single commit/version binding is baked once at build time.
    expect(build).toContain("VERSION=$" + "{{ env.VERSION }}");
    expect(build).toContain("REVISION=$" + "{{ github.sha }}");
    expect(build).toContain("org.opencontainers.image.version=$" + "{{ env.VERSION }}");
    expect(build).toContain("org.opencontainers.image.revision=$" + "{{ github.sha }}");
  });

  test("candidate tag derives from the commit SHA", async () => {
    const text = await workflow();
    const compute = stepBlock(text, "Compute candidate tag");
    expect(compute).toContain("CANDIDATE_TAG=sha-$" + "{GITHUB_SHA}");
    expect(isReviewerCandidateTag(reviewerCandidateTag("deadbeef"))).toBe(true);
  });

  test("probes run against the exact candidate digest, then record it", async () => {
    const text = await workflow();
    const probeStart = text.indexOf("- name: Pull candidate image for verification");
    const record = text.indexOf("- name: Record candidate status");
    expect(probeStart).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(probeStart);
    const probeSection = text.slice(probeStart, record);
    expect(probeSection).toContain("$" + "{{ steps.build.outputs.digest }}");
    expect(probeSection).not.toContain("$" + "{IMAGE}:$" + "{VERSION}");
    expect(probeSection).not.toContain("$" + "{IMAGE}:latest");
    // Existing probes still cover user, source, and revision labels.
    expect(probeSection).toContain("Config.User");
    expect(probeSection).toContain("org.opencontainers.image.source");
    expect(probeSection).toContain("org.opencontainers.image.revision");
    expect(probeSection).toContain("org.opencontainers.image.version");
    // The binary probes still run (runtime, webfetch, quota, agy, codex,
    // sandbox, codex token, claude flags, xai child auth).
    for (const probe of [
      "src/webfetch_probe.ts",
      "src/quota_probe.ts",
      "src/agy_webfetch_probe.ts",
      "src/codex_probe.ts",
      "src/review_sandbox_probe.ts",
      "src/codex_token_probe.ts",
      "src/claude_flag_probe.ts",
      "src/xai_child_auth_probe.ts",
    ]) {
      expect(probeSection).toContain(probe);
    }
  });

  test("pushes record the probed candidate; only the nightly promotes release tags", async () => {
    const text = await workflow();
    // No promotion on push: the old promote/record-manifest steps are gone.
    expect(text).not.toContain("- name: Promote candidate to release tags");
    expect(text).not.toContain("- name: Record registry manifest digest");
    expect(text).not.toContain("imagetools create");
    expect(text).not.toContain("$" + "{IMAGE}:$" + "{VERSION}");
    expect(text).not.toContain("$" + "{IMAGE}:latest");
    const recordBlock = stepBlock(text, "Record candidate status");
    expect(recordBlock).toContain("$" + "{{ steps.build.outputs.digest }}");
    expect(recordBlock).toContain("jumi/candidate-reviewer");
    expect(recordBlock).toContain("digest=${CANDIDATE_DIGEST} version=${VERSION}");
    expect(recordBlock).toContain("/statuses/${GITHUB_SHA}");
    // The nightly workflow promotes the tested digests after its gate.
    const nightly = await readFile(join(repoRoot, ".github/workflows/jumi-nightly-release.yml"), "utf8");
    expect(nightly).toContain("imagetools create");
    expect(nightly).toContain("$" + "{IMAGE}:$" + "{{ steps.gate.outputs.version }}");
    expect(nightly).toContain("$" + "{IMAGE}:latest");
  });

  test("simulated failing probe leaves public tags unchanged; passing probe moves them", () => {
    const candidateDigest = "sha256:candidate";
    const failed = new Map([
      ["ghcr.io/jumi-ai/jumi-reviewer:v1.2.3", "sha256:old"],
      ["ghcr.io/jumi-ai/jumi-reviewer:latest", "sha256:old"],
    ]);
    expect(promoteIfVerified({ probesPassed: false, candidateDigest, version: "v1.2.4", registry: failed })).toEqual({
      moved: false,
    });
    expect(failed.get("ghcr.io/jumi-ai/jumi-reviewer:v1.2.4")).toBeUndefined();
    expect(failed.get("ghcr.io/jumi-ai/jumi-reviewer:latest")).toBe("sha256:old");

    const passed = new Map([
      ["ghcr.io/jumi-ai/jumi-reviewer:v1.2.3", "sha256:old"],
      ["ghcr.io/jumi-ai/jumi-reviewer:latest", "sha256:old"],
    ]);
    expect(promoteIfVerified({ probesPassed: true, candidateDigest, version: "v1.2.4", registry: passed })).toEqual({
      moved: true,
    });
    expect(passed.get("ghcr.io/jumi-ai/jumi-reviewer:v1.2.4")).toBe(candidateDigest);
    expect(passed.get("ghcr.io/jumi-ai/jumi-reviewer:latest")).toBe(candidateDigest);
  });
});
