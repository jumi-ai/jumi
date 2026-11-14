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

export type ReviewMcpSeverity = "bug" | "risk" | "question" | "suggestion";

export const REVIEW_MCP_SEVERITIES: readonly ReviewMcpSeverity[] = ["bug", "risk", "question", "suggestion"];

export function isReviewMcpSeverity(value: unknown): value is ReviewMcpSeverity {
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

export function severityMarker(severity: ReviewMcpSeverity): string {
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
      return { ok: false, error: `line outside hunks: ${usable}:${numeric}` };
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
      const text = [finding.title, finding.body].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      const marker = severityMarker(finding.severity);
      if (finding.path && finding.line != null) {
        lines.push(`${finding.path}:${finding.line}: ${marker}: ${text}`);
      } else {
        lines.push(`${marker}: ${text}`);
      }
    }
    const verdict = this.verdict;
    const trailer = verdict
      ? verdict.reason
        ? `<!-- jumi-check: ${verdict.state}; ${verdict.reason} -->`
        : `<!-- jumi-check: ${verdict.state} -->`
      : "<!-- jumi-check: failure; Incomplete review: no verdict -->";
    return [...lines, trailer].join("\n");
  }
}
