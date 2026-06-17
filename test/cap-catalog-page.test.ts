/**
 * `/cap-catalog` は preview SSR page。worker は HTML を返すだけで、検索 /
 * フィルタは inline JSON + client-side JS。ここでは:
 *   - 200 + text/html + no-store
 *   - tab nav に cap-catalog active 表示
 *   - sample JSON が catalog-data script に埋め込まれている
 *   - 検索 input + meta + list の DOM が出ている
 * を gate する。実 catalog データ (R2 / artifact fetch) は別 PR で配線するので、
 * ここでは "preview" banner と sample 1 行の存在まで確認する。
 */
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
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
    RELEASE_WAVE_HUB: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("OK") }),
    } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: {
      get: async () => "test-webhook-secret",
    } as unknown as SecretsStoreSecret,
  };
}

async function fetchPage(): Promise<{ res: Response; body: string }> {
  const res = await worker.fetch(
    new Request("https://x/cap-catalog"),
    testEnv(),
    {} as ExecutionContext,
  );
  const body = await res.text();
  return { res, body };
}

describe("GET /cap-catalog", () => {
  it("returns 200 HTML with no-store caching", async () => {
    const { res } = await fetchPage();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("renders cap-catalog tab as active", async () => {
    const { body } = await fetchPage();
    expect(body).toMatch(/href="\/cap-catalog"[^>]*class="tab tab-active"/);
  });

  it("inlines sample symbols as JSON", async () => {
    const { body } = await fetchPage();
    // script tag with the catalog-data id
    expect(body).toContain('id="catalog-data"');
    // at least one expected sample symbol (from cap-catalog#18 self-dogfood)
    expect(body).toContain("cap_catalog_schema::SCHEMA_VERSION");
    expect(body).toContain('"language":"rust"');
  });

  it("includes search input + result list containers", async () => {
    const { body } = await fetchPage();
    expect(body).toMatch(/<input[^>]+id="q"[^>]+type="search"/);
    expect(body).toContain('id="meta"');
    expect(body).toContain('id="list"');
  });

  it("flags preview status banner", async () => {
    const { body } = await fetchPage();
    expect(body).toMatch(/Preview/);
  });
});
