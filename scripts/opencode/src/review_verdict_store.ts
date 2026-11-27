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

import {
  canonicalFindingLine,
  canonicalIncompleteReason,
  countMaintainerStoreFindingsTyped,
  type DispositionBy,
  isMaintainerStoreFindingTyped,
  type MaintainerDecision,
  normalizeProofInput,
  type PriorDisposition,
  parseIncomplete,
  parseNeedsMaintainer,
  parseSetDispositionInput,
  priorTextControlError,
  type ReviewIncomplete,
  type ReviewProof,
  renderProofLines,
  validateAllProofs,
} from "./review_verdict_typed.ts";
import { buildCheckTrailer, parseReviewFindings } from "./verdict.ts";

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
  needs_maintainer?: unknown;
  proof?: unknown;
}

export interface ReviewMcpFindingRecord {
  id: string;
  path?: string;
  line?: number;
  severity: ReviewMcpSeverity;
  title: string;
  body: string;
  maintainerDecision?: MaintainerDecision;
  proof?: ReviewProof;
  /** Prior key when materialised via `set_disposition(still_present)`; kept across `update_finding`. */
  key?: string;
  /** True only for a freshly materialised prior (verbatim exact bytes); cleared on reword. */
  verbatim?: boolean;
}

export interface ReviewMcpVerdict {
  state: "success" | "failure";
  reason?: string;
  incomplete?: ReviewIncomplete;
}

interface ReviewRecordFinding {
  id: string;
  path?: string;
  line?: number;
  severity: ReviewMcpSeverity;
  title: string;
  body: string;
  maintainerDecision?: MaintainerDecision;
  proof?: ReviewProof;
  key?: string;
  verbatim?: boolean;
}

export interface ReviewDispositionRecord {
  key: string;
  disposition: PriorDisposition;
  by: DispositionBy;
}

interface ReviewRecordCounts {
  bug: number;
  risk: number;
  question: number;
  suggestion: number;
  /** Subset of `question` already addressed to the maintainer (`❓ maintainer:`). Always written (zero included). */
  maintainerQuestion?: number;
}

export interface ReviewRecord {
  version: 1;
  state: "success" | "failure" | "incomplete";
  reason?: string;
  findings: ReviewRecordFinding[];
  counts: ReviewRecordCounts;
  incomplete?: ReviewIncomplete;
  /** Reviewer + parent dispositions for eligible keyed priors; omitted when empty. */
  dispositions?: ReviewDispositionRecord[];
}

/** Eligible keyed prior the parent supplied for this attempt (verified signed block). */
export interface KeyedPriorInfo {
  key: string;
  /** Exact verified text without the location prefix (body block without `path:line:`, inline live body without footer). */
  text: string;
  severity: ReviewMcpSeverity;
  maintainerDecision?: MaintainerDecision;
  /** Signed path/line; absent for unlocated body priors. */
  path?: string;
  line?: number;
  placement: "body" | "inline";
  /** True when the file is unchanged since the signed head (location prefilled). */
  unchanged?: boolean;
  /** True when the parent auto-withdrew (excluded, not in PR, absent on head). Never required. */
  autoWithdrawn?: boolean;
}

export interface KeyedPriorDisplay {
  key: string;
  text: string;
  severity: ReviewMcpSeverity;
  location?: { path: string; line: number };
  status: "pending" | "withdrawn";
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
  /** Eligible keyed priors (verified block, ancestry proven). Auto-withdrawn entries carry `autoWithdrawn: true`. */
  keyedPriors?: readonly KeyedPriorInfo[];
}

const COULD_NOT_FINISH_RE =
  /could not finish|incomplete|no (output|artifact|verdict|findings)|dirty tree|head moved|missing/i;

export function isMaintainerStoreFinding(
  finding: Pick<ReviewMcpFindingRecord, "severity" | "title" | "body"> & { maintainerDecision?: MaintainerDecision }
): boolean {
  return isMaintainerStoreFindingTyped(finding);
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
  private readonly priors = new Map<string, KeyedPriorInfo>();
  private readonly dispositions = new Map<
    string,
    { disposition: PriorDisposition; by: DispositionBy; note?: string }
  >();
  private readonly keyToId = new Map<string, string>();
  private readonly idToKey = new Map<string, string>();
  private nextId = 1;
  private verdict: ReviewMcpVerdict | undefined;
  private incomplete: ReviewIncomplete = "none";
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
    for (const prior of opts.keyedPriors ?? []) {
      if (!prior || typeof prior.key !== "string" || !prior.key.trim()) continue;
      if (!isReviewMcpSeverity(prior.severity)) continue;
      if (typeof prior.text !== "string") continue;
      const key = prior.key.trim();
      if (this.priors.has(key)) continue;
      this.priors.set(key, {
        key,
        text: prior.text,
        severity: prior.severity,
        ...(prior.maintainerDecision !== undefined ? { maintainerDecision: prior.maintainerDecision } : {}),
        ...(prior.path !== undefined ? { path: prior.path } : {}),
        ...(prior.line !== undefined ? { line: prior.line } : {}),
        placement: prior.placement === "inline" ? "inline" : "body",
        ...(prior.unchanged !== undefined ? { unchanged: prior.unchanged } : {}),
        ...(prior.autoWithdrawn ? { autoWithdrawn: true } : {}),
      });
      if (prior.autoWithdrawn) {
        this.dispositions.set(key, { disposition: "withdrawn", by: "parent" });
      }
    }
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
    if (!this.verdict) return undefined;
    return { ...this.verdict, ...(this.incomplete !== "none" ? { incomplete: this.incomplete } : {}) };
  }

  listFindings(): ReviewMcpFindingRecord[] {
    return [...this.findings.values()].map((finding) => ({ ...finding }));
  }

  listPreviousFindings(): Array<string | KeyedPriorDisplay> {
    const out: Array<string | KeyedPriorDisplay> = [];
    for (const prior of this.priors.values()) {
      const display: KeyedPriorDisplay = {
        key: prior.key,
        text: prior.text,
        severity: prior.severity,
        status: prior.autoWithdrawn ? "withdrawn" : "pending",
      };
      if (prior.path !== undefined && prior.line !== undefined) {
        display.location = { path: prior.path, line: prior.line };
      }
      out.push(display);
    }
    for (const line of this.previous) out.push(line);
    return out;
  }

  listDispositions(): ReviewDispositionRecord[] {
    return [...this.dispositions.entries()].map(([key, value]) => ({
      key,
      disposition: value.disposition,
      by: value.by,
    }));
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
    const hasMaintainerKey = input.needs_maintainer !== undefined && input.needs_maintainer !== null;
    const maint = parseNeedsMaintainer(hasMaintainerKey ? input.needs_maintainer : undefined, input.severity as string);
    if (!maint.ok) return maint;
    if (hasMaintainerKey && input.severity !== "question") {
      return { ok: false, error: "needs_maintainer is only valid on a question" };
    }
    const proofRaw = (input as { proof?: unknown }).proof;
    const proofParsed = normalizeProofInput(proofRaw);
    if (!proofParsed.ok) return proofParsed;
    const id = `f${this.nextId++}`;
    const record: ReviewMcpFindingRecord = {
      id,
      ...(location.path ? { path: location.path } : {}),
      ...(location.line != null ? { line: location.line } : {}),
      severity: input.severity as ReviewMcpSeverity,
      title,
      body,
      maintainerDecision: maint.decision,
      ...(proofParsed.proof ? { proof: proofParsed.proof } : {}),
    };
    const prevNext = this.nextId;
    this.findings.set(id, record);
    const proofCheck = this.checkProofs([...this.findings.values()]);
    if (!proofCheck.ok) {
      this.findings.delete(id);
      this.nextId = prevNext - 1;
      return proofCheck;
    }
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
    const severity = severityRaw as ReviewMcpSeverity;
    let decision: MaintainerDecision = current.maintainerDecision ?? "none";
    const hasMaintainerKey = input.needs_maintainer !== undefined && input.needs_maintainer !== null;
    if (severity !== "question") {
      if (hasMaintainerKey) return { ok: false, error: "needs_maintainer is only valid on a question" };
      decision = "none";
    } else if (hasMaintainerKey) {
      const parsed = parseNeedsMaintainer(input.needs_maintainer, severity);
      if (!parsed.ok) return parsed;
      decision = parsed.decision;
    }
    let proof = current.proof;
    if ((input as { proof?: unknown }).proof !== undefined) {
      const raw = (input as { proof?: unknown }).proof;
      if (raw === null) proof = undefined;
      else {
        const parsed = normalizeProofInput(raw);
        if (!parsed.ok) return parsed;
        proof = parsed.proof;
      }
    }
    const next: ReviewMcpFindingRecord = {
      id,
      ...(location.path ? { path: location.path } : {}),
      ...(location.line != null ? { line: location.line } : {}),
      severity,
      title,
      body,
      maintainerDecision: decision,
      ...(proof ? { proof } : {}),
      ...(current.key ? { key: current.key } : {}),
    };
    this.findings.set(id, next);
    const proofCheck = this.checkProofs([...this.findings.values()]);
    if (!proofCheck.ok) {
      this.findings.set(id, current);
      return proofCheck;
    }
    this.clearStaleSuccess();
    return { ok: true };
  }

  removeFinding(input: { id: unknown }): { ok: true } | ReviewMcpError {
    const closed = this.assertOpen();
    if (closed) return closed;
    const id = String(input.id ?? "").trim();
    if (!id) return { ok: false, error: "remove_finding needs an id" };
    const current = this.findings.get(id);
    if (!current) return { ok: false, error: `unknown finding: ${id}` };
    this.findings.delete(id);
    if (current.key) {
      this.keyToId.delete(current.key);
      this.idToKey.delete(id);
      this.dispositions.delete(current.key);
    }
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
      this.incomplete = "none";
    }
  }

  private renderFor(list: readonly ReviewMcpFindingRecord[], verdict?: ReviewMcpVerdict): string {
    const lines: string[] = [];
    for (const f of list) {
      if (f.key && f.verbatim) {
        lines.push(f.path && f.line != null ? `${f.path}:${f.line}: ${f.body}` : f.body);
      } else {
        const canonical = canonicalFindingLine(f.title, f.body, f.severity, f.maintainerDecision);
        lines.push(f.path && f.line != null ? `${f.path}:${f.line}: ${canonical}` : canonical);
      }
      if (f.proof) lines.push(...renderProofLines(f.proof));
    }
    const trailer = verdict
      ? buildCheckTrailer(verdict.state, verdict.reason)
      : "<!-- jumi-check: failure; Incomplete review: no verdict -->";
    return [...lines, trailer].join("\n");
  }

  private checkProofs(
    list: readonly ReviewMcpFindingRecord[],
    verdict?: ReviewMcpVerdict
  ): { ok: true } | ReviewMcpError {
    if (!list.some((f) => f.proof)) return { ok: true };
    const byId = new Map(list.map((f) => [f.id, f]));
    const renderOrder = (order: readonly { id: string; proof?: ReviewProof }[]): string => {
      const lines: string[] = [];
      for (const item of order) {
        if (item.id === "__sentinel__") {
          const s = item as unknown as ReviewMcpFindingRecord;
          lines.push(`${s.path}:${s.line}: 🔴 bug: sentinel probe`);
          continue;
        }
        const orig = byId.get(item.id);
        if (!orig) continue;
        const proof = (item as { proof?: ReviewProof }).proof;
        if (orig.key && orig.verbatim) {
          lines.push(orig.path && orig.line != null ? `${orig.path}:${orig.line}: ${orig.body}` : orig.body);
        } else {
          const canonical = canonicalFindingLine(orig.title, orig.body, orig.severity, orig.maintainerDecision);
          lines.push(orig.path && orig.line != null ? `${orig.path}:${orig.line}: ${canonical}` : canonical);
        }
        if (proof) lines.push(...renderProofLines(proof));
      }
      const v = verdict ?? this.verdict;
      const trailer = v
        ? buildCheckTrailer(v.state, v.reason)
        : "<!-- jumi-check: failure; Incomplete review: no verdict -->";
      return [...lines, trailer].join("\n");
    };
    const res = validateAllProofs(
      list.map((f) => ({
        id: f.id,
        path: f.path,
        line: f.line,
        severity: f.severity,
        title: f.title,
        body: f.body,
        maintainerDecision: f.maintainerDecision,
        proof: f.proof,
      })),
      renderOrder
    );
    return res.ok ? { ok: true } : res;
  }

  setDisposition(raw: unknown): ReviewMcpOk<{ id?: string }> | ReviewMcpError {
    const closed = this.assertOpen();
    if (closed) return closed;
    const parsed = parseSetDispositionInput(raw);
    if (!parsed.ok) return parsed;
    const { key, disposition, note, location, bodyOnly } = parsed.value;
    const prior = this.priors.get(key);
    if (!prior) return { ok: false, error: `unknown or ineligible prior key: ${key}` };
    if (disposition === "fixed" || disposition === "withdrawn") {
      const existingId = this.keyToId.get(key);
      if (existingId) {
        const rec = this.findings.get(existingId);
        if (rec) {
          this.findings.delete(existingId);
          this.idToKey.delete(existingId);
        }
        this.keyToId.delete(key);
      }
      this.dispositions.set(key, {
        disposition,
        by: "reviewer",
        ...(note ? { note } : {}),
      });
      return { ok: true };
    }
    // still_present
    const existing = this.keyToId.get(key);
    if (existing && this.findings.has(existing)) {
      return { ok: true, id: existing };
    }
    if (prior.autoWithdrawn) {
      return { ok: false, error: `prior ${key} is auto-withdrawn (file gone or excluded): still_present rejected` };
    }
    const controlErr = priorTextControlError(prior.text);
    if (controlErr) return { ok: false, error: `prior ${key}: ${controlErr}` };
    let targetPath: string | undefined;
    let targetLine: number | undefined;
    const hasSignedLocation = prior.path !== undefined && prior.line !== undefined;
    const unchanged = prior.unchanged === true;
    if (hasSignedLocation && unchanged) {
      targetPath = prior.path;
      targetLine = prior.line;
      if (location) {
        const checked = this.validateLocation(location.path, location.line);
        if (!checked.ok) return { ok: false, error: `prior ${key}: ${checked.error}` };
        targetPath = checked.path;
        targetLine = checked.line;
      } else if (bodyOnly) {
        targetPath = undefined;
        targetLine = undefined;
      }
    } else if (hasSignedLocation && !unchanged) {
      if (bodyOnly) {
        targetPath = undefined;
        targetLine = undefined;
      } else if (location) {
        const checked = this.validateLocation(location.path, location.line);
        if (!checked.ok) return { ok: false, error: `prior ${key}: ${checked.error}` };
        targetPath = checked.path;
        targetLine = checked.line;
      } else {
        return {
          ok: false,
          error: `prior ${key}: file changed since the signed head; supply location {path, line} or body_only: true`,
        };
      }
    } else {
      // Unlocated prior: no location required; an explicit location is still validated.
      if (bodyOnly) {
        targetPath = undefined;
        targetLine = undefined;
      } else if (location) {
        const checked = this.validateLocation(location.path, location.line);
        if (!checked.ok) return { ok: false, error: `prior ${key}: ${checked.error}` };
        targetPath = checked.path;
        targetLine = checked.line;
      }
    }
    const id = `f${this.nextId++}`;
    const record: ReviewMcpFindingRecord = {
      id,
      ...(targetPath ? { path: targetPath } : {}),
      ...(targetLine != null ? { line: targetLine } : {}),
      severity: prior.severity,
      title: "",
      body: prior.text,
      maintainerDecision: prior.maintainerDecision ?? "none",
      key,
      verbatim: true,
    };
    const prevNext = this.nextId;
    this.findings.set(id, record);
    const proofCheck = this.checkProofs([...this.findings.values()]);
    if (!proofCheck.ok) {
      this.findings.delete(id);
      this.nextId = prevNext - 1;
      return { ok: false, error: `prior ${key}: ${proofCheck.error}` };
    }
    const sentinelCheck = this.checkMaterialisedIsolation();
    if (!sentinelCheck.ok) {
      this.findings.delete(id);
      this.nextId = prevNext - 1;
      return { ok: false, error: `prior ${key}: ${sentinelCheck.error}` };
    }
    this.keyToId.set(key, id);
    this.idToKey.set(id, key);
    this.dispositions.set(key, { disposition: "still_present", by: "reviewer", ...(note ? { note } : {}) });
    this.clearStaleSuccess();
    return { ok: true, id };
  }

  private checkMaterialisedIsolation(): { ok: true } | { ok: false; error: string } {
    const list = [...this.findings.values()];
    const markdown = this.renderFor(list, this.verdict);
    // A materialised prior must not swallow a later finding: a synthetic bug
    // right after it must still parse separately, in store order.
    const sentinelPath = "src/jumi-sentinel-proof-check.ts";
    const sentinelLine = 1;
    const withSentinel = `${markdown.split("\n").slice(0, -1).join("\n")}\n${sentinelPath}:${sentinelLine}: 🔴 bug: sentinel probe\n${markdown.split("\n").at(-1)}`;
    const parsed = parseReviewFindings(withSentinel);
    const found = parsed.find((f) => f.path === sentinelPath && f.line === sentinelLine);
    if (!found) {
      return { ok: false, error: "proof checks: materialised prior swallows the next finding; rejected" };
    }
    const base = parseReviewFindings(markdown);
    if (parsed.length !== base.length + 1) {
      return { ok: false, error: "proof checks: materialised prior merges findings; rejected" };
    }
    return { ok: true };
  }

  private missingDispositions(): string[] {
    const missing: string[] = [];
    for (const key of this.priors.keys()) {
      if (!this.dispositions.has(key)) missing.push(key);
    }
    return missing.sort();
  }

  setVerdict(input: { state: unknown; reason?: unknown; incomplete?: unknown }): { ok: true } | ReviewMcpError {
    const closed = this.assertOpen();
    if (closed) return closed;
    const state = input.state;
    if (state !== "success" && state !== "failure") {
      return { ok: false, error: `bad verdict state: ${String(state)} (want success|failure)` };
    }
    const parsedIncomplete = parseIncomplete((input as { incomplete?: unknown }).incomplete, state as string);
    if (!parsedIncomplete.ok) return parsedIncomplete;
    let reason = input.reason == null ? "" : String(input.reason).trim();
    if (!reason && parsedIncomplete.incomplete !== "none")
      reason = canonicalIncompleteReason(parsedIncomplete.incomplete);
    if (state === "success" && this.blockingOpen() > 0) {
      return { ok: false, error: "success rejected: open bug/risk findings remain" };
    }
    if (state === "failure" && this.blockingOpen() === 0) {
      const bypass = parsedIncomplete.incomplete !== "none";
      if (!bypass && !COULD_NOT_FINISH_RE.test(reason)) {
        return {
          ok: false,
          error: "failure needs at least one bug/risk finding or an explicit could-not-finish reason",
        };
      }
    }
    const next: ReviewMcpVerdict = {
      state: state as "success" | "failure",
      ...(reason ? { reason } : {}),
      ...(parsedIncomplete.incomplete !== "none" ? { incomplete: parsedIncomplete.incomplete } : {}),
    };
    if (parsedIncomplete.incomplete === "none") {
      const missing = this.missingDispositions();
      if (missing.length > 0) {
        return { ok: false, error: `missing dispositions for prior findings: ${missing.join(", ")}` };
      }
    }
    const proofCheck = this.checkProofs([...this.findings.values()], next);
    if (!proofCheck.ok) return proofCheck;
    this.verdict = reason
      ? { state: state as "success" | "failure", reason }
      : { state: state as "success" | "failure" };
    this.incomplete = parsedIncomplete.incomplete;
    if (this.incomplete !== "none") this.verdict = { ...this.verdict, incomplete: this.incomplete };
    return { ok: true };
  }

  /**
   * Markdown equivalent of today's `JUMI_REVIEW.md`: one finding block per
   * recorded finding (first line plus attached `Proof:` continuation lines),
   * then exactly one `jumi-check` trailer.
   */
  toMarkdown(): string {
    return this.renderFor([...this.findings.values()], this.verdict);
  }

  /**
   * Typed equivalent of `toMarkdown()`: the same verdict state and findings
   * as structured data, using the stored (unsanitized) reason. `incomplete`
   * is the no-verdict case. It carries no runtime-policy output (which
   * question authors block, suggestion caps, contract-env findings): only
   * what the store knows.
   */
  toRecord(): ReviewRecord {
    const counts: ReviewRecordCounts = { bug: 0, risk: 0, question: 0, suggestion: 0, maintainerQuestion: 0 };
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
        ...(finding.maintainerDecision && finding.maintainerDecision !== "none"
          ? { maintainerDecision: finding.maintainerDecision }
          : {}),
        ...(finding.proof ? { proof: finding.proof } : {}),
        ...(finding.key ? { key: finding.key } : {}),
        ...(finding.verbatim ? { verbatim: true } : {}),
      });
    }
    counts.maintainerQuestion = countMaintainerStoreFindingsTyped([...this.findings.values()]);
    const dispositions: ReviewDispositionRecord[] = [...this.dispositions.entries()].map(([key, value]) => ({
      key,
      disposition: value.disposition,
      by: value.by,
    }));
    const withDispositions = dispositions.length > 0 ? { dispositions } : {};
    if (!this.verdict) {
      return { version: 1, state: "incomplete", findings, counts, ...withDispositions };
    }
    return {
      version: 1,
      state: this.verdict.state,
      ...(this.verdict.reason ? { reason: this.verdict.reason } : {}),
      findings,
      counts,
      ...(this.incomplete !== "none" ? { incomplete: this.incomplete } : {}),
      ...withDispositions,
    };
  }
}
