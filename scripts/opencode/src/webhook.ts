import type { GiteaPRPayload, ReviewJob } from "./types.ts";

export interface WebhookPolicy {
  giteaUrl: string;
  allowedOrgs: readonly string[];
  allowedRepos: readonly string[];
}

const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronized", "synchronize"]);
const encoder = new TextEncoder();

export function isReviewWebhookAction(action: string | undefined): boolean {
  return typeof action === "string" && REVIEW_ACTIONS.has(action);
}

export function peekWebhookAction(rawBody: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    if (
      parsed &&
      typeof parsed === "object" &&
      "action" in parsed &&
      typeof (parsed as { action: unknown }).action === "string"
    ) {
      return (parsed as { action: string }).action;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeSignature(value: string): string {
  return value
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyGiteaSignature(
  rawBody: Uint8Array,
  secret: string,
  signatureHeader: string | null
): Promise<boolean> {
  // Fail closed and explicitly: an empty or missing secret must never verify,
  // on any runtime. (Bun's subtle crypto throws DataError on a zero-length
  // HMAC key; that accidental failure is not the control.)
  if (!secret || !signatureHeader) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const body = rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.sign("HMAC", key, body);
  return constantTimeEqual(normalizeSignature(signatureHeader), toHex(new Uint8Array(digest)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid webhook payload: missing ${name}`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid webhook payload: missing ${name}`);
  }
  return value;
}

export function parsePullRequestPayload(rawBody: Uint8Array): GiteaPRPayload {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
  if (!isObject(parsed)) throw new Error("Invalid webhook payload: expected object");
  const repository = parsed.repository;
  const pr = parsed.pull_request;
  if (!isObject(repository)) throw new Error("Invalid webhook payload: missing repository");
  if (!isObject(pr)) throw new Error("Invalid webhook payload: missing pull_request");
  requireString(parsed.action, "action");
  requireString(repository.full_name, "repository.full_name");
  requireNumber(pr.number, "pull_request.number");
  return parsed as unknown as GiteaPRPayload;
}

function originMatches(value: string | undefined, giteaUrl: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === new URL(giteaUrl).origin;
  } catch {
    return false;
  }
}

function ownerIsAllowed(owner: string, allowedOrgs: readonly string[]): boolean {
  return allowedOrgs.includes("*") || allowedOrgs.includes(owner);
}

export function assertRepositoryPolicy(
  repository: { full_name: string; html_url?: string; clone_url?: string },
  policy: WebhookPolicy
): { owner: string; repo: string } {
  const [owner, repo] = repository.full_name.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full_name: ${repository.full_name}`);
  if (!ownerIsAllowed(owner, policy.allowedOrgs)) throw new Error(`Repository owner ${owner} is not allowed`);
  if (policy.allowedRepos.length > 0 && !policy.allowedRepos.includes(repository.full_name)) {
    throw new Error(`Repository ${repository.full_name} is not allowed`);
  }
  if (!originMatches(repository.html_url, policy.giteaUrl) && !originMatches(repository.clone_url, policy.giteaUrl)) {
    throw new Error(`Repository ${repository.full_name} does not match configured Gitea origin`);
  }
  return { owner, repo };
}

export function validateWebhookPayload(
  payload: GiteaPRPayload,
  policy: WebhookPolicy,
  opts?: { reviewDrafts?: boolean }
): ReviewJob | { skip: string } {
  if (!REVIEW_ACTIONS.has(payload.action)) {
    return { skip: `unsupported action ${payload.action}` };
  }
  if (!opts?.reviewDrafts) {
    const pr = payload.pull_request as { draft?: boolean; title?: string };
    const title = typeof pr.title === "string" ? pr.title : "";
    const isDraft = pr.draft === true || title.trim().toLowerCase().startsWith("wip:");
    if (isDraft) return { skip: "draft or WIP pull request" };
  }

  const { owner, repo } = assertRepositoryPolicy(payload.repository, policy);
  if (!payload.pull_request.head?.sha) throw new Error("Invalid webhook payload: missing pull_request.head.sha");
  if (!payload.pull_request.updated_at) throw new Error("Invalid webhook payload: missing pull_request.updated_at");

  return {
    delivery: "",
    owner,
    repo,
    prNumber: payload.pull_request.number,
    action: payload.action,
    headSha: payload.pull_request.head.sha,
    receivedAt: new Date().toISOString(),
    prUpdatedAt: payload.pull_request.updated_at,
  };
}
