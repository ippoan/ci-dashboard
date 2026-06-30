import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

// Mock hub: 与えられた DiscordHealRecord[] を /discord-heal-records GET で返す。
// その他の path は no-op。
function mockHub(records: unknown[]): DurableObjectStub {
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/discord-heal-records" && req.method === "GET") {
        return Response.json(records);
      }
      return new Response("OK");
    },
  } as unknown as DurableObjectStub;
}

function testEnv(hub: DurableObjectStub): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => "x" } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "y" } as unknown as SecretsStoreSecret,
    CI_HUB: { idFromName: () => ({}), get: () => hub } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => "z" } as unknown as SecretsStoreSecret,
  };
}

describe("GET /api/discord-heals (Refs #441 PR5)", () => {
  it("Hub から records をそのまま転送", async () => {
    const records = [
      {
        at: "2026-06-30T05:00:00.000Z",
        deadUrl: "https://discord.com/api/webhooks/old/****",
        newUrl: "https://discord.com/api/webhooks/new/****",
        channelName: "pr-notify",
        channelId: "9999",
        reason: "404 Unknown Webhook on send",
      },
    ];
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/api/discord-heals"),
      testEnv(mockHub(records)),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual(records);
  });

  it("空配列を返す (records 無し)", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/api/discord-heals"),
      testEnv(mockHub([])),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("/ (dashboard HTML) contains discord-heal markup (Refs #441 PR5)", () => {
  it("レンダラに `discord-heal-list` div / loadHeals 呼び出し / WS handler 分岐が入っている", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/"),
      testEnv(mockHub([])),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    // 受け皿の div
    expect(html).toContain('id="discord-heal-list"');
    // bootstrap fetch
    expect(html).toContain("loadHeals");
    expect(html).toContain("/api/discord-heals");
    // WS dispatch
    expect(html).toContain('msg.type === "discord-heal"');
    // CSS class
    expect(html).toContain(".discord-heal-item");
  });
});
