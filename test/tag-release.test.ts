import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

function testEnv(): Env {
  return {
    CI_STATUS: {} as unknown as KVNamespace,
    WEBHOOK_SECRET: "test-secret",
    GITHUB_TOKEN: "ghp_test_token",
    CI_HUB: {} as unknown as DurableObjectNamespace,
  };
}

describe("POST /api/tag-release", () => {
  it("returns 405 for GET", async () => {
    const req = new Request("http://localhost/api/tag-release");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  it("returns 403 for non-ippoan repo", async () => {
    const req = new Request("http://localhost/api/tag-release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "other-org/repo" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
    const data = await res.json<{ error: string }>();
    expect(data.error).toContain("not allowed");
  });

  it("returns 200 on successful dispatch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    const req = new Request("http://localhost/api/tag-release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "ippoan/rust-alc-api" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const data = await res.json<{ ok: boolean; repo: string }>();
    expect(data.ok).toBe(true);
    expect(data.repo).toBe("ippoan/rust-alc-api");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/ippoan/rust-alc-api/actions/workflows/tag-release.yml/dispatches",
      expect.objectContaining({ method: "POST" }),
    );

    fetchSpy.mockRestore();
  });

  it("returns 502 when GitHub API fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );

    const req = new Request("http://localhost/api/tag-release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "ippoan/some-repo" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(502);
    const data = await res.json<{ error: string }>();
    expect(data.error).toContain("404");

    fetchSpy.mockRestore();
  });
});
