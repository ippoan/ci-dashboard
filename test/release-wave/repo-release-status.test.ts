import { describe, it, expect } from "vitest";
import { behindFromCompare } from "../../src/release-wave/repo-release-status";

// 要リリース判定の誤検知修正 (Refs #483):
// commit は積まれても tree 差分がゼロ (revert ペア) なら「最新」扱いにする。
describe("behindFromCompare", () => {
  it("通常の未リリース commit はそのまま数える", () => {
    expect(behindFromCompare({ commits: [{}, {}, {}], files: [{}, {}] })).toBe(3);
  });

  it("差分ゼロ (revert ペア等): commit があっても files が空なら 0 = 最新扱い", () => {
    expect(behindFromCompare({ commits: [{}, {}], files: [] })).toBe(0);
  });

  it("files 欠落 (旧 KV キャッシュ) は commit 数に fallback (誤って最新にしない)", () => {
    expect(behindFromCompare({ commits: [{}, {}] })).toBe(2);
  });

  it("commit ゼロは files に関わらず 0", () => {
    expect(behindFromCompare({ commits: [], files: [] })).toBe(0);
    expect(behindFromCompare({ commits: [] })).toBe(0);
  });
});
