import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { isTagless, detectReleaseModel, isTaglessRepo } from "../src/release-model";

// release-cache.test.ts と同方式: github-api は mock せず real のまま、global
// fetch を stub して GitHub contents 応答を差し替える (workers pool は module
// mock が効かないため)。detectReleaseModel は token を引数で受けるので
// tokenForOrg (OAuth/KV 依存) を経由せず検出ロジックだけ単体テストできる。

/** UTF-8 → GitHub contents 互換 base64。 */
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** path 別に Response を返す fetch stub を仕込む。 */
function stubContents(handler: (path: string) => Response): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(new URL(url).pathname);
  });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isTagless (pure)", () => {
  it("wave も npm も無ければ tagless", () => {
    expect(isTagless({ wave: false, npm: false })).toBe(true);
  });
  it("wave あれば tracked", () => {
    expect(isTagless({ wave: true, npm: false })).toBe(false);
  });
  it("npm あれば tracked", () => {
    expect(isTagless({ wave: false, npm: true })).toBe(false);
  });
  it("両方あっても tracked", () => {
    expect(isTagless({ wave: true, npm: true })).toBe(false);
  });
});

describe("detectReleaseModel (config 自動判定)", () => {
  it("release-wave.yml あり → wave:true", async () => {
    stubContents((path) =>
      path.endsWith("release-wave.yml")
        ? Response.json({ type: "file" })
        : notFound(),
    );
    expect(await detectReleaseModel("tok", "ippoan", "x")).toEqual({
      wave: true,
      npm: false,
    });
  });

  it("publish 可能な package.json → npm:true", async () => {
    stubContents((path) =>
      path.endsWith("package.json")
        ? Response.json({ content: b64(JSON.stringify({ name: "@ippoan/x" })) })
        : notFound(),
    );
    expect(await detectReleaseModel("tok", "ippoan", "x")).toEqual({
      wave: false,
      npm: true,
    });
  });

  it("private:true の package.json → npm:false (= tagless)", async () => {
    stubContents((path) =>
      path.endsWith("package.json")
        ? Response.json({ content: b64(JSON.stringify({ name: "x", private: true })) })
        : notFound(),
    );
    expect((await detectReleaseModel("tok", "ippoan", "x")).npm).toBe(false);
  });

  it("name 無し package.json → npm:false", async () => {
    stubContents((path) =>
      path.endsWith("package.json")
        ? Response.json({ content: b64(JSON.stringify({ version: "1.0.0" })) })
        : notFound(),
    );
    expect((await detectReleaseModel("tok", "ippoan", "x")).npm).toBe(false);
  });

  it("両方 404 → wave:false npm:false (= tagless)", async () => {
    stubContents(() => notFound());
    expect(await detectReleaseModel("tok", "ippoan", "x")).toEqual({
      wave: false,
      npm: false,
    });
  });

  it("wave あり + npm あり → 両方検出", async () => {
    stubContents((path) => {
      if (path.endsWith("release-wave.yml")) return Response.json({ type: "file" });
      if (path.endsWith("package.json")) {
        return Response.json({ content: b64(JSON.stringify({ name: "@ippoan/x" })) });
      }
      return notFound();
    });
    expect(await detectReleaseModel("tok", "ippoan", "x")).toEqual({
      wave: true,
      npm: true,
    });
  });
});

describe("isTaglessRepo", () => {
  it("token 取得不能 (test env に DCR 無し) → false (判定不能は tracked 側 = 一覧に出す)", async () => {
    // tokenForOrg → getGitHubToken は test env では token を解決できず throw する。
    // isTaglessRepo は catch して false (tracked) を返す。
    expect(await isTaglessRepo(env as never, env.CI_STATUS, "ippoan/x")).toBe(false);
  });

  it("TAGLESS_REPOS に列挙された repo は auto-detect (token 取得含む) より先に true を返す (manual override)", async () => {
    // token 解決すら試みない (fetch を一切呼ばずに true が返る) ことを、
    // stub 未設定のまま確認する。
    const overrideEnv = { ...env, TAGLESS_REPOS: "ippoan/mcp-cf-workers" };
    expect(
      await isTaglessRepo(overrideEnv as never, env.CI_STATUS, "ippoan/mcp-cf-workers"),
    ).toBe(true);
  });

  it("TAGLESS_REPOS に無い repo は従来どおり auto-detect (token 取得不能 → false) に委ねる", async () => {
    const overrideEnv = { ...env, TAGLESS_REPOS: "ippoan/mcp-cf-workers" };
    expect(
      await isTaglessRepo(overrideEnv as never, env.CI_STATUS, "ippoan/other"),
    ).toBe(false);
  });
});
