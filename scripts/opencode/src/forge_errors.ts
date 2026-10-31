/** Operator-visible response excerpt. The rest of a forge body never leaves the client. */
export const FORGE_ERROR_BODY_MAX_CHARS = 240;

const ELLIPSIS = "…";

/**
 * `GitHub API GET https://… → 500: …` and the attachment variant.
 * The URL may contain spaces (`GITEA_URL` is not normalized). Status checks
 * keep `→ <status>`.
 */
const FORGE_REQUEST_ERROR_RE = /^(?:GitHub API|Gitea API|GitHub attachment|Gitea attachment) \S+ [\s\S]* → \d+:/;

const FORGE_REQUEST_ERROR_BRAND = Symbol.for("jumi.forgeRequestError");

/** Query values shorter than this are not lifted out as global needles (`token=1`). */
const MIN_EXTRACTED_SECRET_CHARS = 8;

const SENSITIVE_QUERY_NAME =
  /^(?:access_token|refresh_token|id_token|token|password|passwd|client_secret|api_key|apikey|api_token|secret|sig|signature|jwt|auth|authorization|x-amz-signature|x-amz-security-token|x-amz-credential)$/i;

export function isForgeRequestErrorMessage(message: string): boolean {
  return FORGE_REQUEST_ERROR_RE.test(message);
}

export function isForgeRequestError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && FORGE_REQUEST_ERROR_BRAND in err) return true;
  const message = err instanceof Error ? err.message : String(err);
  return isForgeRequestErrorMessage(message);
}

function scrubSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  const needles: string[] = [];
  for (const secret of secrets) {
    if (!secret) continue;
    needles.push(secret);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) needles.push(encoded);
  }
  const unique = [...new Set(needles)].sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of unique) out = out.split(needle).join("***");
  return out;
}

function credentialValues(raw: string, base?: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    if (!base) return [];
    try {
      url = new URL(raw, base);
    } catch {
      return [];
    }
  }
  const values: string[] = [];
  if (url.password.length >= MIN_EXTRACTED_SECRET_CHARS) values.push(url.password);
  collectSensitiveParams(url.searchParams, values);
  if (url.hash.length > 1) collectSensitiveParams(new URLSearchParams(url.hash.slice(1)), values);
  return values;
}

function collectSensitiveParams(params: URLSearchParams, values: string[]): void {
  for (const [name, value] of params) {
    if (value.length < MIN_EXTRACTED_SECRET_CHARS) continue;
    if (!SENSITIVE_QUERY_NAME.test(name)) continue;
    values.push(value);
  }
}

function secretsForScrub(explicit: readonly (string | undefined)[], url: string, body: string): (string | undefined)[] {
  const extracted: string[] = [...credentialValues(url)];
  for (const secret of explicit) {
    if (!secret) continue;
    extracted.push(...credentialValues(secret, url));
  }
  for (const found of body.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    extracted.push(...credentialValues(found.replace(/[),.;]+$/, "")));
  }
  return [...explicit, ...extracted];
}

/** Credential shapes the caller did not pass in: other PATs, JWTs, query secrets, userinfo. */
function scrubCredentialShapes(text: string): string {
  return text
    .replace(/(:\/\/[^/@\s]+:)[^/@\s]+@/g, "$1***@")
    .replace(
      /((?:^|[?&#\s])(?:access_token|refresh_token|id_token|x-amz-security-token|x-amz-signature|x-amz-credential|client_secret|api_token|api_key|apikey|password|passwd|signature|secret|token|auth|authorization|jwt|sig)=)[^&#\s"'<>]*/gi,
      "$1***"
    )
    .replace(
      /("(?:access_token|refresh_token|id_token|password|client_secret|api_key|api_token|secret|token|jwt)"\s*:\s*")[^"]*/gi,
      "$1***"
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, "$1 ***")
    .replace(/\btoken\s+[A-Za-z0-9._~+/=-]{20,}/g, "token ***")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "***")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, "***");
}

function scrubForgeText(text: string, secrets: readonly (string | undefined)[]): string {
  return scrubCredentialShapes(scrubSecrets(text, secrets));
}

function normalizeForgeErrorBody(body: string): string {
  return body.replaceAll("\0", "").replace(/\s+/g, " ").trim();
}

function shortenForgeErrorBody(body: string): string {
  const chars = Array.from(body);
  if (chars.length <= FORGE_ERROR_BODY_MAX_CHARS) return body;
  return `${chars
    .slice(0, FORGE_ERROR_BODY_MAX_CHARS)
    .join("")
    .replace(/\p{Mark}+$/u, "")}${ELLIPSIS}`;
}

export function forgeRequestError(input: {
  service: "GitHub API" | "Gitea API" | "GitHub attachment" | "Gitea attachment";
  method: string;
  url: string;
  status: number;
  body: string;
  secrets?: readonly (string | undefined)[];
}): Error {
  const normalized = normalizeForgeErrorBody(input.body);
  const secrets = secretsForScrub(input.secrets ?? [], input.url, normalized);
  const body = shortenForgeErrorBody(scrubForgeText(normalized, secrets));
  const method = scrubForgeText(input.method, secrets);
  const url = scrubForgeText(input.url, secrets);
  const err = new Error(`${input.service} ${method} ${url} → ${input.status}: ${body}`);
  Object.defineProperty(err, FORGE_REQUEST_ERROR_BRAND, { value: true });
  return err;
}
