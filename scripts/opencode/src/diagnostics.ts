import { stat } from "node:fs/promises";
import { join } from "node:path";

export interface MemorySample {
  rssBytes: number | null;
  cgroupBytes: number | null;
  atMs: number;
}

export interface MemoryPeakState {
  startedAtMs: number;
  start: MemorySample;
  peakRssBytes: number | null;
  peakCgroupBytes: number | null;
  samples: number;
  stop: () => void;
}

function parseKbLine(text: string, key: string): number | null {
  const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
  if (!match) return null;
  return Number(match[1]) * 1024;
}

/** Best-effort process RSS from /proc (Linux). */
async function readProcessRssBytes(pid: number): Promise<number | null> {
  try {
    const text = await Bun.file(`/proc/${pid}/status`).text();
    return parseKbLine(text, "VmRSS");
  } catch {
    return null;
  }
}

/** Best-effort cgroup memory.current (cgroup v2) or memory.usage_in_bytes (v1). */
async function readCgroupMemoryBytes(): Promise<number | null> {
  const candidates = ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"];
  for (const path of candidates) {
    try {
      const text = (await Bun.file(path).text()).trim();
      const value = Number(text);
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      // try next
    }
  }
  return null;
}

export async function sampleMemory(pid?: number): Promise<MemorySample> {
  const [rssBytes, cgroupBytes] = await Promise.all([
    pid !== undefined ? readProcessRssBytes(pid) : Promise.resolve(null),
    readCgroupMemoryBytes(),
  ]);
  return { rssBytes, cgroupBytes, atMs: Date.now() };
}

/**
 * Poll RSS/cgroup while a child runs. Cheap (/proc reads); intervalMs default 5s.
 * onSample fires for the initial sample and every interval so OOM kills still leave a trail.
 */
export function trackMemoryPeak(
  pid: number,
  intervalMs = 5_000,
  onSample?: (sample: MemorySample, peaks: { rss: number | null; cgroup: number | null; n: number }) => void
): MemoryPeakState {
  const state: MemoryPeakState = {
    startedAtMs: Date.now(),
    start: { rssBytes: null, cgroupBytes: null, atMs: Date.now() },
    peakRssBytes: null,
    peakCgroupBytes: null,
    samples: 0,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
  let stopped = false;

  const consider = (sample: MemorySample, isStart = false) => {
    state.samples += 1;
    if (isStart) state.start = sample;
    if (sample.rssBytes !== null) {
      state.peakRssBytes =
        state.peakRssBytes === null ? sample.rssBytes : Math.max(state.peakRssBytes, sample.rssBytes);
    }
    if (sample.cgroupBytes !== null) {
      state.peakCgroupBytes =
        state.peakCgroupBytes === null ? sample.cgroupBytes : Math.max(state.peakCgroupBytes, sample.cgroupBytes);
    }
    onSample?.(sample, { rss: state.peakRssBytes, cgroup: state.peakCgroupBytes, n: state.samples });
  };

  void sampleMemory(pid).then((sample) => {
    if (!stopped) consider(sample, true);
  });

  const timer = setInterval(() => {
    void sampleMemory(pid).then((sample) => {
      if (!stopped) consider(sample);
    });
  }, intervalMs);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  return state;
}

export async function finalizeMemoryTracker(tracker: MemoryPeakState, pid: number): Promise<MemorySample> {
  tracker.stop();
  const finalSample = await sampleMemory(pid);
  if (finalSample.rssBytes !== null) {
    tracker.peakRssBytes =
      tracker.peakRssBytes === null ? finalSample.rssBytes : Math.max(tracker.peakRssBytes, finalSample.rssBytes);
  }
  if (finalSample.cgroupBytes !== null) {
    tracker.peakCgroupBytes =
      tracker.peakCgroupBytes === null
        ? finalSample.cgroupBytes
        : Math.max(tracker.peakCgroupBytes, finalSample.cgroupBytes);
  }
  tracker.samples += 1;
  return finalSample;
}

export async function pathSizeBytes(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** Default OpenCode DB under HOME (matches OpenCode Path.data layout). */
export function defaultOpenCodeDbPath(home: string): string {
  return join(home, ".local", "share", "opencode", "opencode.db");
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "n/a";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 1 : 2)}${units[unit]}`;
}

/** One-line structured log for Loki/grep. Keep values flat and secret-free. */
export function logDiagnostic(
  log: (message: string) => void,
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>
): void {
  const parts = [`event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null) {
      parts.push(`${key}=null`);
      continue;
    }
    if (typeof value === "string") {
      const safe = value.replace(/[\s=]+/g, "_").slice(0, 240);
      parts.push(`${key}=${safe}`);
      continue;
    }
    parts.push(`${key}=${value}`);
  }
  log(`[diag] ${parts.join(" ")}`);
}
