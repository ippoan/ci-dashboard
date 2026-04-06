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

    const stored = await env.CI_STATUS.get("ippoan/rust-alc-api/main");
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

  it("stores workflow_job and attaches to existing run", async () => {
    // First, create a workflow_run
    const runBody = makePayload();
    const runSig = await sign(runBody, WEBHOOK_SECRET);
    const runReq = new Request("http://localhost/webhook", {
      method: "POST",
      body: runBody,
      headers: {
        "X-Hub-Signature-256": runSig,
        "X-GitHub-Event": "workflow_run",
      },
    });
    const ctx1 = createExecutionContext();
    await worker.fetch(runReq, testEnv(), ctx1);
    await waitOnExecutionContext(ctx1);

    // Then, send a workflow_job event
    const jobBody = JSON.stringify({
      action: "completed",
      workflow_job: {
        id: 99,
        run_id: 12345,
        name: "Type Check",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/ippoan/rust-alc-api/actions/runs/12345/job/99",
        started_at: "2026-04-06T11:55:10Z",
        completed_at: "2026-04-06T11:55:20Z",
      },
      repository: { full_name: "ippoan/rust-alc-api" },
    });
    const jobSig = await sign(jobBody, WEBHOOK_SECRET);
    const jobReq = new Request("http://localhost/webhook", {
      method: "POST",
      body: jobBody,
      headers: {
        "X-Hub-Signature-256": jobSig,
        "X-GitHub-Event": "workflow_job",
      },
    });
    const ctx2 = createExecutionContext();
    const res = await worker.fetch(jobReq, testEnv(), ctx2);
    await waitOnExecutionContext(ctx2);
    expect(res.status).toBe(200);

    const stored = await env.CI_STATUS.get("ippoan/rust-alc-api/main");
    const data = JSON.parse(stored!);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].name).toBe("Type Check");
    expect(data.jobs[0].conclusion).toBe("success");
  });

  it("updates existing job instead of duplicating", async () => {
    // Create run with unique repo
    const runBody = makePayload({
      repository: { full_name: "ippoan/test-update" },
      workflow_run: {
        id: 55555, name: "CI", head_branch: "main",
        status: "in_progress", conclusion: null,
        html_url: "https://github.com/ippoan/test-update/actions/runs/55555",
        actor: { login: "yhonda" },
        updated_at: "2026-04-06T12:00:00Z",
        run_started_at: "2026-04-06T11:55:00Z",
      },
    });
    const runSig = await sign(runBody, WEBHOOK_SECRET);
    const ctx1 = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: runBody,
        headers: { "X-Hub-Signature-256": runSig, "X-GitHub-Event": "workflow_run" },
      }),
      testEnv(),
      ctx1
    );
    await waitOnExecutionContext(ctx1);

    // Job in_progress
    const job1 = JSON.stringify({
      action: "in_progress",
      workflow_job: {
        id: 99, run_id: 55555, name: "Vitest",
        status: "in_progress", conclusion: null,
        html_url: "https://github.com/ippoan/test-update/actions/runs/55555/job/99",
        started_at: "2026-04-06T11:55:10Z", completed_at: null,
      },
      repository: { full_name: "ippoan/test-update" },
    });
    const sig1 = await sign(job1, WEBHOOK_SECRET);
    const ctx2 = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: job1,
        headers: { "X-Hub-Signature-256": sig1, "X-GitHub-Event": "workflow_job" },
      }),
      testEnv(),
      ctx2
    );
    await waitOnExecutionContext(ctx2);

    // Job completed
    const job2 = JSON.stringify({
      action: "completed",
      workflow_job: {
        id: 99, run_id: 55555, name: "Vitest",
        status: "completed", conclusion: "success",
        html_url: "https://github.com/ippoan/test-update/actions/runs/55555/job/99",
        started_at: "2026-04-06T11:55:10Z", completed_at: "2026-04-06T11:56:00Z",
      },
      repository: { full_name: "ippoan/test-update" },
    });
    const sig2 = await sign(job2, WEBHOOK_SECRET);
    const ctx3 = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: job2,
        headers: { "X-Hub-Signature-256": sig2, "X-GitHub-Event": "workflow_job" },
      }),
      testEnv(),
      ctx3
    );
    await waitOnExecutionContext(ctx3);

    const stored = await env.CI_STATUS.get("ippoan/test-update/main");
    const data = JSON.parse(stored!);
    expect(data.jobs).toHaveLength(1); // Not duplicated
    expect(data.jobs[0].conclusion).toBe("success"); // Updated
  });

  it("ignores workflow_job for unknown run", async () => {
    const jobBody = JSON.stringify({
      action: "completed",
      workflow_job: {
        id: 99, run_id: 99999, name: "Test",
        status: "completed", conclusion: "success",
        html_url: "https://example.com",
        started_at: null, completed_at: null,
      },
      repository: { full_name: "ippoan/unknown-repo" },
    });
    const sig = await sign(jobBody, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: jobBody,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "workflow_job" },
      }),
      testEnv(),
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });
});
