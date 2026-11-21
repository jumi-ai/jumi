/** Bounded reads for forge attachment downloads. Both forge adapters share this. */

/** Cap for attachment error bodies: a few KiB, enough for a backend message. */
export const ATTACHMENT_ERROR_BODY_MAX_BYTES = 4 * 1024;

const BUDGET_BRAND = Symbol.for("jumi.attachmentByteBudget");

export class AttachmentByteBudgetError extends Error {
  readonly budget: number;
  constructor(budget: number) {
    super(`attachment exceeds byte budget (over ${budget} bytes)`);
    this.name = "AttachmentByteBudgetError";
    this.budget = budget;
    Object.defineProperty(this, BUDGET_BRAND, { value: true });
  }
}

export function isAttachmentByteBudgetError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (BUDGET_BRAND in err || err instanceof AttachmentByteBudgetError);
}

function contentLengthOf(res: Response): number | undefined {
  const raw = res.headers.get("content-length");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best effort: the body may already be locked or closed.
  }
}

/**
 * Read a successful attachment body without buffering past `maxBytes`.
 * When `maxBytes` is undefined the whole body is buffered (legacy callers).
 * When the body exceeds `maxBytes` the stream is cancelled and an
 * `AttachmentByteBudgetError` is thrown. A `Content-Length` above the budget
 * is rejected before any byte is read.
 */
export async function readBoundedAttachmentBytes(res: Response, maxBytes?: number): Promise<Uint8Array> {
  if (maxBytes === undefined) return new Uint8Array(await res.arrayBuffer());
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new AttachmentByteBudgetError(0);
  }
  const declared = contentLengthOf(res);
  if (declared !== undefined && declared > maxBytes) {
    await cancelBody(res);
    throw new AttachmentByteBudgetError(maxBytes);
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new AttachmentByteBudgetError(maxBytes);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const encoder = new TextEncoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes: Uint8Array | undefined =
        typeof value === "string" ? encoder.encode(value) : (value as Uint8Array | undefined);
      if (!bytes || bytes.byteLength === 0) continue;
      total += bytes.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel failures; the budget error is what matters.
        }
        throw new AttachmentByteBudgetError(maxBytes);
      }
      chunks.push(bytes);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released after cancel.
    }
  }
  if (total === 0) return new Uint8Array(0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read an error body up to `maxBytes`, then cancel the rest. The result is
 * truncated, never the whole over-budget body.
 */
export async function readBoundedErrorText(
  res: Response,
  maxBytes: number = ATTACHMENT_ERROR_BODY_MAX_BYTES
): Promise<string> {
  if (!res.body) {
    try {
      const text = await res.text();
      return text.length * 3 > maxBytes
        ? new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, maxBytes))
        : text;
    } catch {
      return "";
    }
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const encoder = new TextEncoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes: Uint8Array | undefined =
        typeof value === "string" ? encoder.encode(value) : (value as Uint8Array | undefined);
      if (!bytes || bytes.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      if (bytes.byteLength > remaining) {
        chunks.push(bytes.subarray(0, remaining));
        total += remaining;
        break;
      }
      chunks.push(bytes);
      total += bytes.byteLength;
      if (total >= maxBytes) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best effort: truncation must not fail the error path.
    }
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
  if (total === 0) return "";
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}
