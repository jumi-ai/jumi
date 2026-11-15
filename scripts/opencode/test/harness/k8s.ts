import type { K8sJobObject, K8sPodObject } from "../../src/dispatch.ts";

export interface FakeK8s {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  jobs: Map<string, K8sJobObject & { creationMs: number }>;
  pods: Map<string, K8sPodObject[]>;
  deletes: string[];
  deleteUrls: string[];
  creates: string[];
}

/**
 * Shared fake Kubernetes API. Records every field the three previous copies
 * recorded (`creates`, `deletes`, `deleteUrls`, `pods`) and answers the union
 * of their routes. The 409 body carries both `reason` and `message` with a
 * JSON content type (the strictest previous variant); no test asserts the
 * body, only the status. Unknown routes 404 like the dispatch variants; the
 * `ci_gate` fallback (`200 {}`) was never hit by its tests.
 */
export function fakeK8s(): FakeK8s {
  const jobs = new Map<string, K8sJobObject & { creationMs: number }>();
  const pods = new Map<string, K8sPodObject[]>();
  const deletes: string[] = [];
  const deleteUrls: string[] = [];
  const creates: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/apis/batch/v1/namespaces/") && url.endsWith("/jobs") && method === "POST") {
      const manifest = JSON.parse(String(init?.body ?? "{}")) as K8sJobObject;
      const name = manifest.metadata?.name ?? "";
      creates.push(name);
      if (jobs.has(name)) {
        return new Response(JSON.stringify({ reason: "AlreadyExists", message: `${name} already exists` }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      const nowIso = new Date().toISOString();
      jobs.set(name, {
        ...manifest,
        metadata: { ...(manifest.metadata ?? {}), creationTimestamp: nowIso },
        status: manifest.status ?? {},
        creationMs: Date.now(),
      } as K8sJobObject & { creationMs: number });
      return new Response(JSON.stringify({ metadata: { name } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/apis/batch/v1/namespaces/") && url.includes("/jobs/") && method === "DELETE") {
      const name = decodeURIComponent(url.split("/jobs/")[1]?.split("?")[0] ?? "");
      deletes.push(name);
      deleteUrls.push(url);
      if (!url.includes("propagationPolicy=Background")) {
        return new Response(JSON.stringify({ message: "propagationPolicy required" }), { status: 400 });
      }
      jobs.delete(name);
      pods.delete(name);
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.includes("/apis/batch/v1/namespaces/") && url.endsWith("/jobs") && method === "GET") {
      const items = [...jobs.entries()].map(([name, job]) => ({
        metadata: { name, creationTimestamp: new Date(job.creationMs).toISOString() },
        spec: (job as K8sJobObject).spec,
        status: (job as K8sJobObject).status ?? {},
      }));
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/v1/namespaces/") && url.includes("/pods") && method === "GET") {
      const selector = decodeURIComponent(url.split("labelSelector=")[1] ?? "");
      const jobName = selector.split("job-name=")[1]?.split("&")[0] ?? "";
      const items = selector.includes("job-name=") ? (pods.get(jobName) ?? []) : [];
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
  return { fetchImpl, jobs, pods, deletes, deleteUrls, creates };
}

/** Legacy alias for the three previous `createFakeK8s` copies. */
export const createFakeK8s = fakeK8s;
