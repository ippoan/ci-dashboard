import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => "test-secret" } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "test-internal" } as unknown as SecretsStoreSecret,
    CI_HUB: {} as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => "test-webhook-secret" } as unknown as SecretsStoreSecret,
  };
}

describe("POST /api/tag-release", () => {
  it("returns 404 for GET (Hono: no GET route defined)", async () => {
    const req = new Request("http://localhost/api/tag-release");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
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

describe("POST /api/release-wave/tag-release-all (一括 tag release)", () => {
  function formReq(repos: string): Request {
    return new Request("http://localhost/api/release-wave/tag-release-all", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ repos }).toString(),
    });
  }

  it("dispatches every repo and 303-redirects on full success", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      formReq("ippoan/auth-worker,ippoan/rust-alc-api"),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/release-wave");
    // repo ごとに 1 dispatch
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/ippoan/auth-worker/actions/workflows/tag-release.yml/dispatches",
      expect.objectContaining({ method: "POST" }),
    );
    fetchSpy.mockRestore();
  });

  it("returns 502 listing failures on partial dispatch failure", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // auth-worker ok
      .mockResolvedValueOnce(new Response("boom", { status: 500 })); // rust-alc-api fail

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      formReq("ippoan/auth-worker,ippoan/rust-alc-api"),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("1/2 dispatched");
    expect(html).toContain("ippoan/rust-alc-api");
    fetchSpy.mockRestore();
  });

  it("returns 400 when no repos are provided", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(formReq(""), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});
