import { describe, it, expect } from "vitest";
import { handleReleaseWaveLiveJs } from "../../src/release-wave/live";

describe("handleReleaseWaveLiveJs (Refs #275)", () => {
  it("serves JS with a javascript content-type", async () => {
    const resp = handleReleaseWaveLiveJs();
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/javascript");
  });

  it("connects to /release-wave/ws and reloads on message", async () => {
    const js = await handleReleaseWaveLiveJs().text();
    expect(js).toContain("/release-wave/ws");
    expect(js).toContain("location.reload()");
    // 切断時に自動再接続する (受け入れ条件)。
    expect(js).toContain("setTimeout(connect, 3000)");
    // proto は https のとき wss に切り替える。
    expect(js).toContain("wss:");
  });
});
