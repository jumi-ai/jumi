import { createHash } from "node:crypto";
import type { Pull, PullFile, Repo, ReviewApi } from "./ports.ts";

export function sanitizeFileSegment(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return clean || "case";
}

/** Inputs pinned once per case so every runner compares the same revision. */
export interface ReplayPinnedInputs {
  repo: Repo;
  pr: Pull | null;
  baseSha: string;
  headSha: string;
  prNumber: number | null;
  /** Null for SHA-only cases (file list is derived from the pinned SHAs via git). */
  prFiles: PullFile[] | null;
}

export interface ReplayPinCase {
  owner: string;
  repo: string;
  prNumber?: number;
  baseSha?: string;
  headSha?: string;
}

export type ReplayPinApi = Pick<ReviewApi, "getRepo" | "getPR" | "getPRFiles">;

/** Resolve a case's base SHA, head SHA and file inputs once, before any runner runs. */
export async function resolveReplayPinnedInputs(
  api: ReplayPinApi,
  reviewCase: ReplayPinCase
): Promise<ReplayPinnedInputs> {
  const repo = await api.getRepo(reviewCase.owner, reviewCase.repo);
  let pr: Pull | null = null;
  if (reviewCase.prNumber != null) {
    pr = await api.getPR(reviewCase.owner, reviewCase.repo, reviewCase.prNumber);
  }
  const baseSha = (reviewCase.baseSha ?? pr?.base.sha ?? "").toLowerCase();
  const headSha = (reviewCase.headSha ?? pr?.head.sha ?? "").toLowerCase();
  let prFiles: PullFile[] | null = null;
  if (pr) {
    prFiles = await api.getPRFiles(reviewCase.owner, reviewCase.repo, pr.number);
  }
  return { repo, pr, baseSha, headSha, prNumber: pr?.number ?? reviewCase.prNumber ?? null, prFiles };
}

function shortReplayHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Collision-free artifact name. Keeps the readable `<case>.<runner>.md` form
 * when unused; otherwise appends a stable hash of the original IDs (plus a
 * counter for exact duplicates) so different cases/runners never share a file.
 */
export function resolveReplayArtifactName(caseId: string, runnerName: string, used: Set<string>): string {
  const base = `${sanitizeFileSegment(caseId)}.${sanitizeFileSegment(runnerName)}.md`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const hash = shortReplayHash(`${caseId}\u0000${runnerName}`);
  const hashed = `${sanitizeFileSegment(caseId)}.${sanitizeFileSegment(runnerName)}.${hash}.md`;
  if (!used.has(hashed)) {
    used.add(hashed);
    return hashed;
  }
  let counter = 2;
  while (true) {
    const candidate = `${sanitizeFileSegment(caseId)}.${sanitizeFileSegment(runnerName)}.${hash}.${counter}.md`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    counter++;
  }
}
