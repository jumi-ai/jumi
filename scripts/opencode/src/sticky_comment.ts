/**
 * Find-by-marker/update-else-create upsert for sticky bot comments.
 * Throws on forge failure; callers that must not fail the job (e.g. the
 * auto-merge note) catch around it.
 */
export interface StickyCommentApi {
  findStickyIssueComment(
    owner: string,
    repo: string,
    index: number,
    botUsername: string,
    marker: string
  ): Promise<{ id: number } | undefined>;
  createIssueComment(owner: string, repo: string, index: number, body: string): Promise<unknown>;
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<unknown>;
}

export async function upsertStickyComment(
  api: StickyCommentApi,
  owner: string,
  repo: string,
  index: number,
  botUsername: string,
  marker: string,
  body: string
): Promise<void> {
  const text = `${marker}\n${body}`;
  const existing = await api.findStickyIssueComment(owner, repo, index, botUsername, marker);
  if (existing) {
    await api.updateIssueComment(owner, repo, existing.id, text);
    return;
  }
  await api.createIssueComment(owner, repo, index, text);
}
