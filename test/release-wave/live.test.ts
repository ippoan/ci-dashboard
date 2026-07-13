import { describe, it, expect } from "vitest";
import { handleReleaseWaveLiveJs } from "../../src/release-wave/live";

describe("handleReleaseWaveLiveJs (Refs #275)", () => {
  it("serves JS with a javascript content-type", async () => {
    const resp = handleReleaseWaveLiveJs();
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/javascript");
  });

  it("connects to /release-wave/ws and refreshes on message", async () => {
    const js = await handleReleaseWaveLiveJs().text();
    expect(js).toContain("/release-wave/ws");
    // WS 受信は (debounce 付き) 部分更新をスケジュールする。
    expect(js).toContain("scheduleRefresh()");
    // 切断時に自動再接続する (受け入れ条件)。
    expect(js).toContain("setTimeout(connect, 3000)");
    // proto は https のとき wss に切り替える。
    expect(js).toContain("wss:");
  });

  it("does a partial update of #rw-live via same-origin fetch, with reload fallback (Refs #479)", async () => {
    const js = await handleReleaseWaveLiveJs().text();
    // 部分更新: 現在 URL を fetch し #rw-live の中身だけ差し替える。
    expect(js).toContain("getElementById(\"rw-live\")");
    expect(js).toContain("fetch(location.href");
    expect(js).toContain("DOMParser");
    expect(js).toContain("innerHTML");
    // #rw-live を持たないページ (詳細ページ等) / 想定外レイアウトは全リロードに fallback。
    expect(js).toContain("location.reload()");
    // webhook バーストを 1 回の再取得にまとめる debounce。
    expect(js).toContain("refreshTimer");
  });
});
