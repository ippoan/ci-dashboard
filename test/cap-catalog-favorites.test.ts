/**
 * `/api/cap-catalog/favorites` GET / PUT は CF Access の email header (=
 * `Cf-Access-Authenticated-User-Email`) で per-user。未認証は 401 で client は
 * localStorage fallback。
 *
 * gate するもの:
 *   - 未認証 (= header 無し) は GET / PUT どちらも 401
 *   - 認証済みで KV に entry 無し → GET は 200 + 空 payload
 *   - PUT → 同じ email で GET したら返ってくる (round-trip)
 *   - PUT body の sanitize: 配列以外の keys, 重複, MAX_KEYS 超過, MAX_KEY_LEN 超過
 *     を drop
 */
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

function testEnv(over: Partial<Env> = {}): Env {
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
    ...over,
  };
}

async function call(req: Request): Promise<Response> {
  return worker.fetch(req, testEnv(), {} as ExecutionContext);
}

describe("/api/cap-catalog/favorites", () => {
  it("GET without CF Access header → 401", async () => {
    const res = await call(new Request("https://x/api/cap-catalog/favorites"));
    expect(res.status).toBe(401);
  });

  it("PUT without CF Access header → 401", async () => {
    const res = await call(
      new Request("https://x/api/cap-catalog/favorites", {
        method: "PUT",
        body: JSON.stringify({ keys: [], favOnly: false }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("GET authed + no entry → 200 + empty payload", async () => {
    const res = await call(
      new Request("https://x/api/cap-catalog/favorites", {
        headers: { "Cf-Access-Authenticated-User-Email": "fresh@example.com" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[]; favOnly: boolean };
    expect(body.keys).toEqual([]);
    expect(body.favOnly).toBe(false);
  });

  it("PUT → GET round-trip preserves keys order + favOnly", async () => {
    const email = "round@example.com";
    const payload = {
      keys: ["ippoan/r1|rust|a::A", "ippoan/r1|rust|b::B", "ippoan/r1|rust|c::C"],
      favOnly: true,
    };
    const put = await call(
      new Request("https://x/api/cap-catalog/favorites", {
        method: "PUT",
        headers: {
          "Cf-Access-Authenticated-User-Email": email,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(put.status).toBe(200);

    const got = await call(
      new Request("https://x/api/cap-catalog/favorites", {
        headers: { "Cf-Access-Authenticated-User-Email": email },
      }),
    );
    expect(got.status).toBe(200);
    const body = (await got.json()) as { keys: string[]; favOnly: boolean };
    expect(body.keys).toEqual(payload.keys);
    expect(body.favOnly).toBe(true);
  });

  it("PUT sanitizes: drops non-string / duplicate / overlong / excess > 100", async () => {
    const email = "sanitize@example.com";
    const longKey = "x".repeat(300); // > MAX_KEY_LEN(200) → drop
    const dup = "ippoan/r1|rust|dup::Dup";
    const many = Array.from({ length: 150 }, (_, i) => `ippoan/r1|rust|k${i}::K${i}`);
    const payload = {
      keys: [dup, dup, 42, null, longKey, "", ...many],
      favOnly: "yes", // 非 boolean → false
    };
    const put = await call(
      new Request("https://x/api/cap-catalog/favorites", {
        method: "PUT",
        headers: {
          "Cf-Access-Authenticated-User-Email": email,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(put.status).toBe(200);
    const body = (await put.json()) as { keys: string[]; favOnly: boolean };
    expect(body.favOnly).toBe(false);
    // dup は 1 回だけ。non-string / longKey / 空文字は drop。total ≤ 100。
    expect(body.keys).toContain(dup);
    expect(body.keys.filter((k) => k === dup).length).toBe(1);
    expect(body.keys.length).toBeLessThanOrEqual(100);
    expect(body.keys.some((k) => k.length > 200)).toBe(false);
  });

  it("PUT with invalid JSON body → 400", async () => {
    const res = await call(
      new Request("https://x/api/cap-catalog/favorites", {
        method: "PUT",
        headers: {
          "Cf-Access-Authenticated-User-Email": "bad@example.com",
          "content-type": "application/json",
        },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed email (CR/LF, no @) with 401", async () => {
    const res = await call(
      new Request("https://x/api/cap-catalog/favorites", {
        headers: { "Cf-Access-Authenticated-User-Email": "not-an-email" },
      }),
    );
    expect(res.status).toBe(401);
  });
});
