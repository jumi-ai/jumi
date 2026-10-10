import type { EngineResult } from "./engine.ts";
import { thrownChainIndex, thrownRunner } from "./engine.ts";
import type { ForgeKind } from "./forge.ts";
import { type NamedRunner, type RunnerStamp, runnerStamp } from "./runners.ts";
import type { SqlClient } from "./sql_client.ts";

export type ProvenanceStatus = "known" | "unknown" | "pending" | "failed";
export type IntentStatus = "pending" | "confirmed" | "failed";

export interface ProvenanceContributors {
  contributors: RunnerStamp[];
  publisher?: RunnerStamp | null;
}

export interface ProvenanceRecord extends ProvenanceContributors {
  id: number;
  forge: string;
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  headSha: string;
  status: "known";
  jobId: number;
  jobKey: string;
  delivery: string;
  jobKind: string;
  createdAt: number;
  updatedAt: number;
}

export interface IntentRecord extends ProvenanceContributors {
  id: number;
  forge: string;
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber: number;
  branch: string;
  jobId: number;
  jobKey: string;
  jobKind: string;
  delivery: string;
  status: IntentStatus;
  headSha: string;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnsureIntentInput {
  forge: string;
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber?: number;
  branch?: string;
  jobId: number;
  jobKey: string;
  jobKind: string;
  delivery: string;
}

export interface ConfirmPublicationInput {
  forge: string;
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  headSha: string;
  contributors: RunnerStamp[];
  publisher?: RunnerStamp | null;
  jobId: number;
  jobKey: string;
  delivery: string;
  jobKind: string;
  issueNumber?: number;
}

export interface ProvenanceLookup {
  status: ProvenanceStatus;
  forge: string;
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  headSha: string;
  contributors: RunnerStamp[];
  publisher?: RunnerStamp | null;
  jobId?: number | null;
  jobKey?: string | null;
}

export const PROVENANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pr_writer_provenance (
  id BIGSERIAL PRIMARY KEY,
  forge TEXT NOT NULL DEFAULT 'gitea',
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'known' CHECK (status IN ('known', 'pending', 'failed')),
  contributors JSONB NOT NULL DEFAULT '[]',
  publisher JSONB,
  job_id BIGINT NOT NULL,
  job_key TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT '',
  job_kind TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pr_writer_provenance_head_unique
  ON pr_writer_provenance (forge, owner, repo, head_sha);

CREATE INDEX IF NOT EXISTS pr_writer_provenance_pr_idx
  ON pr_writer_provenance (owner, repo, pr_number);

CREATE TABLE IF NOT EXISTS pr_publication_intents (
  id BIGSERIAL PRIMARY KEY,
  forge TEXT NOT NULL DEFAULT 'gitea',
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  pr_number INTEGER NOT NULL DEFAULT 0,
  branch TEXT NOT NULL DEFAULT '',
  job_id BIGINT NOT NULL,
  job_key TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  delivery TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  contributors JSONB NOT NULL DEFAULT '[]',
  publisher JSONB,
  head_sha TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pr_publication_intents_job_unique
  ON pr_publication_intents (job_id);

CREATE INDEX IF NOT EXISTS pr_publication_intents_pr_idx
  ON pr_publication_intents (owner, repo, pr_number);

CREATE INDEX IF NOT EXISTS pr_publication_intents_branch_idx
  ON pr_publication_intents (owner, repo, branch);
`;

export function provenanceRunnerKey(runner: RunnerStamp): string {
  const level = runner.effort ?? runner.variant ?? "";
  return `${runner.type}|${runner.model}|${level}`;
}

export function normalizeRunnerStamp(runner: RunnerStamp): RunnerStamp | undefined {
  const type = (runner.type ?? "").trim();
  const model = (runner.model ?? "").trim();
  if (!type || !model) return undefined;
  const effort = typeof runner.effort === "string" && runner.effort ? runner.effort : undefined;
  const variant = typeof runner.variant === "string" && runner.variant ? runner.variant : undefined;
  if (effort) return { type, model, effort };
  if (variant) return { type, model, variant };
  return { type, model };
}

export function mergeContributors(existing: RunnerStamp[], incoming: RunnerStamp[]): RunnerStamp[] {
  const seen = new Set<string>();
  const out: RunnerStamp[] = [];
  for (const runner of [...existing, ...incoming]) {
    const normalized = normalizeRunnerStamp(runner);
    if (!normalized) continue;
    const key = provenanceRunnerKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function sameContributor(left: RunnerStamp, right: RunnerStamp): boolean {
  return (
    provenanceRunnerKey(normalizeRunnerStamp(left) ?? left) ===
    provenanceRunnerKey(normalizeRunnerStamp(right) ?? right)
  );
}

export function runnerStampsFromChain(chain: readonly NamedRunner[], uptoIndex?: number): RunnerStamp[] {
  const end = uptoIndex == null ? chain.length - 1 : Math.min(uptoIndex, chain.length - 1);
  const out: RunnerStamp[] = [];
  for (let i = 0; i <= end; i++) {
    const entry = chain[i];
    if (!entry) continue;
    out.push(runnerStamp(entry));
  }
  return out;
}

function chainIndexForRunner(chain: readonly NamedRunner[], runner: RunnerStamp): number | undefined {
  const normalized = normalizeRunnerStamp(runner);
  if (!normalized) return undefined;
  const want = provenanceRunnerKey(normalized);
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (!entry) continue;
    if (provenanceRunnerKey(runnerStamp(entry)) === want) return i;
  }
  return undefined;
}

/** Conservative per-job collector: every code-writing runner that ran, plus the actual publisher. */
export class ProvenanceCollector {
  private contributors: RunnerStamp[] = [];
  private publisher: RunnerStamp | undefined;

  constructor(private readonly chain?: readonly NamedRunner[]) {}

  noteRunner(runner: RunnerStamp | undefined, chainIndex?: number): void {
    if (!runner) return;
    const normalized = normalizeRunnerStamp(runner);
    if (!normalized) return;
    let toAdd: RunnerStamp[];
    if (this.chain && this.chain.length > 0) {
      let idx = chainIndex;
      if (idx == null) idx = chainIndexForRunner(this.chain, normalized);
      if (idx != null && idx >= 0) {
        toAdd = runnerStampsFromChain(this.chain, idx);
      } else {
        toAdd = [normalized];
      }
    } else {
      toAdd = [normalized];
    }
    this.contributors = mergeContributors(this.contributors, toAdd);
    this.publisher = normalized;
  }

  noteResult(
    result: EngineResult,
    fallback?: { type?: string; model: string; variant?: string; effort?: string }
  ): void {
    const runner = result.runner ?? (fallback ? runnerStamp(fallback) : undefined);
    this.noteRunner(runner, result.chainIndex);
  }

  noteError(err: unknown): void {
    this.noteRunner(thrownRunner(err), thrownChainIndex(err));
  }

  getContributors(): RunnerStamp[] {
    return [...this.contributors];
  }

  getPublisher(): RunnerStamp | undefined {
    return this.publisher ? { ...this.publisher } : undefined;
  }

  isEmpty(): boolean {
    return this.contributors.length === 0;
  }
}

export function normalizeForge(value: string | ForgeKind | undefined): string {
  if (value === "github") return "github";
  return "gitea";
}

function normalizeHead(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function unknownLookup(input: {
  forge: string;
  owner: string;
  repo: string;
  prNumber: number;
  branch: string;
  headSha: string;
}): ProvenanceLookup {
  return {
    status: "unknown",
    forge: input.forge,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    branch: input.branch,
    headSha: input.headSha,
    contributors: [],
    publisher: null,
  };
}

export interface ProvenanceStore {
  migrate(): Promise<void>;
  ensureIntent(input: EnsureIntentInput): Promise<IntentRecord>;
  setIntentTarget(jobId: number, target: { prNumber?: number; branch?: string }): Promise<void>;
  noteIntentRunners(jobId: number, contributors: RunnerStamp[], publisher?: RunnerStamp | null): Promise<void>;
  markIntentFailed(jobId: number, error: string, headSha?: string): Promise<void>;
  confirmPublication(input: ConfirmPublicationInput): Promise<ProvenanceRecord>;
  getIntent(jobId: number): Promise<IntentRecord | undefined>;
  getByHead(forge: string, owner: string, repo: string, headSha: string): Promise<ProvenanceRecord | undefined>;
  listByPr(forge: string, owner: string, repo: string, prNumber: number): Promise<ProvenanceRecord[]>;
  lookupByHead(forge: string, owner: string, repo: string, headSha: string): Promise<ProvenanceLookup>;
  lookupForReview(input: {
    forge: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    branch?: string;
  }): Promise<ProvenanceLookup>;
}

function parseRunnerArray(value: unknown): RunnerStamp[] {
  if (!Array.isArray(value)) return [];
  const out: RunnerStamp[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as { type?: unknown; model?: unknown; variant?: unknown; effort?: unknown };
    if (typeof rec.type !== "string" || typeof rec.model !== "string") continue;
    const normalized = normalizeRunnerStamp({
      type: rec.type,
      model: rec.model,
      ...(typeof rec.variant === "string" ? { variant: rec.variant } : {}),
      ...(typeof rec.effort === "string" ? { effort: rec.effort } : {}),
    });
    if (normalized) out.push(normalized);
  }
  return mergeContributors([], out);
}

function parseRunnerObject(value: unknown): RunnerStamp | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as { type?: unknown; model?: unknown; variant?: unknown; effort?: unknown };
  if (typeof rec.type !== "string" || typeof rec.model !== "string") return null;
  return (
    normalizeRunnerStamp({
      type: rec.type,
      model: rec.model,
      ...(typeof rec.variant === "string" ? { variant: rec.variant } : {}),
      ...(typeof rec.effort === "string" ? { effort: rec.effort } : {}),
    }) ?? null
  );
}

function intentMatchesReview(
  intent: IntentRecord,
  owner: string,
  repo: string,
  prNumber: number,
  branch: string
): boolean {
  if (intent.owner !== owner || intent.repo !== repo) return false;
  if (intent.status !== "pending") return false;
  if (intent.prNumber !== 0 && intent.prNumber === prNumber) return true;
  if (intent.branch && branch && intent.branch === branch) return true;
  return false;
}

export class MemoryProvenanceStore implements ProvenanceStore {
  private nextProvenanceId = 1;
  private nextIntentId = 1;
  private readonly provenance = new Map<string, ProvenanceRecord>();
  private readonly intents = new Map<number, IntentRecord>();

  async migrate(): Promise<void> {}

  private headKey(forge: string, owner: string, repo: string, headSha: string): string {
    return `${forge}|${owner}|${repo}|${normalizeHead(headSha)}`;
  }

  async ensureIntent(input: EnsureIntentInput): Promise<IntentRecord> {
    const existing = this.intents.get(input.jobId);
    if (existing) return { ...existing, contributors: [...existing.contributors] };
    const now = Date.now();
    const record: IntentRecord = {
      id: this.nextIntentId++,
      forge: normalizeForge(input.forge),
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber ?? 0,
      branch: input.branch ?? "",
      jobId: input.jobId,
      jobKey: input.jobKey,
      jobKind: input.jobKind,
      delivery: input.delivery,
      status: "pending",
      contributors: [],
      publisher: null,
      headSha: "",
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.intents.set(input.jobId, record);
    return { ...record, contributors: [] };
  }

  async setIntentTarget(jobId: number, target: { prNumber?: number; branch?: string }): Promise<void> {
    const intent = this.intents.get(jobId);
    if (!intent) return;
    if (target.prNumber != null) intent.prNumber = target.prNumber;
    if (target.branch != null) intent.branch = target.branch;
    intent.updatedAt = Date.now();
  }

  async noteIntentRunners(jobId: number, contributors: RunnerStamp[], publisher?: RunnerStamp | null): Promise<void> {
    const intent = this.intents.get(jobId);
    if (!intent) return;
    intent.contributors = mergeContributors(intent.contributors, contributors);
    if (publisher) intent.publisher = normalizeRunnerStamp(publisher) ?? intent.publisher;
    intent.updatedAt = Date.now();
  }

  async markIntentFailed(jobId: number, error: string, headSha?: string): Promise<void> {
    const intent = this.intents.get(jobId);
    if (!intent) return;
    if (intent.status === "confirmed") return;
    intent.status = "failed";
    intent.error = error.slice(0, 2000);
    if (headSha) intent.headSha = normalizeHead(headSha);
    intent.updatedAt = Date.now();
  }

  async confirmPublication(input: ConfirmPublicationInput): Promise<ProvenanceRecord> {
    const forge = normalizeForge(input.forge);
    const head = normalizeHead(input.headSha);
    if (!head) throw new Error("confirmPublication requires headSha");
    const now = Date.now();
    let previous: RunnerStamp[] = [];
    for (const row of this.provenance.values()) {
      if (
        row.forge === forge &&
        row.owner === input.owner &&
        row.repo === input.repo &&
        row.prNumber === input.prNumber
      ) {
        previous = mergeContributors(previous, row.contributors);
      }
    }
    const merged = mergeContributors(previous, input.contributors);
    const publisher = input.publisher ?? null;
    const key = this.headKey(forge, input.owner, input.repo, head);
    const existing = this.provenance.get(key);
    if (existing) {
      existing.contributors = mergeContributors(existing.contributors, merged);
      if (!existing.publisher && publisher) existing.publisher = publisher;
      existing.updatedAt = now;
      const intent = this.intents.get(input.jobId);
      if (intent && intent.status === "pending") {
        intent.status = "confirmed";
        intent.headSha = head;
        intent.prNumber = input.prNumber;
        intent.branch = input.branch;
        intent.contributors = mergeContributors(intent.contributors, merged);
        if (publisher && !intent.publisher) intent.publisher = publisher;
        intent.updatedAt = now;
      }
      return { ...existing, contributors: [...existing.contributors] };
    }
    const record: ProvenanceRecord = {
      id: this.nextProvenanceId++,
      forge,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      branch: input.branch,
      headSha: head,
      status: "known",
      contributors: merged,
      publisher,
      jobId: input.jobId,
      jobKey: input.jobKey,
      delivery: input.delivery,
      jobKind: input.jobKind,
      createdAt: now,
      updatedAt: now,
    };
    this.provenance.set(key, record);
    const intent = this.intents.get(input.jobId);
    if (intent && intent.status === "pending") {
      intent.status = "confirmed";
      intent.headSha = head;
      intent.prNumber = input.prNumber;
      intent.branch = input.branch;
      intent.contributors = mergeContributors(intent.contributors, merged);
      if (publisher && !intent.publisher) intent.publisher = publisher;
      intent.updatedAt = now;
    }
    return { ...record, contributors: [...record.contributors] };
  }

  async getIntent(jobId: number): Promise<IntentRecord | undefined> {
    const intent = this.intents.get(jobId);
    return intent ? { ...intent, contributors: [...intent.contributors] } : undefined;
  }

  async getByHead(forge: string, owner: string, repo: string, headSha: string): Promise<ProvenanceRecord | undefined> {
    const row = this.provenance.get(this.headKey(normalizeForge(forge), owner, repo, normalizeHead(headSha)));
    return row ? { ...row, contributors: [...row.contributors] } : undefined;
  }

  async listByPr(forge: string, owner: string, repo: string, prNumber: number): Promise<ProvenanceRecord[]> {
    const norm = normalizeForge(forge);
    return [...this.provenance.values()]
      .filter((row) => row.forge === norm && row.owner === owner && row.repo === repo && row.prNumber === prNumber)
      .sort((a, b) => a.id - b.id)
      .map((row) => ({ ...row, contributors: [...row.contributors] }));
  }

  async lookupByHead(forge: string, owner: string, repo: string, headSha: string): Promise<ProvenanceLookup> {
    const norm = normalizeForge(forge);
    const head = normalizeHead(headSha);
    const row = await this.getByHead(norm, owner, repo, head);
    if (row) {
      return {
        status: "known",
        forge: row.forge,
        owner: row.owner,
        repo: row.repo,
        prNumber: row.prNumber,
        branch: row.branch,
        headSha: row.headSha,
        contributors: [...row.contributors],
        publisher: row.publisher,
        jobId: row.jobId,
        jobKey: row.jobKey,
      };
    }
    return unknownLookup({ forge: norm, owner, repo, prNumber: 0, branch: "", headSha: head });
  }

  async lookupForReview(input: {
    forge: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    branch?: string;
  }): Promise<ProvenanceLookup> {
    const norm = normalizeForge(input.forge);
    const head = normalizeHead(input.headSha);
    const branch = input.branch ?? "";
    const known = await this.getByHead(norm, input.owner, input.repo, head);
    if (known) {
      return {
        status: "known",
        forge: known.forge,
        owner: known.owner,
        repo: known.repo,
        prNumber: known.prNumber,
        branch: known.branch,
        headSha: known.headSha,
        contributors: [...known.contributors],
        publisher: known.publisher,
        jobId: known.jobId,
        jobKey: known.jobKey,
      };
    }
    let failed: IntentRecord | undefined;
    for (const intent of this.intents.values()) {
      if (intent.owner !== input.owner || intent.repo !== input.repo) continue;
      const samePr = intent.prNumber !== 0 && intent.prNumber === input.prNumber;
      const sameBranch = Boolean(intent.branch && branch && intent.branch === branch);
      if (!samePr && !sameBranch) continue;
      if (intent.status === "pending" && intentMatchesReview(intent, input.owner, input.repo, input.prNumber, branch)) {
        return {
          status: "pending",
          forge: intent.forge,
          owner: intent.owner,
          repo: intent.repo,
          prNumber: intent.prNumber || input.prNumber,
          branch: intent.branch || branch,
          headSha: head,
          contributors: [...intent.contributors],
          publisher: intent.publisher,
          jobId: intent.jobId,
          jobKey: intent.jobKey,
        };
      }
      if (intent.status === "failed" && !failed) failed = intent;
    }
    if (failed) {
      return {
        status: "failed",
        forge: failed.forge,
        owner: failed.owner,
        repo: failed.repo,
        prNumber: failed.prNumber || input.prNumber,
        branch: failed.branch || branch,
        headSha: head,
        contributors: [...failed.contributors],
        publisher: failed.publisher,
        jobId: failed.jobId,
        jobKey: failed.jobKey,
      };
    }
    return unknownLookup({
      forge: norm,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      branch,
      headSha: head,
    });
  }
}

type ProvenanceRow = {
  id: unknown;
  forge: unknown;
  owner: unknown;
  repo: unknown;
  pr_number: unknown;
  branch: unknown;
  head_sha: unknown;
  status: unknown;
  contributors: unknown;
  publisher: unknown;
  job_id: unknown;
  job_key: unknown;
  delivery: unknown;
  job_kind: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type IntentRow = {
  id: unknown;
  forge: unknown;
  owner: unknown;
  repo: unknown;
  issue_number: unknown;
  pr_number: unknown;
  branch: unknown;
  job_id: unknown;
  job_key: unknown;
  job_kind: unknown;
  delivery: unknown;
  status: unknown;
  contributors: unknown;
  publisher: unknown;
  head_sha: unknown;
  error: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  throw new Error(`expected number, got ${typeof value}`);
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function epoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function parseContributorsJson(value: unknown): RunnerStamp[] {
  if (typeof value === "string") {
    try {
      return parseRunnerArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return parseRunnerArray(value);
}

function parsePublisherJson(value: unknown): RunnerStamp | null {
  if (typeof value === "string") {
    try {
      return parseRunnerObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return parseRunnerObject(value);
}

function mapProvenanceRow(row: ProvenanceRow): ProvenanceRecord {
  return {
    id: num(row.id),
    forge: str(row.forge) || "gitea",
    owner: str(row.owner),
    repo: str(row.repo),
    prNumber: num(row.pr_number),
    branch: str(row.branch),
    headSha: str(row.head_sha),
    status: "known",
    contributors: parseContributorsJson(row.contributors),
    publisher: parsePublisherJson(row.publisher),
    jobId: num(row.job_id),
    jobKey: str(row.job_key),
    delivery: str(row.delivery),
    jobKind: str(row.job_kind),
    createdAt: epoch(row.created_at),
    updatedAt: epoch(row.updated_at),
  };
}

function mapIntentRow(row: IntentRow): IntentRecord {
  const status = str(row.status);
  return {
    id: num(row.id),
    forge: str(row.forge) || "gitea",
    owner: str(row.owner),
    repo: str(row.repo),
    issueNumber: num(row.issue_number),
    prNumber: num(row.pr_number),
    branch: str(row.branch),
    jobId: num(row.job_id),
    jobKey: str(row.job_key),
    jobKind: str(row.job_kind),
    delivery: str(row.delivery),
    status: status === "confirmed" || status === "failed" ? status : "pending",
    contributors: parseContributorsJson(row.contributors),
    publisher: parsePublisherJson(row.publisher),
    headSha: str(row.head_sha),
    error: row.error == null ? null : str(row.error),
    createdAt: epoch(row.created_at),
    updatedAt: epoch(row.updated_at),
  };
}

export class PgProvenanceStore implements ProvenanceStore {
  constructor(private readonly sql: SqlClient) {}

  async migrate(): Promise<void> {
    await this.sql.unsafe(PROVENANCE_SCHEMA_SQL);
  }

  async ensureIntent(input: EnsureIntentInput): Promise<IntentRecord> {
    const rows = asRows<IntentRow>(
      await this.sql.unsafe(
        `INSERT INTO pr_publication_intents (
           forge, owner, repo, issue_number, pr_number, branch, job_id, job_key, job_kind, delivery, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
         ON CONFLICT (job_id) DO NOTHING
         RETURNING *`,
        [
          normalizeForge(input.forge),
          input.owner,
          input.repo,
          input.issueNumber,
          input.prNumber ?? 0,
          input.branch ?? "",
          input.jobId,
          input.jobKey,
          input.jobKind,
          input.delivery,
        ]
      )
    );
    if (rows[0]) return mapIntentRow(rows[0]);
    const existing = await this.getIntent(input.jobId);
    if (!existing) throw new Error(`failed to ensure publication intent for job ${input.jobId}`);
    return existing;
  }

  async setIntentTarget(jobId: number, target: { prNumber?: number; branch?: string }): Promise<void> {
    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [jobId];
    if (target.prNumber != null) {
      params.push(target.prNumber);
      sets.push(`pr_number = $${params.length}`);
    }
    if (target.branch != null) {
      params.push(target.branch);
      sets.push(`branch = $${params.length}`);
    }
    if (sets.length <= 1) return;
    await this.sql.unsafe(`UPDATE pr_publication_intents SET ${sets.join(", ")} WHERE job_id = $1`, params);
  }

  async noteIntentRunners(jobId: number, contributors: RunnerStamp[], publisher?: RunnerStamp | null): Promise<void> {
    const current = await this.getIntent(jobId);
    if (!current) return;
    const merged = mergeContributors(current.contributors, contributors);
    const nextPublisher = publisher ? (normalizeRunnerStamp(publisher) ?? current.publisher) : current.publisher;
    await this.sql.unsafe(
      `UPDATE pr_publication_intents
       SET contributors = $2::jsonb, publisher = $3::jsonb, updated_at = NOW()
       WHERE job_id = $1`,
      [jobId, JSON.stringify(merged), nextPublisher ? JSON.stringify(nextPublisher) : null]
    );
  }

  async markIntentFailed(jobId: number, error: string, headSha?: string): Promise<void> {
    if (headSha) {
      await this.sql.unsafe(
        `UPDATE pr_publication_intents
         SET status = 'failed', error = $2, head_sha = $3, updated_at = NOW()
         WHERE job_id = $1 AND status = 'pending'`,
        [jobId, error.slice(0, 2000), normalizeHead(headSha)]
      );
    } else {
      await this.sql.unsafe(
        `UPDATE pr_publication_intents
         SET status = 'failed', error = $2, updated_at = NOW()
         WHERE job_id = $1 AND status = 'pending'`,
        [jobId, error.slice(0, 2000)]
      );
    }
  }

  async confirmPublication(input: ConfirmPublicationInput): Promise<ProvenanceRecord> {
    const forge = normalizeForge(input.forge);
    const head = normalizeHead(input.headSha);
    if (!head) throw new Error("confirmPublication requires headSha");
    return this.sql.begin(async (tx) => {
      const prior = asRows<{ contributors: unknown }>(
        await tx.unsafe(
          `SELECT contributors FROM pr_writer_provenance
           WHERE forge = $1 AND owner = $2 AND repo = $3 AND pr_number = $4`,
          [forge, input.owner, input.repo, input.prNumber]
        )
      );
      let previous: RunnerStamp[] = [];
      for (const row of prior) previous = mergeContributors(previous, parseContributorsJson(row.contributors));
      const merged = mergeContributors(previous, input.contributors);
      const publisher = input.publisher ?? null;
      const existing = asRows<ProvenanceRow>(
        await tx.unsafe(
          `SELECT * FROM pr_writer_provenance WHERE forge = $1 AND owner = $2 AND repo = $3 AND head_sha = $4`,
          [forge, input.owner, input.repo, head]
        )
      );
      if (existing[0]) {
        const current = mapProvenanceRow(existing[0]);
        const nextContributors = mergeContributors(current.contributors, merged);
        const nextPublisher = current.publisher ?? publisher;
        await tx.unsafe(
          `UPDATE pr_writer_provenance
           SET contributors = $5::jsonb, publisher = $6::jsonb, updated_at = NOW()
           WHERE forge = $1 AND owner = $2 AND repo = $3 AND head_sha = $4`,
          [
            forge,
            input.owner,
            input.repo,
            head,
            JSON.stringify(nextContributors),
            nextPublisher ? JSON.stringify(nextPublisher) : null,
          ]
        );
        const refreshed = asRows<ProvenanceRow>(
          await tx.unsafe(
            `SELECT * FROM pr_writer_provenance WHERE forge = $1 AND owner = $2 AND repo = $3 AND head_sha = $4`,
            [forge, input.owner, input.repo, head]
          )
        );
        const row = refreshed[0] ? mapProvenanceRow(refreshed[0]) : current;
        await tx.unsafe(
          `UPDATE pr_publication_intents
           SET status = 'confirmed', head_sha = $2, pr_number = $3, branch = $4,
               contributors = $5::jsonb, publisher = $6::jsonb, updated_at = NOW()
           WHERE job_id = $1 AND status = 'pending'`,
          [
            input.jobId,
            head,
            input.prNumber,
            input.branch,
            JSON.stringify(mergeContributors(row.contributors, merged)),
            (row.publisher ?? publisher) ? JSON.stringify(row.publisher ?? publisher) : null,
          ]
        );
        return row;
      }
      const inserted = asRows<ProvenanceRow>(
        await tx.unsafe(
          `INSERT INTO pr_writer_provenance (
             forge, owner, repo, pr_number, branch, head_sha, status,
             contributors, publisher, job_id, job_key, delivery, job_kind
           ) VALUES ($1, $2, $3, $4, $5, $6, 'known', $7::jsonb, $8::jsonb, $9, $10, $11, $12)
           ON CONFLICT (forge, owner, repo, head_sha) DO NOTHING
           RETURNING *`,
          [
            forge,
            input.owner,
            input.repo,
            input.prNumber,
            input.branch,
            head,
            JSON.stringify(merged),
            publisher ? JSON.stringify(publisher) : null,
            input.jobId,
            input.jobKey,
            input.delivery,
            input.jobKind,
          ]
        )
      );
      let row = inserted[0] ? mapProvenanceRow(inserted[0]) : undefined;
      if (!row) {
        const raced = asRows<ProvenanceRow>(
          await tx.unsafe(
            `SELECT * FROM pr_writer_provenance WHERE forge = $1 AND owner = $2 AND repo = $3 AND head_sha = $4`,
            [forge, input.owner, input.repo, head]
          )
        );
        if (!raced[0]) throw new Error("failed to confirm publication");
        const current = mapProvenanceRow(raced[0]);
        const nextContributors = mergeContributors(current.contributors, merged);
        const nextPublisher = current.publisher ?? publisher;
        await tx.unsafe(
          `UPDATE pr_writer_provenance
           SET contributors = $5::jsonb, publisher = $6::jsonb, updated_at = NOW()
           WHERE forge = $1 AND owner = $2 AND repo = $3 AND head_sha = $4`,
          [
            forge,
            input.owner,
            input.repo,
            head,
            JSON.stringify(nextContributors),
            nextPublisher ? JSON.stringify(nextPublisher) : null,
          ]
        );
        const refreshed = asRows<ProvenanceRow>(
          await tx.unsafe(
            `SELECT * FROM pr_writer_provenance WHERE forge = $1 AND owner = $2 AND repo = $3 AND head_sha = $4`,
            [forge, input.owner, input.repo, head]
          )
        );
        row = refreshed[0] ? mapProvenanceRow(refreshed[0]) : current;
      }
      await tx.unsafe(
        `UPDATE pr_publication_intents
         SET status = 'confirmed', head_sha = $2, pr_number = $3, branch = $4,
             contributors = $5::jsonb, publisher = $6::jsonb, updated_at = NOW()
         WHERE job_id = $1 AND status = 'pending'`,
        [
          input.jobId,
          head,
          input.prNumber,
          input.branch,
          JSON.stringify(merged),
          publisher ? JSON.stringify(publisher) : null,
        ]
      );
      return row;
    });
  }

  async getIntent(jobId: number): Promise<IntentRecord | undefined> {
    const rows = asRows<IntentRow>(
      await this.sql.unsafe(`SELECT * FROM pr_publication_intents WHERE job_id = $1`, [jobId])
    );
    return rows[0] ? mapIntentRow(rows[0]) : undefined;
  }

  async getByHead(forge: string, owner: string, repo: string, headSha: string): Promise<ProvenanceRecord | undefined> {
    const rows = asRows<ProvenanceRow>(
      await this.sql.unsafe(
        `SELECT * FROM pr_writer_provenance WHERE forge = $1 AND owner = $2 AND repo = $3 AND head_sha = $4`,
        [normalizeForge(forge), owner, repo, normalizeHead(headSha)]
      )
    );
    return rows[0] ? mapProvenanceRow(rows[0]) : undefined;
  }

  async listByPr(forge: string, owner: string, repo: string, prNumber: number): Promise<ProvenanceRecord[]> {
    const rows = asRows<ProvenanceRow>(
      await this.sql.unsafe(
        `SELECT * FROM pr_writer_provenance
         WHERE forge = $1 AND owner = $2 AND repo = $3 AND pr_number = $4 ORDER BY id ASC`,
        [normalizeForge(forge), owner, repo, prNumber]
      )
    );
    return rows.map(mapProvenanceRow);
  }

  async lookupByHead(forge: string, owner: string, repo: string, headSha: string): Promise<ProvenanceLookup> {
    const norm = normalizeForge(forge);
    const head = normalizeHead(headSha);
    const row = await this.getByHead(norm, owner, repo, head);
    if (row) {
      return {
        status: "known",
        forge: row.forge,
        owner: row.owner,
        repo: row.repo,
        prNumber: row.prNumber,
        branch: row.branch,
        headSha: row.headSha,
        contributors: row.contributors,
        publisher: row.publisher,
        jobId: row.jobId,
        jobKey: row.jobKey,
      };
    }
    return unknownLookup({ forge: norm, owner, repo, prNumber: 0, branch: "", headSha: head });
  }

  async lookupForReview(input: {
    forge: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    branch?: string;
  }): Promise<ProvenanceLookup> {
    const norm = normalizeForge(input.forge);
    const head = normalizeHead(input.headSha);
    const branch = input.branch ?? "";
    const known = await this.getByHead(norm, input.owner, input.repo, head);
    if (known) {
      return {
        status: "known",
        forge: known.forge,
        owner: known.owner,
        repo: known.repo,
        prNumber: known.prNumber,
        branch: known.branch,
        headSha: known.headSha,
        contributors: known.contributors,
        publisher: known.publisher,
        jobId: known.jobId,
        jobKey: known.jobKey,
      };
    }
    const intents = asRows<IntentRow>(
      await this.sql.unsafe(
        `SELECT * FROM pr_publication_intents WHERE owner = $1 AND repo = $2 AND status = 'pending' ORDER BY id ASC`,
        [input.owner, input.repo]
      )
    );
    for (const raw of intents) {
      const intent = mapIntentRow(raw);
      if (intentMatchesReview(intent, input.owner, input.repo, input.prNumber, branch)) {
        return {
          status: "pending",
          forge: intent.forge,
          owner: intent.owner,
          repo: intent.repo,
          prNumber: intent.prNumber || input.prNumber,
          branch: intent.branch || branch,
          headSha: head,
          contributors: intent.contributors,
          publisher: intent.publisher,
          jobId: intent.jobId,
          jobKey: intent.jobKey,
        };
      }
    }
    const failedRows = asRows<IntentRow>(
      await this.sql.unsafe(
        `SELECT * FROM pr_publication_intents WHERE owner = $1 AND repo = $2 AND status = 'failed' ORDER BY id DESC LIMIT 20`,
        [input.owner, input.repo]
      )
    );
    for (const raw of failedRows) {
      const intent = mapIntentRow(raw);
      const samePr = intent.prNumber !== 0 && intent.prNumber === input.prNumber;
      const sameBranch = Boolean(intent.branch && branch && intent.branch === branch);
      if (samePr || sameBranch) {
        return {
          status: "failed",
          forge: intent.forge,
          owner: intent.owner,
          repo: intent.repo,
          prNumber: intent.prNumber || input.prNumber,
          branch: intent.branch || branch,
          headSha: head,
          contributors: intent.contributors,
          publisher: intent.publisher,
          jobId: intent.jobId,
          jobKey: intent.jobKey,
        };
      }
    }
    return unknownLookup({
      forge: norm,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      branch,
      headSha: head,
    });
  }
}
