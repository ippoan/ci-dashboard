import { describe, it, expect } from "vitest";
import { handleDashboard } from "../src/dashboard";

describe("handleDashboard", () => {
  it("renders the dashboard shell", async () => {
    const resp = handleDashboard();
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
    const html = await resp.text();
    expect(html).toContain("CI Dashboard");
  });

  it("disables caching so the page is never stale (no-store)", () => {
    // 「毎回キャッシュが残ってうざい」対策: ブラウザ/bfcache に残さず、
    // 再訪・リロードで必ず最新の HTML/JS を読ませる。
    const resp = handleDashboard();
    expect(resp.headers.get("Cache-Control")).toContain("no-store");
  });

  it("renders a hard-reset refresh button linking back to itself", async () => {
    const html = await handleDashboard().text();
    expect(html).toContain('<a class="refresh-btn" href="/"');
    expect(html).toContain("更新（ハードリセット）");
  });
});
