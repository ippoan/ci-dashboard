import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import type { CIStatus } from "../src/webhook";

const WEBHOOK_SECRET = "test-secret";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET,
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

    await env.CI_STATUS.put("ippoan/auth-worker", JSON.stringify(completed));
    await env.CI_STATUS.put("ippoan/rust-alc-api", JSON.stringify(inProgress));

    const req = new Request("http://localhost/status");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const data: CIStatus[] = await res.json();
    expect(data).toHaveLength(2);
    // in_progress should come first
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
    expect(html).toContain("EventSource");
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
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
