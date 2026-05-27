import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => "test-secret" } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "test-internal" } as unknown as SecretsStoreSecret,
    CI_HUB: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("OK") }),
    } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubCloseFlow(opts: { failIssue?: number } = {}) {
  const calls: RecordedCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* keep string */ }
    }
    calls.push({ url, method, body });

    if (opts.failIssue && url.includes(`/issues/${opts.failIssue}`)) {
      return new Response("boom", { status: 500 });
    }
    if (url.includes("/comments")) {
      return Response.json({ id: 1 });
    }
    return Response.json({ number: 1, state: "closed", state_reason: "completed", html_url: "" });
  });
  return { spy, calls };
}

function formBody(pairs: Array<[string, string]>): string {
  const params = new URLSearchParams();
  for (const [k, v] of pairs) params.append(k, v);
  return params.toString();
}

describe("POST /api/release-close-batch", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("groups pairs by tag and posts a tag-attributed comment + PATCH per issue", async () => {
    const { calls } = stubCloseFlow();
    const req = new Request("http://localhost/api/release-close-batch", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/ci-dashboard"],
        ["pair", "v1.2.0:1"],
        ["pair", "v1.2.0:5"],
        ["pair", "v1.1.0:3"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    const location = res.headers.get("Location") ?? "";
    expect(location).toMatch(/^\/releases\?/);
    expect(location).toContain("repo=ippoan%2Fci-dashboard");
    // All three closed (numbers in flash, any order — URLSearchParams encodes
    // commas as %2C, so we decode and compare against a set).
    const closedMatch = location.match(/closed=([^&]+)/);
    expect(closedMatch).not.toBeNull();
    const closedNums = decodeURIComponent(closedMatch![1]!).split(",").sort();
    expect(closedNums).toEqual(["1", "3", "5"]);
    expect(location).not.toContain("failed=");

    // 3 issues × (POST comment + PATCH issue) = 6 GitHub calls.
    expect(calls.length).toBe(6);
    const comments = calls.filter((c) => c.method === "POST" && c.url.includes("/comments"));
    const patches = calls.filter((c) => c.method === "PATCH" && /\/issues\/\d+$/.test(c.url));
    expect(comments.length).toBe(3);
    expect(patches.length).toBe(3);

    // Tag-attributed comment bodies.
    const bodies = comments.map((c) => (c.body as { body: string }).body);
    expect(bodies.filter((b) => b === "Closed by release v1.2.0").length).toBe(2);
    expect(bodies.filter((b) => b === "Closed by release v1.1.0").length).toBe(1);
  });

  it("partitions partial failures into closed= and failed=", async () => {
    const { calls } = stubCloseFlow({ failIssue: 5 });
    const req = new Request("http://localhost/api/release-close-batch", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/ci-dashboard"],
        ["pair", "v1.2.0:1"],
        ["pair", "v1.2.0:5"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("closed=1");
    expect(location).toContain("failed=5");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("redirects without touching GitHub when no pairs are selected", async () => {
    const { calls } = stubCloseFlow();
    const req = new Request("http://localhost/api/release-close-batch", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([["repo", "ippoan/ci-dashboard"]]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    expect(calls.length).toBe(0);
    expect(res.headers.get("Location")).toBe("/releases");
  });

  it("ignores malformed pair strings instead of crashing", async () => {
    const { calls } = stubCloseFlow();
    const req = new Request("http://localhost/api/release-close-batch", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/ci-dashboard"],
        ["pair", "no-colon"],
        ["pair", "v1.2.0:not-a-number"],
        ["pair", "v1.2.0:-3"],
        ["pair", "v1.2.0:7"],   // only this one is valid
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    // 1 issue × 2 ops = 2 calls.
    expect(calls.length).toBe(2);
    expect(res.headers.get("Location") ?? "").toContain("closed=7");
  });

  it("400s on a missing repo or a disallowed org", async () => {
    {
      const req = new Request("http://localhost/api/release-close-batch", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody([["pair", "v1.2.0:1"]]),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, testEnv(), ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(400);
    }
    {
      const req = new Request("http://localhost/api/release-close-batch", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody([
          ["repo", "evil-org/x"],
          ["pair", "v1.2.0:1"],
        ]),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, testEnv(), ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Org not allowed");
    }
  });
});
