import type { ProvenanceLookup } from "./provenance.ts";
import type { IndependentReviewConfig, NamedRunner, RunnerStamp } from "./runners.ts";

/** Parent-owned fail-closed reason prefix. Maps to a failure status, never success. */
export const INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX = "Independent review unavailable:";
export const PROVENANCE_UNKNOWN_DIAGNOSTIC = "provenance-unknown/independence-not-established";

export function isIndependentReviewRefusal(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.startsWith(INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX);
}

/** Family identity ignores effort/variant: same family across levels stays one family. */
export function independenceIdentityKey(type: string, model: string): string {
  return `${type.trim().toLowerCase()}|${model.trim()}`;
}

export function identityKeyOfStamp(stamp: RunnerStamp): string | undefined {
  const type = (stamp.type ?? "").trim();
  const model = (stamp.model ?? "").trim();
  if (!type || !model) return undefined;
  return independenceIdentityKey(type, model);
}

export function identityKeyOfRunner(runner: { type?: string; model: string }): string | undefined {
  const type = (runner.type ?? "opencode").trim();
  const model = (runner.model ?? "").trim();
  if (!type || !model) return undefined;
  return independenceIdentityKey(type, model);
}

export function describeIdentity(type: string, model: string): string {
  return `${type.trim()}:${model.trim()}`;
}

export function buildFamilyMap(policy: IndependentReviewConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const [family, members] of Object.entries(policy.groups)) {
    for (const member of members) {
      const key = independenceIdentityKey(member.type, member.model);
      const owner = map.get(key);
      if (owner && owner !== family) {
        throw new Error(
          `Invalid JUMI_RUNNERS_FILE: independence identity ${member.type}:${member.model} in contradictory groups ${owner} and ${family}`
        );
      }
      map.set(key, family);
    }
  }
  return map;
}

export function familyOfStamp(stamp: RunnerStamp, familyMap: Map<string, string>): string | undefined {
  const key = identityKeyOfStamp(stamp);
  if (!key) return undefined;
  return familyMap.get(key);
}

export function familyOfRunner(
  runner: { type?: string; model: string },
  familyMap: Map<string, string>
): string | undefined {
  const key = identityKeyOfRunner(runner);
  if (!key) return undefined;
  return familyMap.get(key);
}

export interface IndependentReviewDiagnostics {
  head: string;
  policy: "enabled" | "disabled";
  provenanceStatus: string;
  writers: string[];
  writerGroups: string[];
  excludedFamilies: string[];
  eligible: string[];
  chosen?: string;
  reason?: string;
  untrackedNote: string;
}

export type IndependentReviewOutcome =
  | { kind: "disabled"; eligible: NamedRunner[]; diagnostics: IndependentReviewDiagnostics }
  | { kind: "unknown"; eligible: NamedRunner[]; diagnostics: IndependentReviewDiagnostics }
  | {
      kind: "selected";
      eligible: NamedRunner[];
      chosen: NamedRunner;
      excludedFamilies: string[];
      diagnostics: IndependentReviewDiagnostics;
    }
  | { kind: "refused"; reason: string; diagnostics: IndependentReviewDiagnostics };

function runnerLabel(runner: NamedRunner): string {
  return runner.name;
}

function stampLabel(stamp: RunnerStamp): string {
  return describeIdentity(stamp.type, stamp.model);
}

function baseDiagnostics(
  head: string,
  policy: "enabled" | "disabled",
  provenanceStatus: string
): IndependentReviewDiagnostics {
  return {
    head,
    policy,
    provenanceStatus,
    writers: [],
    writerGroups: [],
    excludedFamilies: [],
    eligible: [],
    untrackedNote:
      "independence established for recorded Jumi writers only; untracked external contributions not attested",
  };
}

function refusal(
  head: string,
  provenanceStatus: string,
  reason: string,
  extra?: Partial<IndependentReviewDiagnostics>
): { kind: "refused"; reason: string; diagnostics: IndependentReviewDiagnostics } {
  return {
    kind: "refused",
    reason,
    diagnostics: { ...baseDiagnostics(head, "enabled", provenanceStatus), reason, ...extra },
  };
}

export function resolveIndependentReviewers(input: {
  chain: NamedRunner[];
  provenance: ProvenanceLookup;
  policy?: IndependentReviewConfig | undefined;
  headSha: string;
}): IndependentReviewOutcome {
  const head = input.headSha;
  const chain = input.chain;
  const provenance = input.provenance;
  const policy = input.policy;

  if (policy?.enabled !== true) {
    return {
      kind: "disabled",
      eligible: [...chain],
      diagnostics: {
        ...baseDiagnostics(head, "disabled", provenance.status),
        eligible: chain.map(runnerLabel),
      },
    };
  }

  let familyMap: Map<string, string>;
  try {
    familyMap = buildFamilyMap(policy);
  } catch (err) {
    const reason = `${INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX} contradictory independence groups for ${head} (${err instanceof Error ? err.message : String(err)})`;
    return refusal(head, provenance.status, reason);
  }
  if (familyMap.size === 0) {
    return refusal(
      head,
      provenance.status,
      `${INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX} independence groups missing for ${head}`
    );
  }

  if (provenance.status === "unknown") {
    return {
      kind: "unknown",
      eligible: [...chain],
      diagnostics: {
        ...baseDiagnostics(head, "enabled", provenance.status),
        eligible: chain.map(runnerLabel),
        reason: PROVENANCE_UNKNOWN_DIAGNOSTIC,
        untrackedNote: "genuinely unknown external/legacy/untracked authorship; ordinary reviewer chain applies",
      },
    };
  }

  if (provenance.status === "pending") {
    return refusal(
      head,
      provenance.status,
      `${INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX} writer provenance pending for ${head}; deferring rather than bypassing the independence rule`
    );
  }

  if (provenance.status === "failed") {
    return refusal(
      head,
      provenance.status,
      `${INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX} writer provenance failed for ${head}; deferring rather than bypassing the independence rule`
    );
  }

  // Known Jumi authorship: exclude every contributing writer family.
  const seen = new Map<string, RunnerStamp>();
  for (const contributor of [
    ...(provenance.contributors ?? []),
    ...(provenance.publisher ? [provenance.publisher] : []),
  ]) {
    const key = identityKeyOfStamp(contributor);
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, contributor);
  }
  const writers = [...seen.values()];
  const writerLabels = writers.map(stampLabel);

  if (writers.length === 0) {
    return refusal(
      head,
      provenance.status,
      `${INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX} known provenance for ${head} names no resolvable writer`,
      { writers: writerLabels }
    );
  }

  const writerGroups: string[] = [];
  const unmappedWriters: string[] = [];
  for (const writer of writers) {
    const family = familyOfStamp(writer, familyMap);
    if (!family) {
      unmappedWriters.push(stampLabel(writer));
      continue;
    }
    if (!writerGroups.includes(family)) writerGroups.push(family);
  }
  if (unmappedWriters.length > 0) {
    return refusal(
      head,
      provenance.status,
      `${INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX} writer lacks independence group for ${head} (unmapped: ${unmappedWriters.join(", ")})`,
      { writers: writerLabels, writerGroups }
    );
  }

  const unmappedCandidates: string[] = [];
  for (const runner of chain) {
    if (!familyOfRunner(runner, familyMap)) unmappedCandidates.push(runnerLabel(runner));
  }
  if (unmappedCandidates.length > 0) {
    return refusal(
      head,
      provenance.status,
      `${INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX} reviewer lacks independence group for ${head} (unmapped: ${unmappedCandidates.join(", ")})`,
      { writers: writerLabels, writerGroups, excludedFamilies: [...writerGroups] }
    );
  }

  const excluded = [...writerGroups].sort();
  const eligible = chain.filter((runner) => {
    const family = familyOfRunner(runner, familyMap);
    return family != null && !excluded.includes(family);
  });

  if (eligible.length === 0) {
    return refusal(
      head,
      provenance.status,
      `${INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX} no eligible reviewer for ${head} (writers: ${writerLabels.join(", ")}; excluded families: ${excluded.join(", ")})`,
      { writers: writerLabels, writerGroups, excludedFamilies: excluded, eligible: [] }
    );
  }

  const chosen = eligible[0]!;
  return {
    kind: "selected",
    eligible,
    chosen,
    excludedFamilies: excluded,
    diagnostics: {
      head,
      policy: "enabled",
      provenanceStatus: provenance.status,
      writers: writerLabels,
      writerGroups,
      excludedFamilies: excluded,
      eligible: eligible.map(runnerLabel),
      chosen: runnerLabel(chosen),
      untrackedNote:
        "independence established for recorded Jumi writers only; untracked external contributions not attested",
    },
  };
}

export function provenanceLookupFailureReason(headSha: string, message: string): string {
  return `${INDEPENDENT_REVIEW_UNAVAILABLE_PREFIX} provenance lookup failed for ${headSha} (${message})`;
}

export interface StickyWorkerResolution {
  /** Index in `chain` to start from, or undefined when ordinary selection applies. */
  startIndex: number | undefined;
  /** Writer families recorded for the PR head, in first-seen order. */
  writerFamilies: string[];
  /** Writer identities for diagnostics. */
  writers: string[];
  /** Family chosen for the sticky start, when applicable. */
  stickyFamily?: string;
  /** Human-readable fallback reason when no sticky start applies. */
  reason?: string;
}

/**
 * Sticky writer family for follow-up-style worker jobs on a PR with known
 * Jumi provenance. Returns the chain index whose independence family already
 * wrote the PR, preferring the publisher family and otherwise the first
 * writer family in chain order. Returns `startIndex: undefined` for first
 * implementations, unknown/pending/failed provenance, disabled policy, or
 * when no writer family remains in the active chain (caller falls back to
 * ordinary random-start and logs `reason`).
 */
export function resolveStickyWorkerStart(input: {
  chain: readonly NamedRunner[];
  provenance: ProvenanceLookup;
  policy?: IndependentReviewConfig | undefined;
}): StickyWorkerResolution {
  const empty: StickyWorkerResolution = { startIndex: undefined, writerFamilies: [], writers: [] };
  if (input.chain.length === 0) return { ...empty, reason: "empty worker chain" };
  if (input.policy?.enabled !== true) return { ...empty, reason: "independent review disabled" };
  if (input.provenance.status !== "known") return { ...empty, reason: `provenance ${input.provenance.status}` };
  const contributors = [...(input.provenance.contributors ?? [])];
  if (input.provenance.publisher) contributors.push(input.provenance.publisher);
  if (contributors.length === 0) return { ...empty, reason: "known provenance names no writer" };

  let familyMap: Map<string, string>;
  try {
    familyMap = buildFamilyMap(input.policy);
  } catch (err) {
    return {
      ...empty,
      reason: `contradictory independence groups (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const writers = contributors.map(stampLabel);
  const writerFamilies: string[] = [];
  for (const contributor of contributors) {
    const family = familyOfStamp(contributor, familyMap);
    if (!family) return { ...empty, writerFamilies, writers, reason: `writer lacks independence group` };
    if (!writerFamilies.includes(family)) writerFamilies.push(family);
  }
  if (writerFamilies.length === 0) return { ...empty, writers, reason: "no writer family" };

  const chainFamilies = input.chain.map((runner) => familyOfRunner(runner, familyMap));
  if (chainFamilies.some((family) => family == null)) {
    return { ...empty, writerFamilies, writers, reason: "worker chain has unmapped runner" };
  }
  // Prefer the publisher family so a re-pushed head stays on its last writer;
  // otherwise the first writer family in chain order keeps the choice stable.
  const publisherFamily = input.provenance.publisher ? familyOfStamp(input.provenance.publisher, familyMap) : undefined;
  const orderedFamilies =
    publisherFamily && writerFamilies.includes(publisherFamily)
      ? [publisherFamily, ...writerFamilies.filter((family) => family !== publisherFamily)]
      : writerFamilies;
  for (const family of orderedFamilies) {
    const idx = input.chain.findIndex((runner) => familyOfRunner(runner, familyMap) === family);
    if (idx >= 0) {
      return { startIndex: idx, writerFamilies, writers, stickyFamily: family };
    }
  }
  return {
    ...empty,
    writerFamilies,
    writers,
    reason: `no writer family in worker chain (writers: ${writerFamilies.join(", ")})`,
  };
}
