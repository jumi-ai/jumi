export const STABLE_SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;

export type TagScheme = "rust-v" | "v" | "bare";

export function tagForScheme(version: string, scheme: TagScheme): string {
  if (scheme === "rust-v") return `rust-v${version}`;
  if (scheme === "v") return `v${version}`;
  return version;
}

export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

export function requireEnvValue(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") throw new Error(`missing ${key}`);
  return value;
}

export function allowedVersionsToRegExp(allowed: string): RegExp {
  if (allowed.startsWith("/") && allowed.lastIndexOf("/") > 0) {
    const last = allowed.lastIndexOf("/");
    return new RegExp(allowed.slice(1, last));
  }
  return new RegExp(allowed);
}

export interface ArchPin {
  version: string;
  amdTag: string;
  armTag: string;
  amdSha: string;
  armSha: string;
  tagScheme: TagScheme;
  allowedVersion?: RegExp;
  allowedTag?: RegExp;
}

export function validateArchPin(pin: ArchPin): void {
  if (!STABLE_SEMVER_RE.test(pin.version)) throw new Error(`version is not stable semver: ${pin.version}`);
  if (pin.allowedVersion && !pin.allowedVersion.test(pin.version)) {
    throw new Error(`version does not match allowedVersions: ${pin.version}`);
  }
  const expected = tagForScheme(pin.version, pin.tagScheme);
  if (pin.amdTag !== expected) throw new Error(`amd tag does not match version: ${pin.amdTag} != ${expected}`);
  if (pin.armTag !== expected) throw new Error(`arm tag does not match version: ${pin.armTag} != ${expected}`);
  if (pin.amdTag !== pin.armTag) throw new Error(`arch tags differ: ${pin.amdTag} != ${pin.armTag}`);
  if (pin.allowedTag) {
    if (!pin.allowedTag.test(pin.amdTag)) throw new Error(`amd tag does not match allowedVersions: ${pin.amdTag}`);
    if (!pin.allowedTag.test(pin.armTag)) throw new Error(`arm tag does not match allowedVersions: ${pin.armTag}`);
  }
  if (!HEX64_RE.test(pin.amdSha)) throw new Error(`amd sha is not 64 lowercase hex`);
  if (!HEX64_RE.test(pin.armSha)) throw new Error(`arm sha is not 64 lowercase hex`);
  if (pin.amdSha === pin.armSha) throw new Error(`arch digests must differ`);
}

export function extractFirst(matchString: string, content: string) {
  const re = new RegExp(matchString, "g");
  const match = re.exec(content);
  if (!match) return null;
  return { replaceString: match[0], groups: (match.groups ?? {}) as Record<string, string | undefined> };
}

// Minimal Handlebars subset used by our autoReplace templates:
// {{{newValue}}}, {{{newDigest}}}, {{newValue}}, {{newDigest}},
// plus {{#if newDigest}}...{{/if}} for the Temurin manager.
export function compileAutoReplace(template: string, vars: { newValue?: string; newDigest?: string }): string {
  const withConditionals = template.replace(/\{\{#if newDigest\}\}([\s\S]*?)\{\{\/if\}\}/g, vars.newDigest ? "$1" : "");
  return withConditionals
    .replace(/\{\{\{newValue\}\}\}/g, vars.newValue ?? "")
    .replace(/\{\{\{newDigest\}\}\}/g, vars.newDigest ?? "")
    .replace(/\{\{newValue\}\}/g, vars.newValue ?? "")
    .replace(/\{\{newDigest\}\}/g, vars.newDigest ?? "");
}

export function parseRequirements(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+)==([^\s;]+)$/.exec(trimmed);
    if (!match) continue;
    out[match[1].toLowerCase()] = match[2];
  }
  return out;
}
