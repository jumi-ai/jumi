export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "cancelled");
}

export function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err != null && "code" in err && (err as { code?: string }).code === "ENOENT";
}
