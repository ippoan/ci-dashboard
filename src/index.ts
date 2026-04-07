import { handleWebhook } from "./webhook";
import { handleStatus, getAllStatuses } from "./status";
import { handleDashboard } from "./dashboard";
import { handleTagRelease } from "./tag-release";

export { CIDashboardHub } from "./hub";

export interface Env {
  CI_STATUS: KVNamespace;
  WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  CI_HUB: DurableObjectNamespace;
}

function getHub(env: Env): DurableObjectStub {
  const id = env.CI_HUB.idFromName("singleton");
  return env.CI_HUB.get(id);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    switch (url.pathname) {
      case "/webhook":
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return handleWebhook(request, env, getHub(env));

      case "/ws":
        return getHub(env).fetch(request);

      case "/status":
        return handleStatus(env);

      case "/api/tag-release":
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return handleTagRelease(request, env);

      case "/api/dismiss": {
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        const { run_id } = await request.json<{ run_id: number }>();
        await env.CI_STATUS.delete(`run:${run_id}`);
        const statuses = await getAllStatuses(env);
        const hub = getHub(env);
        await hub.fetch(new Request("http://hub/broadcast", {
          method: "POST",
          body: JSON.stringify(statuses),
        }));
        return Response.json({ ok: true });
      }

      case "/":
        return handleDashboard();

      default:
        return new Response("Not Found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
