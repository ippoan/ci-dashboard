import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

const WEBHOOK_SECRET = "test-secret";

async function sign(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: "in_progress",
    workflow_run: {
      id: 12345,
      name: "CI",
      head_branch: "main",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/ippoan/rust-alc-api/actions/runs/12345",
      actor: { login: "yhonda" },
      updated_at: "2026-04-06T12:00:00Z",
      run_started_at: "2026-04-06T11:55:00Z",
    },
    repository: {
      full_name: "ippoan/rust-alc-api",
    },
    ...overrides,
  });
}

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET,
  };
}

describe("POST /webhook", () => {
  it("rejects missing signature", async () => {
    const req = new Request("http://localhost/webhook", {
      method: "POST",
      body: "{}",
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Missing signature");
  });

  it("rejects invalid signature", async () => {
    const body = makePayload();
    const req = new Request("http://localhost/webhook", {
      method: "POST",
      body,
      headers: {
        "X-Hub-Signature-256": "sha256=invalid",
        "X-GitHub-Event": "workflow_run",
      },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("Invalid signature");
  });

  it("ignores non-workflow_run events", async () => {
    const body = "{}";
    const signature = await sign(body, WEBHOOK_SECRET);
    const req = new Request("http://localhost/webhook", {
      method: "POST",
      body,
      headers: {
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "push",
      },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Ignored event: push");
  });

  it("stores workflow_run status in KV", async () => {
    const body = makePayload();
    const signature = await sign(body, WEBHOOK_SECRET);
    const req = new Request("http://localhost/webhook", {
      method: "POST",
      body,
      headers: {
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "workflow_run",
      },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const stored = await env.CI_STATUS.get("ippoan/rust-alc-api");
    expect(stored).not.toBeNull();
    const data = JSON.parse(stored!);
    expect(data.repo).toBe("ippoan/rust-alc-api");
    expect(data.status).toBe("in_progress");
    expect(data.actor).toBe("yhonda");
  });

  it("rejects non-POST method", async () => {
    const req = new Request("http://localhost/webhook", { method: "GET" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });
});
