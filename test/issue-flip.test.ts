import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { issueKey } from "../src/issue-cache";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => "test-secret" } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "test-internal" } as unknown as SecretsStoreSecret,
    CI_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => "test-webhook-secret" } as unknown as SecretsStoreSecret,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubGitHub(
  opts: { fail?: () => Response; state?: string } = {},
) {
  const calls: RecordedCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* keep string */ }
    }
    calls.push({ url, method, body });

    if (opts.fail) return opts.fail();

    const requestedState = (body as { state?: string } | undefined)?.state ?? "closed";
    return Response.json({
      number: 42,
      title: "some issue",
      state: opts.state ?? requestedState,
      user: { login: "yhonda-ohishi" },
      labels: [{ name: "bug" }],
      assignees: [{ login: "yhonda-ohishi" }],
      comments: 3,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
      html_url: "https://github.com/ippoan/rust-alc-api/issues/42",
      body: "issue body",
    });
  });
  return { spy, calls };
}

describe("POST /api/issue-flip", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("closes an issue via REST PATCH (state_reason: completed) and evicts it from the open cache", async () => {
    await env.CI_STATUS.put(
      issueKey("ippoan/rust-alc-api", 42),
      JSON.stringify({
        repo: "ippoan/rust-alc-api", number: 42, title: "some issue", state: "open",
        author: "y", labels: [], assignees: [], comments: 0,
        created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z",
        url: "https://github.com/ippoan/rust-alc-api/issues/42",
      }),
    );
    const { calls } = stubGitHub();
    const req = new Request("http://localhost/api/issue-flip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "ippoan/rust-alc-api", number: 42, action: "close" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; state: string; number: number };
    expect(data).toEqual({ ok: true, state: "closed", number: 42 });

    const patchCalls = calls.filter((c) => c.method === "PATCH");
    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0]!.url).toContain("/repos/ippoan/rust-alc-api/issues/42");
    expect(patchCalls[0]!.body).toMatchObject({ state: "closed", state_reason: "completed" });

    // Open issues cache no longer holds this issue (upsertIssue deletes on closed).
    expect(await env.CI_STATUS.get(issueKey("ippoan/rust-alc-api", 42))).toBeNull();
  });

  it("reopens an issue via REST PATCH (state: open) and upserts it back into the open cache", async () => {
    const { calls } = stubGitHub({ state: "open" });
    const req = new Request("http://localhost/api/issue-flip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "ippoan/rust-alc-api", number: 42, action: "reopen" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; state: string; number: number };
    expect(data).toEqual({ ok: true, state: "open", number: 42 });

    const patchCalls = calls.filter((c) => c.method === "PATCH");
    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0]!.body).toMatchObject({ state: "open" });
    expect(patchCalls[0]!.body).not.toHaveProperty("state_reason");

    const cached = await env.CI_STATUS.get(issueKey("ippoan/rust-alc-api", 42), "json") as { state: string; title: string } | null;
    expect(cached).not.toBeNull();
    expect(cached!.state).toBe("open");
    expect(cached!.title).toBe("some issue");
  });

  it("400s on a disallowed org (defense-in-depth, mirrors /api/release-close)", async () => {
    const req = new Request("http://localhost/api/issue-flip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "evil-org/x", number: 1, action: "close" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(403);
    const data = await res.json() as { ok: boolean; reason: string };
    expect(data.ok).toBe(false);
    expect(data.reason).toContain("forbidden");
  });

  it("400s on a missing/invalid repo or number", async () => {
    const req = new Request("http://localhost/api/issue-flip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "", number: 0, action: "close" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(false);
  });

  it("400s on an invalid action value", async () => {
    const req = new Request("http://localhost/api/issue-flip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "ippoan/rust-alc-api", number: 42, action: "delete" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
  });

  it("surfaces a formatted reason and propagates the GitHub status on failure", async () => {
    stubGitHub({
      fail: () => new Response(
        JSON.stringify({ message: "Repository was archived so is read-only." }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    });
    const req = new Request("http://localhost/api/issue-flip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "ippoan/rust-alc-api", number: 42, action: "close" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(403);
    const data = await res.json() as { ok: boolean; reason: string };
    expect(data.ok).toBe(false);
    expect(data.reason).toBe("archived (read-only)");
  });

  it("404s on non-POST (Hono only registers the POST route)", async () => {
    const req = new Request("http://localhost/api/issue-flip", { method: "GET" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
});
