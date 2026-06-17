/**
 * `/cap-catalog` SSR page。worker は HTML を返すだけで、検索 / フィルタは
 * inline JSON + client-side JS。`CAP_CATALOG_R2` binding 経由で
 * `v1/latest.jsonl` を fetch し、failure 時は inline sample に fallback する。
 *
 * ここでは:
 *   - 200 + text/html + no-store
 *   - tab nav に cap-catalog active 表示
 *   - R2 binding 無し → sample fallback banner ("Sample fallback")
 *   - R2 binding + jsonl object あり → R2 live banner + 投入した symbol が出る
 *   - JSONL parse error 行 / 必須 field 欠落行 → 弾かれて sample fallback
 *   - 検索 input + meta + list の DOM
 * を gate する。
 */
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

interface R2GetResult {
  body?: string;
  uploaded?: Date;
}

function makeR2(map: Record<string, R2GetResult>): R2Bucket {
  return {
    get: async (key: string) => {
      const entry = map[key];
      if (!entry) return null;
      return {
        text: async () => entry.body ?? "",
        uploaded: entry.uploaded ?? new Date("2026-06-17T00:00:00Z"),
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

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

async function fetchPage(over: Partial<Env> = {}): Promise<{ res: Response; body: string }> {
  const res = await worker.fetch(
    new Request("https://x/cap-catalog"),
    testEnv(over),
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

  it("falls back to inline sample when R2 binding is absent", async () => {
    const { body } = await fetchPage();
    expect(body).toContain("Sample fallback");
    expect(body).toContain("CAP_CATALOG_R2 binding not configured");
    expect(body).toContain('id="catalog-data"');
    // sample includes the cap-catalog#18 self-dogfood SCHEMA_VERSION row
    expect(body).toContain("cap_catalog_schema::SCHEMA_VERSION");
    expect(body).toContain('"language":"rust"');
  });

  it("falls back to inline sample when R2 object is missing", async () => {
    const r2 = makeR2({});
    const { body } = await fetchPage({ CAP_CATALOG_R2: r2 });
    expect(body).toContain("Sample fallback");
    expect(body).toContain("not found");
  });

  it("uses R2 live data when v1/latest.jsonl is present", async () => {
    const jsonl = [
      JSON.stringify({
        repo: "ippoan/auth-worker",
        language: "ts",
        kind: "fn",
        name: "createAuthFetch",
        fq_path: "auth_client::createAuthFetch",
        doc: "Wraps fetch with JWT refresh.",
        features: ["auth-fetch"],
      }),
      "",  // 空行は skip される
      JSON.stringify({
        repo: "ippoan/cap-catalog",
        language: "rust",
        kind: "const",
        name: "SCHEMA_VERSION",
        fq_path: "cap_catalog_schema::SCHEMA_VERSION",
        features: ["catalog-schema"],
      }),
    ].join("\n");
    const r2 = makeR2({
      "v1/latest.jsonl": {
        body: jsonl,
        uploaded: new Date("2026-06-17T03:50:00Z"),
      },
    });
    const { body } = await fetchPage({ CAP_CATALOG_R2: r2 });
    expect(body).toContain("R2 live");
    expect(body).toContain("2026-06-17T03:50:00.000Z");
    expect(body).toContain("createAuthFetch");
    expect(body).toContain('"features":["auth-fetch"]');
  });

  it("escapes `<` in embedded JSON to prevent </script> break-out (XSS gate)", async () => {
    // Rust doc-comment 等に意図せず `</script>` / `<!--` / `<img>` が
    // 混入していても、HTML tokenizer に script close tag と認識されない
    // こと (= `<` → `<` の escape を gate)。
    const jsonl = JSON.stringify({
      repo: "ippoan/x",
      language: "rust",
      kind: "fn",
      name: "evil",
      fq_path: "x::evil",
      doc: "</script><img src=x onerror=alert(1)><!-- foo",
    });
    const r2 = makeR2({
      "v1/latest.jsonl": { body: jsonl },
    });
    const { body } = await fetchPage({ CAP_CATALOG_R2: r2 });
    // 攻撃文字列の raw `<img` / raw `<!--` は body 内に literally 出ない
    // (= HTML tokenizer から見えない)。
    expect(body).not.toContain("<img src=x onerror=");
    expect(body).not.toContain("<!-- foo");
    // doc から発生した raw `</script>` は body 中に出ない (page 自身の
    // closing tag は別物。攻撃 doc 由来の raw が無ければ XSS は不可)。
    expect(body).not.toContain("</script><img");
    // escaped 形が JSON literal 内に存在する (= client `JSON.parse` で
    // `<` に正しく戻る)。`>` は escape 不要 (= HTML tokenizer は `<` を
    // 見ないと tag を start しない)。
    expect(body).toContain("\\u003c/script>");
    expect(body).toContain("\\u003cimg src=x");
    expect(body).toContain("\\u003c!-- foo");
  });

  it("falls back when JSONL has only invalid rows", async () => {
    // 必須 field (repo) 欠落 + invalid JSON の混合 → 0 valid rows → sample fallback
    const jsonl = ["not json at all", JSON.stringify({ name: "x" })].join("\n");
    const r2 = makeR2({
      "v1/latest.jsonl": { body: jsonl },
    });
    const { body } = await fetchPage({ CAP_CATALOG_R2: r2 });
    expect(body).toContain("Sample fallback");
    expect(body).toContain("0 valid rows");
  });

  it("includes search input + result list containers", async () => {
    const { body } = await fetchPage();
    expect(body).toMatch(/<input[^>]+id="q"[^>]+type="search"/);
    expect(body).toContain('id="meta"');
    expect(body).toContain('id="list"');
  });
});
