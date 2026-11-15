export type Env = Record<string, string | undefined>;

export function optionalEnv(env: Env, name: string, fallback?: string): string | undefined {
  return env[name] || fallback;
}

export function intEnv(env: Env, name: string, fallback: number): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${value}`);
  }
  return parsed;
}

export function csvEnv(env: Env, name: string, fallback: string[] = []): string[] {
  const value = env[name];
  if (!value) return fallback;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
