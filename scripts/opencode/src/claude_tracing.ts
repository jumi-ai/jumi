/**
 * Phoenix tracing for `type: claude` runs.
 *
 * An OpenCode child leaves a session sqlite the parent converts and exports
 * after the run (`phoenix.ts`). A Claude child leaves no such database, so the
 * spans have to come from the child itself: the parent passes an image-local
 * Claude Code hook plugin that posts OpenInference spans to Phoenix.
 *
 * The plugin is passed per spawn with `--plugin-dir`, never installed into the
 * checkout or discovered from it. Nothing here is installed at run time either
 * — the plugin is vendored into the image.
 *
 * Everything is fail-open. No endpoint, an endpoint that is not an in-cluster
 * URL, or a missing plugin directory means the child runs untraced; a Phoenix
 * that is down or slow (2s per POST, then skip after 3 failures) is the
 * plugin's problem and never the job's.
 */

import { existsSync } from "node:fs";
import { agentInstance } from "./agent_instance.ts";
import type { TraceContext } from "./engine.ts";
import { PUBLIC_PHOENIX_HOST } from "./phoenix.ts";

/** Where the Dockerfile vendors the plugin. Not an operator-facing knob. */
export const CLAUDE_TRACING_PLUGIN_DIR = "/app/claude-plugins/claude-code-tracing";

let pluginDirOverride: string | undefined;

export function setClaudeTracingPluginDirForTests(dir: string | undefined): void {
  pluginDirOverride = dir;
}

/**
 * Base URL the plugin appends its own REST path to.
 *
 * `PHOENIX_OTLP_ENDPOINT` is stored for the OpenCode exporter, which posts OTLP
 * protobuf to `<base>/v1/traces` and therefore tolerates that path being part
 * of the configured value. The plugin builds `<base>/v1/projects/<name>/spans`
 * instead, so copying the stored string verbatim would POST to
 * `…/v1/traces/v1/projects/…`. Strip the OTLP path rather than trusting the
 * operator to have stored a bare host:port.
 *
 * The public Phoenix hostname is refused here for the same reason the OpenCode
 * exporter refuses it: ingest is the in-cluster service, never the ingress.
 */
export function phoenixPluginEndpoint(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === PUBLIC_PHOENIX_HOST) return undefined;
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1\/traces$/, "");
  return `${url.origin}${path}`;
}

/** The plugin directory to pass, or undefined when this spawn runs untraced. */
export function claudeTracingPluginDir(): string | undefined {
  if (!phoenixPluginEndpoint(process.env.PHOENIX_OTLP_ENDPOINT)) return undefined;
  const dir = pluginDirOverride ?? CLAUDE_TRACING_PLUGIN_DIR;
  return existsSync(dir) ? dir : undefined;
}

/**
 * Env the plugin's hooks read. Empty when this spawn runs untraced.
 *
 * `ARIZE_PROJECT_NAME` is the factory source, not a `claude-code` harness dump:
 * a Claude review lands in the same Phoenix project as that factory's OpenCode
 * reviews. The `JUMI_*` keys become span attributes, so a job lookup finds a
 * Claude run under the same `job_id` / `session.id` as an OpenCode run.
 */
export function claudeTracingEnv(trace?: TraceContext): Record<string, string> {
  const endpoint = phoenixPluginEndpoint(process.env.PHOENIX_OTLP_ENDPOINT);
  if (!endpoint || !claudeTracingPluginDir()) return {};
  const agent = agentInstance();
  const env: Record<string, string> = {
    PHOENIX_ENDPOINT: endpoint,
    ARIZE_PROJECT_NAME: agent,
    ARIZE_TRACE_ENABLED: "true",
    // Prompt text stays out of Phoenix: the parent injects task, feedback and
    // CI prose into it. Tool names, arguments and results still ride along, as
    // they do on OpenCode TOOL spans.
    ARIZE_LOG_PROMPTS: "false",
    // Same-cluster ClusterIP; phoenixPluginEndpoint already refuses anything
    // else. 2s bounds a black hole, and the hooks skip further POSTs after a
    // few failures so this cannot become 2s × tool-calls.
    ARIZE_HTTP_TIMEOUT: "2",
    JUMI_AGENT_INSTANCE: agent,
  };
  if (trace) {
    env.JUMI_TRACE_KIND = trace.kind;
    env.JUMI_OWNER = trace.owner;
    env.JUMI_REPO = trace.repo;
    if (trace.sha) env.JUMI_SHA = trace.sha;
    if (trace.jobId) env.JUMI_JOB_ID = trace.jobId;
  }
  return env;
}
