import { appendFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueApi } from "../src/gitea_issues.ts";
import type { ReviewApi } from "../src/review.ts";
import { MemoryReviewJobStore, WORKER_JOB_KINDS } from "../src/review_jobs.ts";
import { processEngineTick } from "../src/server.ts";
import { installProcessShutdown } from "../src/shutdown.ts";
import { processWorkerTick } from "../src/worker.ts";
import { makeReviewApi } from "./fakes/forge.ts";
import {
  makeComment,
  makeConfig,
  makeFile,
  makeIssue,
  makeIssueJob,
  makeJob,
  makePR,
  makeRepo,
  makeWorkerConfig,
} from "./fixtures.ts";
import { frozenGit } from "./harness/git.ts";

const role = process.argv[2];
const statusPath = process.argv[3];
if ((role !== "worker" && role !== "engine") || !statusPath) {
  console.error("usage: shutdown_signal_harness.ts worker|engine <status>");
  process.exit(2);
}

function report(line: string) {
  appendFileSync(statusPath, `${line}\n`);
}

function spawnStubbornChild() {
  return Bun.spawn(["bash", "-c", "trap '' TERM INT; sleep 300"], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

type ProbeApi = {
  comments: string[];
  statuses: Array<{ state: string }>;
};

function shutdownReviewApi(): ReviewApi & ProbeApi {
  const comments: string[] = [];
  const statuses: Array<{ state: string }> = [];
  const fake = makeReviewApi({
    getPRFiles: async () => [makeFile()],
    createIssueComment: async (_owner, _repo, _index, body) => {
      comments.push(body);
      return makeComment({ id: comments.length, body });
    },
    updateIssueComment: async (_owner, _repo, commentId, body) => {
      comments.push(body);
      return makeComment({ id: commentId, body });
    },
    createCommitStatus: async (_owner, _repo, _sha, status) => {
      statuses.push({ state: status.state });
      return status;
    },
    listCommitStatuses: async () => [{ id: 1, context: "build", status: "success" }],
  });
  return Object.assign(fake, { comments, statuses });
}

const store = new MemoryReviewJobStore();
const holder = role === "worker" ? "worker-1" : "engine-1";
const kinds = role === "worker" ? WORKER_JOB_KINDS : undefined;
let reported = false;
const originalRelease = store.releaseLease.bind(store);
const originalShutdownRelease = store.shutdownRelease.bind(store);
const originalExpire = store.expireLease.bind(store);
const workerApi = { comments: [], statuses: [] } as unknown as IssueApi & ProbeApi;
const reviewApi = shutdownReviewApi();
const api: ProbeApi = role === "worker" ? workerApi : reviewApi;
async function reportFreed(id: number, leasedBy: string, how: string) {
  if (reported) return;
  reported = true;
  const row = store.rows.find((item) => item.id === id);
  const sibling = await store.lease("sibling", 60_000, undefined, kinds);
  const failures = api.statuses.filter((status) => status.state === "failure").length;
  report(
    `FREED-${how} attempt=${row?.attempt ?? -1} sibling=${sibling?.leasedBy ?? "none"} comments=${api.comments.length} failures=${failures}`
  );
}
store.releaseLease = async (id, leasedBy) => {
  const ok = await originalRelease(id, leasedBy);
  if (ok && leasedBy === holder) await reportFreed(id, leasedBy, "release");
  return ok;
};
store.shutdownRelease = async (id, leasedBy, now) => {
  const ok = await originalShutdownRelease(id, leasedBy, now);
  if (ok && leasedBy === holder) await reportFreed(id, leasedBy, "release");
  return ok;
};
store.expireLease = async (id, leasedBy) => {
  const ok = await originalExpire(id, leasedBy);
  if (ok && leasedBy === holder) await reportFreed(id, leasedBy, "expire");
  return ok;
};

const shutdown = new AbortController();
installProcessShutdown(shutdown, (message) => {
  console.log(message);
  report(message);
});

const child = spawnStubbornChild();

function abortError(): Error {
  const err = new Error("cancelled");
  err.name = "AbortError";
  return err;
}

async function run(): Promise<void> {
  if (role === "worker") {
    await store.enqueueIssue(makeIssueJob());
    await processWorkerTick(
      store,
      makeWorkerConfig(),
      workerApi,
      holder,
      {
        abortSignal: shutdown.signal,
        implement: async (opts) => {
          await opts.onPid?.(child.pid);
          report(`READY ${child.pid}`);
          // Ordered shutdown: hold the lease while the child is still
          // running. The child ignores SIGTERM, so this hangs past the
          // shutdown abort until the test SIGKILLs the child.
          await child.exited;
          throw abortError();
        },
      },
      (message) => {
        console.log(message);
        report(message);
      }
    );
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), "jumi-shutdown-engine-"));
  await store.enqueue(makeJob());
  await processEngineTick(
    store,
    makeConfig({ role: "engine", workdir: workspace, home: workspace }),
    reviewApi,
    holder,
    {
      abortSignal: shutdown.signal,
      ciRelistDelayMs: 0,
      gitRunner: frozenGit(),
      workspacePreparer: async () => undefined,
      openCodeRunner: async () => {
        report(`READY ${child.pid}`);
        await child.exited;
        throw abortError();
      },
    },
    (message) => {
      console.log(message);
      report(message);
    }
  );
}

run().then(
  () => {
    report("JOB_RETURNED");
  },
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    report(`JOB_FAILED ${message}`);
    console.error(err);
    process.exit(1);
  }
);
