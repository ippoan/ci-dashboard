/**
 * `/mcp` の binding_jwt 保護 (Refs #498) をテストする。
 *
 *  1. `bindingJwtMiddleware` 単体: Bearer 欠落/不正 → 401 + WWW-Authenticate
 *     (ci-dashboard 専用 slug 付き) / active token → 200 + claims 設定。
 *  2. `handleMcpRequest` 経由の scope gate: claims 未提供 (= middleware
 *     bypass) や scope 不足の JWT で write/workflow/project tool を呼ぶと
 *     isError の CallToolResult が返り、実行されないこと。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { bindingJwtMiddleware, type BindingJwtClaims } from "../../src/mcp/auth";
import { handleMcpRequest } from "../../src/mcp/server";
import { appTestEnv } from "../_helpers/app-env";
import type { Env } from "../../src/index";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload.sig";

function mockIntrospectFetch(opts: {
  expectedToken: string;
  authWorkerOrigin: string;
  active?: Partial<{ sub: string; github_login: string; scope: string; exp: number; aud: string }>;
  forceStatus?: number;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url !== `${opts.authWorkerOrigin}/mcp/introspect`) {
      return new Response("wrong URL: " + url, { status: 500 });
    }
    if (opts.forceStatus !== undefined) {
      return new Response(JSON.stringify({ active: false }), {
        status: opts.forceStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    const authz = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
    if (authz !== `Bearer ${opts.expectedToken}`) {
      return new Response(JSON.stringify({ active: false }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        active: true,
        sub: opts.active?.sub ?? "user:42",
        github_login: opts.active?.github_login ?? "octocat",
        scope: opts.active?.scope ?? "mcp.read",
        exp: opts.active?.exp ?? Math.floor(Date.now() / 1000) + 3600,
        ...(opts.active?.aud ? { aud: opts.active.aud } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("bindingJwtMiddleware (/mcp)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function buildApp(introspectFetch?: typeof fetch) {
    const app = new Hono<{ Bindings: Env; Variables: { bindingJwt: BindingJwtClaims } }>();
    app.use("/mcp", bindingJwtMiddleware({ introspectFetch, authWorkerOrigin: "https://auth.invalid" }));
    app.get("/mcp", (c) => c.json({ bindingJwt: c.get("bindingJwt") }));
    return app;
  }

  it("401 + WWW-Authenticate (ci-dashboard slug) when Authorization header is missing", async () => {
    const app = buildApp(mockIntrospectFetch({ expectedToken: TOKEN, authWorkerOrigin: "https://auth.invalid" }));
    const res = await app.request("/mcp", { method: "GET" }, appTestEnv());
    expect(res.status).toBe(401);
    const www = res.headers.get("WWW-Authenticate");
    expect(www).toContain('Bearer realm="MCP"');
    expect(www).toContain(
      'resource_metadata="https://auth.invalid/.well-known/oauth-protected-resource/ci-dashboard"',
    );
    expect(www).toContain('error="invalid_request"');
  });

  it("401 when introspect reports the token inactive", async () => {
    const app = buildApp(mockIntrospectFetch({ expectedToken: TOKEN, authWorkerOrigin: "https://auth.invalid" }));
    const res = await app.request(
      "/mcp",
      { method: "GET", headers: { Authorization: "Bearer wrong-token" } },
      appTestEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("503 when auth-worker introspect is unavailable (fail-closed)", async () => {
    const app = buildApp(
      mockIntrospectFetch({ expectedToken: TOKEN, authWorkerOrigin: "https://auth.invalid", forceStatus: 503 }),
    );
    const res = await app.request(
      "/mcp",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      appTestEnv(),
    );
    expect(res.status).toBe(503);
  });

  it("200 + claims set when the token is active", async () => {
    const app = buildApp(
      mockIntrospectFetch({
        expectedToken: TOKEN,
        authWorkerOrigin: "https://auth.invalid",
        active: { sub: "user:1", github_login: "alice", scope: "mcp.read mcp.write" },
      }),
    );
    const res = await app.request(
      "/mcp",
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      appTestEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { bindingJwt: BindingJwtClaims };
    expect(body.bindingJwt).toMatchObject({ sub: "user:1", github_login: "alice", scope: "mcp.read mcp.write" });
  });
});

describe("handleMcpRequest scope gate", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    claims?: BindingJwtClaims,
  ) {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const res = await handleMcpRequest(req, appTestEnv() as unknown as Env, claims);
    expect(res.status).toBe(200);
    return await res.json() as {
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    };
  }

  it("forbids create_issue (mcp.write) when no claims are provided (middleware bypass, fail-closed)", async () => {
    const body = await callTool("create_issue", { repo: "rust-alc-api", title: "x" });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('requires scope "mcp.write"');
  });

  it("forbids list_issues (mcp.read) when no claims are provided (middleware bypass, fail-closed)", async () => {
    const body = await callTool("list_issues", { repo: "rust-alc-api" });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('requires scope "mcp.read"');
  });

  it("forbids create_issue (mcp.write) when claims only grant mcp.read", async () => {
    const body = await callTool(
      "create_issue",
      { repo: "rust-alc-api", title: "x" },
      { sub: "u", github_login: "g", scope: "mcp.read", exp: Math.floor(Date.now() / 1000) + 60 },
    );
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('requires scope "mcp.write"');
  });

  it("allows list_issues (mcp.read) when claims grant mcp.read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
    const body = await callTool(
      "list_issues",
      { repo: "rust-alc-api" },
      { sub: "u", github_login: "g", scope: "mcp.read", exp: Math.floor(Date.now() / 1000) + 60 },
    );
    expect(body.result?.isError).toBeFalsy();
  });

  it("allows create_issue when claims grant mcp.write", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ number: 1, title: "x", state: "open", html_url: "https://github.com/ippoan/rust-alc-api/issues/1" }),
    );
    const body = await callTool(
      "create_issue",
      { repo: "rust-alc-api", title: "x" },
      { sub: "u", github_login: "g", scope: "mcp.write", exp: Math.floor(Date.now() / 1000) + 60 },
    );
    expect(body.result?.isError).toBeFalsy();
  });
});
