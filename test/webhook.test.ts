import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import type { CIStatus, JobStatus } from "../src/webhook";

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
    expect(await res.text()).toBe("Ignored event: watch");
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

  it("push to default branch flushes commits cache (not tags)", async () => {
    await env.CI_STATUS.put("rcache:v1:tags:ippoan/foo:10", "[]", { expirationTtl: 300 });
    await env.CI_STATUS.put("rcache:v1:commits:ippoan/foo:main:50", "[]", { expirationTtl: 60 });
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
    // tags cache は触らない (push が tag じゃないので)
    expect(await env.CI_STATUS.get("rcache:v1:tags:ippoan/foo:10")).toBe("[]");
  });

  it("push to feature branch is noop for release-cache", async () => {
    await env.CI_STATUS.put("rcache:v1:commits:ippoan/foo:main:50", "[]", { expirationTtl: 60 });
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
  });
});
