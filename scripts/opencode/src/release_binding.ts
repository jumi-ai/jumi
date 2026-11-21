import type { BumpKind } from "./release.ts";

export interface BindingStep {
  sha: string;
  bump: BumpKind;
  touchesWorkflows: boolean;
}

export interface ShaAllocation {
  reuseVersion: string | null;
  baseVersion: string | null;
  steps: BindingStep[];
  taken: readonly string[];
  targetSha: string;
  nextVersion: (latest: string | null, bump: BumpKind) => string;
}

/**
 * One version binding per commit SHA.
 *
 * Pure so tests can drive it with mocked tags/refs: every caller that sees
 * the same inputs computes the same version (overlapping runs and retries
 * agree), and the patch-until-free loop means a version is never handed to
 * two SHAs. Workflow-touching steps mint nothing (the release backfills
 * instead), so they consume no version. A SHA that already owns a tag
 * reuses it; existing tags are never moved.
 */
export function allocateShaVersion(allocation: ShaAllocation): string | null {
  if (allocation.reuseVersion) return allocation.reuseVersion;
  const taken = new Set(allocation.taken);
  let current = allocation.baseVersion;
  let answer: string | null = null;
  for (const step of allocation.steps) {
    if (step.touchesWorkflows) {
      if (step.sha === allocation.targetSha && answer === null) return null;
      continue;
    }
    let candidate = allocation.nextVersion(current, step.bump);
    while (taken.has(candidate)) {
      candidate = allocation.nextVersion(candidate, "patch");
    }
    taken.add(candidate);
    current = candidate;
    if (step.sha === allocation.targetSha) answer = candidate;
  }
  return answer;
}

/** Fail when a version is bound to more than one SHA (pairs, since a Map cannot hold the collision). */
export function assertSingleOwner(bindings: ReadonlyArray<readonly [string, string]>): void {
  const owners = new Map<string, string>();
  for (const [version, sha] of bindings) {
    const seen = owners.get(version);
    if (seen !== undefined && seen !== sha) {
      throw new Error(`Version ${version} is bound to two SHAs (${seen} and ${sha})`);
    }
    owners.set(version, sha);
  }
}

/**
 * Candidate image tag for a commit SHA. The reviewer workflow builds and
 * pushes this non-release tag first, probes that exact digest, and only
 * then moves the version and `latest` tags to the verified digest — so a
 * failed probe never leaves public tags pointing at an unverified image.
 */
export function reviewerCandidateTag(sha: string): string {
  return `sha-${sha.trim().toLowerCase()}`;
}

/** Public release tags the candidate must never collide with (`latest` or `vX.Y.Z`). */
export function isPublicReleaseTag(tag: string): boolean {
  const trimmed = tag.trim();
  if (trimmed === "latest") return true;
  return /^v\d+\.\d+\.\d+$/.test(trimmed);
}

/** Candidate tags derived from a commit SHA (`sha-<hex>`), never a release tag. */
export function isReviewerCandidateTag(tag: string): boolean {
  return /^sha-[0-9a-f]{4,64}$/.test(tag.trim().toLowerCase());
}

export interface ShaBindingDeps {
  listTags: () => string[];
  peeledCommit: (tag: string) => string | null;
  isAncestor: (commit: string, sha: string) => boolean;
  commitsInRange: (base: string | null, sha: string) => string[];
  contractAt: (ref: string) => string | null;
  touchesWorkflows: (sha: string) => boolean;
  classify: (previous: string | null, current: string) => BumpKind;
  nextVersion: (latest: string | null, bump: BumpKind) => string;
  compareMax: (a: string, b: string) => number;
}

export interface ShaBinding {
  version: string | null;
  reuse: string | null;
  base: string | null;
}

/**
 * Git-backed binding behind injected queries so the walk stays testable:
 * the newest ancestor tag is the base, every commit from after the base
 * through the target allocates in history order, and the target reuses its
 * own tag when it already has one.
 */
export function describeShaBinding(fullSha: string, deps: ShaBindingDeps): ShaBinding {
  const tags = deps.listTags();
  const reuse = tags.filter((tag) => deps.peeledCommit(tag) === fullSha).at(-1) ?? null;
  if (reuse) return { version: reuse, reuse, base: null };
  let base: string | null = null;
  for (const tag of tags) {
    const commit = deps.peeledCommit(tag);
    if (!commit || !deps.isAncestor(commit, fullSha)) continue;
    if (!base || deps.compareMax(tag, base) > 0) base = tag;
  }
  let prev: string | null = base ? (deps.contractAt(base) ?? "") : null;
  const steps: BindingStep[] = deps.commitsInRange(base, fullSha).map((commit) => {
    const contract = deps.contractAt(commit) ?? "";
    const touches = deps.touchesWorkflows(commit);
    const step: BindingStep = { sha: commit, bump: deps.classify(prev, contract), touchesWorkflows: touches };
    if (!touches) prev = contract;
    return step;
  });
  const version = allocateShaVersion({
    reuseVersion: null,
    baseVersion: base,
    steps,
    taken: tags,
    targetSha: fullSha,
    nextVersion: deps.nextVersion,
  });
  return { version, reuse: null, base };
}
