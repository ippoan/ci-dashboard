import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

// hub.fetch の記録用。テストごとに reset する。
const hubCalls: Array<{ url: string; body: unknown }> = [];

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => "test-secret" } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "test-internal" } as unknown as SecretsStoreSecret,
    CI_HUB: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (req: Request) => {
          let body: unknown = null;
          try { body = await req.clone().json(); } catch { /* no body */ }
          hubCalls.push({ url: req.url, body });
          return Response.json({ patched: true });
        },
      }),
    } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => "test-webhook-secret" } as unknown as SecretsStoreSecret,
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
  afterEach(() => { vi.restoreAllMocks(); hubCalls.length = 0; });

  it("synchronously patches the index blob for same-repo + cross-repo closes (Refs #343)", async () => {
    stubCloseFlow();
    const req = new Request("http://localhost/api/release-close-batch", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/cdp-relay"],
        // same-repo (card 上の issue) + cross-repo (別 repo の issue)
        ["pair", "v1.0.0:12"],
        ["pair", "main@abc1234:ippoan/mcp-cf-workers#28"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    const applyClose = hubCalls.find((c) => c.url.includes("/releases-index-apply-close"));
    expect(applyClose).toBeDefined();
    const body = applyClose!.body as { repo: string; urls: string[] };
    expect(body.repo).toBe("ippoan/cdp-relay");
    // url 突合: card repo の同一 repo 行も、別 repo の cross-repo 行も拾う。
    expect(body.urls).toContain("https://github.com/ippoan/cdp-relay/issues/12");
    expect(body.urls).toContain("https://github.com/ippoan/mcp-cf-workers/issues/28");
  });

  it("does not call the close-patch hub when every issue fails to close", async () => {
    stubCloseFlow({ failIssue: 12 });
    const req = new Request("http://localhost/api/release-close-batch", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/cdp-relay"],
        ["pair", "v1.0.0:12"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    expect(hubCalls.find((c) => c.url.includes("/releases-index-apply-close"))).toBeUndefined();
  });

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

  it("closes a cross-repo pair against its home repo, not the card repo", async () => {
    const { calls } = stubCloseFlow();
    const req = new Request("http://localhost/api/release-close-batch", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/cdp-relay"],
        // same-repo row (closes against card repo) …
        ["pair", "main@abc1234:5"],
        // … cross-repo row: issue lives in ippoan/mcp-cf-workers, shipped by a
        // cdp-relay PR. Must close against mcp-cf-workers, not cdp-relay.
        ["pair", "main@abc1234:ippoan/mcp-cf-workers#28"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    const location = res.headers.get("Location") ?? "";
    const closedNums = decodeURIComponent(location.match(/closed=([^&]+)/)![1]!).split(",").sort();
    expect(closedNums).toEqual(["28", "5"]);

    // same-repo close hits cdp-relay
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/repos/ippoan/cdp-relay/issues/5"))).toBe(true);
    // cross-repo close hits mcp-cf-workers (NOT cdp-relay)
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/repos/ippoan/mcp-cf-workers/issues/28"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/repos/ippoan/cdp-relay/issues/28"))).toBe(false);
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
    // batch handler も failed_reasons を flash 経路に乗せること。
    // Refs ippoan/ci-dashboard#152
    expect(location).toMatch(/failed_reasons=5%3A/);
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
