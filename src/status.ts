import type { Env } from "./index";
import type { CIStatus } from "./webhook";

export async function getAllStatuses(env: Env): Promise<CIStatus[]> {
  const list = await env.CI_STATUS.list();
  const statuses: CIStatus[] = [];

  for (const key of list.keys) {
    const value = await env.CI_STATUS.get(key.name);
    if (value) {
      statuses.push(JSON.parse(value) as CIStatus);
    }
  }

  // Sort: in_progress first, then by updated_at desc
  statuses.sort((a, b) => {
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (a.status !== "in_progress" && b.status === "in_progress") return 1;
    return b.updated_at.localeCompare(a.updated_at);
  });

  return statuses;
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
