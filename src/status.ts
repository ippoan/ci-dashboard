import type { Env } from "./index";
import type { CIStatus } from "./webhook";

export async function getAllStatuses(env: Env): Promise<CIStatus[]> {
  const list = await env.CI_STATUS.list({ prefix: "run:" });
  const all: CIStatus[] = [];

  for (const key of list.keys) {
    const value = await env.CI_STATUS.get(key.name);
    if (value) {
      all.push(JSON.parse(value) as CIStatus);
    }
  }

  // Keep only the latest per repo per status group
  const latestInProgress = new Map<string, CIStatus>();
  const latestCompleted = new Map<string, CIStatus>();

  for (const s of all) {
    const map = s.status === "completed" ? latestCompleted : latestInProgress;
    const existing = map.get(s.repo);
    if (!existing || s.updated_at > existing.updated_at) {
      map.set(s.repo, s);
    }
  }

  // Hide completed when in_progress exists for the same repo
  for (const repo of latestInProgress.keys()) {
    latestCompleted.delete(repo);
  }
  const result = [...latestInProgress.values(), ...latestCompleted.values()];

  // Sort: in_progress first, then by updated_at desc
  result.sort((a, b) => {
    if (a.status !== "completed" && b.status === "completed") return -1;
    if (a.status === "completed" && b.status !== "completed") return 1;
    return b.updated_at.localeCompare(a.updated_at);
  });

  return result;
}

export async function handleStatus(env: Env): Promise<Response> {
  const statuses = await getAllStatuses(env);
  return new Response(JSON.stringify(statuses, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
