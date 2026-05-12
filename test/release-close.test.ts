import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: "test-secret",
    GITHUB_TOKEN: "test-token",
    CI_HUB: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("OK") }),
    } as unknown as DurableObjectNamespace,
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

    // Per-issue failure injection: any GitHub API touching the failing issue
    // returns 500 so the issue ends up in the `failed` flash list.
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

describe("POST /api/release-close", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("closes selected issues and redirects with the closed flash", async () => {
    const { calls } = stubCloseFlow();
    const req = new Request("http://localhost/api/release-close", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/ci-dashboard"],
        ["tag", "v1.2.0"],
        ["issue", "12"],
        ["issue", "34"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    const location = res.headers.get("Location") ?? "";
    expect(location).toMatch(/^\/releases\?/);
    expect(location).toContain("repo=ippoan%2Fci-dashboard");
    expect(location).toContain("tag=v1.2.0");
    expect(location).toMatch(/closed=12(?:%2C|,)34/);
    expect(location).not.toContain("failed=");

    // 2 issues × (POST comment + PATCH issue) = 4 GitHub calls.
    expect(calls.length).toBe(4);
    const postComments = calls.filter((c) => c.method === "POST" && c.url.includes("/comments"));
    const patchIssues = calls.filter((c) => c.method === "PATCH" && /\/issues\/\d+$/.test(c.url));
    expect(postComments.length).toBe(2);
    expect(patchIssues.length).toBe(2);

    // Comment body carries the release tag.
    expect((postComments[0]!.body as { body: string }).body).toBe("Closed by release v1.2.0");
    // PATCH payload uses state_reason=completed.
    expect(patchIssues[0]!.body).toMatchObject({ state: "closed", state_reason: "completed" });
  });

  it("partitions partial failures into closed= + failed= flash params", async () => {
    const { calls } = stubCloseFlow({ failIssue: 34 });
    const req = new Request("http://localhost/api/release-close", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/ci-dashboard"],
        ["tag", "v1.2.0"],
        ["issue", "12"],
        ["issue", "34"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("closed=12");
    expect(location).toContain("failed=34");
    // Some GitHub API traffic still happened, but the failed issue short-circuits its PATCH.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("redirects without touching GitHub when no issues are selected", async () => {
    const { calls } = stubCloseFlow();
    const req = new Request("http://localhost/api/release-close", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/ci-dashboard"],
        ["tag", "v1.2.0"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    expect(calls.length).toBe(0);
    expect(res.headers.get("Location")).toContain("/releases?repo=");
  });

  it("400s when repo or tag is missing", async () => {
    const req = new Request("http://localhost/api/release-close", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([["issue", "12"]]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
  });

  it("400s on a disallowed org", async () => {
    const req = new Request("http://localhost/api/release-close", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "evil-org/x"],
        ["tag", "v1"],
        ["issue", "1"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Org not allowed");
  });
});
