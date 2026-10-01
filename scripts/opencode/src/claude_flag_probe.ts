#!/usr/bin/env bun
/**
 * Prove Jumi's production Claude flags against the *installed `claude` binary*,
 * not against the constants that built them.
 *
 * A unit test that compares `claudeArgv()` to `CLAUDE_PERMISSION_MODE` grades
 * itself: it stays green when the binary drops a flag, renames a choice, or
 * starts ignoring a value. In production that shows up as every Claude spawn
 * dying with a generic non-zero exit, or — worse for `--effort` — as a silent
 * downgrade the parent never notices. `claude --version` in the image job does
 * not exercise a single production flag.
 *
 * How: stand up a stub Anthropic-compatible endpoint on loopback, point the
 * binary at it with `ANTHROPIC_BASE_URL`, and run the exact argv `claudeArgv()`
 * emits. Nothing is billed and no request leaves the machine: the operator's
 * `CLAUDE_CODE_OAUTH_TOKEN` is deliberately kept out of the child env, so the
 * probe cannot spend real quota even if one is exported.
 *
 * What the run proves, beyond "the process started":
 *   - the binary echoes back the `permission-mode` and `model` it accepted, so
 *     a value that parses but is ignored still fails here;
 *   - `--output-format stream-json --verbose` still yields the event stream
 *     `ClaudeStreamParser` reads text and token usage from;
 *   - every name in `--allowedTools` is a tool this binary actually has;
 *   - every `--effort` level an operator may configure is still known, since a
 *     level this release dropped only warns and runs at the default;
 *   - `--plugin-dir` is on the argv *and the plugin behind it actually runs*: the
 *     probe stands up a second loopback server as a throwaway Phoenix, points
 *     `PHOENIX_OTLP_ENDPOINT` at it, and requires the run to POST a span
 *     carrying this probe's job id. That is the one link nothing else exercises
 *     — `claude --help` proves the flag is spelled the same, and the hook unit
 *     tests exec `hooks/*.sh` directly, so between them a release that stopped
 *     loading inline manifest hooks (or `--setting-sources user` starting to
 *     suppress them) would leave every homelab Claude run untraced with nothing
 *     anywhere saying so;
 *   - skills load without checkout hooks: a fleet skill under `~/.claude/skills`
 *     and a checkout `.claude/skills` skill staged by
 *     `stageClaudeCheckoutSkills` are both in the init event's skill list. The
 *     stub then has the model load the checkout skill, and neither checkout
 *     hook runs: not the `SessionStart` hook in `.claude/settings.json`, and not
 *     the `Stop` hook in the skill's own frontmatter. Nor does the inline
 *     shell in the skill's body (`` !`cmd` `` and a ```! fence). A skill's
 *     frontmatter hooks only run once the skill is loaded, and `SessionStart`
 *     is not one of the events the binary runs from there, so the control is a
 *     second run with the same skill unstaged, where that `Stop` hook and both
 *     shell forms must fire.
 *
 * Then each flag value the binary is able to reject is re-run with a nonsense
 * value and must draw an objection. That is what keeps the positive case
 * honest: a binary that shrugged at `--permission-mode nonsense` would also
 * shrug at a typo in production, and the probe says so instead of passing.
 *
 * Exit 0 when every case matches its expectation, 1 otherwise.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_ALLOWED_TOOLS, CLAUDE_PERMISSION_MODE, claudeArgv, stripAnsi } from "./claude.ts";
import { CLAUDE_CHECKOUT_SKILLS_PLUGIN, stageClaudeCheckoutSkills } from "./claude_checkout_skills.ts";
import { claudeTracingEnv } from "./claude_tracing.ts";
import { ClaudeStreamParser } from "./claude_usage.ts";
import { CLAUDE_EFFORT_LEVELS } from "./runners.ts";

/** Text the stub answers with; seeing it means the session really completed. */
const PROBE_MARKER = "JUMI-CLAUDE-FLAG-PROBE-OK";
/**
 * Never a real model id: the image must not carry one (see deploy/contract.md),
 * and the stub answers whatever it is asked for. `--model` is echoed back in
 * the init event, which is what this probe checks.
 */
const PROBE_MODEL = "jumi-claude-flag-probe-model";
/**
 * The level the full production judgment and the negative control run at. Every
 * other level in `CLAUDE_EFFORT_LEVELS` gets its own positive run below: that
 * set is what `parseRunnersCatalog` lets an operator configure, and `--effort`
 * is the one production flag the binary answers with a warning instead of an
 * exit, so a level it no longer knows downgrades the run in silence.
 */
const PROBE_EFFORT = "high";
/** Job id the tracing plugin must stamp on the span it POSTs, if it ran at all. */
const PROBE_JOB_ID = "jumi-claude-flag-probe-job";
/**
 * Cap a single `claude` run. The endpoint is loopback, so a healthy run is
 * seconds; this is only a hang guard, and the whole table stays well under the
 * `timeout 600` the image verification wraps the probe in.
 */
const RUN_TIMEOUT_MS = 60_000;
/** Skill the probe puts in `~/.claude/skills`, the fleet/user location. */
export const PROBE_FLEET_SKILL = "jumi-probe-fleet-skill";
/** Skill the probe puts in the checkout's `.claude/skills`. */
export const PROBE_CHECKOUT_SKILL = "jumi-probe-checkout-skill";
/** File the checkout's `.claude/settings.json` hook would create if it ran. */
const PROBE_SETTINGS_HOOK_MARKER = "jumi-probe-checkout-settings-hook-ran";
/** File the checkout skill's frontmatter hook would create if it ran. */
const PROBE_SKILL_HOOK_MARKER = "jumi-probe-checkout-skill-hook-ran";
/** File the same frontmatter hook must create when the skill is not staged. */
const PROBE_UNSTAGED_HOOK_MARKER = "jumi-probe-unstaged-skill-hook-ran";
/** Files the inline shell in the checkout skill's body would create if it ran. */
const PROBE_SKILL_SHELL_MARKER = "jumi-probe-checkout-skill-shell-ran";
/** Files that same inline shell must create when the skill is not staged. */
const PROBE_UNSTAGED_SHELL_MARKER = "jumi-probe-unstaged-skill-shell-ran";
/** One file per inline shell form the binary runs from a skill body. */
const PROBE_SHELL_FORMS = ["inline", "fence"] as const;

/**
 * Production flags whose *value* the installed binary validates. Everything
 * else Jumi passes (`--model`, the tool lists) is taken verbatim, so a nonsense
 * value there draws no objection and cannot be a negative control; the tool
 * names are checked against the init event instead.
 */
export const CLAUDE_REJECTABLE_FLAGS = ["--permission-mode", "--setting-sources", "--output-format", "--effort"];

export interface PinnedFlagValue {
  readonly flag: string;
  readonly value: string;
}

/**
 * The flag values this probe pins, read back out of the production argv so the
 * table cannot drift from `claudeArgv()`. Unit-tested against the shipped
 * constants; probed against the binary below.
 */
export function pinnedFlagValues(argv: readonly string[]): PinnedFlagValue[] {
  const pinned: PinnedFlagValue[] = [];
  for (const flag of CLAUDE_REJECTABLE_FLAGS) {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (value !== undefined) pinned.push({ flag, value });
  }
  return pinned;
}

/** Same argv with one flag's value swapped, for the negative controls. */
export function withFlagValue(argv: readonly string[], flag: string, value: string): string[] {
  const swapped = [...argv];
  const index = swapped.indexOf(flag);
  if (index < 0 || index + 1 >= swapped.length) throw new Error(`argv has no value for ${flag}`);
  swapped[index + 1] = value;
  return swapped;
}

/** A value no release can consider valid, for `flag`. */
export function nonsenseValue(flag: string): string {
  return `jumi-not-a-valid${flag.replace(/^--/, "-")}`;
}

/**
 * A complaint about a flag Jumi actually passed. Scoped to lines that name one
 * of our own flags so an unrelated runtime warning (container, locale, root)
 * does not read as a rejected production flag.
 *
 * `stripAnsi` first, for the same reason `runClaude` pipes claude's stderr
 * through it (`claude.ts`): this binary colorizes, and the anchor below would
 * miss a `\x1b[33mWarning:\x1b[0m …` line the parent reads as a warning.
 */
export function droppedFlagWarning(argv: readonly string[], stderr: string): string | undefined {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  return stripAnsi(stderr)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^(warning|error)\b/i.test(line) && flags.some((flag) => line.includes(flag)));
}

/**
 * What an objection looks like. A rejected flag exits non-zero with commander's
 * `error:` line; `--effort` instead warns and falls back to the default, which
 * is just as much a broken production flag, so both count — as long as the
 * complaint names the flag and the value it refused. Judged on stripped stderr,
 * the same text the parent reads.
 */
export function flagObjection(
  flag: string,
  value: string,
  run: { readonly code: number; readonly stderr: string }
): string | undefined {
  const complaint = stripAnsi(run.stderr)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes(flag) && line.includes(value));
  if (complaint) return complaint;
  if (run.code !== 0) return `exit ${run.code}`;
  return undefined;
}

interface StubState {
  /** Paths the binary asked the stub endpoint for, for the failure report. */
  readonly paths: string[];
  /** Skill the stub's model loads before it answers, when set. */
  loadSkill?: string;
}

function sse(events: readonly { event: string; data: unknown }[]): string {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/**
 * Just enough of `POST /v1/messages` for one streamed text turn, preceded by
 * one `Skill` tool call when `state.loadSkill` is set. Usage numbers are
 * non-zero on purpose: the probe asserts the parent can still account tokens
 * from this flag combination.
 */
function startStubAnthropic(state: StubState) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      state.paths.push(`${req.method} ${pathname}`);
      if (!pathname.endsWith("/v1/messages")) return new Response("{}", { headers: { "content-type": "text/plain" } });
      const message = {
        id: "msg_jumi_probe",
        type: "message",
        role: "assistant",
        model: PROBE_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      };
      // The skill is asked for once: the request that carries its tool result
      // gets the text turn.
      const body = state.loadSkill ? await req.text() : "";
      const callSkill = state.loadSkill !== undefined && !body.includes('"tool_result"');
      const block = callSkill
        ? { type: "tool_use", id: "toolu_jumi_probe", name: "Skill", input: {} }
        : { type: "text", text: "" };
      const delta = callSkill
        ? { type: "input_json_delta", partial_json: JSON.stringify({ skill: state.loadSkill }) }
        : { type: "text_delta", text: PROBE_MARKER };
      return new Response(
        sse([
          { event: "message_start", data: { type: "message_start", message } },
          { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: block } },
          { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta } },
          { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: callSkill ? "tool_use" : "end_turn", stop_sequence: null },
              usage: { output_tokens: 7 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]),
        { headers: { "content-type": "text/event-stream" } }
      );
    },
  });
}

/** One span POST the vendored hook plugin made, as the fake Phoenix saw it. */
export interface CapturedSpan {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly jobId: string;
}

/**
 * Stands in for the in-cluster Phoenix. The plugin POSTs
 * `<base>/v1/projects/<project>/spans`; everything about that path, and the
 * attributes on the span, is what `judgeTracingPlugin` reads back.
 */
function startStubPhoenix(spans: CapturedSpan[]) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      try {
        const body = (await req.json()) as {
          data?: { name?: string; span_kind?: string; attributes?: Record<string, unknown> }[];
        };
        for (const span of body.data ?? []) {
          spans.push({
            path,
            name: String(span.name ?? ""),
            kind: String(span.span_kind ?? ""),
            jobId: String(span.attributes?.job_id ?? ""),
          });
        }
      } catch {
        spans.push({ path, name: "<unparseable body>", kind: "", jobId: "" });
      }
      return Response.json({ total_received: 1, total_queued: 1 }, { status: 202 });
    },
  });
}

/**
 * The plugin loaded and traced this run. Deliberately not fail-open: in
 * production a silent non-load is the whole failure this probe exists to catch,
 * and here the destination is a server in this process, so "no span" can only
 * mean the hooks never ran.
 */
export function judgeTracingPlugin(project: string, spans: readonly CapturedSpan[]): CaseResult {
  const name = "--plugin-dir actually loads: the run POSTs a span to Phoenix";
  const wantPath = `/v1/projects/${project}/spans`;
  const mine = spans.filter((span) => span.path === wantPath && span.jobId === PROBE_JOB_ID);
  if (mine.length === 0) {
    const seen = spans.map((span) => `${span.path} ${span.name} job_id=${span.jobId || "<none>"}`).join("; ");
    return {
      name,
      ok: false,
      observed: `no span at ${wantPath} with job_id=${PROBE_JOB_ID}; saw ${seen || "nothing"}`,
    };
  }
  return { name, ok: true, observed: `${mine.length} span(s) at ${wantPath}: ${mine.map((s) => s.name).join(", ")}` };
}

/** The inline shell forms whose marker file under `marker` exists. */
async function shellFormsRan(marker: string): Promise<string[]> {
  const ran: string[] = [];
  for (const form of PROBE_SHELL_FORMS) if (await Bun.file(`${marker}-${form}`).exists()) ran.push(form);
  return ran;
}

interface ProbeSkillCommands {
  /** Created by the `Stop` hook in the frontmatter. */
  readonly hookMarker: string;
  /** Prefix of the files the two inline shell forms in the body create. */
  readonly shellMarker: string;
  /**
   * Also put `---` and the inline form in the description. The binary ends
   * frontmatter at the first `---` it meets, so a staged copy that wrote the
   * description back as it came would hand the rest over as body, and run it.
   */
  readonly inDescription?: boolean;
}

/**
 * `Stop`, not `SessionStart`: the binary runs a loaded skill's frontmatter
 * `Stop` hook and never its `SessionStart` one.
 */
function probeSkill(name: string, commands?: ProbeSkillCommands): string {
  const extra = commands?.inDescription ? ` --- !\`touch ${commands.shellMarker}-inline\`` : "";
  const head = `---\nname: ${name}\ndescription: "Jumi claude flag probe skill${extra}"\n`;
  if (!commands) return `${head}---\nProbe skill body.\n`;
  const hooks = `hooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: "touch ${commands.hookMarker}"\n`;
  const marker = commands.shellMarker;
  return `${head}${hooks}---\nProbe skill body. !\`touch ${marker}-inline\`\n\n\`\`\`!\ntouch ${marker}-fence\n\`\`\`\n`;
}

interface SkillProbe {
  /** Created by the `SessionStart` hook in the checkout's `.claude/settings.json`. */
  readonly settingsMarker: string;
  /** Created by the `Stop` hook in the checkout skill's frontmatter. */
  readonly skillMarker: string;
  /** Created by that same frontmatter hook in the unstaged copy. */
  readonly unstagedMarker: string;
  /** Prefix of the files the checkout skill's inline shell creates. */
  readonly skillShellMarker: string;
  /** The same prefix for the unstaged copy. */
  readonly unstagedShellMarker: string;
  /** The checkout skill as a plain plugin, frontmatter untouched. */
  readonly unstagedPlugin: string;
}

/**
 * A fleet skill in HOME, and a checkout that carries a skill *and* commands: a
 * hook in `.claude/settings.json`, a hook in the skill's own frontmatter, and
 * inline shell in the skill's body, each with its own marker. Beside them,
 * outside the checkout, the same skill as a plugin `stageClaudeCheckoutSkills`
 * never touched.
 */
async function seedSkillProbe(home: string, workdir: string): Promise<SkillProbe> {
  const probe = {
    settingsMarker: join(home, PROBE_SETTINGS_HOOK_MARKER),
    skillMarker: join(home, PROBE_SKILL_HOOK_MARKER),
    unstagedMarker: join(home, PROBE_UNSTAGED_HOOK_MARKER),
    skillShellMarker: join(home, PROBE_SKILL_SHELL_MARKER),
    unstagedShellMarker: join(home, PROBE_UNSTAGED_SHELL_MARKER),
    unstagedPlugin: join(home, "unstaged-checkout-skills"),
  };
  await mkdir(join(home, ".claude", "skills", PROBE_FLEET_SKILL), { recursive: true });
  await writeFile(join(home, ".claude", "skills", PROBE_FLEET_SKILL, "SKILL.md"), probeSkill(PROBE_FLEET_SKILL));
  await mkdir(join(workdir, ".claude", "skills", PROBE_CHECKOUT_SKILL), { recursive: true });
  await writeFile(
    join(workdir, ".claude", "skills", PROBE_CHECKOUT_SKILL, "SKILL.md"),
    probeSkill(PROBE_CHECKOUT_SKILL, {
      hookMarker: probe.skillMarker,
      shellMarker: probe.skillShellMarker,
      inDescription: true,
    })
  );
  await writeFile(
    join(workdir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${probe.settingsMarker}` }] }] },
    })
  );
  await mkdir(join(probe.unstagedPlugin, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(probe.unstagedPlugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: CLAUDE_CHECKOUT_SKILLS_PLUGIN, description: "Jumi claude flag probe control" })
  );
  await mkdir(join(probe.unstagedPlugin, "skills", PROBE_CHECKOUT_SKILL), { recursive: true });
  await writeFile(
    join(probe.unstagedPlugin, "skills", PROBE_CHECKOUT_SKILL, "SKILL.md"),
    probeSkill(PROBE_CHECKOUT_SKILL, { hookMarker: probe.unstagedMarker, shellMarker: probe.unstagedShellMarker })
  );
  return probe;
}

/** The checkout skill, by the name the model loads it under. */
export const PROBE_CHECKOUT_SKILL_COMMAND = `${CLAUDE_CHECKOUT_SKILLS_PLUGIN}:${PROBE_CHECKOUT_SKILL}`;

/** The `Skill` tool reported it loaded the checkout skill. */
function checkoutSkillLoaded(events: readonly Record<string, unknown>[]): boolean {
  return events.some((event) => {
    const result = event.tool_use_result as { success?: unknown; commandName?: unknown } | undefined;
    return event.type === "user" && result?.success === true && result.commandName === PROBE_CHECKOUT_SKILL_COMMAND;
  });
}

export interface CheckoutHooksRan {
  /** The `SessionStart` hook in the checkout's `.claude/settings.json`. */
  readonly settings: boolean;
  /** The `Stop` hook in the checkout skill's frontmatter. */
  readonly skill: boolean;
  /** Inline shell forms in the checkout skill's body that ran. */
  readonly shell: readonly string[];
}

/**
 * Both skill sources reach the model, the checkout skill loads, and none of
 * the checkout's commands runs. Judged on the production run.
 */
export function judgeSkills(run: RunResult, hooks: CheckoutHooksRan): CaseResult[] {
  const events = jsonLines(run.stdout);
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const skills = Array.isArray(init?.skills) ? init.skills.map((skill) => String(skill)) : [];
  const checkout = PROBE_CHECKOUT_SKILL_COMMAND;
  const loaded = checkoutSkillLoaded(events);
  return [
    {
      name: "a fleet skill in ~/.claude/skills is discoverable",
      ok: skills.includes(PROBE_FLEET_SKILL),
      observed: skills.includes(PROBE_FLEET_SKILL) ? PROBE_FLEET_SKILL : `skills: ${skills.join(", ") || "<none>"}`,
    },
    {
      name: "a checkout .claude/skills skill is discoverable through the staged plugin",
      ok: skills.includes(checkout),
      observed: skills.includes(checkout) ? checkout : `skills: ${skills.join(", ") || "<none>"}`,
    },
    {
      name: "the Skill tool loads the staged checkout skill",
      ok: loaded,
      observed: loaded ? `${checkout} loaded` : "no successful Skill tool result for it",
    },
    {
      name: "the checkout's .claude/settings.json hook does not run",
      ok: !hooks.settings,
      observed: hooks.settings ? `${PROBE_SETTINGS_HOOK_MARKER} was created` : "no hook marker",
    },
    {
      name: "the loaded checkout skill's frontmatter hook does not run",
      ok: !hooks.skill,
      observed: hooks.skill ? `${PROBE_SKILL_HOOK_MARKER} was created` : "no hook marker",
    },
    {
      name: "the loaded checkout skill's inline shell does not run",
      ok: hooks.shell.length === 0,
      observed: hooks.shell.length > 0 ? `ran: ${hooks.shell.join(", ")}` : "no shell marker",
    },
  ];
}

/**
 * The control for the two checks above: the same skill, loaded from a plugin
 * whose `SKILL.md` was not rewritten, runs its `Stop` hook and both inline
 * shell forms. If this binary stopped running one of them, "does not run"
 * above proves nothing about the staging. `shellRan` is the forms that ran.
 */
export function judgeUnstagedSkill(run: RunResult, hookRan: boolean, shellRan: readonly string[]): CaseResult[] {
  const hook = "an unstaged skill's frontmatter hook does run (so staging it away means something)";
  const shell = "an unstaged skill's inline shell does run (so staging it away means something)";
  const both = (observed: string) => [hook, shell].map((name) => ({ name, ok: false, observed }));
  if (run.timedOut) return both(`claude hung, killed after ${RUN_TIMEOUT_MS}ms`);
  if (!checkoutSkillLoaded(jsonLines(run.stdout))) {
    return both(`the skill did not load (exit ${run.code}), so its commands had no chance to run`);
  }
  const missing = PROBE_SHELL_FORMS.filter((form) => !shellRan.includes(form));
  return [
    {
      name: hook,
      ok: hookRan,
      observed: hookRan
        ? `${PROBE_UNSTAGED_HOOK_MARKER} was created`
        : "no hook marker — this binary no longer runs the frontmatter Stop hook the probe plants",
    },
    {
      name: shell,
      ok: missing.length === 0,
      observed:
        missing.length === 0
          ? `ran: ${shellRan.join(", ")}`
          : `this binary no longer runs the ${missing.join(" and ")} shell the probe plants`,
    },
  ];
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Deliberately not `process.env`: no OAuth token, no forge secrets, and a
 * throwaway `HOME`, so the probe can neither bill the operator nor read the
 * image's own Claude state.
 */
async function runClaudeArgv(
  argv: readonly string[],
  origin: string,
  home: string,
  workdir: string,
  extraEnv: Record<string, string> = {}
) {
  const proc = Bun.spawn([...argv], {
    cwd: workdir,
    stdin: new Response(`Reply with exactly ${PROBE_MARKER} and nothing else.`),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: home,
      ANTHROPIC_BASE_URL: origin,
      ANTHROPIC_API_KEY: "jumi-claude-flag-probe",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ...extraEnv,
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, RUN_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr, timedOut } satisfies RunResult;
  } finally {
    clearTimeout(timer);
  }
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        events.push(parsed as Record<string, unknown>);
    } catch {
      // Not stream-json; the shape assertions below report the miss.
    }
  }
  return events;
}

export interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly observed: string;
}

/** Every production flag value, as the binary reports it back after accepting it. */
function judgeProductionRun(argv: readonly string[], run: RunResult): CaseResult[] {
  const name = "production argv is accepted by the installed binary";
  if (run.timedOut) return [{ name, ok: false, observed: `claude hung, killed after ${RUN_TIMEOUT_MS}ms` }];
  if (run.code !== 0) {
    const detail = `${run.stderr}\n${run.stdout}`.trim().slice(-600);
    return [{ name, ok: false, observed: `claude exited ${run.code}: ${detail}` }];
  }

  const events = jsonLines(run.stdout);
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const parser = new ClaudeStreamParser();
  parser.push(new TextEncoder().encode(run.stdout));
  parser.end();

  // A warning is exit 0 with the flag silently dropped, which is the failure
  // mode `--effort` has: the run looks healthy and is quietly not the run Jumi
  // asked for.
  const warning = droppedFlagWarning(argv, run.stderr);
  const tools = Array.isArray(init?.tools) ? init.tools.map((tool) => String(tool)) : [];
  const missingTools = CLAUDE_ALLOWED_TOOLS.split(",").filter((tool) => !tools.includes(tool));

  return [
    { name, ok: true, observed: `exit 0 against the stub endpoint` },
    {
      name: "binary reports it is running the pinned permission mode",
      ok: init?.permissionMode === CLAUDE_PERMISSION_MODE,
      observed: `permissionMode=${String(init?.permissionMode)} want ${CLAUDE_PERMISSION_MODE}`,
    },
    {
      name: "binary reports it is running the requested model",
      ok: init?.model === PROBE_MODEL,
      observed: `model=${String(init?.model)} want ${PROBE_MODEL}`,
    },
    {
      name: "no production flag was warned about and dropped",
      ok: warning === undefined,
      observed: warning ?? "clean stderr",
    },
    {
      name: "--allowedTools names tools this binary has",
      ok: missingTools.length === 0,
      observed: missingTools.length === 0 ? "all present" : `binary has no ${missingTools.join(", ")}`,
    },
    {
      name: "stream-json still carries the parent's output text",
      ok: parser.text().includes(PROBE_MARKER),
      observed: parser.text().slice(0, 200) || "<empty>",
    },
    {
      name: "stream-json still carries token usage for the parent's accounting",
      ok: (parser.usage()?.size ?? 0) > 0,
      observed: `models with usage: ${parser.usage()?.size ?? 0}`,
    },
  ];
}

export function judgeNegativeRun(pinned: PinnedFlagValue, bad: string, run: RunResult): CaseResult {
  const name = `${pinned.flag} ${bad} is refused (so pinning ${pinned.value} means something)`;
  if (run.timedOut) return { name, ok: false, observed: `claude hung, killed after ${RUN_TIMEOUT_MS}ms` };
  const objection = flagObjection(pinned.flag, bad, run);
  if (!objection) {
    return { name, ok: false, observed: `accepted silently (exit ${run.code}) — this binary cannot reject the value` };
  }
  if (run.stdout.includes(PROBE_MARKER) && run.code === 0 && pinned.flag !== "--effort") {
    return { name, ok: false, observed: `complained but still ran the turn: ${objection}` };
  }
  if (pinned.flag === "--effort") {
    // `--effort` is the only flag whose rejection is a *warning*, so the
    // positive run's sole defence against a silent downgrade is
    // `droppedFlagWarning` — and its matcher is anchored (`/^(warning|error)\b/i`)
    // while `flagObjection` is not. Demand the anchored matcher here too, or a
    // release that prefixes the line (`⚠ Warning: …`) would keep this control
    // green while "no production flag was warned about and dropped" quietly
    // stopped detecting anything.
    //
    // Only `--effort` is passed as the argv, and the line must name `bad`:
    // otherwise any anchored line mentioning some *other* flag we pass
    // (`--model`, `--verbose`, …) would satisfy this while the `--effort`
    // warning itself went unseen, which is the vacuity this control exists to
    // rule out.
    const anchored = droppedFlagWarning([pinned.flag], run.stderr);
    if (anchored === undefined || !anchored.includes(bad)) {
      return {
        name,
        ok: false,
        observed: `objected (${objection}) but droppedFlagWarning saw no anchored line naming ${pinned.flag} ${bad} (${anchored ?? "no match"}) — the positive run's dropped-flag detector is blind`,
      };
    }
    return { name, ok: true, observed: anchored };
  }
  return { name, ok: true, observed: objection };
}

/**
 * One positive run per `--effort` level the binary advertises. A level it no
 * longer knows is a warning plus a default-effort run, not an exit, so this is
 * the only thing standing between an operator's `xhigh`/`max` runner and a
 * silently downgraded job after a Claude upgrade.
 */
export function judgeEffortLevel(level: string, argv: readonly string[], run: RunResult): CaseResult {
  const name = `--effort ${level} is accepted, not warned about and dropped`;
  if (run.timedOut) return { name, ok: false, observed: `claude hung, killed after ${RUN_TIMEOUT_MS}ms` };
  if (run.code !== 0) {
    return { name, ok: false, observed: `claude exited ${run.code}: ${run.stderr.trim().slice(-300)}` };
  }
  const warning = droppedFlagWarning(argv, run.stderr);
  return { name, ok: warning === undefined, observed: warning ?? "exit 0, clean stderr" };
}

async function main(): Promise<number> {
  const state: StubState = { paths: [] };
  const server = startStubAnthropic(state);
  const origin = `http://127.0.0.1:${server.port}`;
  const spans: CapturedSpan[] = [];
  const phoenix = startStubPhoenix(spans);
  const home = await mkdtemp(join(tmpdir(), "jumi-claude-probe-home-"));
  const workdir = await mkdtemp(join(tmpdir(), "jumi-claude-probe-work-"));
  const results: CaseResult[] = [];

  try {
    // Homelab always has this env (that is the whole point of tracing). Image
    // jobs do not, so without it `claudeArgv()` omits `--plugin-dir` and the
    // probe never sees the one new production flag. Pointing it at the stub
    // above — never at whatever an operator exported — is also what lets the
    // production run below be judged on a span that actually arrived.
    process.env.PHOENIX_OTLP_ENDPOINT = `http://127.0.0.1:${phoenix.port}`;
    const skillProbe = await seedSkillProbe(home, workdir);
    const checkoutSkills = await stageClaudeCheckoutSkills(workdir, join(home, "checkout-skills"), console.error);
    const argv = claudeArgv({ model: PROBE_MODEL, effort: PROBE_EFFORT, workdir }, checkoutSkills);
    const pinned = pinnedFlagValues(argv);
    // The same env `runClaude` merges into a production spawn, so the plugin is
    // configured here exactly as it is in the homelab.
    const tracing = claudeTracingEnv({
      kind: "review",
      owner: "kirmanak",
      repo: "jumi",
      sha: "0".repeat(40),
      jobId: PROBE_JOB_ID,
    });
    console.log(`argv under test: ${argv.join(" ")}`);
    console.log(`pinned values: ${pinned.map(({ flag, value }) => `${flag}=${value}`).join(" ")}`);
    const traced = argv.includes("--plugin-dir");
    if (!traced) {
      results.push({
        name: "production argv still carries --plugin-dir",
        ok: false,
        observed: "missing --plugin-dir (plugin path missing from the image, or tracing did not enable)",
      });
    }
    if (pinned.length !== CLAUDE_REJECTABLE_FLAGS.length) {
      results.push({
        name: "production argv still carries every rejectable flag",
        ok: false,
        observed: `pinned ${pinned.map((p) => p.flag).join(", ") || "nothing"} of ${CLAUDE_REJECTABLE_FLAGS.join(", ")}`,
      });
    }

    // Only the production run and the unstaged control have the model load the
    // checkout skill; every later run is the plain one-turn answer.
    state.loadSkill = PROBE_CHECKOUT_SKILL_COMMAND;
    const production = await runClaudeArgv(argv, origin, home, workdir, tracing);
    results.push(...judgeProductionRun(argv, production));
    results.push(
      ...judgeSkills(production, {
        settings: await Bun.file(skillProbe.settingsMarker).exists(),
        skill: await Bun.file(skillProbe.skillMarker).exists(),
        shell: await shellFormsRan(skillProbe.skillShellMarker),
      })
    );
    // Only the production run is traced; the effort and negative-control runs
    // below keep the plain env, so the spans collected are unambiguously that
    // one run's.
    if (traced) results.push(judgeTracingPlugin(tracing.ARIZE_PROJECT_NAME ?? "", spans));

    const unstagedArgv = claudeArgv({ model: PROBE_MODEL, effort: PROBE_EFFORT, workdir }, skillProbe.unstagedPlugin);
    const unstaged = await runClaudeArgv(unstagedArgv, origin, home, workdir);
    results.push(
      ...judgeUnstagedSkill(
        unstaged,
        await Bun.file(skillProbe.unstagedMarker).exists(),
        await shellFormsRan(skillProbe.unstagedShellMarker)
      )
    );
    state.loadSkill = undefined;

    // Every other level an operator may have put in `JUMI_RUNNERS_FILE`.
    for (const level of CLAUDE_EFFORT_LEVELS.filter((candidate) => candidate !== PROBE_EFFORT)) {
      const levelArgv = withFlagValue(argv, "--effort", level);
      results.push(judgeEffortLevel(level, levelArgv, await runClaudeArgv(levelArgv, origin, home, workdir)));
    }

    for (const entry of pinned) {
      const bad = nonsenseValue(entry.flag);
      const swapped = withFlagValue(argv, entry.flag, bad);
      const run = await runClaudeArgv(swapped, origin, home, workdir);
      results.push(judgeNegativeRun(entry, bad, run));
    }
  } finally {
    server.stop(true);
    phoenix.stop(true);
    await rm(home, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }

  for (const { name, ok, observed } of results) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${observed}`);
  }
  const failures = results.filter((result) => !result.ok).length;
  if (failures > 0) {
    console.error(`stub endpoint saw: ${state.paths.join(", ") || "no requests"}`);
    console.error(`claude flag probe: ${failures}/${results.length} check(s) failed against the installed binary`);
    return 1;
  }
  console.log(`claude flag probe: ${results.length}/${results.length} checks pass against the installed claude binary`);
  return 0;
}

if (import.meta.main) process.exit(await main());
