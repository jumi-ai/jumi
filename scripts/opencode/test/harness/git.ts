import type { GitRunner } from "../../src/workspace.ts";

export interface FakeGitOptions {
  head?: string;
  porcelain?: string;
  baseReviewMd?: string;
}

/**
 * Shared frozen git runner. Defaults match every previous `frozenGit` copy:
 * `rev-parse` -> head, `status` -> porcelain, `ls-files`/`checkout` -> "".
 * `ls-tree`/`show` serve `baseReviewMd` exactly like `review.test.ts`; when it
 * is unset `ls-tree` returns "" (the `review_excludes` behaviour) and `show`
 * throws (no previous caller without `baseReviewMd` calls it).
 */
export function fakeGit(opts: FakeGitOptions | string = {}): GitRunner {
  const resolved: FakeGitOptions = typeof opts === "string" ? { head: opts } : opts;
  const head = resolved.head ?? "headsha";
  const porcelain = resolved.porcelain ?? "?? JUMI_REVIEW.md";
  return (async (args: string[]) => {
    if (args[0] === "rev-parse") return head;
    if (args[0] === "status") return porcelain;
    if (args[0] === "ls-files") return "";
    if (args[0] === "checkout") return "";
    if (args[0] === "ls-tree") {
      if (resolved.baseReviewMd === undefined) return "";
      const size = Buffer.byteLength(resolved.baseReviewMd, "utf8");
      return `100644 blob ${"b".repeat(40)} ${size}\tREVIEW.md`;
    }
    if (args[0] === "show") {
      if (resolved.baseReviewMd === undefined) throw new Error(`unexpected git ${args.join(" ")}`);
      return resolved.baseReviewMd;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  }) as GitRunner;
}

/** Legacy aliases so migrated call sites keep their `frozenGit()` shape. */
export const frozenGit = fakeGit;
export const frozenGitRunner = fakeGit;
