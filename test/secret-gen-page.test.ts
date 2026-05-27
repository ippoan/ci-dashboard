/**
 * `/secret-gen` is fully client-rendered — the worker only serves static
 * HTML + a tiny crypto.getRandomValues helper, so these specs assert the
 * page wires up the controls and never accidentally executes generation
 * server-side (no Math.random, no body bytes echoed from any binding).
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
  };
}

async function fetchPage(): Promise<{ res: Response; body: string }> {
  const res = await worker.fetch(
    new Request("https://x/secret-gen"),
    testEnv(),
    {} as ExecutionContext,
  );
  const body = await res.text();
  return { res, body };
}

describe("GET /secret-gen", () => {
  it("returns 200 HTML with no-store caching", async () => {
    const { res } = await fetchPage();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("renders the four output formats and the byte-count input", async () => {
    const { body } = await fetchPage();
    expect(body).toContain('id="bytes"');
    expect(body).toContain('id="format"');
    expect(body).toContain('value="hex"');
    expect(body).toContain('value="base64url"');
    expect(body).toContain('value="base64"');
    expect(body).toContain('value="alnum"');
  });

  it("wires the generate + copy buttons to client-side handlers", async () => {
    const { body } = await fetchPage();
    expect(body).toContain('id="regen"');
    expect(body).toContain('id="copy"');
    expect(body).toContain("crypto.getRandomValues");
    expect(body).toContain("navigator.clipboard");
  });

  it("never reaches for Math.random on the server or in the shipped script", async () => {
    const { body } = await fetchPage();
    // Defence in depth — Math.random would silently weaken the value if a
    // future refactor moved generation out of crypto.getRandomValues.
    expect(body).not.toContain("Math.random");
  });

  it("marks the Secret Generator tab as active", async () => {
    const { body } = await fetchPage();
    // The shared tab strip flips a `tab-active` class on the current page;
    // existing pages assert the same way (see issues-page.test.ts).
    expect(body).toMatch(/tab tab-active[^>]*>\s*🔐 Secret Generator/);
  });
});

describe("nav tab presence on other pages", () => {
  it("dashboard renders the Secret Generator link", async () => {
    const res = await worker.fetch(
      new Request("https://x/"),
      testEnv(),
      {} as ExecutionContext,
    );
    const body = await res.text();
    expect(body).toContain('href="/secret-gen"');
    expect(body).toContain("🔐 Secret Generator");
  });
});
