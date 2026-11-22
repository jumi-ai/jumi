import type { Forge } from "./forge.ts";
import type { IssueApi } from "./gitea_issues.ts";
import type { ReviewApi } from "./review.ts";
import type { HandleWorkerWebhookDeps } from "./worker_webhook.ts";

export function workerMailboxApi(
  api: ReviewApi &
    Partial<
      Pick<
        IssueApi,
        | "listOpenPulls"
        | "listIssueBlocks"
        | "listRepoIssues"
        | "listPullCommits"
        | "deleteGitRef"
        | "getRepoFile"
        | "addIssueAssignees"
        | "addIssueLabel"
      >
    > &
    Partial<
      Pick<
        Forge,
        | "deleteGitRef"
        | "getBranch"
        | "scheduleAutoMerge"
        | "cancelAutoMerge"
        | "listIssueTimeline"
        | "getPRFiles"
        | "compareCommits"
      >
    > & {
      rememberInstallation?: (installationId: string, owner?: string, repo?: string) => void;
    }
): HandleWorkerWebhookDeps["api"] {
  return {
    getIssue: (owner, repo, index) => api.getIssue(owner, repo, index),
    getRepo: (owner, repo) => api.getRepo(owner, repo),
    getPR: (owner, repo, index) => api.getPR(owner, repo, index),
    getCollaboratorPermission: (owner, repo, username) => api.getCollaboratorPermission(owner, repo, username),
    getAppPermissions: api.getAppPermissions ? (slug) => api.getAppPermissions!(slug) : undefined,
    listOpenPulls: (owner, repo) => (api.listOpenPulls ? api.listOpenPulls(owner, repo) : Promise.resolve([])),
    listIssueBlocks: api.listIssueBlocks ? (owner, repo, index) => api.listIssueBlocks!(owner, repo, index) : undefined,
    listRepoIssues: api.listRepoIssues ? (owner, repo, opts) => api.listRepoIssues!(owner, repo, opts) : undefined,
    listPullCommits: api.listPullCommits ? (owner, repo, index) => api.listPullCommits!(owner, repo, index) : undefined,
    deleteGitRef: api.deleteGitRef ? (owner, repo, ref) => api.deleteGitRef!(owner, repo, ref) : undefined,
    getRepoFile: api.getRepoFile ? (owner, repo, path, ref) => api.getRepoFile!(owner, repo, path, ref) : undefined,
    addIssueAssignees: api.addIssueAssignees
      ? (owner, repo, index, assignees) => api.addIssueAssignees!(owner, repo, index, assignees)
      : undefined,
    addIssueLabel: api.addIssueLabel
      ? (owner, repo, index, label) => api.addIssueLabel!(owner, repo, index, label)
      : undefined,
    getBranch: api.getBranch ? (owner, repo, branch) => api.getBranch!(owner, repo, branch) : undefined,
    scheduleAutoMerge: api.scheduleAutoMerge
      ? (owner, repo, index, opts) => api.scheduleAutoMerge!(owner, repo, index, opts)
      : undefined,
    cancelAutoMerge: api.cancelAutoMerge ? (owner, repo, index) => api.cancelAutoMerge!(owner, repo, index) : undefined,
    getPRFiles: api.getPRFiles ? (owner, repo, index) => api.getPRFiles!(owner, repo, index) : undefined,
    listIssueTimeline: api.listIssueTimeline
      ? (owner, repo, index) => api.listIssueTimeline!(owner, repo, index)
      : undefined,
    compareCommits: (api as { compareCommits?: Forge["compareCommits"] }).compareCommits
      ? (owner, repo, basehead) =>
          (api as { compareCommits?: Forge["compareCommits"] }).compareCommits!(owner, repo, basehead)
      : undefined,
    findStickyIssueComment: (owner, repo, index, bot, marker) =>
      api.findStickyIssueComment(owner, repo, index, bot, marker),
    createIssueComment: (owner, repo, index, body) => api.createIssueComment(owner, repo, index, body),
    updateIssueComment: (owner, repo, id, body) => api.updateIssueComment(owner, repo, id, body),
    listIssueComments: (owner, repo, index) => api.listIssueComments(owner, repo, index),
    listPullReviews: (owner, repo, index) => api.listPullReviews(owner, repo, index),
    listPullReviewComments: (owner, repo, index, reviews) => api.listPullReviewComments(owner, repo, index, reviews),
    createCommitStatus: (owner, repo, sha, status) => api.createCommitStatus(owner, repo, sha, status),
    rememberInstallation: api.rememberInstallation?.bind(api),
  };
}
