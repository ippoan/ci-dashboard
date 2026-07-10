import { describe, expect, it } from "vitest";

import {
  matchPreviewHost,
  handlePreviewRouter,
  safeWorkersDevOrigin,
  safeRunAppBase,
  PREVIEW_API_BASE_COOKIE,
  type PreviewRouterEnv,
} from "../../src/release-wave/preview-router";
import type { PendingReleaseRecord } from "../../src/release-wave/pending-release";

function pending(
  repo: string,
  previewUrl: string | null,
  workerName?: string,
): PendingReleaseRecord {
  return {
    schema_version: 1,
    repo,
    ...(workerName ? { worker_name: workerName } : {}),
    version_id: "1601602a-6672-4615-bc07-0f3ec0ece237",
    tag: "v0.9.9",
    preview_url: previewUrl,
    uploaded_at: "2026-07-10T00:00:00.000Z",
  };
}

/** getPendingRelease が使う get(key, "json") だけ実装した最小 fake KV。 */
function fakeKv(entries: Record<string, PendingReleaseRecord>): KVNamespace {
  return {
    get: async (key: string) => entries[key] ?? null,
  } as unknown as KVNamespace;
}

const APPS = JSON.stringify({
  trouble: { repo: "ippoan/nuxt-trouble", backend: "ippoan/rust-alc-api" },
  dtako: {
    repo: "ohishi-exp/nuxt-dtako-admin",
    worker: "dtako-admin",
    backend: "ippoan/rust-alc-api",
  },
});

function env(
  entries: Record<string, PendingReleaseRecord>,
  apps: string | undefined = APPS,
): PreviewRouterEnv {
  return { COMPAT_KV: fakeKv(entries), PREVIEW_ROUTER_APPS: apps };
}

/** 転送 request を捕捉し固定応答を返す fetch stub。 */
function stubFetch(captured: Request[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    captured.push(input as Request);
    return new Response("upstream-body", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
}

describe("matchPreviewHost", () => {
  it("preview-<app>.ippoan.org から app 名を取り出す", () => {
    const req = new Request("https://preview-trouble.ippoan.org/tickets?p=1");
    expect(matchPreviewHost(req)).toBe("trouble");
  });

  it("preview-* 以外の hostname は null (通常 routing に流す)", () => {
    for (const u of [
      "https://ci-dashboard.ippoan.org/release-wave",
      "https://preview-x.ippoan.org.evil.example/",
      "https://xpreview-a.ippoan.org/",
      "https://preview-.ippoan.org/",
    ]) {
      expect(matchPreviewHost(new Request(u))).toBeNull();
    }
  });
});

describe("safeWorkersDevOrigin / safeRunAppBase", () => {
  it("https + *.workers.dev のみ origin を返す", () => {
    expect(
      safeWorkersDevOrigin("https://abc123-nuxt-trouble.foo.workers.dev/path"),
    ).toBe("https://abc123-nuxt-trouble.foo.workers.dev");
    expect(safeWorkersDevOrigin("http://abc.workers.dev/")).toBeNull();
    expect(safeWorkersDevOrigin("https://evil.example/")).toBeNull();
    expect(safeWorkersDevOrigin("https://evil.example/x.workers.dev")).toBeNull();
    expect(safeWorkersDevOrigin(null)).toBeNull();
    expect(safeWorkersDevOrigin("not a url")).toBeNull();
  });

  it("https + *.run.app のみ origin を返す", () => {
    expect(
      safeRunAppBase("https://v1-42-0---rust-alc-api-abc-an.a.run.app/api"),
    ).toBe("https://v1-42-0---rust-alc-api-abc-an.a.run.app");
    expect(safeRunAppBase("http://x.run.app/")).toBeNull();
    expect(safeRunAppBase("https://evil.example/")).toBeNull();
    expect(safeRunAppBase(null)).toBeNull();
  });
});

describe("handlePreviewRouter", () => {
  it("未知 app / 設定なしは 404 固定文言 (内部情報を echo しない)", async () => {
    const req = new Request("https://preview-unknown.ippoan.org/");
    const res = await handlePreviewRouter(req, env({}), "unknown", stubFetch([]));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("no pending preview");

    const res2 = await handlePreviewRouter(
      req,
      env({}, undefined),
      "trouble",
      stubFetch([]),
    );
    expect(res2.status).toBe(404);
  });

  it("pending 無し / preview_url 空は 404", async () => {
    const req = new Request("https://preview-trouble.ippoan.org/");
    const res = await handlePreviewRouter(req, env({}), "trouble", stubFetch([]));
    expect(res.status).toBe(404);

    const res2 = await handlePreviewRouter(
      req,
      env({
        "pending-release::ippoan/nuxt-trouble": pending(
          "ippoan/nuxt-trouble",
          null,
        ),
      }),
      "trouble",
      stubFetch([]),
    );
    expect(res2.status).toBe(404);
  });

  it("preview_url が workers.dev 以外なら proxy しない (open proxy 防止)", async () => {
    const captured: Request[] = [];
    const res = await handlePreviewRouter(
      new Request("https://preview-trouble.ippoan.org/"),
      env({
        "pending-release::ippoan/nuxt-trouble": pending(
          "ippoan/nuxt-trouble",
          "https://evil.example/",
        ),
      }),
      "trouble",
      stubFetch(captured),
    );
    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it("path/query を保って preview origin へ proxy し、backend pending の override cookie を注入する", async () => {
    const captured: Request[] = [];
    const res = await handlePreviewRouter(
      new Request("https://preview-trouble.ippoan.org/tickets?page=2"),
      env({
        "pending-release::ippoan/nuxt-trouble": pending(
          "ippoan/nuxt-trouble",
          "https://abc123-nuxt-trouble.foo.workers.dev",
        ),
        "pending-release::ippoan/rust-alc-api": pending(
          "ippoan/rust-alc-api",
          "https://v1-42-0---rust-alc-api-abc-an.a.run.app",
        ),
      }),
      "trouble",
      stubFetch(captured),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-body");
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      "https://abc123-nuxt-trouble.foo.workers.dev/tickets?page=2",
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(
      `${PREVIEW_API_BASE_COOKIE}=${encodeURIComponent(
        "https://v1-42-0---rust-alc-api-abc-an.a.run.app",
      )}`,
    );
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");
  });

  it("backend pending が無ければ override cookie を削除する (stale 防止)", async () => {
    const res = await handlePreviewRouter(
      new Request("https://preview-trouble.ippoan.org/"),
      env({
        "pending-release::ippoan/nuxt-trouble": pending(
          "ippoan/nuxt-trouble",
          "https://abc123-nuxt-trouble.foo.workers.dev",
        ),
      }),
      "trouble",
      stubFetch([]),
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${PREVIEW_API_BASE_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
  });

  it("backend の preview_url が run.app 以外なら cookie に載せない", async () => {
    const res = await handlePreviewRouter(
      new Request("https://preview-trouble.ippoan.org/"),
      env({
        "pending-release::ippoan/nuxt-trouble": pending(
          "ippoan/nuxt-trouble",
          "https://abc123-nuxt-trouble.foo.workers.dev",
        ),
        "pending-release::ippoan/rust-alc-api": pending(
          "ippoan/rust-alc-api",
          "https://evil.example/",
        ),
      }),
      "trouble",
      stubFetch([]),
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).not.toContain("evil.example");
    expect(cookie).toContain("Max-Age=0");
  });

  it("monorepo unit は per-worker key を優先して引く (Refs #427)", async () => {
    const captured: Request[] = [];
    const res = await handlePreviewRouter(
      new Request("https://preview-dtako.ippoan.org/"),
      env({
        // legacy repo-key は古い残骸、per-worker key が真実。
        "pending-release::ohishi-exp/nuxt-dtako-admin": pending(
          "ohishi-exp/nuxt-dtako-admin",
          "https://stale-legacy.foo.workers.dev",
        ),
        "pending-release::ohishi-exp/nuxt-dtako-admin::dtako-admin": pending(
          "ohishi-exp/nuxt-dtako-admin",
          "https://fresh-perworker.foo.workers.dev",
          "dtako-admin",
        ),
      }),
      "dtako",
      stubFetch(captured),
    );
    expect(res.status).toBe(200);
    expect(captured[0].url).toBe("https://fresh-perworker.foo.workers.dev/");
  });
});
