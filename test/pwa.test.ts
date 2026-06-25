import { describe, it, expect } from "vitest";
import {
  PWA_HEAD_TAGS,
  PWA_REGISTER_SCRIPT,
  handlePwaManifest,
  handlePwaServiceWorker,
  handlePwaIcon,
} from "../src/pwa";

describe("PWA head + register snippets", () => {
  it("links the manifest and registers the service worker", () => {
    expect(PWA_HEAD_TAGS).toContain('rel="manifest"');
    expect(PWA_HEAD_TAGS).toContain('href="/manifest.webmanifest"');
    expect(PWA_HEAD_TAGS).toContain("theme-color");
    expect(PWA_REGISTER_SCRIPT).toContain('navigator.serviceWorker.register("/sw.js")');
  });
});

describe("handlePwaManifest", () => {
  it("returns a valid manifest with required PWA fields", async () => {
    const res = handlePwaManifest();
    expect(res.headers.get("Content-Type")).toContain("application/manifest+json");
    const json = await res.json() as Record<string, unknown>;
    expect(json.name).toBeTruthy();
    expect(json.short_name).toBeTruthy();
    expect(json.start_url).toBe("/");
    expect(json.display).toBe("standalone");
    expect(Array.isArray(json.icons)).toBe(true);
    const icons = json.icons as Array<{ purpose: string }>;
    expect(icons.some((i) => i.purpose.includes("any"))).toBe(true);
    expect(icons.some((i) => i.purpose.includes("maskable"))).toBe(true);
  });
});

describe("handlePwaServiceWorker", () => {
  it("returns JS with correct content-type and scope header", async () => {
    const res = handlePwaServiceWorker();
    expect(res.headers.get("Content-Type")).toContain("application/javascript");
    expect(res.headers.get("Service-Worker-Allowed")).toBe("/");
    const body = await res.text();
    expect(body).toContain("addEventListener(\"install\"");
    expect(body).toContain("addEventListener(\"fetch\"");
    // Do not intercept live endpoints.
    expect(body).toContain("/ws");
    expect(body).toContain("/mcp");
    expect(body).toContain("/webhook");
    expect(body).toContain("/api/");
  });

  it("serves only static assets cache-first; dynamic data (/snapshot) is network-first (Refs #427)", async () => {
    const body = await handlePwaServiceWorker().text();
    // cache-first 分岐は明示的な static 判定 (STATIC_ASSETS / /icons/ / manifest)
    // でガードされていること。`/snapshot` を cache-first に落とさない。
    expect(body).toContain("isStatic");
    expect(body).toContain('url.pathname.startsWith("/icons/")');
    expect(body).toContain('url.pathname === "/manifest.webmanifest"');
    // network-first の fetch().catch(cache) パターンが残っていること。
    expect(body).toMatch(/fetch\(req\)\s*\.then/);
    // 動的 JSON を cache に焼かない設計のマーカー (navigation だけ cache.put)。
    expect(body).toContain('req.mode === "navigate" && res.ok');
  });

  it("bumps CACHE_VERSION past v1 so existing clients evict the poisoned cache (Refs #427)", async () => {
    const body = await handlePwaServiceWorker().text();
    expect(body).toContain("ci-dashboard-v2");
    expect(body).not.toContain("ci-dashboard-v1");
  });
});

describe("handlePwaIcon", () => {
  it("returns SVG with svg+xml content-type", async () => {
    const res = handlePwaIcon("/icons/icon.svg");
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body.startsWith("<svg")).toBe(true);
  });

  it("returns the maskable variant for the maskable path", async () => {
    const normal = await handlePwaIcon("/icons/icon.svg").text();
    const maskable = await handlePwaIcon("/icons/icon-maskable.svg").text();
    expect(normal).not.toBe(maskable);
    expect(maskable).toContain("scale(0.8)");
  });
});
