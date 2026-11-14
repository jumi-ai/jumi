import { accessSync, constants as fsConstants, mkdirSync, statSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { childScratchDir, ensureEngineScratchIgnored } from "./engine_scratch.ts";
import { FORGE_COMMITTER_EMAIL, FORGE_COMMITTER_NAME } from "./forge.ts";
import type { Pull, Repo } from "./ports.ts";
import type { ReviewJob } from "./types.ts";

export { GITHUB_GIT_USERNAME } from "./github_auth.ts";

export interface GitAuth {
  giteaUrl: string;
  username: string;
  token: string;
  embedTokenInUrl?: boolean;
  authorName?: string;
  authorEmail?: string;
}

export type GitAuthResolver = () => Promise<GitAuth>;

export type GitCredentials = {
  username: string;
  token: string;
  embedTokenInUrl?: boolean;
  authorName: string;
  authorEmail: string;
};

export type GitRunner = (
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> }
) => Promise<string>;

export interface CheckoutPullRequestWorkspaceOptions {
  workdir: string;
  repo: Repo;
  pr: Pull;
  giteaUrl: string;
  username: string;
  token: string;
  embedTokenInUrl?: boolean;
  authorName?: string;
  authorEmail?: string;
  gitRunner?: GitRunner;
  logger?: (message: string) => void;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output).trim();
}

function normalizeGiteaUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function validateCloneUrl(value: string, forgeUrl: string): string {
  const clone = new URL(value);
  const forge = new URL(normalizeGiteaUrl(forgeUrl));
  if (clone.protocol !== "https:" && clone.protocol !== "http:")
    throw new Error(`Unsupported clone URL protocol: ${clone.protocol}`);
  if (clone.username || clone.password || clone.search || clone.hash)
    throw new Error("Clone URL must not include credentials, query, or fragment");
  if (clone.origin !== forge.origin) throw new Error("Clone URL origin does not match configured forge URL");
  if (forge.pathname !== "/" && !clone.pathname.startsWith(forge.pathname)) {
    throw new Error("Clone URL path is outside configured forge URL");
  }
  return clone.toString();
}

export function authenticatedCloneUrl(cloneUrl: string, username: string, token: string): string {
  const url = new URL(cloneUrl);
  url.username = username;
  url.password = token;
  return url.toString();
}

export function gitRemoteUrl(cloneUrl: string, auth: GitAuth): string {
  if (!auth.embedTokenInUrl) return cloneUrl;
  return authenticatedCloneUrl(cloneUrl, auth.username, auth.token);
}

const CREDENTIAL_HELPER_RE = /(credential\.helper=)!f\(\) \{[\s\S]*?\}; f/g;

/** Also drops the credential-helper shell function every configured git command carries in its argv. */
export function redactGitSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
    .split(gitCredentialHelper())
    .join("***")
    .replace(CREDENTIAL_HELPER_RE, "$1***")
    .replace(/(:\/\/[^/@\s]+:)[^/@\s]+@/g, "$1***@");
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

export async function resolveGitAuth(opts: {
  giteaUrl: string;
  giteaToken: string;
  botUsername: string;
  gitAuthResolver?: GitAuthResolver;
}): Promise<GitAuth> {
  if (opts.gitAuthResolver) return opts.gitAuthResolver();
  return { giteaUrl: opts.giteaUrl, username: opts.botUsername, token: opts.giteaToken };
}

function hasGitCredentials(value: unknown): value is {
  resolveGitCredentials: (target?: { owner?: string; repo?: string }) => Promise<GitCredentials>;
} {
  return (
    typeof value === "object" &&
    value != null &&
    "resolveGitCredentials" in value &&
    typeof (value as { resolveGitCredentials?: unknown }).resolveGitCredentials === "function"
  );
}

export function gitAuthResolverFor(
  config: { giteaUrl: string; giteaToken: string; botUsername: string },
  api?: unknown,
  repo?: { owner: string; repo: string }
): GitAuthResolver {
  return async () => {
    if (hasGitCredentials(api)) {
      const creds = await api.resolveGitCredentials(repo);
      return { giteaUrl: config.giteaUrl, ...creds };
    }
    return { giteaUrl: config.giteaUrl, username: config.botUsername, token: config.giteaToken };
  };
}

function gitAuthorName(auth: GitAuth): string {
  return auth.authorName ?? FORGE_COMMITTER_NAME;
}

function gitAuthorEmail(auth: GitAuth): string {
  return auth.authorEmail ?? FORGE_COMMITTER_EMAIL;
}

function gitCredentialHelper(): string {
  return [
    "!f() {",
    'if [ "$1" != "get" ]; then exit 0; fi;',
    'protocol="";',
    'host="";',
    "while IFS= read -r line; do",
    '[ -n "$line" ] || break;',
    'case "$line" in',
    `protocol=*) protocol="\${line#protocol=}" ;;`,
    `host=*) host="\${line#host=}" ;;`,
    "esac;",
    "done;",
    'if { [ "$protocol" = "https" ] || [ "$protocol" = "http" ]; } && [ "$host" = "$GIT_AUTH_HOST" ]; then',
    "printf 'username=%s\\n' \"$GIT_AUTH_USERNAME\";",
    "printf 'password=%s\\n' \"$GIT_AUTH_TOKEN\";",
    "fi;",
    "}; f",
  ].join(" ");
}

export function gitConfigArgs(): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${gitCredentialHelper()}`,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.symlinks=false",
    "-c",
    "filter.lfs.required=false",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.process=",
    "-c",
    "protocol.file.allow=never",
  ];
}

export function gitOpenCodeChildEnv(auth: GitAuth, workdir?: string): Record<string, string> {
  const env = gitEnv(auth);
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTH_HOST: env.GIT_AUTH_HOST ?? "",
    GIT_AUTH_USERNAME: env.GIT_AUTH_USERNAME ?? "",
    GIT_AUTH_TOKEN: env.GIT_AUTH_TOKEN ?? "",
    // Non-secret forge origin so the engine spawn can point the child's git at
    // the parent-held credential proxy (`child_git_proxy.ts`). The final child
    // process never sees `GIT_AUTH_TOKEN`; the engine strips it before spawn.
    GIT_AUTH_URL: auth.giteaUrl,
    GIT_AUTHOR_NAME: gitAuthorName(auth),
    GIT_AUTHOR_EMAIL: gitAuthorEmail(auth),
    GIT_COMMITTER_NAME: gitAuthorName(auth),
    GIT_COMMITTER_EMAIL: gitAuthorEmail(auth),
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: gitCredentialHelper(),
    GIT_CONFIG_KEY_2: "core.symlinks",
    GIT_CONFIG_VALUE_2: "false",
    // Agent scratch under the worktree's `.jumi-tmp`: `/tmp` may be a small
    // RAM disk, so downloaded tools, venvs, and caches must never use a
    // hard-coded `/tmp/...` path.
    ...(workdir ? { TMPDIR: childScratchDir(workdir) } : {}),
  };
}

export function workerOpenCodeChildEnv(
  auth: GitAuth,
  workdir: string,
  opts?: WorkerChildEnvOptions | ((message: string) => void)
): Record<string, string> {
  const resolved = normalizeWorkerChildEnvOpts(opts);
  const javaHome = resolved.javaHome ?? process.env.JAVA_HOME ?? "/opt/java/openjdk";
  const workRoot = resolved.workRoot ?? process.env.WORKDIR ?? "/work";
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const scratch = childScratchDir(workdir);
  const home = resolveEffectiveWorkerHome({
    home: resolved.home,
    workRoot,
    logger: resolved.logger,
  });
  const caches = workerToolCacheEnv(workdir, {
    owner: resolved.owner,
    repo: resolved.repo,
    workRoot,
    cacheDir: resolved.cacheDir,
  });
  const javaToolOptions = withJavaOpts(scratch, home, caches.mavenRepo);
  return {
    ...gitOpenCodeChildEnv(auth, workdir),
    HOME: home,
    JAVA_HOME: javaHome,
    PATH: `${join(javaHome, "bin")}:${path}`,
    JAVA_TOOL_OPTIONS: javaToolOptions,
    MAVEN_OPTS: `-Dmaven.repo.local=${caches.mavenRepo}`,
    GRADLE_USER_HOME: caches.gradleHome,
    GRADLE_OPTS: "-Dorg.gradle.daemon=false",
    ANDROID_USER_HOME: caches.androidHome,
    ANDROID_HOME: caches.androidSdk,
    ANDROID_SDK_ROOT: caches.androidSdk,
    KONAN_DATA_DIR: caches.konanDir,
    npm_config_cache: caches.npmCache,
    BUN_INSTALL_CACHE_DIR: caches.bunCache,
    UV_CACHE_DIR: caches.uvCache,
    PIP_CACHE_DIR: caches.pipCache,
    XDG_CACHE_HOME: caches.xdgCache,
  };
}

/** Options for `workerOpenCodeChildEnv` (a bare logger function stays accepted). */
export interface WorkerChildEnvOptions {
  owner?: string;
  repo?: string;
  logger?: (message: string) => void;
  home?: string;
  workRoot?: string;
  cacheDir?: string;
  javaHome?: string;
}

function normalizeWorkerChildEnvOpts(
  opts?: WorkerChildEnvOptions | ((message: string) => void)
): WorkerChildEnvOptions {
  if (!opts) return {};
  if (typeof opts === "function") return { logger: opts };
  return opts;
}

function isWritableDirSync(path: string): boolean {
  try {
    const info = statSync(path);
    if (!info.isDirectory()) return false;
    accessSync(path, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Effective HOME for a worker child. The image passwd entry points at
 * `/data` (read-only under `readOnlyRootFilesystem`), while `$HOME` on a Job
 * pod is a per-pod writable emptyDir. Probe `$HOME`; when it is missing or
 * not writable, fall back to `$WORKDIR/.home` (per job, never shared) and log
 * one line. Only caches are shared via `JUMI_CACHE_DIR`.
 */
export function resolveEffectiveWorkerHome(opts?: {
  home?: string;
  workRoot?: string;
  logger?: (message: string) => void;
}): string {
  const workRoot = opts?.workRoot ?? process.env.WORKDIR ?? "/work";
  const raw = (opts?.home ?? process.env.HOME ?? "").trim();
  if (raw && isWritableDirSync(raw)) return raw;
  const fallback = join(workRoot, ".home");
  try {
    mkdirSync(fallback, { recursive: true });
  } catch {
    // Best effort: the child still gets a writable-looking HOME value.
  }
  opts?.logger?.(`HOME ${raw || "(unset)"} is missing or not writable, using ${fallback} instead`);
  return fallback;
}

export interface WorkerToolCaches {
  gradleHome: string;
  androidHome: string;
  androidSdk: string;
  konanDir: string;
  mavenRepo: string;
  npmCache: string;
  bunCache: string;
  uvCache: string;
  pipCache: string;
  xdgCache: string;
}

function inferOwnerRepo(workdir: string, workRoot: string): { owner?: string; repo?: string } {
  try {
    const rel = relative(workRoot, workdir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return {};
    const parts = rel.split(sep).filter(Boolean);
    if (parts.length < 2) return {};
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return {};
  }
}

/**
 * Per-repository tool caches. When `JUMI_CACHE_DIR` is set the base is
 * `<cache>/<owner>/<repo>/` (a deployer-provided volume shared across jobs);
 * unset it keeps a writable per-pod location (`$WORKDIR/.gradle` for Gradle,
 * the rest under `$WORKDIR/.cache`). Nothing returned here is inside the
 * worktree or `.jumi-tmp`: only the JVM tmpdir lives there.
 */
export function workerToolCacheEnv(
  workdir: string,
  opts?: { owner?: string; repo?: string; workRoot?: string; cacheDir?: string }
): WorkerToolCaches {
  const workRoot = opts?.workRoot ?? process.env.WORKDIR ?? "/work";
  const rawCache = (opts?.cacheDir ?? process.env.JUMI_CACHE_DIR ?? "").trim();
  const inferred = inferOwnerRepo(workdir, workRoot);
  const owner = opts?.owner ?? inferred.owner;
  const repo = opts?.repo ?? inferred.repo;
  // Reject traversal segments whenever the caller names a repository, even
  // when the cache root is unset (per-pod layout ignores the names).
  if (opts?.owner !== undefined) assertSafeSegment(opts.owner, "owner");
  if (opts?.repo !== undefined) assertSafeSegment(opts.repo, "repo");
  if (rawCache) {
    if (owner === undefined || repo === undefined) {
      const base = join(workRoot, ".cache");
      return podToolCaches(workRoot, base);
    }
    const base = join(rawCache, assertSafeSegment(owner, "owner"), assertSafeSegment(repo, "repo"));
    return {
      gradleHome: join(base, "gradle"),
      androidHome: join(base, "android"),
      androidSdk: join(base, "android-sdk"),
      konanDir: join(base, "konan"),
      mavenRepo: join(base, "maven"),
      npmCache: join(base, "npm"),
      bunCache: join(base, "bun"),
      uvCache: join(base, "uv"),
      pipCache: join(base, "pip"),
      xdgCache: join(base, "xdg"),
    };
  }
  return podToolCaches(workRoot, join(workRoot, ".cache"));
}

function podToolCaches(workRoot: string, base: string): WorkerToolCaches {
  return {
    gradleHome: join(workRoot, ".gradle"),
    androidHome: join(base, "android"),
    androidSdk: join(base, "android-sdk"),
    konanDir: join(base, "konan"),
    mavenRepo: join(base, "maven"),
    npmCache: join(base, "npm"),
    bunCache: join(base, "bun"),
    uvCache: join(base, "uv"),
    pipCache: join(base, "pip"),
    xdgCache: join(base, "xdg"),
  };
}

/** `JAVA_TOOL_OPTIONS` for a worker child: tmpdir + user.home + maven repo, no duplicates. */
function withJavaOpts(scratch: string, home: string, mavenRepo: string): string {
  const parts = [`-Djava.io.tmpdir=${scratch}`, `-Duser.home=${home}`, `-Dmaven.repo.local=${mavenRepo}`];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const key = part.split("=")[0] ?? part;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(" ");
}

/**
 * The seed mount is read-only, so `cp` preserves its read-only mode bits.
 * The wrapper must write lock and marker files under `wrapper/dists`, so
 * add owner-write throughout the copied tree.
 */
async function makeCopiedTreeOwnerWritable(root: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  await chmod(root, (info.mode & 0o7777) | 0o200);
  if (!info.isDirectory()) return;
  const entries = await readdir(root);
  for (const entry of entries) {
    await makeCopiedTreeOwnerWritable(join(root, entry));
  }
}

/**
 * Optional read-only Gradle seed (`GRADLE_SEED_HOME`): a read-only directory the
 * deploy mounts, laid out as a Gradle user home that a trusted seeder populated.
 * When set and usable the worker child gets `GRADLE_RO_DEP_CACHE` pointing at the
 * seed's `caches` (Gradle expects `modules-2` under it); before spawn the parent
 * copies `$SEED/wrapper/dists` into `$GRADLE_USER_HOME/wrapper/dists` (copy, never
 * symlink: the wrapper writes lock and marker files there). The child never gets
 * write access to the seed.
 *
 * Fail open: unset means today's behaviour exactly (no env, no copy, no log). A
 * missing, non-directory, unreadable, or empty seed, a seed without
 * `caches/modules-2`, or a copy error, logs one line and the job continues
 * cold (no extra env). The wrapper copy is kept when only the dependency
 * cache is missing; a failed copy never touches the live destination, so one
 * job's copy error never deletes the shared
 * `$GRADLE_USER_HOME/wrapper/dists` another concurrent job of the same
 * repository populated and may be running Gradle from (per-repository
 * `GRADLE_USER_HOME` may be shared by concurrent jobs of one repository and
 * the queue runs jobs concurrently). The seed is first copied to
 * a temp sibling (`wrapper/.dists.seed-*`) and only merged/renamed over
 * `dists` on success. Merging into a pre-existing destination is intentional:
 * stale dists from a rotated seed accumulate rather than risk deleting a live
 * tree.
 */
export async function prepareGradleSeed(
  gradleUserHome: string,
  opts?: { seedHome?: string; logger?: (message: string) => void }
): Promise<Record<string, string>> {
  const raw = opts?.seedHome ?? process.env.GRADLE_SEED_HOME;
  const seedHome = raw?.trim();
  if (!seedHome) return {};
  const log = opts?.logger;
  let seedStat: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    seedStat = await lstat(seedHome);
  } catch {
    log?.(`gradle seed unavailable: ${seedHome} missing, continuing without cache`);
    return {};
  }
  if (!seedStat.isDirectory()) {
    log?.(`gradle seed unavailable: ${seedHome} is not a directory, continuing without cache`);
    return {};
  }
  let entries: string[];
  try {
    entries = await readdir(seedHome);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.(`gradle seed unavailable: ${seedHome} unreadable (${detail}), continuing without cache`);
    return {};
  }
  if (entries.length === 0) {
    log?.(`gradle seed unavailable: ${seedHome} is empty, continuing without cache`);
    return {};
  }
  const src = join(seedHome, "wrapper", "dists");
  let srcStat: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    srcStat = await lstat(src);
  } catch {
    srcStat = undefined;
  }
  if (srcStat?.isDirectory()) {
    const dest = join(gradleUserHome, "wrapper", "dists");
    // Per-repository GRADLE_USER_HOME may be shared by concurrent jobs of one
    // repository, so dest may already hold a live tree another job populated.
    // Stage the copy in a temp sibling and only touch dest on success: a failed
    // copy removes just the staging dir, never the live tree (no `destExisted` check, which
    // races when two cold-start jobs both see a missing dest).
    let tmpRoot: string | undefined;
    let staging: string | undefined;
    try {
      await mkdir(dirname(dest), { recursive: true });
      tmpRoot = await mkdtemp(join(dirname(dest), ".dists.seed-"));
      staging = join(tmpRoot, "dists");
      await cp(src, staging, { recursive: true });
      await makeCopiedTreeOwnerWritable(staging);
      const destNow = await lstat(dest).catch(() => undefined);
      if (!destNow) {
        try {
          await rename(staging, dest);
        } catch {
          // Dest appeared concurrently between the check and the rename (or
          // rename cannot replace it): fall back to merging.
          await cp(staging, dest, { recursive: true });
        }
      } else {
        await cp(staging, dest, { recursive: true });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log?.(`gradle seed copy failed: ${src} (${detail}), continuing without cache`);
      return {};
    } finally {
      if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
  let modulesStat: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    modulesStat = await lstat(join(seedHome, "caches", "modules-2"));
  } catch {
    modulesStat = undefined;
  }
  if (!modulesStat?.isDirectory()) {
    log?.(
      `gradle seed has no dependency cache: ${join(seedHome, "caches", "modules-2")} missing, continuing without cache`
    );
    return {};
  }
  return { GRADLE_RO_DEP_CACHE: join(seedHome, "caches") };
}

/** Base worker child env plus the Gradle seed (copy + `GRADLE_RO_DEP_CACHE`) when set. */
export async function workerOpenCodeChildEnvWithGradleSeed(
  auth: GitAuth,
  workdir: string,
  opts?: WorkerChildEnvOptions | ((message: string) => void)
): Promise<Record<string, string>> {
  const resolved = normalizeWorkerChildEnvOpts(opts);
  const base = workerOpenCodeChildEnv(auth, workdir, resolved);
  const seedEnv = await prepareGradleSeed(base.GRADLE_USER_HOME, { logger: resolved.logger });
  return { ...base, ...seedEnv };
}

export function gitEnv(auth: GitAuth): Record<string, string | undefined> {
  const gitea = new URL(normalizeGiteaUrl(auth.giteaUrl));
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_AUTHOR_NAME: gitAuthorName(auth),
    GIT_AUTHOR_EMAIL: gitAuthorEmail(auth),
    GIT_COMMITTER_NAME: gitAuthorName(auth),
    GIT_COMMITTER_EMAIL: gitAuthorEmail(auth),
    GIT_AUTH_HOST: gitea.host,
    GIT_AUTH_USERNAME: auth.username,
    GIT_AUTH_TOKEN: auth.token,
  };
}

export async function runGit(
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> }
): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited]);
  if (exitCode !== 0) {
    const secrets = [opts.env.GIT_AUTH_TOKEN];
    const details = redactGitSecrets([stdout, stderr].filter(Boolean).join("\n"), secrets);
    const command = redactGitSecrets(args.join(" "), secrets);
    throw new Error(`git ${command} failed with exit code ${exitCode}${details ? `:\n${details}` : ""}`);
  }
  return stdout;
}

function assertSha(value: string, label: string): string {
  if (!/^[0-9a-f]{7,40}$/i.test(value)) throw new Error(`Invalid ${label} SHA: ${value}`);
  return value;
}

export async function createReviewWorkspace(root: string, job: ReviewJob): Promise<string> {
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, `jumi-${job.owner}-${job.repo}-${job.prNumber}-`));
}

/** Bare mirror kept on the workspace root. Not the worker cache at `_cache`. */
export const REVIEW_MIRROR_DIR = "_review-mirrors";

const reviewMirrorWaits = new Map<string, Promise<void>>();

function assertSafeSegment(value: string, label: string): string {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function reviewMirrorPath(workspace: string, owner: string, repo: string): string {
  return join(
    dirname(workspace),
    REVIEW_MIRROR_DIR,
    assertSafeSegment(owner, "owner"),
    `${assertSafeSegment(repo, "repo")}.git`
  );
}

/**
 * `lstat` does not follow the last component. `mkdir` and a later `lstat` of
 * `<repo>.git` do follow a symlink at `_review-mirrors` or the owner directory,
 * which would send the mirror into another store. `rm` of a symlink removes the link.
 */
async function removeIfNotRealDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info || (info.isDirectory() && !info.isSymbolicLink())) return;
  await rm(path, { force: true });
}

async function removeTree(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return;
  if (info.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  await rm(path, { recursive: true, force: true });
}

/** A directory left by a killed `clone --bare` is not a repository yet. */
async function isUsableBareMirror(path: string): Promise<boolean> {
  const head = await lstat(join(path, "HEAD")).catch(() => undefined);
  const configInfo = await lstat(join(path, "config")).catch(() => undefined);
  const objects = await lstat(join(path, "objects")).catch(() => undefined);
  if (!head?.isFile() || !configInfo?.isFile() || !objects?.isDirectory()) return false;
  const config = await readFile(join(path, "config"), "utf8").catch(() => "");
  return /(^|\n)\s*bare\s*=\s*true\s*(\n|$)/.test(config);
}

function withReviewMirrorLock<T>(mirrorPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = reviewMirrorWaits.get(mirrorPath) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  reviewMirrorWaits.set(mirrorPath, tail);
  return previous.then(fn, fn).finally(() => {
    release();
    if (reviewMirrorWaits.get(mirrorPath) === tail) reviewMirrorWaits.delete(mirrorPath);
  });
}

/**
 * Parent-owned bare mirror, one per owner/repo, next to the throwaway checkouts.
 * The review child runs the pull request. A worktree of the worker cache at
 * `_cache` would share a writable object store with later implement clones, so
 * this mirror is separate and the throwaway is `clone --reference`: new objects
 * land in the checkout, which is deleted with the review. No `--depth`:
 * merge-base and git log need the history. `gc.auto=0` so a later fetch does
 * not prune objects an in-flight checkout still borrows.
 */
async function ensureReviewMirror(opts: {
  mirrorPath: string;
  cloneUrl: string;
  auth: GitAuth;
  run: (args: string[], cwd: string) => Promise<string>;
  logger?: (message: string) => void;
  label: string;
}): Promise<void> {
  await withReviewMirrorLock(opts.mirrorPath, async () => {
    const ownerDir = dirname(opts.mirrorPath);
    const mirrorRoot = dirname(ownerDir);
    await removeIfNotRealDirectory(mirrorRoot);
    await mkdir(mirrorRoot, { recursive: true });
    await removeIfNotRealDirectory(ownerDir);
    await mkdir(ownerDir, { recursive: true });

    const incoming = `${opts.mirrorPath}.incoming`;
    await removeTree(incoming);

    const info = await lstat(opts.mirrorPath).catch(() => undefined);
    let ready = false;
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) {
      await rm(opts.mirrorPath, { force: true });
    } else if (info?.isDirectory()) {
      ready = await isUsableBareMirror(opts.mirrorPath);
      if (!ready) await removeTree(opts.mirrorPath);
    }

    const gcOff = ["-c", "gc.auto=0"];
    if (ready) {
      opts.logger?.(`Fetching ${opts.label} review mirror`);
    } else {
      opts.logger?.(`Cloning ${opts.label} into review mirror`);
      await opts.run(
        [...gcOff, "clone", "--bare", gitRemoteUrl(opts.cloneUrl, opts.auth), incoming],
        dirname(opts.mirrorPath)
      );
      await rename(incoming, opts.mirrorPath);
    }
    if (opts.auth.embedTokenInUrl) {
      await opts.run(["remote", "set-url", "origin", opts.cloneUrl], opts.mirrorPath);
    }
    await opts.run(["config", "gc.auto", "0"], opts.mirrorPath);
    await opts.run([...gcOff, "fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], opts.mirrorPath);
  });
}

export async function checkoutPullRequestWorkspace(opts: CheckoutPullRequestWorkspaceOptions): Promise<void> {
  const git = opts.gitRunner ?? runGit;
  const configArgs = gitConfigArgs();
  const runConfiguredGit = (args: string[], runOpts: { cwd: string; env: Record<string, string | undefined> }) =>
    git([...configArgs, ...args], runOpts);
  const auth: GitAuth = {
    giteaUrl: opts.giteaUrl,
    username: opts.username,
    token: opts.token,
    embedTokenInUrl: opts.embedTokenInUrl,
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
  };
  const env = gitEnv(auth);
  const headSha = assertSha(opts.pr.head.sha, "PR head");
  const baseSha = assertSha(opts.pr.base.sha, "PR target");
  const prRef = `refs/pull/${opts.pr.number}/head`;
  const remotePrRef = `refs/remotes/origin/pr/${opts.pr.number}/head`;
  const targetBranch = "jumi/target";
  const baseCloneUrl = validateCloneUrl(opts.repo.clone_url, opts.giteaUrl);
  const mirrorPath = reviewMirrorPath(opts.workdir, opts.repo.owner.login, opts.repo.name);
  const runAt = (args: string[], cwd: string) => runConfiguredGit(args, { cwd, env });

  await ensureReviewMirror({
    mirrorPath,
    cloneUrl: baseCloneUrl,
    auth,
    run: runAt,
    logger: opts.logger,
    label: opts.repo.full_name,
  });

  opts.logger?.(`Cloning ${opts.repo.full_name} into review workspace`);
  await runAt(
    ["clone", "--reference", mirrorPath, gitRemoteUrl(baseCloneUrl, auth), opts.workdir],
    dirname(opts.workdir)
  );
  if (auth.embedTokenInUrl) {
    await runAt(["remote", "set-url", "origin", baseCloneUrl], opts.workdir);
  }

  opts.logger?.(`Fetching target branch ${opts.pr.base.ref}`);
  await runConfiguredGit(
    ["fetch", "origin", `+refs/heads/${opts.pr.base.ref}:refs/remotes/origin/${opts.pr.base.ref}`],
    {
      cwd: opts.workdir,
      env,
    }
  );
  await runConfiguredGit(["branch", "--force", targetBranch, baseSha], { cwd: opts.workdir, env });

  try {
    opts.logger?.(`Fetching PR ref ${prRef}`);
    await runConfiguredGit(["fetch", "origin", `+${prRef}:${remotePrRef}`], { cwd: opts.workdir, env });
  } catch (err) {
    if (!opts.pr.head.repo?.clone_url) throw err;
    const headCloneUrl = validateCloneUrl(opts.pr.head.repo.clone_url, opts.giteaUrl);
    opts.logger?.(`Fetching PR head branch ${opts.pr.head.ref} from source repository`);
    await runConfiguredGit(["remote", "add", "pr-head", gitRemoteUrl(headCloneUrl, auth)], {
      cwd: opts.workdir,
      env,
    });
    if (auth.embedTokenInUrl) {
      await runConfiguredGit(["remote", "set-url", "pr-head", headCloneUrl], { cwd: opts.workdir, env });
    }
    await runConfiguredGit(
      ["fetch", "pr-head", `+refs/heads/${opts.pr.head.ref}:refs/remotes/pr-head/${opts.pr.head.ref}`],
      {
        cwd: opts.workdir,
        env,
      }
    );
  }

  opts.logger?.(`Checking out PR head ${headSha} with target branch ${targetBranch}`);
  await runConfiguredGit(["checkout", "--force", "-B", `jumi/pr-${opts.pr.number}`, headSha], {
    cwd: opts.workdir,
    env,
  });
  const checkedOutHead = await runConfiguredGit(["rev-parse", "HEAD"], { cwd: opts.workdir, env });
  if (checkedOutHead !== headSha) throw new Error(`Checked out ${checkedOutHead}, expected PR head ${headSha}`);
  const checkedOutBase = await runConfiguredGit(["rev-parse", targetBranch], { cwd: opts.workdir, env });
  if (checkedOutBase !== baseSha)
    throw new Error(`Target ref ${targetBranch} is ${checkedOutBase}, expected ${baseSha}`);
  await ensureEngineScratchIgnored(opts.workdir);
}

export async function removeReviewWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
