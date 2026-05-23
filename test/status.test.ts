import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import type { CIStatus } from "../src/webhook";

const WEBHOOK_SECRET = "test-secret";

// Mock Hub that supports /statuses + /release-alerts by reading from KV
// (like the real Hub's ensureCache + ensureAlerts).
function mockHub(kv: KVNamespace): DurableObjectStub {
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);

      // Banner endpoint: parses release-alert:* keys and returns the cached
      // payload list. Mirrors Hub.ensureAlerts() shape.
      if (url.pathname === "/release-alerts") {
        const list = await kv.list({ prefix: "release-alert:" });
        const values = await Promise.all(list.keys.map((k) => kv.get(k.name)));
        const alerts = values
          .filter((v): v is string => v !== null)
          .map((v) => JSON.parse(v));
        return Response.json(alerts);
      }

      if (url.pathname === "/statuses") {
        const list = await kv.list({ prefix: "run:" });
        const values = await Promise.all(
          list.keys.map((key) => kv.get(key.name))
        );
        const all = values
          .filter((v): v is string => v !== null)
          .map((v) => JSON.parse(v) as CIStatus);

        const latestInProgress = new Map<string, CIStatus>();
        const latestCompleted = new Map<string, CIStatus>();
        for (const s of all) {
          const map = s.status === "completed" ? latestCompleted : latestInProgress;
          const existing = map.get(s.repo);
          if (!existing || s.updated_at > existing.updated_at) {
            map.set(s.repo, s);
          }
        }
        for (const [repo, ip] of latestInProgress) {
          const completed = latestCompleted.get(repo);
          if (completed && completed.updated_at > ip.updated_at) {
            latestInProgress.delete(repo);
          }
        }
        const result = [...latestInProgress.values(), ...latestCompleted.values()];
        result.sort((a, b) => {
          if (a.status !== "completed" && b.status === "completed") return -1;
          if (a.status === "completed" && b.status !== "completed") return 1;
          return b.updated_at.localeCompare(a.updated_at);
        });
        return Response.json(result);
      }
      return new Response("OK");
    },
  } as unknown as DurableObjectStub;
}

function testEnv(): Env {
  const hub = mockHub(env.CI_STATUS);
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
    GITHUB_APP_INSTALLATIONS: JSON.stringify({"ippoan":111,"ohishi-exp":222,"yhonda-ohishi":333}),
    CI_HUB: { idFromName: () => ({}), get: () => hub } as unknown as DurableObjectNamespace,
  };
}

describe("GET /status", () => {
  it("returns empty array when no data", async () => {
    const req = new Request("http://localhost/status");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it("returns stored statuses sorted (in_progress first)", async () => {
    const completed: CIStatus = {
      repo: "ippoan/auth-worker",
      workflow: "test.yml",
      branch: "main",
      status: "completed",
      conclusion: "success",
      run_id: 100,
      run_url: "https://github.com/ippoan/auth-worker/actions/runs/100",
      actor: "yhonda",
      updated_at: "2026-04-06T12:00:00Z",
      started_at: "2026-04-06T11:55:00Z",
    };

    const inProgress: CIStatus = {
      repo: "ippoan/rust-alc-api",
      workflow: "ci.yml",
      branch: "main",
      status: "in_progress",
      conclusion: null,
      run_id: 200,
      run_url: "https://github.com/ippoan/rust-alc-api/actions/runs/200",
      actor: "yhonda",
      updated_at: "2026-04-06T11:58:00Z",
      started_at: "2026-04-06T11:50:00Z",
    };

    await env.CI_STATUS.put("run:100", JSON.stringify(completed));
    await env.CI_STATUS.put("run:200", JSON.stringify(inProgress));

    const req = new Request("http://localhost/status");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const data: CIStatus[] = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0]!.repo).toBe("ippoan/rust-alc-api");
    expect(data[1]!.repo).toBe("ippoan/auth-worker");
  });
});

describe("GET /", () => {
  it("returns HTML dashboard", async () => {
    const req = new Request("http://localhost/");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("CI Dashboard");
    expect(html).toContain("WebSocket");
    // Banner mount point + supporting JS must be present.
    expect(html).toContain('id="release-banner-list"');
    expect(html).toContain("renderBanners");
    // Snapshot-based loading (WS-driven, no polling). Refs #64.
    expect(html).toContain("loadSnapshot");
    expect(html).toContain("reconnect-btn");
    // Tab-return refetch hook (Refs #92): visibilitychange listener that
    // calls loadSnapshot when the tab becomes visible. Not a setInterval —
    // just a one-shot per tab return.
    expect(html).toContain("visibilitychange");
    expect(html).not.toContain("setInterval(loadSnapshot");
  });
});

describe("GET /release-alerts", () => {
  it("returns empty list when no alerts cached", async () => {
    const req = new Request("http://localhost/release-alerts");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it("returns cached alerts from KV", async () => {
    await env.CI_STATUS.put("release-alert:ippoan/foo", JSON.stringify({
      repo: "ippoan/foo",
      tag: "v1.2.3",
      prevTag: "v1.2.2",
      openIssues: [{ number: 42, title: "still open", url: "https://example.com/42" }],
      detectedAt: "2026-05-12T10:00:00Z",
    }));

    const req = new Request("http://localhost/release-alerts");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    const data: Array<{ repo: string; tag: string; openIssues: unknown[] }> = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0]!.repo).toBe("ippoan/foo");
    expect(data[0]!.tag).toBe("v1.2.3");
    expect(data[0]!.openIssues).toHaveLength(1);
  });
});

describe("routing", () => {
  it("returns 404 for unknown path", async () => {
    const req = new Request("http://localhost/unknown");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("handles OPTIONS for CORS", async () => {
    const req = new Request("http://localhost/webhook", { method: "OPTIONS" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204); // Hono CORS middleware returns 204 for OPTIONS
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
