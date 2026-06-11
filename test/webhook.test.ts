import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import type { CIStatus, JobStatus, WebhookQueueMessage } from "../src/webhook";
import { consumeWebhookBatch } from "../src/webhook";

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

// Tracks calls forwarded to the Hub. Tests use this to assert that side
// effects (e.g. release-alert-detect on a Tag Release completion) actually
// fire on top of the primary update-run path.
const hubCalls: Array<{ path: string; body: unknown }> = [];

function resetHubCalls() { hubCalls.length = 0; }

// Mock Hub DO that performs KV operations like the real Hub
function mockHub(kv: KVNamespace): DurableObjectStub {
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      // Record every dispatch for cross-handler assertions. Body is best-effort
      // — non-JSON requests are kept as raw text.
      try {
        const text = await req.clone().text();
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        hubCalls.push({ path: url.pathname, body: parsed });
      } catch { /* ignore */ }

      if (url.pathname === "/release-alert-detect") {
        // Side-channel for Tag Release completion. The real Hub fans out to
        // GitHub; the mock just acks.
        return new Response("OK");
      }

      if (url.pathname === "/update-run") {
        const payload = await req.json() as {
          run: {
            id: number; name: string; head_branch: string;
            status: string; conclusion: string | null; html_url: string;
            actor: { login: string }; updated_at: string; run_started_at: string;
          };
          repo: string;
        };
        const { run, repo } = payload;
        const key = `run:${run.id}`;
        const existing = await kv.get(key);
        if (existing) {
          const prev = JSON.parse(existing) as CIStatus;
          prev.status = run.status;
          prev.conclusion = run.conclusion;
          prev.updated_at = run.updated_at;
          if (run.status === "completed" && prev.jobs) {
            for (const job of prev.jobs) {
              if (job.status === "in_progress" || job.status === "queued") {
                job.status = "completed";
                job.conclusion = job.conclusion ?? "skipped";
              }
            }
          }
          await kv.put(key, JSON.stringify(prev), { expirationTtl: 86400 });
        } else {
          const status: CIStatus = {
            repo, workflow: run.name, branch: run.head_branch,
            status: run.status, conclusion: run.conclusion,
            run_id: run.id, run_url: run.html_url, actor: run.actor.login,
            updated_at: run.updated_at, started_at: run.run_started_at,
          };
          await kv.put(key, JSON.stringify(status), { expirationTtl: 86400 });
        }
        return new Response("OK");
      }

      if (url.pathname === "/update-job") {
        const payload = await req.json() as {
          job: {
            run_id: number; name: string; status: string;
            conclusion: string | null; html_url: string;
            started_at: string | null; completed_at: string | null;
          };
        };
        const { job } = payload;
        const key = `run:${job.run_id}`;
        const existing = await kv.get(key);
        if (!existing) return new Response("OK");
        const status = JSON.parse(existing) as CIStatus;
        const jobStatus: JobStatus = {
          name: job.name, status: job.status, conclusion: job.conclusion,
          url: job.html_url, started_at: job.started_at, completed_at: job.completed_at,
        };
        const jobs = status.jobs ?? [];
        const idx = jobs.findIndex((j) => j.name === job.name);
        if (idx >= 0) { jobs[idx] = jobStatus; } else { jobs.push(jobStatus); }
        status.jobs = jobs;
        await kv.put(key, JSON.stringify(status), { expirationTtl: 86400 });
        return new Response("OK");
      }

      if (url.pathname === "/delete-run") {
        const { run_id } = await req.json() as { run_id: number };
        await kv.delete(`run:${run_id}`);
        return new Response("OK");
      }

      return new Response("OK");
    },
  } as unknown as DurableObjectStub;
}

function testEnv(): Env {
  const hub = mockHub(env.CI_STATUS);
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => WEBHOOK_SECRET } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "test-internal" } as unknown as SecretsStoreSecret,
    CI_HUB: { idFromName: () => ({}), get: () => hub } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => "test-webhook-secret" } as unknown as SecretsStoreSecret,
  };
}

describe("POST /webhook", () => {
  beforeEach(() => { resetHubCalls(); });

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

  // Phase 3 (Refs #133) で push event 自体は handler 持つようになったため、
  // テストの対象 event を fall-through 確実な watch に切替。
  it("ignores unrecognized events (fall-through 200)", async () => {
    const body = "{}";
    const signature = await sign(body, WEBHOOK_SECRET);
    const req = new Request("http://localhost/webhook", {
      method: "POST",
      body,
      headers: {
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "watch",
      },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    // Ack-then-process (Refs #318): 応答は event 処理結果を反映せず常に "OK"。
    expect(await res.text()).toBe("OK");
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

    const stored = await env.CI_STATUS.get("run:12345");
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
    expect(res.status).toBe(404); // Hono: no GET route defined for /webhook
  });

  // `/webhooks` (複数) は CF Access bypass prefix に合わせたエイリアス。
  // 単数 `/webhook` と同一 handler に届くことを保証する。
  it("accepts the same payload on /webhooks (plural alias)", async () => {
    const body = makePayload();
    const signature = await sign(body, WEBHOOK_SECRET);
    const req = new Request("http://localhost/webhooks", {
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

    const stored = await env.CI_STATUS.get("run:12345");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).repo).toBe("ippoan/rust-alc-api");
  });

  it("stores workflow_job and attaches to existing run", async () => {
    const te = testEnv();
    // First, create a workflow_run
    const runBody = makePayload();
    const runSig = await sign(runBody, WEBHOOK_SECRET);
    const ctx1 = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: runBody,
        headers: { "X-Hub-Signature-256": runSig, "X-GitHub-Event": "workflow_run" },
      }),
      te,
      ctx1
    );
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
    const ctx2 = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: jobBody,
        headers: { "X-Hub-Signature-256": jobSig, "X-GitHub-Event": "workflow_job" },
      }),
      te,
      ctx2
    );
    await waitOnExecutionContext(ctx2);
    expect(res.status).toBe(200);

    const stored = await env.CI_STATUS.get("run:12345");
    const data = JSON.parse(stored!);
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].name).toBe("Type Check");
    expect(data.jobs[0].conclusion).toBe("success");
  });

  it("updates existing job instead of duplicating", async () => {
    const te = testEnv();
    // Create run
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
      te,
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
      te,
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
      te,
      ctx3
    );
    await waitOnExecutionContext(ctx3);

    const stored = await env.CI_STATUS.get("run:55555");
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

  // Release alert detection: we listen for the **CI** workflow finishing on a
  // tag head_branch (e.g. v0.0.43). That run is the one that does
  // `wrangler deploy`, so by the time it completes the new code is live and
  // the /release-alert-detect ping reaches a Hub that knows the route. See
  // issue #51 for why detecting on Tag Release directly was wrong.
  it("triggers release-alert-detect on a successful CI run for a tag", async () => {
    const body = makePayload({
      action: "completed",
      workflow_run: {
        id: 77777, name: "CI", head_branch: "v0.0.43",
        status: "completed", conclusion: "success",
        html_url: "https://github.com/ippoan/foo/actions/runs/77777",
        actor: { login: "yhonda" },
        updated_at: "2026-05-12T10:00:00Z",
        run_started_at: "2026-05-12T09:59:00Z",
      },
      repository: { full_name: "ippoan/foo" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "workflow_run" },
      }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const detectCalls = hubCalls.filter((c) => c.path === "/release-alert-detect");
    expect(detectCalls.length).toBe(1);
    // We pass the tag explicitly from head_branch so the Hub doesn't need to
    // re-resolve "latest" (avoids races with rapid back-to-back releases).
    expect(detectCalls[0]!.body).toMatchObject({
      repo: "ippoan/foo", tag: "v0.0.43",
    });
  });

  it("does NOT trigger release-alert-detect for CI on a branch (non-tag)", async () => {
    const body = makePayload({
      action: "completed",
      workflow_run: {
        id: 11111, name: "CI", head_branch: "main",
        status: "completed", conclusion: "success",
        html_url: "https://github.com/ippoan/foo/actions/runs/11111",
        actor: { login: "yhonda" },
        updated_at: "2026-05-12T10:00:00Z",
        run_started_at: "2026-05-12T09:59:00Z",
      },
      repository: { full_name: "ippoan/foo" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "workflow_run" },
      }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(hubCalls.filter((c) => c.path === "/release-alert-detect")).toHaveLength(0);
  });

  it("does NOT trigger release-alert-detect for failed CI on a tag", async () => {
    const body = makePayload({
      action: "completed",
      workflow_run: {
        id: 22222, name: "CI", head_branch: "v0.0.43",
        status: "completed", conclusion: "failure",
        html_url: "https://github.com/ippoan/foo/actions/runs/22222",
        actor: { login: "yhonda" },
        updated_at: "2026-05-12T10:00:00Z",
        run_started_at: "2026-05-12T09:59:00Z",
      },
      repository: { full_name: "ippoan/foo" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "workflow_run" },
      }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(hubCalls.filter((c) => c.path === "/release-alert-detect")).toHaveLength(0);
  });

  // Tagless-repo PR-merge detection. When env.TAGLESS_REPOS includes the
  // PR's repo and the PR was merged into the default branch, the webhook
  // should fan out to /release-alert-detect-pr on the hub.
  it("triggers release-alert-detect-pr when a tagless-repo PR merges into default branch", async () => {
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 42,
        merged: true,
        merge_commit_sha: "abcdef1234567890",
        base: { ref: "main" },
      },
      repository: { full_name: "ippoan/secrets-inventory-gcp", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const taglessEnv: Env = {
      ...testEnv(),
      TAGLESS_REPOS: "ippoan/secrets-inventory-gcp,ippoan/ci-workflows",
    };
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      taglessEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const calls = hubCalls.filter((c) => c.path === "/release-alert-detect-pr");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      repo: "ippoan/secrets-inventory-gcp",
      prNumber: 42,
      mergeSha: "abcdef1234567890",
      defaultBranch: "main",
    });
  });

  it("does NOT trigger release-alert-detect-pr when repo is not in TAGLESS_REPOS", async () => {
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 7, merged: true, merge_commit_sha: "deadbeef", base: { ref: "main" },
      },
      repository: { full_name: "ippoan/auth-worker", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const taglessEnv: Env = {
      ...testEnv(),
      TAGLESS_REPOS: "ippoan/secrets-inventory-gcp",
    };
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      taglessEnv, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(hubCalls.filter((c) => c.path === "/release-alert-detect-pr")).toHaveLength(0);
  });

  it("does NOT trigger release-alert-detect-pr for closed-but-not-merged PRs", async () => {
    const body = JSON.stringify({
      action: "closed",
      pull_request: { number: 8, merged: false, merge_commit_sha: null, base: { ref: "main" } },
      repository: { full_name: "ippoan/secrets-inventory-gcp", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const taglessEnv: Env = { ...testEnv(), TAGLESS_REPOS: "ippoan/secrets-inventory-gcp" };
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      taglessEnv, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(hubCalls.filter((c) => c.path === "/release-alert-detect-pr")).toHaveLength(0);
  });

  it("does NOT trigger release-alert-detect-pr for PRs merged into non-default branches", async () => {
    const body = JSON.stringify({
      action: "closed",
      pull_request: { number: 9, merged: true, merge_commit_sha: "abc", base: { ref: "develop" } },
      repository: { full_name: "ippoan/secrets-inventory-gcp", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const taglessEnv: Env = { ...testEnv(), TAGLESS_REPOS: "ippoan/secrets-inventory-gcp" };
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      taglessEnv, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(hubCalls.filter((c) => c.path === "/release-alert-detect-pr")).toHaveLength(0);
  });

  // #231: a PR merged into the default branch flushes the repo's compare +
  // commits cache so /releases' "Unreleased" zone reflects the just-merged
  // Refs immediately (not after the 60s TTL). Ungated by TAGLESS so any
  // watched repo benefits.
  it("merged PR into default branch flushes compare + commits cache", async () => {
    await env.CI_STATUS.put("rcache:v1:cmp:ippoan/foo:v1.0.0..main", "{}", { expirationTtl: 60 });
    await env.CI_STATUS.put("rcache:v1:commits:ippoan/foo:main:100", "[]", { expirationTtl: 60 });
    const body = JSON.stringify({
      action: "closed",
      pull_request: { number: 12, merged: true, merge_commit_sha: "cafef00d", base: { ref: "main" } },
      repository: { full_name: "ippoan/foo", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await env.CI_STATUS.get("rcache:v1:cmp:ippoan/foo:v1.0.0..main")).toBeNull();
    expect(await env.CI_STATUS.get("rcache:v1:commits:ippoan/foo:main:100")).toBeNull();
  });

  it("PR merged into a non-default branch does NOT flush compare cache", async () => {
    await env.CI_STATUS.put("rcache:v1:cmp:ippoan/foo:v1.0.0..main", "{}", { expirationTtl: 60 });
    const body = JSON.stringify({
      action: "closed",
      pull_request: { number: 13, merged: true, merge_commit_sha: "abc", base: { ref: "develop" } },
      repository: { full_name: "ippoan/foo", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await env.CI_STATUS.get("rcache:v1:cmp:ippoan/foo:v1.0.0..main")).toBe("{}");
  });

  // Regression guard for issue #51: Tag Release directly must NOT fire — the
  // Hub it would reach is still on the previous version's deploy.
  it("does NOT trigger release-alert-detect on a Tag Release workflow completion", async () => {
    const body = makePayload({
      action: "completed",
      workflow_run: {
        id: 33333, name: "Tag Release", head_branch: "main",
        status: "completed", conclusion: "success",
        html_url: "https://github.com/ippoan/foo/actions/runs/33333",
        actor: { login: "yhonda" },
        updated_at: "2026-05-12T10:00:00Z",
        run_started_at: "2026-05-12T09:59:00Z",
      },
      repository: { full_name: "ippoan/foo" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "workflow_run" },
      }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(hubCalls.filter((c) => c.path === "/release-alert-detect")).toHaveLength(0);
  });

  // ───── Phase 3 (Refs #133): release / push / issues → release-cache invalidation ─────

  it("release event flushes tags cache for the repo", async () => {
    // Seed the tags cache for ippoan/foo
    await env.CI_STATUS.put(
      "rcache:v1:tags:ippoan/foo:10",
      JSON.stringify([{ name: "v0.0.1", commit: { sha: "a" } }]),
      { expirationTtl: 300 },
    );
    const body = JSON.stringify({
      action: "published",
      release: { tag_name: "v0.0.2", id: 1 },
      repository: { full_name: "ippoan/foo" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "release" },
      }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await env.CI_STATUS.get("rcache:v1:tags:ippoan/foo:10")).toBeNull();
  });

  it("push to refs/tags/* flushes tags cache", async () => {
    await env.CI_STATUS.put("rcache:v1:tags:ippoan/foo:10", "[]", { expirationTtl: 300 });
    const body = JSON.stringify({
      ref: "refs/tags/v0.0.3",
      repository: { full_name: "ippoan/foo", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "push" },
      }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await env.CI_STATUS.get("rcache:v1:tags:ippoan/foo:10")).toBeNull();
  });

  it("push to default branch flushes commits + compare cache (not tags)", async () => {
    await env.CI_STATUS.put("rcache:v1:tags:ippoan/foo:10", "[]", { expirationTtl: 300 });
    await env.CI_STATUS.put("rcache:v1:commits:ippoan/foo:main:50", "[]", { expirationTtl: 60 });
    // "Unreleased" ゾーンの tag...main compare key (Refs #231)
    await env.CI_STATUS.put("rcache:v1:cmp:ippoan/foo:v1.0.0..main", "{}", { expirationTtl: 60 });
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "ippoan/foo", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "push" },
      }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await env.CI_STATUS.get("rcache:v1:commits:ippoan/foo:main:50")).toBeNull();
    // merge で main HEAD が動くと compare 内容が変わるので flush される (#231)
    expect(await env.CI_STATUS.get("rcache:v1:cmp:ippoan/foo:v1.0.0..main")).toBeNull();
    // tags cache は触らない (push が tag じゃないので)
    expect(await env.CI_STATUS.get("rcache:v1:tags:ippoan/foo:10")).toBe("[]");
  });

  it("push to feature branch is noop for release-cache", async () => {
    await env.CI_STATUS.put("rcache:v1:commits:ippoan/foo:main:50", "[]", { expirationTtl: 60 });
    await env.CI_STATUS.put("rcache:v1:cmp:ippoan/foo:v1.0.0..main", "{}", { expirationTtl: 60 });
    const body = JSON.stringify({
      ref: "refs/heads/feature-x",
      repository: { full_name: "ippoan/foo", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "push" },
      }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    // 触らない
    expect(await env.CI_STATUS.get("rcache:v1:commits:ippoan/foo:main:50")).toBe("[]");
    expect(await env.CI_STATUS.get("rcache:v1:cmp:ippoan/foo:v1.0.0..main")).toBe("{}");
  });

  it("issues event also invalidates release-cache issue key (close immediately reflects on /releases)", async () => {
    await env.CI_STATUS.put(
      "rcache:v1:issue:ippoan/foo:42",
      JSON.stringify({ number: 42, state: "open" }),
      { expirationTtl: 60 },
    );
    const body = JSON.stringify({
      action: "closed",
      issue: {
        number: 42, title: "x", state: "closed", user: { login: "y" },
        labels: [], assignees: [], comments: 0,
        created_at: "2026-05-27T00:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
        html_url: "https://github.com/ippoan/foo/issues/42",
      },
      repository: { full_name: "ippoan/foo" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "issues" },
      }),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await env.CI_STATUS.get("rcache:v1:issue:ippoan/foo:42")).toBeNull();

    // /issues live reload trigger (Refs #321): KV upsert 後に Hub へ
    // /issues-updated が飛び、WS client に broadcast される。
    const updates = hubCalls.filter((c) => c.path === "/issues-updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].body).toEqual({ repo: "ippoan/foo", number: 42, state: "closed" });
  });
});

// ───── pull_request → pr-map cache patch (Refs #304) ─────
//
// /issues の関連 PR chip 用 KV cache (pr-map-cache.ts) を webhook が即時
// patch する配線のテスト。patch ロジック自体の matrix は
// test/pr-map-cache.test.ts でカバーする — ここでは「webhook handler から
// applyPullRequestEvent が呼ばれ、KV に反映される」ことだけを確認する。
describe("POST /webhook pull_request — pr-map patch (Refs #304)", () => {
  const PR_MAP_KEY = "issues-page:pr-map:v2";

  beforeEach(async () => {
    resetHubCalls();
    await env.CI_STATUS.delete(PR_MAP_KEY);
  });

  it("opened + Refs #N で pr-map に chip が追加される (storedAt 不変)", async () => {
    const storedAt = Date.now() - 1000;
    await env.CI_STATUS.put(PR_MAP_KEY, JSON.stringify({ storedAt, data: {} }));

    const body = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 12,
        merged: false,
        merge_commit_sha: null,
        base: { ref: "main" },
        title: "feat: do the thing",
        body: "Refs #7",
        draft: false,
        html_url: "https://github.com/ippoan/rust-alc-api/pull/12",
        updated_at: "2026-06-10T00:00:00Z",
      },
      repository: { full_name: "ippoan/rust-alc-api", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const entry = await env.CI_STATUS.get(PR_MAP_KEY, "json") as {
      storedAt: number;
      patchedAt?: number;
      data: Record<string, Array<{ number: number; state: string }>>;
    };
    expect(entry.storedAt).toBe(storedAt);
    expect(entry.patchedAt).toBeGreaterThan(0);
    expect(entry.data["ippoan/rust-alc-api#7"]).toHaveLength(1);
    expect(entry.data["ippoan/rust-alc-api#7"]![0]!.number).toBe(12);
    expect(entry.data["ippoan/rust-alc-api#7"]![0]!.state).toBe("open");
  });

  it("cache 不在の pull_request event は pr-map を作らない (no-op)", async () => {
    const body = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 12, merged: false, merge_commit_sha: null, base: { ref: "main" },
        title: "feat: x", body: "Refs #7",
        html_url: "https://github.com/ippoan/rust-alc-api/pull/12",
        updated_at: "2026-06-10T00:00:00Z",
      },
      repository: { full_name: "ippoan/rust-alc-api", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await env.CI_STATUS.get(PR_MAP_KEY)).toBeNull();
  });

  it("title 無しの最小 payload (既存 fixture 形) でも 200 (除去のみ動作)", async () => {
    await env.CI_STATUS.put(PR_MAP_KEY, JSON.stringify({
      storedAt: Date.now(),
      data: {
        "ippoan/secrets-inventory-gcp#3": [{
          repo: "ippoan/secrets-inventory-gcp", number: 8, title: "old",
          url: "https://github.com/ippoan/secrets-inventory-gcp/pull/8",
          draft: false, updated_at: "2026-06-01T00:00:00Z", state: "open",
        }],
      },
    }));
    const body = JSON.stringify({
      action: "closed",
      pull_request: { number: 8, merged: false, merge_commit_sha: null, base: { ref: "main" } },
      repository: { full_name: "ippoan/secrets-inventory-gcp", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const entry = await env.CI_STATUS.get(PR_MAP_KEY, "json") as {
      data: Record<string, unknown[]>;
    };
    // closed-unmerged → 除去 (key ごと消える)
    expect(entry.data["ippoan/secrets-inventory-gcp#3"]).toBeUndefined();
  });
});

// ───── Queue ingest (Refs #318) ─────
//
// WEBHOOK_QUEUE binding がある env では受信 handler は enqueue + 即 200 のみ
// 行い、処理は consumeWebhookBatch (queue consumer) が担う。binding 無し /
// enqueue 失敗時は waitUntil fallback で従来どおり inline 処理される。
describe("webhook queue ingest (Refs #318)", () => {
  const issueBody = JSON.stringify({
    action: "opened",
    issue: {
      number: 77, title: "queued issue", state: "open", user: { login: "y" },
      labels: [], assignees: [], comments: 0,
      created_at: "2026-06-11T00:00:00Z",
      updated_at: "2026-06-11T00:00:00Z",
      html_url: "https://github.com/ippoan/foo/issues/77",
    },
    repository: { full_name: "ippoan/foo" },
  });

  beforeEach(async () => {
    resetHubCalls();
    await env.CI_STATUS.delete("issue:ippoan/foo#77");
  });

  it("WEBHOOK_QUEUE があれば enqueue + 200 で、inline 処理はしない", async () => {
    const sent: WebhookQueueMessage[] = [];
    const queueEnv = {
      ...testEnv(),
      WEBHOOK_QUEUE: { send: async (m: WebhookQueueMessage) => { sent.push(m); } },
    } as unknown as Env;

    const sig = await sign(issueBody, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body: issueBody,
        headers: {
          "X-Hub-Signature-256": sig,
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "deliv-1",
        },
      }),
      queueEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ event: "issues", body: issueBody, delivery: "deliv-1" });
    // 処理は consumer 側の責務 — 受信時点では KV に入らない
    expect(await env.CI_STATUS.get("issue:ippoan/foo#77")).toBeNull();
  });

  it("enqueue 失敗時は inline 処理に fallback する", async () => {
    const queueEnv = {
      ...testEnv(),
      WEBHOOK_QUEUE: { send: async () => { throw new Error("message too large"); } },
    } as unknown as Env;

    const sig = await sign(issueBody, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body: issueBody,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "issues" },
      }),
      queueEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    // fallback で従来どおり KV upsert される
    const stored = await env.CI_STATUS.get("issue:ippoan/foo#77", "json") as { number: number } | null;
    expect(stored?.number).toBe(77);
  });

  it("consumeWebhookBatch: 正常 message は処理して ack", async () => {
    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      messages: [{
        body: { event: "issues", body: issueBody, delivery: "deliv-2" },
        attempts: 1,
        ack: () => acked.push("deliv-2"),
        retry: () => retried.push("deliv-2"),
      }],
    } as unknown as MessageBatch<WebhookQueueMessage>;

    await consumeWebhookBatch(batch, testEnv());

    expect(acked).toEqual(["deliv-2"]);
    expect(retried).toEqual([]);
    const stored = await env.CI_STATUS.get("issue:ippoan/foo#77", "json") as { number: number } | null;
    expect(stored?.number).toBe(77);
  });

  it("consumeWebhookBatch: 処理失敗 message は retry (後続 message は処理継続)", async () => {
    const acked: string[] = [];
    const retried: string[] = [];
    const make = (delivery: string, event: string, body: string) => ({
      body: { event, body, delivery },
      attempts: 1,
      ack: () => acked.push(delivery),
      retry: () => retried.push(delivery),
    });
    const batch = {
      messages: [
        make("bad", "issues", "{not json"),
        make("good", "issues", issueBody),
      ],
    } as unknown as MessageBatch<WebhookQueueMessage>;

    await consumeWebhookBatch(batch, testEnv());

    expect(retried).toEqual(["bad"]);
    expect(acked).toEqual(["good"]);
  });
});

// ───── /releases index blob の stale 化 + queue refresh job (Refs #325) ─────
describe("releases index blob (Refs #325)", () => {
  beforeEach(async () => {
    resetHubCalls();
    await env.CI_STATUS.delete("releases:index:v1");
    await env.CI_STATUS.delete("releases:index:refreshing");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function seedBlob(): Promise<void> {
    await env.CI_STATUS.put(
      "releases:index:v1",
      JSON.stringify({ storedAt: Date.now(), views: [] }),
    );
  }

  async function blobStoredAt(): Promise<number | null> {
    const blob = await env.CI_STATUS.get("releases:index:v1", "json") as
      { storedAt: number } | null;
    return blob ? blob.storedAt : null;
  }

  it("PR merged で issues-updated broadcast + staleRepos に repo が積まれる (Refs #327)", async () => {
    await seedBlob();
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 9, merged: true, merge_commit_sha: "abc",
        base: { ref: "main" }, title: "feat", body: "Refs #1",
        draft: false, html_url: "https://github.com/ippoan/foo/pull/9",
        updated_at: "2026-06-11T00:00:00Z",
      },
      repository: { full_name: "ippoan/foo", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);

    const blob = await env.CI_STATUS.get("releases:index:v1", "json") as
      { storedAt: number; staleRepos?: string[] };
    expect(blob.storedAt).toBe(0);
    expect(blob.staleRepos).toContain("ippoan/foo");
    // merged 紫チップ反映用の /issues live reload も発火する
    const updates = hubCalls.filter((c) => c.path === "/issues-updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].body).toEqual({ repo: "ippoan/foo", number: 9, state: "merged" });
  });

  it("refresh job 完了で releases-updated が broadcast される (Refs #327)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("not stubbed", { status: 500 }));
    const acked: string[] = [];
    const batch = {
      messages: [{
        body: { kind: "releases-index-refresh" },
        attempts: 1,
        ack: () => acked.push("refresh"),
        retry: () => { throw new Error("should not retry"); },
      }],
    } as unknown as MessageBatch<import("../src/webhook").QueueMessage>;

    await consumeWebhookBatch(batch, testEnv());

    expect(acked).toEqual(["refresh"]);
    const updates = hubCalls.filter((c) => c.path === "/releases-updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].body).toEqual({ repo: "*" });
  });

  it("index に出ていない issue の event は blob を stale 化しない (Refs #339)", async () => {
    await seedBlob();
    const before = await blobStoredAt();
    const body = JSON.stringify({
      action: "opened",
      issue: {
        number: 5, title: "t", state: "open", user: { login: "y" },
        labels: [], assignees: [], comments: 0,
        created_at: "2026-06-11T00:00:00Z", updated_at: "2026-06-11T00:00:00Z",
        html_url: "https://github.com/ippoan/foo/issues/5",
      },
      repository: { full_name: "ippoan/foo" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "issues" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);
    // 該当行が無い = index 内容に影響なし → 全集計の引き金にしない
    expect(await blobStoredAt()).toBe(before);
  });

  it("index に出ている issue の close は blob を直接 patch して broadcast する (Refs #339)", async () => {
    // blob に open 行を seed (synthetic block)
    await env.CI_STATUS.put("releases:index:v1", JSON.stringify({
      storedAt: 12345,
      views: [{
        repo: "ippoan/foo", tagless: true, olderTags: [],
        tagBlocks: [{
          tag: "main@abc1234", prevTag: null, synthetic: true,
          issues: [{
            number: 7, title: "t", state: "open",
            labels: [], assignees: [], warnings: [],
            url: "https://github.com/ippoan/foo/issues/7",
            updated_at: "2026-06-11T00:00:00Z",
          }],
        }],
      }],
    }));
    const body = JSON.stringify({
      action: "closed",
      issue: {
        number: 7, title: "t", state: "closed", user: { login: "y" },
        labels: [], assignees: [], comments: 0,
        created_at: "2026-06-11T00:00:00Z", updated_at: "2026-06-11T01:00:00Z",
        html_url: "https://github.com/ippoan/foo/issues/7",
      },
      repository: { full_name: "ippoan/foo" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "issues" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);

    const blob = await env.CI_STATUS.get("releases:index:v1", "json") as {
      storedAt: number;
      views: Array<{ tagBlocks: Array<{ issues: Array<{ state: string; warnings: string[] }> }> }>;
    };
    // 行が closed に書き換わり、storedAt (= full snapshot 時刻) は不変
    expect(blob.views[0].tagBlocks[0].issues[0].state).toBe("closed");
    expect(blob.storedAt).toBe(12345);
    // /releases の WS reload が発火する
    const updates = hubCalls.filter((c) => c.path === "/releases-updated");
    expect(updates).toHaveLength(1);
  });

  it("PR merged は Refs #N を /issues KV から組んで synthetic block に挿入する (Refs #339)", async () => {
    // /issues KV に open issue (行データの供給元)
    await env.CI_STATUS.put("issue:ippoan/foo#9", JSON.stringify({
      repo: "ippoan/foo", number: 9, title: "patched in", state: "open",
      author: "y", labels: ["bug"], assignees: [], comments: 0,
      created_at: "2026-06-11T00:00:00Z", updated_at: "2026-06-11T00:00:00Z",
      url: "https://github.com/ippoan/foo/issues/9",
    }));
    // blob: 空の synthetic block を持つ tagless card
    await env.CI_STATUS.put("releases:index:v1", JSON.stringify({
      storedAt: 12345,
      views: [{
        repo: "ippoan/foo", tagless: true, olderTags: [],
        tagBlocks: [{ tag: "main@abc1234", prevTag: null, synthetic: true, issues: [] }],
      }],
    }));
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 50, merged: true, merge_commit_sha: "deadbeefcafe1234",
        base: { ref: "main" }, title: "feat: x", body: "Refs #9",
        draft: false, html_url: "https://github.com/ippoan/foo/pull/50",
        updated_at: "2026-06-11T01:00:00Z",
      },
      repository: { full_name: "ippoan/foo", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);

    const blob = await env.CI_STATUS.get("releases:index:v1", "json") as {
      storedAt: number;
      staleRepos?: string[];
      views: Array<{ tagBlocks: Array<{ tag: string; issues: Array<{ number: number; title: string }> }> }>;
    };
    const block = blob.views[0].tagBlocks[0];
    // 行が /issues KV から挿入され、block の sha が merge_commit_sha に進む
    expect(block.issues.map((i) => i.number)).toEqual([9]);
    expect(block.issues[0].title).toBe("patched in");
    expect(block.tag).toBe("main@deadbee");
    // 全集計の引き金 (stale 化) は不要
    expect(blob.storedAt).toBe(12345);
    expect(blob.staleRepos ?? []).toEqual([]);
    const updates = hubCalls.filter((c) => c.path === "/releases-updated");
    expect(updates).toHaveLength(1);
  });

  it("Refs 先が /issues KV に無い merge は全集計に fallback する (Refs #339)", async () => {
    await env.CI_STATUS.put("releases:index:v1", JSON.stringify({
      storedAt: 12345,
      views: [{
        repo: "ippoan/foo", tagless: true, olderTags: [],
        tagBlocks: [{ tag: "main@abc1234", prevTag: null, synthetic: true, issues: [] }],
      }],
    }));
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 51, merged: true, merge_commit_sha: "abc",
        base: { ref: "main" }, title: "feat: y", body: "Refs #99",
        draft: false, html_url: "https://github.com/ippoan/foo/pull/51",
        updated_at: "2026-06-11T01:00:00Z",
      },
      repository: { full_name: "ippoan/foo", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);

    const blob = await env.CI_STATUS.get("releases:index:v1", "json") as
      { storedAt: number; staleRepos?: string[] };
    expect(blob.storedAt).toBe(0);
    expect(blob.staleRepos).toContain("ippoan/foo");
  });

  it("tag push で blob が stale 化される", async () => {
    await seedBlob();
    const body = JSON.stringify({
      ref: "refs/tags/v1.0.0",
      repository: { full_name: "ippoan/foo", default_branch: "main" },
    });
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST", body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "push" },
      }),
      testEnv(), ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await blobStoredAt()).toBe(0);
  });

  it("queue の releases-index-refresh job で blob が再生成される", async () => {
    // compute は watched 空 fixture (mockHub の /statuses は非 JSON → catch で
    // 空扱い、allowlist fetch も 500 → catch) で即完走する。
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("not stubbed", { status: 500 }));
    const acked: string[] = [];
    const batch = {
      messages: [{
        body: { kind: "releases-index-refresh" },
        attempts: 1,
        ack: () => acked.push("refresh"),
        retry: () => { throw new Error("should not retry"); },
      }],
    } as unknown as MessageBatch<import("../src/webhook").QueueMessage>;

    await consumeWebhookBatch(batch, testEnv());

    expect(acked).toEqual(["refresh"]);
    expect(await env.CI_STATUS.get("releases:index:v1")).not.toBeNull();
  });
});

// ───── event-first batch (Refs #335) ─────
describe("consumeWebhookBatch — event-first (Refs #335)", () => {
  beforeEach(async () => {
    resetHubCalls();
    await env.CI_STATUS.delete("releases:index:v1");
    await env.CI_STATUS.delete("releases:index:refreshing");
    await env.CI_STATUS.delete("issue:ippoan/foo#88");
    await env.CI_STATUS.delete("github:rl-backoff");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("refresh job が同 batch にあっても event は処理され、重複 refresh は 1 回にまとまる", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("not stubbed", { status: 500 }));
    const issueBody = JSON.stringify({
      action: "opened",
      issue: {
        number: 88, title: "batched", state: "open", user: { login: "y" },
        labels: [], assignees: [], comments: 0,
        created_at: "2026-06-11T00:00:00Z", updated_at: "2026-06-11T00:00:00Z",
        html_url: "https://github.com/ippoan/foo/issues/88",
      },
      repository: { full_name: "ippoan/foo" },
    });
    const acked: string[] = [];
    const make = (id: string, body: unknown) => ({
      body, attempts: 1,
      ack: () => acked.push(id),
      retry: () => { throw new Error("should not retry: " + id); },
    });
    const batch = {
      messages: [
        make("r1", { kind: "releases-index-refresh" }),
        make("ev", { event: "issues", body: issueBody, delivery: "d1" }),
        make("r2", { kind: "releases-index-refresh" }),
      ],
    } as unknown as MessageBatch<import("../src/webhook").QueueMessage>;

    await consumeWebhookBatch(batch, testEnv());

    // event は refresh より先に処理される (ack 順で検証)
    expect(acked[0]).toBe("ev");
    expect(acked.sort()).toEqual(["ev", "r1", "r2"]);
    // event の効果 (KV upsert)
    const stored = await env.CI_STATUS.get("issue:ippoan/foo#88", "json") as { number: number } | null;
    expect(stored?.number).toBe(88);
    // refresh は 1 回だけ (= /releases-updated broadcast も最大 1 回)
    const updates = hubCalls.filter((c) => c.path === "/releases-updated");
    expect(updates.length).toBeLessThanOrEqual(1);
  });
});

// ───── refresh bail 時の self-reschedule (Refs #337) ─────
describe("consumeWebhookBatch — refresh self-reschedule (Refs #337)", () => {
  beforeEach(async () => {
    resetHubCalls();
    await env.CI_STATUS.delete("releases:index:v1");
    await env.CI_STATUS.delete("releases:index:refreshing");
    await env.CI_STATUS.delete("releases:index:rekick-scheduled");
    await env.CI_STATUS.delete("github:rl-backoff");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function refreshBatch(acked: string[]) {
    return {
      messages: [{
        body: { kind: "releases-index-refresh" },
        attempts: 1,
        ack: () => acked.push("r"),
        retry: () => { throw new Error("should not retry"); },
      }],
    } as unknown as MessageBatch<import("../src/webhook").QueueMessage>;
  }

  it("lock bail 時は 60s 遅延の refresh job を再投函してから ack する", async () => {
    // deploy に殺された compute の残 lock を再現
    await env.CI_STATUS.put("releases:index:refreshing", "1", { expirationTtl: 60 });
    await env.CI_STATUS.put("releases:index:v1", JSON.stringify({ storedAt: 0, views: [] }));

    const sent: Array<{ msg: unknown; opts: unknown }> = [];
    const queueEnv = {
      ...testEnv(),
      WEBHOOK_QUEUE: { send: async (msg: unknown, opts: unknown) => { sent.push({ msg, opts }); } },
    } as unknown as Env;
    const acked: string[] = [];

    await consumeWebhookBatch(refreshBatch(acked), queueEnv);

    expect(acked).toEqual(["r"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].msg).toEqual({ kind: "releases-index-refresh" });
    expect(sent[0].opts).toEqual({ delaySeconds: 60 });
    // 重複防止 marker が立つ → 2 通目の bail では再投函しない
    const acked2: string[] = [];
    await consumeWebhookBatch(refreshBatch(acked2), queueEnv);
    expect(acked2).toEqual(["r"]);
    expect(sent).toHaveLength(1);
  });

  it("fresh 時は再投函しない (停止条件)", async () => {
    await env.CI_STATUS.put("releases:index:v1", JSON.stringify({ storedAt: Date.now(), views: [] }));
    const sent: unknown[] = [];
    const queueEnv = {
      ...testEnv(),
      WEBHOOK_QUEUE: { send: async (msg: unknown) => { sent.push(msg); } },
    } as unknown as Env;
    const acked: string[] = [];

    await consumeWebhookBatch(refreshBatch(acked), queueEnv);

    expect(acked).toEqual(["r"]);
    expect(sent).toHaveLength(0);
  });
});
