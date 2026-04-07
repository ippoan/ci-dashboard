import type { Env } from "./index";
import type { CIStatus } from "./webhook";

export async function getAllStatuses(env: Env): Promise<CIStatus[]> {
  const list = await env.CI_STATUS.list({ prefix: "run:" });
  const values = await Promise.all(
    list.keys.map((key) => env.CI_STATUS.get(key.name))
  );
  const all = values
    .filter((v): v is string => v !== null)
    .map((v) => JSON.parse(v) as CIStatus);

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

  // Drop stale in_progress: if completed is newer, the run already finished
  for (const [repo, ip] of latestInProgress) {
    const completed = latestCompleted.get(repo);
    if (completed && completed.updated_at > ip.updated_at) {
      latestInProgress.delete(repo);
    }
  }

  // Combine: in_progress first, then latest completed per repo
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
