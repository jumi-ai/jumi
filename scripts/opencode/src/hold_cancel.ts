import { resolveWorkerPullRequest } from "./gitea_issues.ts";
import { settleFollowUpHold } from "./hold_settlement.ts";
import type { Pull } from "./ports.ts";
import type { SkipLatchKey, SkipLatchStore } from "./skip_latches.ts";
import { readSuggestionHold } from "./suggestion_hold.ts";
import { errorMessage } from "./util/error.ts";

export interface SettleHeldCancelOpts {
  // biome-ignore lint/suspicious/noExplicitAny: forge fakes vary per test.
  api: any;
  owner: string;
  repo: string;
  issueNumber: number;
  latches: SkipLatchStore;
  latchKey: SkipLatchKey;
  botUsername: string;
  defaultBranch?: string;
  deploymentTrusted?: readonly string[];
  deploymentIgnore?: readonly string[];
  deploymentBlocking?: readonly string[];
  log?: (message: string) => void;
  reason?: string;
}

/**
 * Cancel-path settlement: resolve the PR for the held head through the
 * existing closing-PR resolution, then reuse the shared gate. Unknown
 * evidence (no PR, unresolvable review, head moved) keeps with one
 * `unknown` log and no write. Never throws. Call before the latch wipe.
 */
export async function settleHeldCancelThroughGate(opts: SettleHeldCancelOpts): Promise<void> {
  const log = opts.log ?? (() => undefined);
  try {
    let hold: { consumed?: boolean; headSha?: string; count?: number } | undefined;
    try {
      hold = await readSuggestionHold(opts.latches, opts.latchKey);
    } catch (err) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.issueNumber}: unknown (hold unreadable: ${errorMessage(err)})`
      );
      return;
    }
    if (!hold?.consumed || !hold.count || !hold.headSha) return;
    let defaultBranch = (opts.defaultBranch ?? "").trim();
    if (!defaultBranch) {
      try {
        if (typeof opts.api?.getRepo === "function") {
          const repoInfo = await opts.api.getRepo(opts.owner, opts.repo);
          defaultBranch = (repoInfo?.default_branch ?? "").trim();
        }
      } catch {
        defaultBranch = "";
      }
    }
    let pr: Pull | undefined;
    try {
      if (typeof opts.api?.listOpenPulls !== "function") {
        log(
          `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.issueNumber}: unknown (listOpenPulls unavailable)`
        );
        return;
      }
      pr = await resolveWorkerPullRequest(opts.api, opts.owner, opts.repo, opts.issueNumber, opts.botUsername);
    } catch (err) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.issueNumber}: unknown (failed to resolve closing PR: ${errorMessage(err)})`
      );
      return;
    }
    if (!pr) {
      log(`hold settlement kept for ${opts.owner}/${opts.repo}#${opts.issueNumber}: unknown (no closing PR)`);
      return;
    }
    const prHead = pr.head?.sha ?? "";
    if (!prHead) {
      log(`hold settlement kept for ${opts.owner}/${opts.repo}#${opts.issueNumber}: unknown (missing head)`);
      return;
    }
    if (hold.headSha.toLowerCase() !== prHead.toLowerCase()) {
      log(
        `hold settlement kept for ${opts.owner}/${opts.repo}#${opts.issueNumber}: unknown (head-mismatch held ${hold.headSha} vs ${prHead})`
      );
      return;
    }
    await settleFollowUpHold({
      api: opts.api,
      owner: opts.owner,
      repo: opts.repo,
      prNumber: pr.number,
      latches: opts.latches,
      latchKey: opts.latchKey,
      intent: { kind: "skipped", reason: opts.reason ?? "unassigned" },
      botUsername: opts.botUsername,
      defaultBranch,
      deploymentTrusted: opts.deploymentTrusted,
      deploymentIgnore: opts.deploymentIgnore,
      deploymentBlocking: opts.deploymentBlocking,
      log,
    });
  } catch (err) {
    log(`hold settlement kept for ${opts.owner}/${opts.repo}#${opts.issueNumber}: unknown (${errorMessage(err)})`);
  }
}
