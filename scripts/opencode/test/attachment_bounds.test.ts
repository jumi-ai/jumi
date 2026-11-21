import { afterEach, describe, expect, test } from "bun:test";
import { GiteaAPI } from "../src/api.ts";
import {
  ATTACHMENT_ERROR_BODY_MAX_BYTES,
  AttachmentByteBudgetError,
  isAttachmentByteBudgetError,
} from "../src/attachment_transfer.ts";
import { GithubAPI } from "../src/github_api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function chunkOf(size: number, fill: number): Uint8Array {
  return new Uint8Array(Array.from({ length: size }, () => fill));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function streamedResponse(
  chunks: Uint8Array[],
  opts?: { contentLength?: number; status?: number }
): { response: Response; state: { cancelled: boolean; emitted: number } } {
  const state = { cancelled: false, emitted: 0 };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        state.emitted += 1;
        controller.enqueue(chunks[index]!);
        index += 1;
      } else {
        controller.close();
      }
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const headers: Record<string, string> = {};
  if (opts?.contentLength !== undefined) headers["content-length"] = String(opts.contentLength);
  return {
    response: new Response(stream, { status: opts?.status ?? 200, headers }),
    state,
  };
}

describe("attachment bounded downloads", () => {
  test("error cap is a few KiB", () => {
    expect(ATTACHMENT_ERROR_BODY_MAX_BYTES).toBeGreaterThanOrEqual(1024);
    expect(ATTACHMENT_ERROR_BODY_MAX_BYTES).toBeLessThanOrEqual(16 * 1024);
  });

  test("Gitea: body within budget returns exact bytes", async () => {
    const chunks = [chunkOf(4, 1), chunkOf(4, 2), chunkOf(3, 3)];
    const expected = concat(chunks);
    const { response } = streamedResponse(chunks);
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const bytes = await new GiteaAPI("https://gitea.example.test", "token-1").downloadAttachmentBytes(
      "https://gitea.example.test/attachments/1",
      100
    );
    expect(bytes).toEqual(expected);
  });

  test("Gitea: body over budget aborts after the cap and cancels the stream", async () => {
    const chunks = [chunkOf(6, 1), chunkOf(6, 2), chunkOf(6, 3), chunkOf(6, 4), chunkOf(6, 5)];
    const { response, state } = streamedResponse(chunks);
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const err = await new GiteaAPI("https://gitea.example.test", "token-1")
      .downloadAttachmentBytes("https://gitea.example.test/attachments/1", 10)
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AttachmentByteBudgetError);
    expect(isAttachmentByteBudgetError(err)).toBe(true);
    expect(state.cancelled).toBe(true);
    expect(state.emitted).toBeLessThan(chunks.length);
  });

  test("Gitea: Content-Length above budget is rejected early", async () => {
    const chunks = [chunkOf(6, 1), chunkOf(6, 2), chunkOf(6, 3), chunkOf(6, 4), chunkOf(6, 5)];
    const { response, state } = streamedResponse(chunks, { contentLength: 10_000 });
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const err = await new GiteaAPI("https://gitea.example.test", "token-1")
      .downloadAttachmentBytes("https://gitea.example.test/attachments/1", 10)
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    expect(isAttachmentByteBudgetError(err)).toBe(true);
    expect(state.cancelled).toBe(true);
    expect(state.emitted).toBeLessThan(chunks.length);
  });

  test("Gitea: oversized error body is truncated", async () => {
    const errorChunk = new TextEncoder().encode("e".repeat(2048));
    const { response, state } = streamedResponse(
      [errorChunk, errorChunk, errorChunk, errorChunk, errorChunk, errorChunk],
      { status: 500 }
    );
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const err = await new GiteaAPI("https://gitea.example.test", "token-1")
      .downloadAttachmentBytes("https://gitea.example.test/attachments/1", 10)
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : "";
    expect(message).toContain("→ 500:");
    expect(message.length).toBeLessThan(errorChunk.byteLength * 6);
    expect(state.cancelled).toBe(true);
  });

  test("GitHub: body within budget returns exact bytes", async () => {
    const chunks = [chunkOf(5, 7), chunkOf(5, 8)];
    const expected = concat(chunks);
    const { response } = streamedResponse(chunks);
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const bytes = await new GithubAPI({ token: "token-1", apiUrl: "https://api.github.com" }).downloadAttachmentBytes(
      "https://api.github.com/attachments/1",
      100
    );
    expect(bytes).toEqual(expected);
  });

  test("GitHub: body over budget aborts after the cap and cancels the stream", async () => {
    const chunks = [chunkOf(6, 9), chunkOf(6, 10), chunkOf(6, 11), chunkOf(6, 12)];
    const { response, state } = streamedResponse(chunks);
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const err = await new GithubAPI({ token: "token-1", apiUrl: "https://api.github.com" })
      .downloadAttachmentBytes("https://api.github.com/attachments/1", 10)
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    expect(err).toBeInstanceOf(Error);
    expect(isAttachmentByteBudgetError(err)).toBe(true);
    expect(state.cancelled).toBe(true);
    expect(state.emitted).toBeLessThan(chunks.length);
  });

  test("GitHub: oversized error body is truncated", async () => {
    const errorChunk = new TextEncoder().encode("f".repeat(2048));
    const { response, state } = streamedResponse(
      [errorChunk, errorChunk, errorChunk, errorChunk, errorChunk, errorChunk],
      { status: 502 }
    );
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const err = await new GithubAPI({ token: "token-1", apiUrl: "https://api.github.com" })
      .downloadAttachmentBytes("https://api.github.com/attachments/1", 10)
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : "";
    expect(message).toContain("→ 502:");
    expect(message.length).toBeLessThan(errorChunk.byteLength * 6);
    expect(state.cancelled).toBe(true);
  });
});
