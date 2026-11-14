import { existsSync, readFileSync } from "node:fs";

/** Manifest written at image build time from the same version-check commands. */
export const INSTALLED_TOOLS_PATH = "/app/installed-tools.txt";

export function resolveInstalledToolsPath(): string {
  const override = process.env.JUMI_INSTALLED_TOOLS_PATH?.trim();
  if (override) return override;
  return INSTALLED_TOOLS_PATH;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Read the manifest, one `name version` entry per line. Missing file omits the block. */
export function loadInstalledToolsManifest(manifestPath?: string): string[] | undefined {
  const path = manifestPath ?? resolveInstalledToolsPath();
  try {
    if (!existsSync(path)) return undefined;
    const lines = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return undefined;
    return lines;
  } catch {
    return undefined;
  }
}

/** Short block naming what is already installed so agents do not probe for it. */
export function formatInstalledToolsBlock(tools: readonly string[]): string {
  const lines = tools.map((tool) => `  ${escapeXml(tool)}`).join("\n");
  return `<installed_tools>
${lines}
  These are installed; do not probe with \`which\`/\`command -v\`; install anything else under the rule above.
</installed_tools>`;
}

/** Formatted block, or empty when the manifest is missing (dev checkout, tests). */
export function installedToolsBlockForPrompt(manifestPath?: string): string {
  const tools = loadInstalledToolsManifest(manifestPath);
  if (!tools) return "";
  return formatInstalledToolsBlock(tools);
}

/** Append the block once; already-stamped prompts are returned unchanged. */
export function withInstalledTools(prompt: string, manifestPath?: string): string {
  if (prompt.includes("<installed_tools>")) return prompt;
  const block = installedToolsBlockForPrompt(manifestPath);
  if (!block) return prompt;
  return `${prompt}\n\n${block}`;
}
