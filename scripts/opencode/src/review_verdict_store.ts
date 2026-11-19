/**
 * In-memory review verdict behind the parent-owned review MCP server.
 *
 * The model records findings and the verdict through MCP tools. The parent
 * publishes from this state, never from a file in the checkout. Validation
 * that used to live in the prompt and `verdict.ts` (changed-file scoping,
 * hunk lines, severity enum, success/failure gating) now rejects bad calls
 * at call time so the model gets a useful error instead of the publisher
 * discovering it afterwards.
 */

import { buildCheckTrailer } from "./verdict.ts";

export type ReviewMcpSeverity = "bug" | "risk" | "question" | "suggestion";

const REVIEW_MCP_SEVERITIES: readonly ReviewMcpSeverity[] = ["bug", "risk", "question", "suggestion"];

function isReviewMcpSeverity(value: unknown): value is ReviewMcpSeverity {
  return value === "bug" || value === "risk" || value === "question" || value === "suggestion";
}

export interface ReviewMcpFindingInput {
  path?: string;
  line?: number;
  severity: ReviewMcpSeverity | string;
  title?: string;
  body?: string;
}

export interface ReviewMcpFindingRecord {
  id: string;
  path?: string;
  line?: number;
  severity: ReviewMcpSeverity;
  title: string;
  body: string;
}

export interface ReviewMcpVerdict {
  state: "success" | "failure";
  reason?: string;
}

interface ReviewRecordFinding {
  id: string;
  path?: string;
  line?: number;
  severity: ReviewMcpSeverity;
  title: string;
  body: string;
}

interface ReviewRecordCounts {
  bug: number;
  risk: number;
  question: number;
  suggestion: number;
  /** Subset of `question` already addressed to the maintainer (`❓ maintainer:`). */
  maintainerQuestion?: number;
}

export interface ReviewRecord {
  version: 1;
  state: "success" | "failure" | "incomplete";
  reason?: string;
  findings: ReviewRecordFinding[];
  counts: ReviewRecordCounts;
}

export type ReviewMcpError = { ok: false; error: string };
export type ReviewMcpOk<T> = { ok: true } & T;

function usableMcpPath(path: string): string | undefined {
  let value = path.trim().replace(/\\/g, "/");
  if (value.startsWith("./")) value = value.slice(2);
  if (!value || value.startsWith("/") || value.includes("\0")) return undefined;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return value;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function hunkLinesForPatch(patch: string): Set<number> {
  const lines = new Set<number>();
  const raw = patch.split(/\r?\n/);
  let next = 0;
  let inHunk = false;
  for (const row of raw) {
    const hunk = HUNK_RE.exec(row);
    if (hunk) {
      next = Number.parseInt(hunk[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (row.startsWith("+++") || row.startsWith("---")) continue;
    if (row.startsWith("+")) {
      if (Number.isSafeInteger(next) && next >= 1) lines.add(next);
      next += 1;
    } else if (row.startsWith("-")) {
      // Removed line: not a line in the new file.
    } else if (row.startsWith("\\")) {
      // "\ No newline at end of file": no line advance.
    } else {
      // Context line (including a bare empty split line): part of the hunk.
      if (Number.isSafeInteger(next) && next >= 1) lines.add(next);
      next += 1;
    }
  }
  return lines;
}

export interface ReviewVerdictStoreOpts {
  changedFiles: readonly { filename: string; patch?: string }[];
  excludedFiles?: readonly string[];
  previousFindings?: readonly string[];
}

const COULD_NOT_FINISH_RE =
  /could not finish|incomplete|no (output|artifact|verdict|findings)|dirty tree|head moved|missing/i;

function severityMarker(severity: ReviewMcpSeverity): string {
  switch (severity) {
    case "bug":
      return "🔴 bug";
    case "risk":
      return "🟡 risk";
    case "suggestion":
      return "💡 simpler";
    case "question":
      return "❓ q";
  }
}

/** Check trailers embedded in hostile titles/bodies: the text parser strips them before counting. */
function stripEmbeddedChecks(text: string): string {
  return text
    .replace(/<!--\s*jumi-check:\s*(?:success|failure)(?:\s*;\s*(?:(?!-->).)*?)?\s*-->/gi, " ")
    .replace(/<!--\s*jumi-review:[^>]*-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical finding line for `toMarkdown()`: a single severity marker, never
 * a doubled `❓ q: ❓ maintainer:` / `💡 simpler: 💡 simpler:` prefix and never
 * a marker repeated from the body (`❓ maintainer: … ❓ maintainer: …`). The
 * model already writes its own marker (`❓ maintainer:`, `💡 simpler:`) and
 * may repeat it in the body; the store canonicalizes the title and the body
 * separately (stripping that severity's leading markers from each), joins the
 * remainders, and puts one canonical marker in front so the text parser
 * matches and an unlocated line never parses as a located finding (the
 * canonical `word:` keeps a colon inside any would-be path, which the path
 * validator rejects).
 */
function stripQuestionPart(part: string): { content: string; isMaintainer: boolean } {
  // For questions, strip embedded check/review trailers first, mirroring the
  // text parser's maintainer count (which runs on stripped comment text):
  // otherwise the canonical prefix and the record count disagree on hostile
  // inputs that hide a marker behind a check literal.
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
      // A doubled `❓ q: ❓ maintainer:` still leads with a maintainer
      // marker after the generic strip: loop to catch it. Stripping to
      // empty is allowed per part so a bare marker still canonicalizes to
      // a single marker once the parts are rejoined.
      if (!cur) break;
      continue;
    }
    break;
  }
  return { content: cur, isMaintainer };
}

function stripSeverityPart(part: string, severity: ReviewMcpSeverity): string {
  // Other severities keep the raw text so a check-only body still counts,
  // matching the raw-line risk/suggestion counters; embedded checks are not
  // stripped here.
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
function canonicalFindingLine(
  title: string | undefined,
  body: string | undefined,
  severity: ReviewMcpSeverity
): string {
  if (severity === "question") {
    const t = stripQuestionPart(title ?? "");
    const b = stripQuestionPart(body ?? "");
    const isMaintainer = t.isMaintainer || b.isMaintainer;
    const combined = [t.content, b.content].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const base = isMaintainer ? "❓ maintainer" : "❓ q";
    return combined ? `${base}: ${combined}` : `${base}:`;
  }
  const t = stripSeverityPart(title ?? "", severity);
  const b = stripSeverityPart(body ?? "", severity);
  let combined = [t, b].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!combined) {
    // A finding whose whole text is markers (`🟡` + `🟡`) still publishes
    // with a body so the parser counts it, matching the typed input. The
    // body is the bare emoji so the line keeps one canonical `word:` prefix.
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

/**
 * Whether a stored finding is a maintainer-only `❓`: a question whose
 * title or whose body leads with the prescribed `❓ maintainer:` marker
 * (tolerating a doubled `❓ q: ❓ maintainer:` prefix, so old rows still
 * count). A `❓ maintainer:` buried in the middle of both parts does not
 * count, matching the text parser which only reads the published first line.
 */
function isMaintainerStoreFinding(finding: Pick<ReviewMcpFindingRecord, "severity" | "title" | "body">): boolean {
  if (finding.severity !== "question") return false;
  // Agreement with the text parser runs on the canonical markdown, not the
  // raw input: each part is canonicalized separately by `toMarkdown()`, so a
  // `❓ maintainer:` leading either part publishes as `❓ maintainer:` and
  // must count here too.
  return canonicalFindingLine(finding.title, finding.body, "question").startsWith("❓ maintainer:");
}

/** Count the maintainer-only `❓` findings among stored findings. */
function countMaintainerStoreFindings(
  findings: ReadonlyArray<Pick<ReviewMcpFindingRecord, "severity" | "title" | "body">>
): number {
  let count = 0;
  for (const finding of findings) {
    if (isMaintainerStoreFinding(finding)) count++;
  }
  return count;
}

/**
 * Store behind the review MCP tools. Not thread-safe across workers; one
 * store lives for one spawn and dies with it.
 */
export class ReviewVerdictStore {
  private readonly changed = new Set<string>();
  private readonly excluded = new Set<string>();
  private readonly hunks = new Map<string, Set<number>>();
  private readonly findings = new Map<string, ReviewMcpFindingRecord>();
  private readonly previous: readonly string[];
  private nextId = 1;
  private verdict: ReviewMcpVerdict | undefined;
  private closed = false;

  constructor(opts: ReviewVerdictStoreOpts) {
    for (const file of opts.changedFiles) {
      if (typeof file.filename !== "string" || !file.filename) continue;
      this.changed.add(file.filename);
      if (typeof file.patch === "string" && file.patch) {
        this.hunks.set(file.filename, hunkLinesForPatch(file.patch));
      }
    }
    for (const name of opts.excludedFiles ?? []) {
      if (typeof name === "string" && name) this.excluded.add(name);
    }
    this.previous = [...(opts.previousFindings ?? [])];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): ReviewMcpError | undefined {
    if (this.closed) return { ok: false, error: "review spawn ended: verdict store is closed" };
    return undefined;
  }

  hasFindings(): boolean {
    return this.findings.size > 0;
  }

  hasVerdict(): boolean {
    return this.verdict !== undefined;
  }

  hasAnything(): boolean {
    return this.findings.size > 0 || this.verdict !== undefined;
  }

  getVerdict(): ReviewMcpVerdict | undefined {
    return this.verdict ? { ...this.verdict } : undefined;
  }

  listFindings(): ReviewMcpFindingRecord[] {
    return [...this.findings.values()].map((finding) => ({ ...finding }));
  }

  listPreviousFindings(): string[] {
    return [...this.previous];
  }

  private validateLocation(path: unknown, line: unknown): { ok: true; path?: string; line?: number } | ReviewMcpError {
    const hasPath = path !== undefined && path !== null && String(path).trim() !== "";
    const hasLine = line !== undefined && line !== null && String(line).trim() !== "";
    if (!hasPath && !hasLine) return { ok: true } as const;
    if (hasPath !== hasLine) {
      return { ok: false, error: "path and line must be set together" };
    }
    const usable = usableMcpPath(String(path));
    if (!usable) return { ok: false, error: `unusable path: ${String(path)}` };
    if (!this.changed.has(usable)) return { ok: false, error: `path not in pull: ${usable}` };
    if (this.excluded.has(usable)) return { ok: false, error: `excluded path: ${usable}` };
    const numeric = typeof line === "number" ? line : Number.parseInt(String(line), 10);
    if (!Number.isSafeInteger(numeric) || numeric < 1) {
      return { ok: false, error: `unusable line: ${String(line)}` };
    }
    const valid = this.hunks.get(usable);
    if (!valid || valid.size === 0 || !valid.has(numeric)) {
      return {
        ok: false,
        error: `line outside hunks: ${usable}:${numeric} (no diff hunks cover this line; record the finding with no path and line if it still applies)`,
      };
    }
    return { ok: true, path: usable, line: numeric };
  }

  private validateSeverity(severity: unknown): severity is ReviewMcpSeverity {
    return isReviewMcpSeverity(severity);
  }

  addFinding(input: ReviewMcpFindingInput): ReviewMcpOk<{ id: string }> | ReviewMcpError {
    const closed = this.assertOpen();
    if (closed) return closed;
    if (!this.validateSeverity(input.severity)) {
      return { ok: false, error: `bad severity: ${String(input.severity)} (want bug|risk|question|suggestion)` };
    }
    const location = this.validateLocation(input.path, input.line);
    if (!location.ok) return location;
    const title = (input.title ?? "").trim();
    const body = (input.body ?? "").trim();
    if (!title && !body) return { ok: false, error: "finding needs a title or a body" };
    const id = `f${this.nextId++}`;
    this.findings.set(id, {
      id,
      ...(location.path ? { path: location.path } : {}),
      ...(location.line != null ? { line: location.line } : {}),
      severity: input.severity as ReviewMcpSeverity,
      title,
      body,
    });
    this.clearStaleSuccess();
    return { ok: true, id };
  }

  updateFinding(input: { id: unknown } & Partial<ReviewMcpFindingInput>): { ok: true } | ReviewMcpError {
    const closed = this.assertOpen();
    if (closed) return closed;
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "update_finding needs an id" };
    const current = this.findings.get(id);
    if (!current) return { ok: false, error: `unknown finding: ${id}` };
    const severityRaw = input.severity === undefined ? current.severity : input.severity;
    if (!this.validateSeverity(severityRaw)) {
      return { ok: false, error: `bad severity: ${String(input.severity)} (want bug|risk|question|suggestion)` };
    }
    const location = this.validateLocation(
      input.path === undefined ? current.path : input.path,
      input.line === undefined ? current.line : input.line
    );
    if (!location.ok) return location;
    const title = input.title === undefined ? current.title : String(input.title).trim();
    const body = input.body === undefined ? current.body : String(input.body).trim();
    if (!title && !body) return { ok: false, error: "finding needs a title or a body" };
    this.findings.set(id, {
      id,
      ...(location.path ? { path: location.path } : {}),
      ...(location.line != null ? { line: location.line } : {}),
      severity: severityRaw,
      title,
      body,
    });
    this.clearStaleSuccess();
    return { ok: true };
  }

  removeFinding(input: { id: unknown }): { ok: true } | ReviewMcpError {
    const closed = this.assertOpen();
    if (closed) return closed;
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "remove_finding needs an id" };
    if (!this.findings.delete(id)) return { ok: false, error: `unknown finding: ${id}` };
    return { ok: true };
  }

  private blockingOpen(): number {
    let count = 0;
    for (const finding of this.findings.values()) {
      if (finding.severity === "bug" || finding.severity === "risk") count++;
    }
    return count;
  }

  /** Open bug/risk findings. A recorded success verdict implies zero. */
  openBlockingCount(): number {
    return this.blockingOpen();
  }

  /**
   * A finding recorded after a success verdict is newer information that
   * invalidates it ("last wins" across tools, not just across verdict
   * calls). Clearing keeps the store from ever holding success alongside
   * an open bug/risk, whatever order the model calls the tools in.
   */
  private clearStaleSuccess(): void {
    if (this.verdict?.state === "success" && this.blockingOpen() > 0) {
      this.verdict = undefined;
    }
  }

  setVerdict(input: { state: unknown; reason?: unknown }): { ok: true } | ReviewMcpError {
    const closed = this.assertOpen();
    if (closed) return closed;
    const state = input.state;
    if (state !== "success" && state !== "failure") {
      return { ok: false, error: `bad verdict state: ${String(state)} (want success|failure)` };
    }
    const reason = input.reason == null ? "" : String(input.reason).trim();
    if (state === "success" && this.blockingOpen() > 0) {
      return { ok: false, error: "success rejected: open bug/risk findings remain" };
    }
    if (state === "failure" && this.blockingOpen() === 0 && !COULD_NOT_FINISH_RE.test(reason)) {
      return {
        ok: false,
        error: "failure needs at least one bug/risk finding or an explicit could-not-finish reason",
      };
    }
    this.verdict = reason ? { state, reason } : { state };
    return { ok: true };
  }

  /**
   * Markdown equivalent of today's `JUMI_REVIEW.md`: one finding line per
   * recorded finding, then exactly one `jumi-check` trailer. Findings without
   * a path/line publish as severity-marker body lines.
   */
  toMarkdown(): string {
    const lines: string[] = [];
    for (const finding of this.findings.values()) {
      // Canonical single marker: the model already writes its own marker
      // (`❓ maintainer:`, `💡 simpler:`) and may repeat it in the body;
      // canonicalizing title and body separately strips each part's leading
      // markers so the published body carries one marker the text parser
      // matches, and an unlocated line never parses as a located finding.
      const canonical = canonicalFindingLine(finding.title, finding.body, finding.severity);
      if (finding.path && finding.line != null) {
        lines.push(`${finding.path}:${finding.line}: ${canonical}`);
      } else {
        lines.push(canonical);
      }
    }
    const verdict = this.verdict;
    const trailer = verdict
      ? buildCheckTrailer(verdict.state, verdict.reason)
      : "<!-- jumi-check: failure; Incomplete review: no verdict -->";
    return [...lines, trailer].join("\n");
  }

  /**
   * Typed equivalent of `toMarkdown()`: the same verdict state and findings
   * as structured data, using the stored (unsanitized) reason. `incomplete`
   * is the no-verdict case. It carries no runtime-policy output (which
   * question authors block, suggestion caps, contract-env findings): only
   * what the store knows.
   */
  toRecord(): ReviewRecord {
    const counts: ReviewRecordCounts = { bug: 0, risk: 0, question: 0, suggestion: 0 };
    const findings: ReviewRecordFinding[] = [];
    for (const finding of this.findings.values()) {
      counts[finding.severity] += 1;
      findings.push({
        id: finding.id,
        ...(finding.path ? { path: finding.path } : {}),
        ...(finding.line != null ? { line: finding.line } : {}),
        severity: finding.severity,
        title: finding.title,
        body: finding.body,
      });
    }
    const maintainerQuestion = countMaintainerStoreFindings([...this.findings.values()]);
    if (maintainerQuestion > 0) counts.maintainerQuestion = maintainerQuestion;
    if (!this.verdict) {
      return { version: 1, state: "incomplete", findings, counts };
    }
    return {
      version: 1,
      state: this.verdict.state,
      ...(this.verdict.reason ? { reason: this.verdict.reason } : {}),
      findings,
      counts,
    };
  }
}
