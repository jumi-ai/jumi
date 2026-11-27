/**
 * Typed review fields shared by the MCP and Pi bindings (`review_mcp.ts`,
 * `pi_review.ts`). One validator serves both: the bindings only translate
 * wire shapes.
 *
 * Covers `needs_maintainer`, `proof` and `set_verdict.incomplete` so
 * `review_verdict_store.ts` stays small (file-size ratchet).
 */

import {
  countBlockingFindings,
  countBugFindings,
  countMaintainerQuestionFindings,
  countNonMaintainerQuestionFindings,
  countQuestionFindings,
  countRiskFindings,
  countSuggestionFindings,
  hasFindingProof,
  parseReviewFindings,
  parseReviewOutput,
  reviewFindingLines,
} from "./verdict.ts";

export type MaintainerDecision = "typed_true" | "typed_false" | "none";

export type TypedSeverity = "bug" | "risk" | "question" | "suggestion";

/** Check trailers embedded in hostile titles/bodies: the text parser strips them before counting. */
function stripEmbeddedChecks(text: string): string {
  return text
    .replace(/<!--\s*jumi-check:\s*(?:success|failure)(?:\s*;\s*(?:(?!-->).)*?)?\s*-->/gi, " ")
    .replace(/<!--\s*jumi-review:[^>]*-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripQuestionPart(part: string): { content: string; isMaintainer: boolean } {
  let cur = stripEmbeddedChecks(part);
  cur = cur.replace(/^(?:\*\*|__)?\s*/, "");
  let isMaintainer = false;
  for (;;) {
    const maint = /^(?:(?:❓\s*(?:q\s*:|question\s*:)?|(?:q|question)\s*:)\s*)?❓\s*maintainer\s*:\s*/iu.exec(cur);
    if (maint) {
      const rest = cur.slice(maint[0].length).replace(/^(?:\*\*|__)?\s*/, "");
      isMaintainer = true;
      cur = rest;
      if (!cur) break;
      continue;
    }
    const generic = /^(?:❓\s*(?:q\s*:|question\s*:)?|(?:q|question)\s*:|❓)\s*/iu.exec(cur);
    if (generic && generic[0].length > 0) {
      cur = cur.slice(generic[0].length).replace(/^(?:\*\*|__)?\s*/, "");
      if (!cur) break;
      continue;
    }
    break;
  }
  return { content: cur, isMaintainer };
}

function stripSeverityPart(part: string, severity: TypedSeverity): string {
  let cur = part.replace(/\s+/g, " ").trim();
  cur = cur.replace(/^(?:\*\*|__)?\s*/, "");
  const re =
    severity === "suggestion"
      ? /^(?:💡\s*(?:simpler\s*:|suggestions?\s*:)?|(?:simpler|suggestions?)\s*:|💡)\s*/iu
      : severity === "bug"
        ? /^(?:🔴\s*(?:bug\s*:)?|bug\s*:|🔴)\s*/iu
        : /^(?:🟡\s*(?:risk\s*:)?|risk\s*:|🟡)\s*/iu;
  for (;;) {
    const m = re.exec(cur);
    if (!m || m[0].length === 0) break;
    cur = cur.slice(m[0].length).replace(/^(?:\*\*|__)?\s*/, "");
    if (!cur) break;
  }
  return cur;
}

/** Canonicalize title and body separately, then join with one marker in front. */
export function canonicalFindingLine(
  title: string | undefined,
  body: string | undefined,
  severity: TypedSeverity,
  decision?: MaintainerDecision
): string {
  if (severity === "question") {
    const t = stripQuestionPart(title ?? "");
    const b = stripQuestionPart(body ?? "");
    const isMaintainer = resolveMaintainerResolved(decision ?? "none", t.isMaintainer || b.isMaintainer);
    const combined = [t.content, b.content].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const base = isMaintainer ? "❓ maintainer" : "❓ q";
    return combined ? `${base}: ${combined}` : `${base}:`;
  }
  const t = stripSeverityPart(title ?? "", severity);
  const b = stripSeverityPart(body ?? "", severity);
  let combined = [t, b].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!combined) {
    const raw = [title ?? "", body ?? ""].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (raw) {
      if (severity === "bug") combined = "🔴";
      else if (severity === "risk") combined = "🟡";
      else if (severity === "suggestion") combined = "💡";
    }
  }
  if (severity === "suggestion") return combined ? `💡 simpler: ${combined}` : `💡 simpler:`;
  if (severity === "bug") return combined ? `🔴 bug: ${combined}` : `🔴 bug:`;
  return combined ? `🟡 risk: ${combined}` : `🟡 risk:`;
}

export function isMaintainerStoreFindingTyped(finding: {
  severity: string;
  title: string;
  body: string;
  maintainerDecision?: MaintainerDecision;
}): boolean {
  if (finding.severity !== "question") return false;
  if (finding.maintainerDecision === "typed_true") return true;
  if (finding.maintainerDecision === "typed_false") return false;
  return canonicalFindingLine(finding.title, finding.body, "question").startsWith("❓ maintainer:");
}

export function countMaintainerStoreFindingsTyped(
  findings: ReadonlyArray<{ severity: string; title: string; body: string; maintainerDecision?: MaintainerDecision }>
): number {
  let count = 0;
  for (const finding of findings) {
    if (isMaintainerStoreFindingTyped(finding)) count++;
  }
  return count;
}

export interface ReviewProof {
  location?: string;
  command?: string;
  excerpt?: string;
}

export type ReviewIncomplete = "none" | "could_not_finish" | "head_moved" | "dirty_tree" | "no_artifact";

function isIncomplete(value: unknown): value is ReviewIncomplete {
  return (
    value === "none" ||
    value === "could_not_finish" ||
    value === "head_moved" ||
    value === "dirty_tree" ||
    value === "no_artifact"
  );
}

/** Minimal finding shape the typed validators need (store record compatible). */
export interface TypedFindingLike {
  id: string;
  path?: string;
  line?: number;
  severity: string;
  title: string;
  body: string;
  maintainerDecision?: MaintainerDecision;
  proof?: ReviewProof;
}

export function parseNeedsMaintainer(
  value: unknown,
  severity: string
): { ok: true; decision: MaintainerDecision } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, decision: "none" };
  if (typeof value !== "boolean") {
    return { ok: false, error: "needs_maintainer must be a boolean" };
  }
  if (severity !== "question") {
    return { ok: false, error: "needs_maintainer is only valid on a question" };
  }
  return { ok: true, decision: value ? "typed_true" : "typed_false" };
}

function resolveMaintainerResolved(decision: MaintainerDecision | undefined, legacyIsMaintainer: boolean): boolean {
  if (decision === "typed_true") return true;
  if (decision === "typed_false") return false;
  return legacyIsMaintainer;
}

const CONTROL_RE = /<!--\s*jumi-/i;
const FENCE_RUN_RE = /(`{3,}|~{3,})/;

function proofFieldError(field: string, value: string): string | undefined {
  if (CONTROL_RE.test(value)) {
    return `${field} must not contain Jumi control syntax (<!-- jumi- ...)`;
  }
  return undefined;
}

export function normalizeProofInput(raw: unknown): { ok: true; proof?: ReviewProof } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "proof must be an object with location, command or excerpt" };
  }
  const obj = raw as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const v = obj[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t ? t : undefined;
  };
  const rawLocation = obj.location;
  const rawCommand = obj.command;
  const rawExcerpt = obj.excerpt;
  for (const [key, v] of [
    ["location", rawLocation],
    ["command", rawCommand],
    ["excerpt", rawExcerpt],
  ] as const) {
    if (v !== undefined && v !== null && typeof v !== "string") {
      return { ok: false, error: `proof.${key} must be a string` };
    }
  }
  const location = pick("location");
  const commandRaw = pick("command");
  const excerptRaw = pick("excerpt");
  // Location/command are single-line references: collapse whitespace so an
  // embedded newline cannot smuggle a second finding line past the renderer.
  const command = commandRaw?.replace(/\s+/g, " ").trim() || undefined;
  const collapsedLocation = location?.replace(/\s+/g, " ").trim() || undefined;
  const excerpt = excerptRaw?.trim() ? excerptRaw.trim() : undefined;
  if (!collapsedLocation && !command && !excerpt) {
    return { ok: false, error: "proof needs at least one non-blank field (location, command or excerpt)" };
  }
  if (collapsedLocation) {
    const err = proofFieldError("proof.location", collapsedLocation);
    if (err) return { ok: false, error: err };
  }
  if (command) {
    const err = proofFieldError("proof.command", command);
    if (err) return { ok: false, error: err };
  }
  if (excerpt) {
    const err = proofFieldError("proof.excerpt", excerpt);
    if (err) return { ok: false, error: err };
    if (FENCE_RUN_RE.test(excerpt)) {
      return {
        ok: false,
        error: "proof.excerpt must not contain ``` or ~~~ (Jumi renders the excerpt in its own closed fence)",
      };
    }
  }
  const proof: ReviewProof = {
    ...(collapsedLocation ? { location: collapsedLocation } : {}),
    ...(command ? { command } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
  return { ok: true, proof };
}

/**
 * Render a proof as indented continuation lines attached to its finding.
 * Every line starts with two spaces so legacy block collection keeps it
 * attached; the excerpt (when present) always rides inside its own closed
 * fence so marker-looking text inside cannot start a new finding.
 */
export function renderProofLines(proof: ReviewProof): string[] {
  const lines: string[] = [];
  if (proof.location) lines.push(`  Proof: ${proof.location}`);
  else lines.push(`  Proof:`);
  if (proof.command) lines.push(`  $ ${proof.command}`);
  if (proof.excerpt) {
    lines.push("  ```");
    for (const row of proof.excerpt.split(/\r?\n/)) {
      // Keep the excerpt verbatim inside the fence; prefix with two spaces
      // so an empty line stays inside the block and a fence-close lookalike
      // (already rejected) is the only way out.
      lines.push(row.length > 0 ? `  ${row}` : "  ");
    }
    lines.push("  ```");
  }
  return lines;
}

/** Canonical blank-reason for an incomplete failure (still matches the legacy regex). */
export function canonicalIncompleteReason(incomplete: ReviewIncomplete): string {
  switch (incomplete) {
    case "could_not_finish":
      return "could not finish";
    case "head_moved":
      return "head moved";
    case "dirty_tree":
      return "dirty tree";
    case "no_artifact":
      return "no artifact";
    case "none":
      return "";
  }
}

export function parseIncomplete(
  value: unknown,
  state: string
): { ok: true; incomplete: ReviewIncomplete } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, incomplete: "none" };
  if (typeof value !== "string" || !isIncomplete(value)) {
    return { ok: false, error: "bad incomplete (want none|could_not_finish|head_moved|dirty_tree|no_artifact)" };
  }
  if (value !== "none" && state !== "failure") {
    return { ok: false, error: "incomplete is only valid with failure" };
  }
  return { ok: true, incomplete: value };
}

/** Compare legacy readings with and without one proof. */
function checkProofIsolationPair(withProof: string, withoutProof: string): { ok: true } | { ok: false; error: string } {
  const withFindings = parseReviewFindings(withProof);
  const withoutFindings = parseReviewFindings(withoutProof);
  if (withFindings.length !== withoutFindings.length) {
    return {
      ok: false,
      error: `proof changes finding boundaries (${withoutFindings.length} without, ${withFindings.length} with); keep the proof inside its own finding`,
    };
  }
  for (let i = 0; i < withFindings.length; i++) {
    const a = withFindings[i];
    const b = withoutFindings[i];
    if (!a || !b || a.path !== b.path || a.line !== b.line) {
      return {
        ok: false,
        error: `proof moves finding ${i + 1} (${b?.path ?? "?"}:${b?.line ?? "?"} vs ${a?.path ?? "?"}:${a?.line ?? "?"}); keep the proof inside its own finding`,
      };
    }
  }
  const withLines = reviewFindingLines(withProof);
  const withoutLines = reviewFindingLines(withoutProof);
  if (withLines.length !== withoutLines.length) {
    return {
      ok: false,
      error: `proof changes finding blocks (${withoutLines.length} without, ${withLines.length} with); keep the proof inside its own finding`,
    };
  }
  const counters: Array<(text: string) => number> = [
    countQuestionFindings,
    countSuggestionFindings,
    countBugFindings,
    countRiskFindings,
    countBlockingFindings,
    countMaintainerQuestionFindings,
    countNonMaintainerQuestionFindings,
  ];
  const names = ["question", "suggestion", "bug", "risk", "blocking", "maintainer", "non-maintainer question"];
  for (let i = 0; i < counters.length; i++) {
    const fn = counters[i];
    if (!fn) continue;
    if (fn(withProof) !== fn(withoutProof)) {
      return {
        ok: false,
        error: `proof changes legacy ${names[i]} count; keep marker-looking proof text inside the fenced excerpt`,
      };
    }
  }
  const withParsed = parseReviewOutput(withProof);
  const withoutParsed = parseReviewOutput(withoutProof);
  if (
    withParsed.verdict.state !== withoutParsed.verdict.state ||
    withParsed.verdict.description !== withoutParsed.verdict.description ||
    withParsed.verdict.incomplete !== withoutParsed.verdict.incomplete
  ) {
    return {
      ok: false,
      error: "proof changes the check trailer; keep trailer-looking text out of the proof",
    };
  }
  // Every proof must stay attached to its own finding and carry proof there.
  // Unlocated findings never appear in `parseReviewFindings`, so scan the
  // published blocks themselves: each `Proof:` block must pass the proof check.
  let proofBlocks = 0;
  for (const block of withLines) {
    if (/proof\s*:/i.test(block)) {
      proofBlocks++;
      if (!hasFindingProof(block)) {
        return {
          ok: false,
          error:
            "proof is not attached to its finding with a file:line, command or fenced excerpt; add a location with a line number, a command, or an excerpt",
        };
      }
    }
  }
  if (proofBlocks === 0) {
    return { ok: false, error: "proof rendering lost the Proof: line; keep it on its own line inside the finding" };
  }
  return { ok: true };
}

const SENTINEL_PATH = "src/jumi-sentinel-proof-check.ts";
const SENTINEL_LINE = 1;

function findingsContainSentinel(text: string): boolean {
  return parseReviewFindings(text).some((f) => f.path === SENTINEL_PATH && f.line === SENTINEL_LINE);
}

/**
 * Validate every proof in a store rendering: pairwise isolation plus the
 * sentinel check in store order and in body-then-inline (predecessor) order.
 * `buildMarkdown` renders the given findings with the current verdict/trailer.
 */
export function validateAllProofs(
  findings: readonly TypedFindingLike[],
  buildMarkdown: (ordered: readonly TypedFindingLike[]) => string
): { ok: true } | { ok: false; error: string } {
  const proofIds = findings.filter((f) => f.proof).map((f) => f.id);
  if (proofIds.length === 0) return { ok: true };
  const withProof = buildMarkdown(findings);
  // Pairwise isolation: with all proofs vs without each single proof.
  for (const id of proofIds) {
    const without = findings.map((f) => (f.id === id && f.proof ? { ...f, proof: undefined } : f));
    const withoutProof = buildMarkdown(without);
    const pair = checkProofIsolationPair(withProof, withoutProof);
    if (!pair.ok) return { ok: false, error: `finding ${id}: ${pair.error}` };
    // The rendered proof itself must carry proof where the legacy reader sees it.
    const blocks = reviewFindingLines(withProof);
    const hasProof = blocks.some((b) => /proof\s*:/i.test(b) && hasFindingProof(b));
    if (!hasProof) {
      return {
        ok: false,
        error: `finding ${id}: proof is not attached to its finding with a file:line, command or fenced excerpt; add a location with a line number, a command, or an excerpt`,
      };
    }
  }
  // Sentinel: a synthetic located bug right after each proof-bearing finding
  // must parse separately at its own location, in store order and in
  // body-then-inline (predecessor) order.
  const orders: Array<{ name: string; ordered: TypedFindingLike[] }> = [
    { name: "body", ordered: [...findings] },
    {
      name: "predecessor",
      ordered: [
        ...findings.filter((f) => f.path === undefined || f.line === undefined),
        ...findings.filter((f) => f.path !== undefined && f.line !== undefined),
      ],
    },
  ];
  for (const order of orders) {
    for (let i = 0; i < order.ordered.length; i++) {
      const current = order.ordered[i];
      if (!current || !current.proof) continue;
      const sentinel: TypedFindingLike = {
        id: "__sentinel__",
        path: SENTINEL_PATH,
        line: SENTINEL_LINE,
        severity: "bug",
        title: "sentinel probe",
        body: "sentinel",
      };
      const withSentinel = [...order.ordered.slice(0, i + 1), sentinel, ...order.ordered.slice(i + 1)];
      const text = buildMarkdown(withSentinel);
      const parsed = parseReviewFindings(text);
      const found = parsed.find((f) => f.path === SENTINEL_PATH && f.line === SENTINEL_LINE);
      if (!found) {
        return {
          ok: false,
          error: `finding ${current.id}: proof swallows the next finding (${order.name} order); keep the excerpt inside its closed fence`,
        };
      }
      if (!findingsContainSentinel(text)) {
        return {
          ok: false,
          error: `finding ${current.id}: sentinel lost in ${order.name} order; keep the proof inside its own finding`,
        };
      }
      // Sentinel must not disturb the other counts beyond +1 blocking/bug.
      const base = parseReviewFindings(buildMarkdown(order.ordered));
      if (parsed.length !== base.length + 1) {
        return {
          ok: false,
          error: `finding ${current.id}: proof merges findings in ${order.name} order; keep the proof inside its own finding`,
        };
      }
    }
  }
  return { ok: true };
}
