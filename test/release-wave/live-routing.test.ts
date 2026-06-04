import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/index";

// /release-wave/ws と /release-wave/live.js が動的 `:wave_id` route に捕捉されず、
// 静的 route として解決されることを worker レベルで確認する (Refs #275)。
function testEnv(hubFetch: (req: Request) => Promise<Response>): Env {
  return {
    RELEASE_WAVE_HUB: {
      idFromName: () => ({}),
      get: () => ({ fetch: hubFetch }),
    } as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

describe("release-wave live routes (Refs #275)", () => {
  it("GET /release-wave/live.js serves JS without hitting the DO", async () => {
    const hubFetch = vi.fn(async () => new Response("should-not-be-called"));
    const req = new Request("http://localhost/release-wave/live.js");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(hubFetch), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/javascript");
    expect(hubFetch).not.toHaveBeenCalled();
    expect(await res.text()).toContain("/release-wave/ws");
  });

  it("GET /release-wave/ws proxies to the DO with pathname rewritten to /ws", async () => {
    let seenPath = "";
    // 実 DO は 101 + webSocket を返すが、test 境界で webSocket は扱えないので
    // marker 付き 200 を返して「proxy に解決された + path 書き換え」だけ検証する。
    const hubFetch = vi.fn(async (req: Request) => {
      seenPath = new URL(req.url).pathname;
      return new Response("proxied", { headers: { "x-from-do": "1" } });
    });
    const req = new Request("http://localhost/release-wave/ws", {
      headers: { Upgrade: "websocket" },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(hubFetch), ctx);
    await waitOnExecutionContext(ctx);
    expect(hubFetch).toHaveBeenCalledOnce();
    // DO 側 fetch は pathname === "/ws" で受理するので、proxy が書き換えていること。
    expect(seenPath).toBe("/ws");
    // 動的 `:wave_id` ではなく proxy に解決された (= DO の応答が返る)。
    expect(res.headers.get("x-from-do")).toBe("1");
  });
});
