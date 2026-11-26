import { logDiagnostic } from "./diagnostics.ts";
import { forgeCapabilities } from "./forge_capabilities.ts";
import type { ProvenanceStore } from "./provenance.ts";
import {
  classifyBlockingFindings,
  type NewReviewFindingRow,
  normalizeFindingForge,
  normalizeFindingRunner,
  parseBlockingFindings,
  touchedFromFilenames,
} from "./review_findings.ts";
import { formatRunnerStamp } from "./runners.ts";
import { errorMessage } from "./util/error.ts";

/**
 * Finding-outcome publishing extracted from `review.ts` so that file stays
 * within its size ratchet. Behaviour is unchanged: fixed/dismissed reads
 * the between-reviews touch set, and writer attribution stays fail-open.
 */

export interface BlockingFindingRecordInput {
  recordFindings?: (rows: NewReviewFindingRow[]) => Promise<void>;
  previousFindings?: readonly string[];
  touchedFiles?: readonly { filename: string }[];
  changedFiles?: readonly { filename: string }[];
  forgeKind?: string;
  owner: string;
  repo: string;
  prNumber: number;
  resultRunner?: string | null;
  writerRunner?: string | null;
  reviewRound?: number;
}

export async function recordBlockingFindingOutcomes(
  input: BlockingFindingRecordInput,
  comment: string,
  ctx: { singleFilePath?: string; log: (message: string) => void; reviewLabel: string }
): Promise<void> {
  if (!input.recordFindings || !input.previousFindings || input.previousFindings.length === 0) return;
  try {
    const prevBlocking = parseBlockingFindings(input.previousFindings.join("\n\n"), {
      singleFilePath: ctx.singleFilePath,
    });
    const currBlocking = parseBlockingFindings(comment, { singleFilePath: ctx.singleFilePath });
    const touched = touchedFromFilenames((input.touchedFiles ?? input.changedFiles ?? []).map((file) => file.filename));
    const classified = classifyBlockingFindings(prevBlocking, currBlocking, touched);
    const rows = classified.map((entry) => ({
      forge: normalizeFindingForge(input.forgeKind),
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      severity: entry.prev.severity,
      reviewerRunner: normalizeFindingRunner(input.resultRunner),
      writerRunner: (input.writerRunner ?? "").trim(),
      reviewRound: input.reviewRound ?? 1,
      outcome: entry.outcome,
      fingerprint: entry.fingerprint,
      path: entry.prev.path,
      line: entry.prev.line,
    }));
    await input.recordFindings(rows);
    logDiagnostic(ctx.log, "review_findings", { review: ctx.reviewLabel, findings: rows.length });
  } catch (err) {
    ctx.log(`finding metrics unavailable: ${errorMessage(err)}`);
  }
}

export interface FindingWriterInput {
  writerRunner?: string | null;
  provenance?: ProvenanceStore;
  forgeKind?: string;
  owner: string;
  repo: string;
  prNumber: number;
}

export async function resolveFindingWriterRunner(
  input: FindingWriterInput,
  headSha: string,
  branch: string
): Promise<string | null> {
  let writerRunner = input.writerRunner ?? null;
  if (!writerRunner && input.provenance) {
    try {
      const lookup = await input.provenance.lookupForReview({
        forge: forgeCapabilities(input.forgeKind).kind,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        headSha,
        branch,
      });
      const stamp = lookup.publisher ?? lookup.contributors[lookup.contributors.length - 1];
      if (stamp) writerRunner = formatRunnerStamp(stamp);
    } catch {
      // Fail-open.
    }
  }
  return writerRunner;
}
