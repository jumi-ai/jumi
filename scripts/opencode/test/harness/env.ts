/**
 * Save `vars` over `process.env` and return a restore function that puts every
 * named variable back (deleting those that were unset). Works in
 * `beforeEach`/`afterEach` style:
 *
 * ```ts
 * let restore: () => void;
 * beforeEach(() => { restore = withEnv({ FOO: "1", BAR: undefined }); });
 * afterEach(() => { restore(); });
 * ```
 */
export function withEnv(vars: Record<string, string | undefined>): () => void;
/**
 * Scoped form: apply `vars` for `run`, then restore every named variable
 * (including delete-if-unset) even when `run` throws.
 */
export function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T>;
export function withEnv<T>(
  vars: Record<string, string | undefined>,
  run?: () => Promise<T> | T
): Promise<T> | (() => void) {
  const saved = new Map<string, string | undefined>();
  for (const name of Object.keys(vars)) saved.set(name, process.env[name]);
  const restore = () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  if (run === undefined) {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return restore;
  }
  return (async () => {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      return await run();
    } finally {
      restore();
    }
  })();
}
