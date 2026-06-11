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

function stubCloseFlow(
  opts: {
    failIssue?: number;
    /**
     * 失敗時 GitHub API が返す Response。default は status 500 "boom" (= generic
     * fallback path)。archived 403 など特定の reason を test するときに上書き。
     * Refs ippoan/ci-dashboard#152
     */
    failResponse?: () => Response;
  } = {},
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

    // Per-issue failure injection: any GitHub API touching the failing issue
    // returns 500 so the issue ends up in the `failed` flash list.
    if (opts.failIssue && url.includes(`/issues/${opts.failIssue}`)) {
      return opts.failResponse
        ? opts.failResponse()
        : new Response("boom", { status: 500 });
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
  afterEach(() => { vi.restoreAllMocks(); hubCalls.length = 0; });

  it("delegates closed issues to the hub for synchronous blob patch (Refs #343)", async () => {
    stubCloseFlow();
    const req = new Request("http://localhost/api/release-close", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/claude-skills"],
        ["tag", "v1.2.0"],
        ["issue", "68"],
        ["issue", "70"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    const applyClose = hubCalls.find((c) => c.url.includes("/releases-index-apply-close"));
    expect(applyClose).toBeDefined();
    expect(applyClose!.body).toMatchObject({
      repo: "ippoan/claude-skills",
      urls: [
        "https://github.com/ippoan/claude-skills/issues/68",
        "https://github.com/ippoan/claude-skills/issues/70",
      ],
    });
  });

  it("does not call the close-patch hub when every issue fails to close", async () => {
    stubCloseFlow({ failIssue: 68 });
    const req = new Request("http://localhost/api/release-close", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/claude-skills"],
        ["tag", "v1.2.0"],
        ["issue", "68"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    expect(hubCalls.find((c) => c.url.includes("/releases-index-apply-close"))).toBeUndefined();
  });

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
    // 失敗 issue には reason が同伴している (500 fallback path)。
    expect(location).toMatch(/failed_reasons=34%3A/);
    // Some GitHub API traffic still happened, but the failed issue short-circuits its PATCH.
    expect(calls.length).toBeGreaterThan(0);
  });

  // ippoan/github-mcp-server-rs#59 (archived 状態) で実害発生したケース。
  // GitHub API は 403 + "Repository was archived so is read-only." を返すが、
  // 旧 UI は "Failed to close: #N (try again)" の汎用 message しか出さず、
  // operator が原因に気付けなかった。Refs ippoan/ci-dashboard#152。
  it("surfaces 'archived (read-only)' as failed_reasons for an archived-repo 403", async () => {
    stubCloseFlow({
      failIssue: 59,
      failResponse: () => new Response(
        JSON.stringify({
          message: "Repository was archived so is read-only.",
          documentation_url: "https://docs.github.com/v3/issues",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    });
    const req = new Request("http://localhost/api/release-close", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody([
        ["repo", "ippoan/github-mcp-server-rs"],
        ["tag", "v0.1.0"],
        ["issue", "59"],
      ]),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    const location = res.headers.get("Location") ?? "";
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    expect(params.get("failed")).toBe("59");
    const reasons = params.get("failed_reasons") ?? "";
    // 形式: `N:urlencoded-reason`。decode して reason 部分を検証。
    expect(reasons.startsWith("59:")).toBe(true);
    expect(decodeURIComponent(reasons.slice("59:".length))).toBe("archived (read-only)");
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
