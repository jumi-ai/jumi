import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";

/**
 * Checkout skills for a Claude spawn, without checkout hooks.
 *
 * `--setting-sources user` is what keeps the untrusted checkout's
 * `.claude/settings.json` hooks out, and it also keeps the checkout's
 * `.claude/skills` out: the binary only reads project skills when the
 * `project` source is on, and that source brings the checkout's hooks, env and
 * permission rules with it. So the checkout's skills are staged instead as an
 * inline plugin (`--plugin-dir`) the parent writes outside the checkout:
 *
 *   - the plugin root is ours, so it carries no `hooks/hooks.json`;
 *   - every `SKILL.md` is re-fronted with only `name` and `description`, because
 *     a skill's own frontmatter `hooks:` run once the skill is loaded;
 *   - symlinks that leave the checkout are skipped, and the copy is bounded.
 *
 * The model sees these skills as `checkout:<name>`. Fleet skills under
 * `~/.claude/skills` still load through the user source untouched.
 */
export const CLAUDE_CHECKOUT_SKILLS_PLUGIN = "checkout";
export const CLAUDE_CHECKOUT_SKILLS_MAX_FILES = 2_000;
export const CLAUDE_CHECKOUT_SKILLS_MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 8;

class StageLimitError extends Error {}

interface StageState {
  root: string;
  files: number;
  bytes: number;
  skills: number;
  seen: Set<string>;
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

function yamlString(value: string): string {
  // JSON strings are YAML double-quoted scalars; escape the two line
  // separators JSON leaves raw so YAML cannot read them as a break.
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/**
 * `SKILL.md` with its frontmatter replaced by `name` and `description` only.
 * The new block is always first in the file, so whatever the original
 * frontmatter said (hooks, allowed-tools, model, …) is either dropped or left
 * as inert body text. Undefined when the frontmatter is not YAML.
 */
export function hooklessSkillMarkdown(text: string, fallbackName: string): string | undefined {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const match = FRONTMATTER_RE.exec(source);
  let fields: Record<string, unknown> = {};
  let body = source;
  if (match) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(match[1] ?? "");
    } catch {
      return undefined;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
    body = source.slice(match[0].length);
  }
  const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : fallbackName;
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  const head = [`name: ${yamlString(name)}`];
  if (description) head.push(`description: ${yamlString(description)}`);
  return `---\n${head.join("\n")}\n---\n${body}`;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

async function stageTree(state: StageState, src: string, dest: string, depth: number): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src)) {
    const from = join(src, entry);
    let real: string;
    try {
      real = await realpath(from);
    } catch {
      continue;
    }
    if (!inside(state.root, real)) continue;
    const info = await stat(real);
    const to = join(dest, entry);
    if (info.isDirectory()) {
      if (depth >= MAX_DEPTH || state.seen.has(real)) continue;
      state.seen.add(real);
      await stageTree(state, real, to, depth + 1);
      continue;
    }
    if (!info.isFile()) continue;
    state.files += 1;
    state.bytes += info.size;
    if (state.files > CLAUDE_CHECKOUT_SKILLS_MAX_FILES || state.bytes > CLAUDE_CHECKOUT_SKILLS_MAX_BYTES) {
      throw new StageLimitError(
        `checkout skills exceed ${CLAUDE_CHECKOUT_SKILLS_MAX_FILES} files or ${CLAUDE_CHECKOUT_SKILLS_MAX_BYTES} bytes`
      );
    }
    if (entry.toLowerCase() !== "skill.md") {
      await writeFile(to, await readFile(real));
      continue;
    }
    const skill = hooklessSkillMarkdown(await readFile(real, "utf8"), basename(dest));
    if (skill === undefined) continue;
    // Always the exact name the binary looks for, whatever case the checkout used.
    await writeFile(join(dest, "SKILL.md"), skill);
    state.skills += 1;
  }
}

/**
 * Stage `<workdir>/.claude/skills` as a hook-free inline plugin under `dest`.
 * Returns the plugin dir to pass as `--plugin-dir`, or undefined when the
 * checkout has no skills or they cannot be staged. Never throws: a checkout
 * whose skills cannot be staged is reviewed without them, not refused.
 */
export async function stageClaudeCheckoutSkills(
  workdir: string,
  dest: string,
  log: (message: string) => void = () => undefined
): Promise<string | undefined> {
  try {
    const src = join(workdir, ".claude", "skills");
    try {
      await lstat(src);
    } catch {
      return undefined;
    }
    const root = await realpath(workdir);
    const real = await realpath(src);
    if (!inside(root, real) || !(await stat(real)).isDirectory()) return undefined;
    const state: StageState = { root, files: 0, bytes: 0, skills: 0, seen: new Set([real]) };
    await stageTree(state, real, join(dest, "skills"), 0);
    if (state.skills === 0) return undefined;
    await mkdir(join(dest, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dest, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: CLAUDE_CHECKOUT_SKILLS_PLUGIN,
          description: "Skills from the checkout's .claude/skills, staged without hooks",
        },
        null,
        2
      )}\n`
    );
    return dest;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[claude] checkout skills not staged: ${reason}`);
    return undefined;
  }
}
