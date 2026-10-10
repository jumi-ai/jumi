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
