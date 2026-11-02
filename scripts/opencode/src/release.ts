import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTRACT_PATH = "deploy/contract.md";
export const REVIEWER_LOADER_PATH = "scripts/opencode/src/config.ts";
export const WORKER_LOADER_PATH = "scripts/opencode/src/worker_config.ts";
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/** Env helpers the loaders call; their own declarations read the caller's `name`, not an env name. */
const ENV_HELPERS = ["requireEnv", "requirePem", "optionalEnv", "intEnv", "csvEnv"];
/** Call site of an env helper; the arguments are split by a paren scan, not by the regex. */
const LOADER_ENV_HELPER_RE = new RegExp(`\\b(${ENV_HELPERS.join("|")})\\s*\\(`, "g");
const LOADER_ENV_PROP_RE = /\b(?:resolved|env)\.([A-Z][A-Z0-9_]*)\b/g;
const LOADER_ENV_INDEX_RE = /\b(?:resolved|env)\[\s*([^\]]+?)\s*\]/g;
/** Helpers that throw when the variable is unset. */
const REQUIRING_HELPERS = new Set(["requireEnv", "requirePem"]);
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const CONST_ENV_NAME_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
const CONST_ENV_MAP_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^}]*)\}/g;
const CONST_ENV_MAP_ENTRY_RE = /([A-Za-z_$][\w$]*)\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
const CONST_ENV_LIST_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]*)\]/g;
const CONST_ENV_LIST_ENTRY_RE = /"([A-Za-z_][A-Za-z0-9_]*)"/g;
const FOR_OF_CONST_RE = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;
/** Shared forge bind the worker loader delegates to; its env belongs to both images. */
const FORGE_BIND_FN = "loadForgeBind";
/** Guard whose branch is reached only when `FORGE=github`: an `if` block or a ternary. */
const FORGE_GITHUB_GUARD_RE = /\b(?:\w+\.)?forge\s*===\s*"github"/g;
/** A `/` right after one of these (or at the start of the file) opens a regex literal, not a division. */
const REGEX_PREFIX_RE = /^[(,=:[!&|?{};+\-*%^~<>]?$/;

export type BumpKind = "major" | "minor" | "patch" | "initial";
export type VersionDecision = BumpKind | "reuse";
export type ImageName = "reviewer" | "worker" | "control";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export interface ImageContract {
  /** Loader fails process start when unset under the default `FORGE` (`requireEnv` / `requirePem`). */
  requiredEnv: string[];
  /** GitOps must set it, but the loader tolerates unset (local/dev mode, or another `FORGE`). */
  gitOpsEnv: string[];
  optionalEnv: string[];
  /** Process-start rules. Adding or removing one is a required GitOps change (major). */
  requiredConstraints: string[];
  ports: string[];
  runAs: string;
  probes: string[];
  command: string;
  imageTarget: string;
  volumes: string[];
}

export type ContractEnvIssueKind =
  | "missing"
  | "extra"
  | "required_as_optional"
  | "optional_as_required"
  | "forge_conditional_as_required"
  | "forge_conditional_as_optional"
  | "unresolved_env_ref"
  | "duplicate";

export interface ContractEnvIssue {
  image: ImageName;
  name: string;
  kind: ContractEnvIssueKind;
}

export interface DeployContract {
  reviewer: ImageContract;
  worker: ImageContract;
  control: ImageContract;
}

export interface ReleasePlan {
  version: string;
  bump: VersionDecision;
  body: string;
}

export function parseSemVerTag(tag: string): SemVer | null {
  const match = SEMVER_TAG.exec(tag.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatSemVerTag(version: SemVer): string {
  return `v${version.major}.${version.minor}.${version.patch}`;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function emptyImage(): ImageContract {
  return {
    requiredEnv: [],
    gitOpsEnv: [],
    optionalEnv: [],
    requiredConstraints: [],
    ports: [],
    runAs: "",
    probes: [],
    command: "",
    imageTarget: "",
    volumes: [],
  };
}

function headingSection(markdown: string, level: number, title: string): string {
  const re = new RegExp(`^#{${level}}\\s+${title}\\s*$`, "im");
  const match = re.exec(markdown);
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = new RegExp(`^#{1,${level}}\\s+`, "m").exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function listValues(sectionText: string): string[] {
  return sectionText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) =>
      line
        .slice(2)
        .trim()
        .replace(/^`([^`]+)`$/, "$1")
    );
}

function firstValue(values: string[]): string {
  return values[0] ?? "";
}

function parseImage(section: string): ImageContract {
  return {
    requiredEnv: listValues(headingSection(section, 4, "required env")),
    gitOpsEnv: listValues(headingSection(section, 4, "gitops env")),
    optionalEnv: listValues(headingSection(section, 4, "optional env")),
    requiredConstraints: listValues(headingSection(section, 4, "required constraints")),
    ports: listValues(headingSection(section, 4, "ports")),
    runAs: firstValue(listValues(headingSection(section, 4, "runAs"))),
    probes: listValues(headingSection(section, 4, "probes")),
    command: firstValue(listValues(headingSection(section, 4, "command"))),
    imageTarget: firstValue(listValues(headingSection(section, 4, "image target"))),
    volumes: listValues(headingSection(section, 4, "volumes")),
  };
}

/**
 * Env names behind constants: `const X = "NAME"`, `const M = { key: "NAME" }` (`M.key`), and
 * `const L = ["A", "B"]`. A `for (const k of L)` binding is not one of these — it is scoped to its
 * own loop body, so `forOfScopes` keeps it out of this file-global map.
 */
function constEnvNames(source: string): Map<string, string[]> {
  const consts = new Map<string, string[]>();
  const add = (ref: string, name: string): void => {
    if (!ENV_NAME_RE.test(name)) return;
    const names = consts.get(ref);
    if (!names) consts.set(ref, [name]);
    else if (!names.includes(name)) names.push(name);
  };
  for (const match of source.matchAll(CONST_ENV_NAME_RE)) add(match[1], match[2]);
  for (const match of source.matchAll(CONST_ENV_MAP_RE)) {
    for (const entry of match[2].matchAll(CONST_ENV_MAP_ENTRY_RE)) add(`${match[1]}.${entry[1]}`, entry[2]);
  }
  for (const match of source.matchAll(CONST_ENV_LIST_RE)) {
    for (const entry of match[2].matchAll(CONST_ENV_LIST_ENTRY_RE)) add(match[1], entry[1]);
  }
  return consts;
}

/** Empty for refs with no env name behind them: helper definitions (`env[name]`), computed keys. */
function resolveEnvRef(ref: string, consts: Map<string, string[]>): string[] {
  const trimmed = ref.trim();
  const literal = /^"([A-Za-z_][A-Za-z0-9_]*)"$/.exec(trimmed);
  if (literal) return ENV_NAME_RE.test(literal[1]) ? [literal[1]] : [];
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(trimmed)) return consts.get(trimmed) ?? [];
  return [];
}

/**
 * The source with string, template, regex, and comment bodies blanked, length and newlines kept, so
 * brace, ternary, and env-read scans see code only: a `"}"` in a message no longer moves a range,
 * and a comment that spells `env[name]` is not a read. Indices still line up with the original, so
 * the ref text is recovered from `source` at the same offsets.
 */
function maskLiterals(source: string): string {
  const out = source.split("");
  const blank = (start: number, stop: number): number => {
    const end = Math.min(stop, source.length);
    for (let i = start; i < end; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
    return end;
  };
  const stringEnd = (open: number): number => {
    const quote = source[open];
    let braces = 0;
    for (let i = open + 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "\\") i++;
      else if (quote === "`" && ch === "$" && source[i + 1] === "{") {
        braces++;
        i++;
      } else if (braces > 0) {
        if (ch === "{") braces++;
        else if (ch === "}") braces--;
      } else if (ch === quote) return i + 1;
      else if (quote !== "`" && ch === "\n") return i;
    }
    return source.length;
  };
  const regexEnd = (open: number): number => {
    let inClass = false;
    for (let i = open + 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "\\") i++;
      else if (ch === "\n") return i;
      else if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) return i + 1;
    }
    return source.length;
  };
  let previous = "";
  let cursor = 0;
  while (cursor < source.length) {
    const ch = source[cursor];
    const pair = source.slice(cursor, cursor + 2);
    if (pair === "//") {
      const newline = source.indexOf("\n", cursor);
      cursor = blank(cursor, newline < 0 ? source.length : newline);
    } else if (pair === "/*") {
      const close = source.indexOf("*/", cursor + 2);
      cursor = blank(cursor, close < 0 ? source.length : close + 2);
    } else if (ch === '"' || ch === "'" || ch === "`") {
      cursor = blank(cursor, stringEnd(cursor));
    } else if (ch === "/" && REGEX_PREFIX_RE.test(previous)) {
      cursor = blank(cursor, regexEnd(cursor));
    } else {
      if (ch.trim()) previous = ch;
      cursor++;
    }
  }
  return out.join("");
}

/** Takes masked source: see `maskLiterals`. */
function matchingBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * `[start, end)` of each top-level argument of the call whose `(` sits at `open`, or `null` when the
 * parentheses never close. A scan rather than a regex, so an argument may be any expression — a
 * call, a member access, an object — instead of the bare identifier a regex can spell. Takes masked
 * source, so a comma inside a string does not split an argument.
 */
function callArguments(masked: string, open: number): Array<[number, number]> | null {
  const args: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth > 0) continue;
      args.push([start, i]);
      return args;
    } else if (ch === "," && depth === 1) {
      args.push([start, i]);
      start = i + 1;
    }
  }
  return null;
}

/** `[start, end)` of the body a `for (…)` header ending at `from` covers. Takes masked source. */
function loopBodyRange(masked: string, from: number): [number, number] | null {
  let start = from;
  while (start < masked.length && !masked[start].trim()) start++;
  if (start >= masked.length) return null;
  if (masked[start] === "{") {
    const end = matchingBrace(masked, start);
    return end < 0 ? null : [start, end + 1];
  }
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) return [start, i + 1];
  }
  return null;
}

/** A `for (const k of LIST)` binding, together with the loop body it stands for the list inside. */
interface EnvScope {
  binding: string;
  names: string[];
  start: number;
  end: number;
}

/**
 * Loop bindings over a const list: inside the body, `env[k]` names every entry of the list. Scoped
 * to the body rather than added to the file-global consts, so two loops binding the same name do not
 * union their lists and a binding over a runtime value stays unresolved instead of borrowing one.
 */
function forOfScopes(masked: string, consts: Map<string, string[]>): EnvScope[] {
  const scopes: EnvScope[] = [];
  for (const match of masked.matchAll(FOR_OF_CONST_RE)) {
    const names = consts.get(match[2]);
    if (!names) continue;
    const body = loopBodyRange(masked, match.index + match[0].length);
    if (body) scopes.push({ binding: match[1], names, start: body[0], end: body[1] });
  }
  return scopes;
}

/**
 * Index of the `{` opening the body of a function whose parameter list closes at `close`, or `-1`.
 * A return-type annotation brings braces of its own — `: { forge: string }`, `: Promise<{ … }>` —
 * so the scan skips any `{…}` that follows a token a type can continue from (`:`, `|`, `&`, `,`,
 * `<`, `(`, `=>`) and stops at the first `{` that follows a complete type. Takes masked source.
 */
function bodyBrace(masked: string, close: number): number {
  let complete = true;
  let previous = "";
  for (let i = close + 1; i < masked.length; i++) {
    const ch = masked[i];
    if (!ch.trim()) continue;
    if (ch === "{") {
      if (complete) return i;
      const end = matchingBrace(masked, i);
      if (end < 0) return -1;
      i = end;
      complete = true;
    } else {
      complete = !("|&,<(=?:".includes(ch) || (ch === ">" && previous === "="));
    }
    previous = masked[i];
  }
  return -1;
}

/** `[start, end)` of `function <name>(...) { ... }`, or `null` when the source does not declare it. */
function functionRange(source: string, name: string, masked = maskLiterals(source)): [number, number] | null {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`).exec(masked);
  if (!decl) return null;
  let cursor = decl.index + decl[0].length - 1;
  let depth = 0;
  for (; cursor < masked.length; cursor++) {
    if (masked[cursor] === "(") depth++;
    else if (masked[cursor] === ")" && --depth === 0) break;
  }
  const open = bodyBrace(masked, cursor);
  if (open < 0) return null;
  const end = matchingBrace(masked, open);
  return end < 0 ? null : [decl.index, end + 1];
}

/** Text of `function <name>(...) { ... }`, or `""` when the source does not declare it. */
function functionBlock(source: string, name: string): string {
  const range = functionRange(source, name);
  return range ? source.slice(range[0], range[1]) : "";
}

/** A loader that calls the shared forge bind reads its env too, even across files. */
function withSharedForgeBind(source: string, shared: string): string {
  if (!new RegExp(`\\b${FORGE_BIND_FN}\\s*\\(`).test(source)) return source;
  if (new RegExp(`function\\s+${FORGE_BIND_FN}\\b`).test(source)) return source;
  const block = functionBlock(shared, FORGE_BIND_FN);
  return block ? `${source}\n${block}` : source;
}

/** Index of the `:` closing the true branch of the ternary whose `?` sits at `open`, else `-1`. */
function ternaryBranchEnd(masked: string, open: number): number {
  let depth = 0;
  let nested = 0;
  for (let i = open + 1; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth < 0) return -1;
    } else if (depth > 0) continue;
    else if (ch === "?") {
      if (masked[i + 1] === "?") i++;
      else if (masked[i + 1] !== ".") nested++;
    } else if (ch === ":") {
      if (nested === 0) return i;
      nested--;
    }
  }
  return -1;
}

/** Branches reached only when `FORGE=github`: `if (forge === "github") { … }` and the ternary form. */
function forgeGithubRanges(source: string): Array<[number, number]> {
  const masked = maskLiterals(source);
  const nextCode = (from: number): number => {
    for (let i = from; i < masked.length; i++) {
      if (masked[i].trim()) return i;
    }
    return -1;
  };
  const ranges: Array<[number, number]> = [];
  for (const match of source.matchAll(FORGE_GITHUB_GUARD_RE)) {
    let open = nextCode(match.index + match[0].length);
    if (open >= 0 && masked[open] === ")") open = nextCode(open + 1);
    if (open < 0) continue;
    if (masked[open] !== "{" && masked[open] !== "?") continue;
    const end = masked[open] === "{" ? matchingBrace(masked, open) : ternaryBranchEnd(masked, open);
    if (end > open) ranges.push([open, end]);
  }
  return ranges;
}

interface EnvRead {
  /** The resolved env name, or the raw ref text when `resolved` is false. */
  name: string;
  /** The read throws when the variable is unset. */
  requiring: boolean;
  /** The ref resolved to an env name; unresolved refs are reported, never classified. */
  resolved: boolean;
  index: number;
}

/**
 * Every env read the loader makes. The scans run over the masked source, so a comment or a message
 * that mentions `env.X` or spells a `requireEnv` call is text, not a read; the ref text is recovered
 * from the original at the same offsets, because masking keeps lengths.
 */
function envReads(source: string, consts: Map<string, string[]>): EnvRead[] {
  const masked = maskLiterals(source);
  // The helper declarations pass the caller's `name` around (`requireEnv(env, name)` inside
  // `requirePem`, `env[name]`): no env name lives there, so their bodies are not scanned.
  const helpers = ENV_HELPERS.map((helper) => functionRange(source, helper, masked)).filter((range) => range !== null);
  const declared = (index: number): boolean => helpers.some(([start, end]) => index >= start && index < end);
  const scopes = forOfScopes(masked, consts);
  const reads: EnvRead[] = [];
  // An unresolvable ref is recorded whatever the helper: a gitops variable reaches the loader
  // through `optionalEnv` or a plain index read just as often as through a throwing helper.
  const push = (ref: string, requiring: boolean, index: number): void => {
    const trimmed = ref.trim();
    const scope = scopes.filter((s) => s.binding === trimmed && index > s.start && index < s.end).pop();
    const names = scope ? scope.names : resolveEnvRef(trimmed, consts);
    if (names.length === 0) reads.push({ name: trimmed, requiring, resolved: false, index });
    for (const name of names) reads.push({ name, requiring, resolved: true, index });
  };
  // The env argument of a helper call, or the call text when it has no readable name argument: a
  // call the scan cannot read still reads env under some name, so it is reported, never dropped.
  const callRef = (call: number, open: number): string => {
    const args = callArguments(masked, open);
    const named = args?.[1];
    if (named && source.slice(named[0], named[1]).trim()) return source.slice(named[0], named[1]);
    return source.slice(call, args ? args[args.length - 1][1] + 1 : open + 1);
  };
  for (const match of masked.matchAll(LOADER_ENV_HELPER_RE)) {
    if (declared(match.index)) continue;
    const open = match.index + match[0].length - 1;
    push(callRef(match.index, open), REQUIRING_HELPERS.has(match[1]), match.index);
  }
  for (const match of masked.matchAll(LOADER_ENV_PROP_RE)) {
    if (declared(match.index)) continue;
    reads.push({ name: match[1], requiring: false, resolved: true, index: match.index });
  }
  for (const match of masked.matchAll(LOADER_ENV_INDEX_RE)) {
    if (declared(match.index)) continue;
    const start = match.index + match[0].indexOf("[") + 1;
    push(source.slice(start, match.index + match[0].length - 1), false, match.index);
  }
  return reads;
}

/**
 * Process-start env as the loader sees it: `requireEnv`/`requirePem` → required, the same call
 * reached only under `FORGE=github` → gitOps (forge-conditional), every other read → optional.
 * `unresolved` holds refs that are neither literal nor constant, from any read: the scanner cannot
 * name that variable, so it is reported instead of silently dropped.
 */
export function gitOpsLoaderEnv(
  source: string,
  sharedSource = ""
): { required: string[]; gitOps: string[]; optional: string[]; unresolved: string[] } {
  const scanned = withSharedForgeBind(source, sharedSource);
  const consts = constEnvNames(`${source}\n${sharedSource}`);
  const reads = envReads(scanned, consts);
  const named = reads.filter((read) => read.resolved);
  const ranges = forgeGithubRanges(scanned);
  const forgeOnly = (index: number): boolean => ranges.some(([start, end]) => index > start && index < end);
  const required: string[] = [];
  const gitOps: string[] = [];
  const optional: string[] = [];
  for (const name of [...new Set(named.map((read) => read.name))].sort()) {
    const requiring = named.filter((read) => read.name === name && read.requiring);
    if (requiring.some((read) => !forgeOnly(read.index))) required.push(name);
    else if (requiring.length > 0) gitOps.push(name);
    else optional.push(name);
  }
  const unresolved = [...new Set(reads.filter((read) => !read.resolved).map((read) => read.name))].sort();
  return { required, gitOps, optional, unresolved };
}

export function formatContractEnvIssue(issue: ContractEnvIssue): string {
  if (issue.kind === "missing") {
    return `${issue.image} loader env \`${issue.name}\` is missing from deploy/contract.md required/gitops/optional env`;
  }
  if (issue.kind === "extra") {
    return `${issue.image} contract env \`${issue.name}\` is not read by the loader`;
  }
  if (issue.kind === "required_as_optional") {
    return `${issue.image} env \`${issue.name}\` fails process start when unset but is not listed as required env`;
  }
  if (issue.kind === "optional_as_required") {
    return `${issue.image} env \`${issue.name}\` does not fail process start when unset but is listed as required env (use gitops env if GitOps must set it)`;
  }
  if (issue.kind === "forge_conditional_as_required") {
    return `${issue.image} env \`${issue.name}\` only fails process start when \`FORGE=github\` but is listed as required env (use gitops env)`;
  }
  if (issue.kind === "forge_conditional_as_optional") {
    return `${issue.image} env \`${issue.name}\` fails process start when \`FORGE=github\` but is listed as optional env (use gitops env)`;
  }
  if (issue.kind === "unresolved_env_ref") {
    return `${issue.image} loader reads env named by \`${issue.name}\`, which is neither a string literal nor a constant: deploy/contract.md cannot be checked against it (use a literal or a \`const\`)`;
  }
  return `${issue.image} env \`${issue.name}\` is listed under more than one of required/gitops/optional env`;
}

/** Control runs both loaders: pass control_config.ts + codex_control.ts concatenated as controlSrc. */
export function contractEnvIssues(
  contract: DeployContract,
  reviewerSrc: string,
  workerSrc: string,
  controlSrc = ""
): ContractEnvIssue[] {
  const issues: ContractEnvIssue[] = [];
  for (const image of ["reviewer", "worker", "control"] as const) {
    const expected =
      image === "reviewer"
        ? gitOpsLoaderEnv(reviewerSrc)
        : image === "worker"
          ? gitOpsLoaderEnv(workerSrc, reviewerSrc)
          : controlSrc
            ? gitOpsLoaderEnv(controlSrc, reviewerSrc)
            : { required: [], gitOps: [], optional: [], unresolved: [] };
    const listedRequired = contract[image].requiredEnv;
    const listedGitOps = contract[image].gitOpsEnv;
    const listedOptional = contract[image].optionalEnv;
    const requiredSet = new Set(listedRequired);
    const gitOpsSet = new Set(listedGitOps);
    const optionalSet = new Set([...listedGitOps, ...listedOptional]);
    const listed = new Set([...listedRequired, ...listedGitOps, ...listedOptional]);
    const expectedNames = new Set([...expected.required, ...expected.gitOps, ...expected.optional]);
    for (const ref of expected.unresolved) {
      issues.push({ image, name: ref, kind: "unresolved_env_ref" });
    }
    const seen = new Set<string>();
    for (const name of [...listedRequired, ...listedGitOps, ...listedOptional]) {
      if (seen.has(name)) issues.push({ image, name, kind: "duplicate" });
      seen.add(name);
    }
    for (const name of expectedNames) {
      if (!listed.has(name)) issues.push({ image, name, kind: "missing" });
    }
    for (const name of listed) {
      if (!expectedNames.has(name)) issues.push({ image, name, kind: "extra" });
    }
    for (const name of expected.required) {
      if (optionalSet.has(name) && !requiredSet.has(name)) {
        issues.push({ image, name, kind: "required_as_optional" });
      }
    }
    for (const name of expected.optional) {
      if (requiredSet.has(name) && !optionalSet.has(name)) {
        issues.push({ image, name, kind: "optional_as_required" });
      }
    }
    for (const name of expected.gitOps) {
      if (!listed.has(name) || gitOpsSet.has(name)) continue;
      issues.push({
        image,
        name,
        kind: requiredSet.has(name) ? "forge_conditional_as_required" : "forge_conditional_as_optional",
      });
    }
  }
  return issues;
}

export function parseContract(markdown: string): DeployContract {
  if (!markdown.trim()) {
    return { reviewer: emptyImage(), worker: emptyImage(), control: emptyImage() };
  }
  const reviewer = headingSection(markdown, 3, "reviewer");
  const worker = headingSection(markdown, 3, "worker");
  if (!reviewer || !worker) {
    throw new Error("deploy/contract.md must contain ### reviewer and ### worker");
  }
  const controlSection = headingSection(markdown, 3, "control");
  return {
    reviewer: parseImage(reviewer),
    worker: parseImage(worker),
    control: controlSection ? parseImage(controlSection) : emptyImage(),
  };
}

function addedLines(previous: string, current: string): string[] {
  const prevLines = new Set(previous.split("\n"));
  return current.split("\n").filter((line) => !prevLines.has(line));
}

export function hasBreakingMarker(previous: string, current: string): boolean {
  return addedLines(previous, current).some((line) => {
    const trimmed = line.trim();
    return /^#{1,6}\s*BREAKING\b/i.test(trimmed) || /(^|\s)BREAKING(\s|:|$)/.test(trimmed);
  });
}

function removedItems(previous: string[], current: string[]): string[] {
  const next = new Set(current);
  return previous.filter((item) => !next.has(item));
}

function addedItems(previous: string[], current: string[]): string[] {
  const prev = new Set(previous);
  return current.filter((item) => !prev.has(item));
}

/** Env GitOps must set: fails process start (`required env`) or chart-only (`gitops env`). */
function gitOpsRequiredEnv(image: ImageContract): string[] {
  return [...image.requiredEnv, ...image.gitOpsEnv];
}

export function removedRequiredFields(previous: ImageContract, current: ImageContract): string[] {
  const removed: string[] = [];
  for (const key of removedItems(gitOpsRequiredEnv(previous), gitOpsRequiredEnv(current))) {
    removed.push(`env ${key}`);
  }
  for (const item of removedItems(previous.requiredConstraints, current.requiredConstraints)) {
    removed.push(`constraint ${item}`);
  }
  for (const port of removedItems(previous.ports, current.ports)) {
    removed.push(`port ${port}`);
  }
  if (previous.runAs && previous.runAs !== current.runAs) removed.push(`user ${previous.runAs}`);
  for (const probe of removedItems(previous.probes, current.probes)) {
    removed.push(`probe ${probe}`);
  }
  if (previous.command && previous.command !== current.command) removed.push(`command ${previous.command}`);
  if (previous.imageTarget && previous.imageTarget !== current.imageTarget) {
    removed.push(`target ${previous.imageTarget}`);
  }
  return removed;
}

function hasRequiredGitOpsChange(previous: ImageContract, current: ImageContract): boolean {
  return (
    addedItems(gitOpsRequiredEnv(previous), gitOpsRequiredEnv(current)).length > 0 ||
    removedItems(gitOpsRequiredEnv(previous), gitOpsRequiredEnv(current)).length > 0 ||
    addedItems(previous.requiredConstraints, current.requiredConstraints).length > 0 ||
    removedItems(previous.requiredConstraints, current.requiredConstraints).length > 0 ||
    addedItems(previous.ports, current.ports).length > 0 ||
    removedItems(previous.ports, current.ports).length > 0 ||
    previous.runAs !== current.runAs ||
    addedItems(previous.probes, current.probes).length > 0 ||
    removedItems(previous.probes, current.probes).length > 0 ||
    previous.command !== current.command ||
    previous.imageTarget !== current.imageTarget
  );
}

function hasOptionalGitOpsChange(previous: ImageContract, current: ImageContract): boolean {
  return (
    addedItems(previous.optionalEnv, current.optionalEnv).length > 0 ||
    removedItems(previous.optionalEnv, current.optionalEnv).length > 0 ||
    addedItems(previous.volumes, current.volumes).length > 0 ||
    removedItems(previous.volumes, current.volumes).length > 0
  );
}

export function classifyBump(previousMarkdown: string | null, currentMarkdown: string): BumpKind {
  if (previousMarkdown === null) return "initial";
  if (hasBreakingMarker(previousMarkdown, currentMarkdown)) return "major";
  const previous = parseContract(previousMarkdown);
  const current = parseContract(currentMarkdown);
  if (
    hasRequiredGitOpsChange(previous.reviewer, current.reviewer) ||
    hasRequiredGitOpsChange(previous.worker, current.worker) ||
    hasRequiredGitOpsChange(previous.control, current.control)
  ) {
    return "major";
  }
  if (
    hasOptionalGitOpsChange(previous.reviewer, current.reviewer) ||
    hasOptionalGitOpsChange(previous.worker, current.worker) ||
    hasOptionalGitOpsChange(previous.control, current.control)
  ) {
    return "minor";
  }
  return "patch";
}

export function nextVersionFrom(latestTag: string | null, bump: BumpKind): string {
  if (bump === "initial" || latestTag === null) return "v1.0.0";
  const parsed = parseSemVerTag(latestTag);
  if (!parsed) return "v1.0.0";
  if (bump === "major") return formatSemVerTag({ major: parsed.major + 1, minor: 0, patch: 0 });
  if (bump === "minor") return formatSemVerTag({ major: parsed.major, minor: parsed.minor + 1, patch: 0 });
  return formatSemVerTag({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1 });
}

function requiresEnvBullet(current: ImageContract, key: string): string {
  if (current.requiredEnv.includes(key)) {
    return `- **requires** \`${key}\` (new; missing → crash)`;
  }
  return `- **requires** \`${key}\` (new; GitOps must set; unset → local/dev, no crash)`;
}

function gitOpsBullets(previous: ImageContract, current: ImageContract): string[] {
  const bullets: string[] = [];
  const prevGitOps = gitOpsRequiredEnv(previous);
  const nextGitOps = gitOpsRequiredEnv(current);
  for (const key of addedItems(prevGitOps, nextGitOps)) {
    bullets.push(requiresEnvBullet(current, key));
  }
  for (const key of removedItems(prevGitOps, nextGitOps)) {
    bullets.push(`- **removed** \`${key}\` (was required)`);
  }
  for (const key of addedItems(previous.requiredEnv, current.requiredEnv)) {
    if (previous.gitOpsEnv.includes(key)) {
      bullets.push(`- **process start** \`${key}\` now fails when unset (was GitOps-only)`);
    }
  }
  for (const key of addedItems(previous.gitOpsEnv, current.gitOpsEnv)) {
    if (previous.requiredEnv.includes(key)) {
      bullets.push(`- **process start** \`${key}\` no longer fails when unset (GitOps must still set it)`);
    }
  }
  for (const port of addedItems(previous.ports, current.ports)) {
    bullets.push(`- **port** \`${port}\` (new)`);
  }
  for (const port of removedItems(previous.ports, current.ports)) {
    bullets.push(`- **removed port** \`${port}\``);
  }
  if (previous.runAs !== current.runAs && (previous.runAs || current.runAs)) {
    bullets.push(`- **runAs** \`${previous.runAs || "none"}\` → \`${current.runAs || "none"}\``);
  }
  for (const probe of addedItems(previous.probes, current.probes)) {
    bullets.push(`- **probe** \`${probe}\` (new)`);
  }
  for (const probe of removedItems(previous.probes, current.probes)) {
    bullets.push(`- **removed probe** \`${probe}\``);
  }
  if (previous.command !== current.command && (previous.command || current.command)) {
    bullets.push(`- **command** \`${previous.command || "none"}\` → \`${current.command || "none"}\``);
  }
  if (previous.imageTarget !== current.imageTarget && (previous.imageTarget || current.imageTarget)) {
    bullets.push(`- **image target** \`${previous.imageTarget || "none"}\` → \`${current.imageTarget || "none"}\``);
  }
  for (const item of addedItems(previous.requiredConstraints, current.requiredConstraints)) {
    bullets.push(`- **constraint** \`${item}\` (new; process start fails closed)`);
  }
  for (const item of removedItems(previous.requiredConstraints, current.requiredConstraints)) {
    bullets.push(`- **removed constraint** \`${item}\``);
  }
  for (const key of addedItems(previous.optionalEnv, current.optionalEnv)) {
    bullets.push(`- **optional env** \`${key}\` (new)`);
  }
  for (const key of removedItems(previous.optionalEnv, current.optionalEnv)) {
    bullets.push(`- **removed optional env** \`${key}\``);
  }
  for (const volume of addedItems(previous.volumes, current.volumes)) {
    bullets.push(`- **volume** \`${volume}\` (new)`);
  }
  for (const volume of removedItems(previous.volumes, current.volumes)) {
    bullets.push(`- **removed volume** \`${volume}\``);
  }
  return bullets;
}

function formatGitOpsSection(previousMarkdown: string | null, currentMarkdown: string): string {
  if (previousMarkdown === null) return "none";
  const previous = parseContract(previousMarkdown);
  const current = parseContract(currentMarkdown);
  const reviewer = gitOpsBullets(previous.reviewer, current.reviewer);
  const worker = gitOpsBullets(previous.worker, current.worker);
  const control = gitOpsBullets(previous.control, current.control);
  if (reviewer.length === 0 && worker.length === 0 && control.length === 0) return "none";
  const reviewerBlock = reviewer.length > 0 ? reviewer.join("\n") : "- none";
  const workerBlock = worker.length > 0 ? worker.join("\n") : "- none";
  const controlBlock = control.length > 0 ? control.join("\n") : "- none";
  return `### reviewer\n${reviewerBlock}\n### worker\n${workerBlock}\n### control\n${controlBlock}`;
}

function formatBreakingSection(previousMarkdown: string | null, currentMarkdown: string): string {
  if (previousMarkdown === null) return "none";
  const bullets: string[] = [];
  if (hasBreakingMarker(previousMarkdown, currentMarkdown)) {
    bullets.push("- BREAKING marker in deploy/contract.md");
  }
  const previous = parseContract(previousMarkdown);
  const current = parseContract(currentMarkdown);
  for (const image of ["reviewer", "worker", "control"] as const) {
    for (const field of removedRequiredFields(previous[image], current[image])) {
      bullets.push(`- ${image}: removed required ${field}`);
    }
  }
  return bullets.length > 0 ? bullets.join("\n") : "none";
}

export function buildReleaseBody(opts: {
  previousContract: string | null;
  currentContract: string;
  changes: string[];
}): string {
  const gitOps = formatGitOpsSection(opts.previousContract, opts.currentContract);
  const breaking = formatBreakingSection(opts.previousContract, opts.currentContract);
  const changes = opts.changes.length > 0 ? opts.changes.map((line) => `- ${line}`).join("\n") : "- none";
  return `## GitOps\n${gitOps}\n\n## Breaking\n${breaking}\n\n## Changes\n${changes}\n`;
}

export function workflowRebuildsOnTag(yaml: string): boolean {
  const hasTagTrigger = /tags:\s*\["v\*"\]/.test(yaml) || /tags:\s*\n\s*-\s*"v\*"/m.test(yaml);
  if (!hasTagTrigger) return false;
  if (/if:\s*\$\{\{\s*github\.ref_type\s*!=\s*'tag'\s*\}\}/.test(yaml)) return false;
  if (/if:\s*\$\{\{\s*github\.event_name\s*!=\s*'push'\s*\|\|\s*github\.ref_type\s*!=\s*'tag'/.test(yaml)) {
    return false;
  }
  return true;
}

export function shouldSkipImageBuild(refType: string): boolean {
  return refType === "tag";
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

function gitAllowFail(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout;
}

export function listSemverTags(repoDir: string): string[] {
  const out = gitAllowFail(["tag", "--list", "v*"], repoDir) ?? "";
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((tag) => parseSemVerTag(tag))
    .sort((a, b) => compareSemVer(parseSemVerTag(a)!, parseSemVerTag(b)!));
}

export function headSemverTag(repoDir: string): string | null {
  const pointed = gitAllowFail(["tag", "--points-at", "HEAD"], repoDir) ?? "";
  const tags = pointed
    .split("\n")
    .map((line) => line.trim())
    .filter((tag) => parseSemVerTag(tag))
    .sort((a, b) => compareSemVer(parseSemVerTag(a)!, parseSemVerTag(b)!));
  return tags.at(-1) ?? null;
}

export function latestSemverTag(repoDir: string): string | null {
  const tags = listSemverTags(repoDir);
  return tags.at(-1) ?? null;
}

export function contractAt(repoDir: string, ref: string): string | null {
  return gitAllowFail(["show", `${ref}:${CONTRACT_PATH}`], repoDir);
}

export function currentContract(repoDir: string): string {
  return readFileSync(join(repoDir, CONTRACT_PATH), "utf8");
}

export function changesSince(repoDir: string, tag: string | null): string[] {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const out = tag
    ? (gitAllowFail(["log", "--oneline", range], repoDir) ?? "")
    : (gitAllowFail(["log", "--oneline", "-1"], repoDir) ?? "");
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function computeRelease(repoDir: string): ReleasePlan {
  const current = currentContract(repoDir);
  const headTag = headSemverTag(repoDir);
  if (headTag) {
    const older = listSemverTags(repoDir).filter((tag) => tag !== headTag);
    const previousTag = older.at(-1) ?? null;
    const previous = previousTag ? (contractAt(repoDir, previousTag) ?? "") : null;
    return {
      version: headTag,
      bump: "reuse",
      body: buildReleaseBody({
        previousContract: previous,
        currentContract: current,
        changes: changesSince(repoDir, previousTag),
      }),
    };
  }
  const latest = latestSemverTag(repoDir);
  const previous = latest ? (contractAt(repoDir, latest) ?? "") : null;
  const bump = classifyBump(previous, current);
  return {
    version: nextVersionFrom(latest, bump),
    bump,
    body: buildReleaseBody({
      previousContract: previous,
      currentContract: current,
      changes: changesSince(repoDir, latest),
    }),
  };
}

function repoRoot(cwd = process.cwd()): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

interface GiteaTag {
  name?: string;
  commit?: { sha?: string };
  id?: string;
}

export async function publishRelease(opts: {
  serverUrl: string;
  token: string;
  owner: string;
  repo: string;
  sha: string;
  version: string;
  body: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ tagCreated: boolean; releaseCreated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `${opts.serverUrl.replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
  const headers = {
    Authorization: `token ${opts.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    if (res.status === 403) {
      throw new Error(
        `Gitea API 403 ${method} ${path}. The default Actions token cannot write tags/releases. Do not add a PAT; fix token permissions.`
      );
    }
    return { status: res.status, text };
  }

  const existingTag = await request("GET", `/tags/${encodeURIComponent(opts.version)}`);
  let tagCreated = false;
  if (existingTag.status === 200) {
    const parsed = JSON.parse(existingTag.text) as GiteaTag;
    const sha = parsed.commit?.sha ?? parsed.id ?? "";
    if (sha && sha !== opts.sha) {
      throw new Error(`Refusing to move immutable tag ${opts.version} from ${sha} to ${opts.sha}`);
    }
  } else if (existingTag.status === 404) {
    const created = await request("POST", "/tags", {
      tag_name: opts.version,
      target: opts.sha,
      message: opts.version,
    });
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`Gitea API POST /tags → ${created.status}: ${created.text}`);
    }
    tagCreated = true;
  } else {
    throw new Error(`Gitea API GET /tags/${opts.version} → ${existingTag.status}: ${existingTag.text}`);
  }

  const existingRelease = await request("GET", `/releases/tags/${encodeURIComponent(opts.version)}`);
  let releaseCreated = false;
  if (existingRelease.status === 200) {
    return { tagCreated, releaseCreated };
  }
  if (existingRelease.status !== 404) {
    throw new Error(
      `Gitea API GET /releases/tags/${opts.version} → ${existingRelease.status}: ${existingRelease.text}`
    );
  }
  const createdRelease = await request("POST", "/releases", {
    tag_name: opts.version,
    target_commitish: opts.sha,
    name: opts.version,
    body: opts.body,
    draft: false,
    prerelease: false,
  });
  if (createdRelease.status !== 200 && createdRelease.status !== 201) {
    throw new Error(`Gitea API POST /releases → ${createdRelease.status}: ${createdRelease.text}`);
  }
  releaseCreated = true;
  return { tagCreated, releaseCreated };
}

interface GitHubRefObject {
  sha?: string;
  type?: string;
  url?: string;
}

interface GitHubRef {
  ref?: string;
  object?: GitHubRefObject;
}

interface GitHubTagObject {
  sha?: string;
  tag?: string;
  object?: GitHubRefObject;
}

export function touchesGitHubWorkflows(repoDir: string, sha = "HEAD"): boolean {
  const out =
    gitAllowFail(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha, "--", ".github/workflows"],
      repoDir
    ) ?? "";
  return (
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length > 0
  );
}

export function advertisedNextVersion(repoDir: string, sha = "HEAD"): string | null {
  const plan = computeRelease(repoDir);
  if (plan.bump !== "reuse" && touchesGitHubWorkflows(repoDir, sha)) {
    return null;
  }
  return plan.version;
}

export function peeledCommitForTag(repoDir: string, tag: string): string | null {
  const out = gitAllowFail(["rev-parse", `${tag}^{commit}`], repoDir);
  const sha = out?.trim() ?? "";
  return sha || null;
}

function changesBetween(repoDir: string, fromTag: string | null, toRef: string): string[] {
  const out = fromTag
    ? (gitAllowFail(["log", "--oneline", `${fromTag}..${toRef}`], repoDir) ?? "")
    : (gitAllowFail(["log", "--oneline", "-1", toRef], repoDir) ?? "");
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function releaseBodyForTag(repoDir: string, tag: string): string {
  const tags = listSemverTags(repoDir);
  const idx = tags.indexOf(tag);
  const previousTag = idx > 0 ? tags[idx - 1] : null;
  const previousContract = previousTag ? (contractAt(repoDir, previousTag) ?? "") : null;
  const current = contractAt(repoDir, tag) ?? "";
  return buildReleaseBody({
    previousContract: previousContract,
    currentContract: current,
    changes: changesBetween(repoDir, previousTag, tag),
  });
}

export async function publishGitHubRelease(opts: {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  sha: string;
  version: string;
  body: string;
  makeLatest?: boolean;
  skipMissingRelease?: boolean;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ tagCreated: boolean; releaseCreated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `${opts.apiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jumi",
  };

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => "");
    if (res.status === 403) {
      throw new Error(
        `GitHub API 403 ${method} ${path}. The default Actions token cannot write tags/releases. Do not add a PAT; fix token permissions.`
      );
    }
    return { status: res.status, text };
  }

  async function peeledCommit(refSha: string, refType: string): Promise<string> {
    if (refType !== "tag") return refSha;
    const tagObj = await request("GET", `/git/tags/${refSha}`);
    if (tagObj.status !== 200) {
      throw new Error(`GitHub API GET /git/tags/${refSha} → ${tagObj.status}: ${tagObj.text}`);
    }
    const parsed = JSON.parse(tagObj.text) as GitHubTagObject;
    const peeled = parsed.object?.sha ?? "";
    if (!peeled) throw new Error(`GitHub tag object ${refSha} is missing peeled commit`);
    return peeled;
  }

  const refPath = `/git/ref/tags/${encodeURIComponent(opts.version)}`;
  const existingRef = await request("GET", refPath);
  let tagCreated = false;
  if (existingRef.status === 200) {
    const parsed = JSON.parse(existingRef.text) as GitHubRef;
    const refSha = parsed.object?.sha ?? "";
    const refType = parsed.object?.type ?? "";
    if (!refSha) throw new Error(`GitHub ref tags/${opts.version} is missing object sha`);
    const peeled = await peeledCommit(refSha, refType);
    if (peeled !== opts.sha) {
      throw new Error(`Refusing to move immutable tag ${opts.version} from ${peeled} to ${opts.sha}`);
    }
  } else if (existingRef.status === 404) {
    const tagObj = await request("POST", "/git/tags", {
      tag: opts.version,
      message: opts.version,
      object: opts.sha,
      type: "commit",
    });
    if (tagObj.status !== 200 && tagObj.status !== 201) {
      throw new Error(`GitHub API POST /git/tags → ${tagObj.status}: ${tagObj.text}`);
    }
    const parsedTag = JSON.parse(tagObj.text) as { sha?: string };
    const tagObjectSha = parsedTag.sha ?? "";
    if (!tagObjectSha) throw new Error("GitHub API POST /git/tags did not return a tag object sha");
    const ref = await request("POST", "/git/refs", {
      ref: `refs/tags/${opts.version}`,
      sha: tagObjectSha,
    });
    if (ref.status === 200 || ref.status === 201) {
      tagCreated = true;
    } else if (ref.status === 422) {
      const retry = await request("GET", refPath);
      if (retry.status !== 200) {
        throw new Error(`GitHub API POST /git/refs → ${ref.status}: ${ref.text}`);
      }
      const reparsed = JSON.parse(retry.text) as GitHubRef;
      const retrySha = reparsed.object?.sha ?? "";
      const retryType = reparsed.object?.type ?? "";
      if (!retrySha) throw new Error(`GitHub ref tags/${opts.version} is missing object sha`);
      const peeled = await peeledCommit(retrySha, retryType);
      if (peeled !== opts.sha) {
        throw new Error(`Refusing to move immutable tag ${opts.version} from ${peeled} to ${opts.sha}`);
      }
    } else {
      throw new Error(`GitHub API POST /git/refs → ${ref.status}: ${ref.text}`);
    }
  } else {
    throw new Error(`GitHub API GET ${refPath} → ${existingRef.status}: ${existingRef.text}`);
  }

  const existingRelease = await request("GET", `/releases/tags/${encodeURIComponent(opts.version)}`);
  if (existingRelease.status === 200) {
    return { tagCreated, releaseCreated: false };
  }
  if (existingRelease.status !== 404) {
    throw new Error(
      `GitHub API GET /releases/tags/${opts.version} → ${existingRelease.status}: ${existingRelease.text}`
    );
  }
  const createdRelease = await request("POST", "/releases", {
    tag_name: opts.version,
    ...(tagCreated ? { target_commitish: opts.sha } : {}),
    name: opts.version,
    body: opts.body,
    draft: false,
    prerelease: false,
    generate_release_notes: false,
    make_latest: opts.makeLatest === false ? "false" : "true",
  });
  if (createdRelease.status === 404 && opts.skipMissingRelease) {
    return { tagCreated, releaseCreated: false };
  }
  if (createdRelease.status !== 200 && createdRelease.status !== 201) {
    throw new Error(`GitHub API POST /releases → ${createdRelease.status}: ${createdRelease.text}`);
  }
  return { tagCreated, releaseCreated: true };
}

export async function runPublishGitHub(opts: {
  repoDir: string;
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  sha: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
  const { repoDir: root, apiUrl, token, owner, repo, sha, fetchImpl } = opts;
  const plan = computeRelease(root);
  const latest = latestSemverTag(root);
  if (plan.bump === "reuse") {
    const result = await publishGitHubRelease({
      apiUrl,
      token,
      owner,
      repo,
      sha,
      version: plan.version,
      body: plan.body,
      fetchImpl,
    });
    console.log(
      `Published ${plan.version} bump=reuse tagCreated=${result.tagCreated} releaseCreated=${result.releaseCreated}`
    );
    const older = listSemverTags(root).filter((tag) => tag !== plan.version);
    const previousLatest = older.at(-1) ?? null;
    if (previousLatest && previousLatest !== plan.version) {
      const tagCommit = peeledCommitForTag(root, previousLatest);
      if (tagCommit) {
        const backfill = await publishGitHubRelease({
          apiUrl,
          token,
          owner,
          repo,
          sha: tagCommit,
          version: previousLatest,
          body: releaseBodyForTag(root, previousLatest),
          makeLatest: false,
          skipMissingRelease: true,
          fetchImpl,
        });
        console.log(
          `Backfilled ${previousLatest} tagCreated=${backfill.tagCreated} releaseCreated=${backfill.releaseCreated}`
        );
      }
    }
    return;
  }
  if (touchesGitHubWorkflows(root, sha)) {
    console.log(
      `Skipping new version ${plan.version} on ${sha} because it touches .github/workflows; backfilling latest tag if needed`
    );
    if (latest) {
      const tagCommit = peeledCommitForTag(root, latest);
      if (tagCommit) {
        const backfill = await publishGitHubRelease({
          apiUrl,
          token,
          owner,
          repo,
          sha: tagCommit,
          version: latest,
          body: releaseBodyForTag(root, latest),
          fetchImpl,
        });
        console.log(`Backfilled ${latest} tagCreated=${backfill.tagCreated} releaseCreated=${backfill.releaseCreated}`);
      }
    }
    return;
  }
  const result = await publishGitHubRelease({
    apiUrl,
    token,
    owner,
    repo,
    sha,
    version: plan.version,
    body: plan.body,
    fetchImpl,
  });
  console.log(
    `Published ${plan.version} bump=${plan.bump} tagCreated=${result.tagCreated} releaseCreated=${result.releaseCreated}`
  );
  if (latest && latest !== plan.version) {
    const tagCommit = peeledCommitForTag(root, latest);
    if (tagCommit) {
      const backfill = await publishGitHubRelease({
        apiUrl,
        token,
        owner,
        repo,
        sha: tagCommit,
        version: latest,
        body: releaseBodyForTag(root, latest),
        makeLatest: false,
        fetchImpl,
      });
      console.log(`Backfilled ${latest} tagCreated=${backfill.tagCreated} releaseCreated=${backfill.releaseCreated}`);
    }
  }
}

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "next-version";
  const root = repoRoot();
  const plan = computeRelease(root);
  if (command === "next-version") {
    const version = advertisedNextVersion(root);
    process.stdout.write(`${version ?? ""}\n`);
    return;
  }
  if (command === "release-body") {
    process.stdout.write(plan.body);
    return;
  }
  if (command === "skip-build") {
    process.stdout.write(
      `${shouldSkipImageBuild(process.env.REF_TYPE ?? process.env.GITHUB_REF_TYPE ?? "") ? "yes" : "no"}\n`
    );
    return;
  }
  if (command === "publish") {
    const token = process.env.GITHUB_TOKEN || process.env.GITEA_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const serverUrl = process.env.GITHUB_SERVER_URL || process.env.GITEA_URL;
    const sha = process.env.GITHUB_SHA;
    if (!token) throw new Error("GITHUB_TOKEN is required to publish a release");
    if (!repository?.includes("/")) throw new Error("GITHUB_REPOSITORY is required");
    if (!serverUrl) throw new Error("GITHUB_SERVER_URL is required");
    if (!sha) throw new Error("GITHUB_SHA is required");
    const [owner, repo] = repository.split("/");
    const result = await publishRelease({
      serverUrl,
      token,
      owner,
      repo,
      sha,
      version: plan.version,
      body: plan.body,
    });
    console.log(
      `Published ${plan.version} bump=${plan.bump} tagCreated=${result.tagCreated} releaseCreated=${result.releaseCreated}`
    );
    return;
  }
  if (command === "publish-github") {
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
    const sha = process.env.GITHUB_SHA;
    if (!token) throw new Error("GITHUB_TOKEN is required to publish a release");
    if (!repository?.includes("/")) throw new Error("GITHUB_REPOSITORY is required");
    if (!sha) throw new Error("GITHUB_SHA is required");
    const [owner, repo] = repository.split("/");
    await runPublishGitHub({ repoDir: root, apiUrl, token, owner, repo, sha });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
