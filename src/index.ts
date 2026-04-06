import { handleWebhook } from "./webhook";
import { handleStream } from "./stream";
import { handleStatus } from "./status";
import { handleDashboard } from "./dashboard";

export interface Env {
  CI_STATUS: KVNamespace;
  WEBHOOK_SECRET: string;
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
        return handleWebhook(request, env);

      case "/stream":
        return handleStream(request, env, ctx);

      case "/status":
        return handleStatus(env);

      case "/":
        return handleDashboard();

      default:
        return new Response("Not Found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
