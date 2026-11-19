interface AssigneeLike {
  login?: string;
  username?: string;
}

export type LabelLike = string | { name?: string };

export interface IssueAssignees {
  assignee?: AssigneeLike | null;
  assignees?: AssigneeLike[] | null;
  labels?: LabelLike[] | null;
}

export interface PickupPolicy {
  botUsername: string;
  isPickedUp?: (issue: IssueAssignees) => boolean;
}

function loginOf(user: AssigneeLike | null | undefined): string | undefined {
  const value = user?.login ?? user?.username;
  return value?.toLowerCase();
}

export function isAssignedToBot(issue: IssueAssignees, botUsername: string): boolean {
  const bot = botUsername.toLowerCase();
  if (loginOf(issue.assignee) === bot) return true;
  return (issue.assignees ?? []).some((assignee) => loginOf(assignee) === bot);
}

function labelName(label: LabelLike): string {
  return typeof label === "string" ? label : (label.name ?? "");
}

export function hasLabel(issue: { labels?: LabelLike[] | null }, name: string): boolean {
  const needle = name.toLowerCase();
  return (issue.labels ?? []).some((label) => labelName(label).toLowerCase() === needle);
}

export function isIssuePickedUp(issue: IssueAssignees, policy: PickupPolicy): boolean {
  if (policy.isPickedUp) return policy.isPickedUp(issue);
  return isAssignedToBot(issue, policy.botUsername);
}

export function isPullRequestIssue(issue: { pull_request?: unknown; is_pull?: boolean }): boolean {
  return issue.pull_request != null || issue.is_pull === true;
}
