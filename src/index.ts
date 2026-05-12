import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleWebhook } from "./webhook";
import { handleDashboard } from "./dashboard";
import { handleIssuesPage } from "./issues-page";
import { handleReleasesPage } from "./releases-page";
import { handleReleaseClose } from "./release-close";
import { handleRecheck } from "./recheck";
import { handleTagRelease } from "./tag-release";
import { handleMcpRequest } from "./mcp/server";

export { CIDashboardHub } from "./hub";

export interface Env {
  CI_STATUS: KVNamespace;
  WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  CI_HUB: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

function getHub(env: Env): DurableObjectStub {
  const id = env.CI_HUB.idFromName("singleton");
  return env.CI_HUB.get(id);
}

// Dashboard
app.get("/", () => handleDashboard());

// Open issues (SSR, cross-org)
app.get("/issues", (c) => handleIssuesPage(c.env));

// Release confirmation view (SSR + POST close action)
// See issue #35 + CLAUDE.md `release / close フロー`.
app.get("/releases", (c) => handleReleasesPage(c.req.raw, c.env));
app.post("/api/release-close", (c) => handleReleaseClose(c.req.raw, c.env));

// WebSocket
app.get("/ws", (c) => getHub(c.env).fetch(c.req.raw));

// Webhook
app.post("/webhook", (c) => handleWebhook(c.req.raw, c.env, getHub(c.env)));

// Status
app.get("/status", async (c) => {
  const res = await getHub(c.env).fetch(new Request("http://hub/statuses"));
  const body = await res.text();
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Tag release
app.post("/api/tag-release", (c) => handleTagRelease(c.req.raw, c.env));

// Recheck
app.post("/api/recheck", (c) => handleRecheck(c.req.raw, c.env, getHub(c.env)));

// Dismiss run
app.post("/api/dismiss", async (c) => {
  const { run_id } = await c.req.json<{ run_id: number }>();
  await getHub(c.env).fetch(
    new Request("http://hub/delete-run", {
      method: "POST",
      body: JSON.stringify({ run_id }),
    }),
  );
  return c.json({ ok: true });
});

// MCP endpoint (Streamable HTTP)
app.all("/mcp", (c) => handleMcpRequest(c.req.raw, c.env.GITHUB_TOKEN));

export default app;
