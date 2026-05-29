import { describe, it, expect } from "vitest";
import {
  needsRelease,
  renderRepoReleaseStatusSection,
  injectRepoStatusSection,
  handleReleaseWaveListPageWithRepoStatus,
} from "../../src/release-wave/repo-status-section";
import type { RepoReleaseStatus } from "../../src/release-wave/repo-release-status";
import type { Env } from "../../src/index";

function status(p: Partial<RepoReleaseStatus>): RepoReleaseStatus {
  return {
    repo: "ippoan/x",
    latestTag: null,
    behind: 0,
    hasTag: false,
    tagless: false,
    ...p,
  };
}

describe("needsRelease", () => {
  it("untagged (main only) repo needs release", () => {
    expect(needsRelease(status({ hasTag: false }))).toBe(true);
  });
  it("tagged repo behind main needs release", () => {
    expect(
      needsRelease(status({ hasTag: true, latestTag: "v1.0.0", behind: 3 })),
    ).toBe(true);
  });
  it("tagged + up to date does not", () => {
    expect(
      needsRelease(status({ hasTag: true, latestTag: "v1.0.0", behind: 0 })),
    ).toBe(false);
  });
  it("tagless repo never needs release", () => {
    expect(needsRelease(status({ hasTag: false, tagless: true }))).toBe(false);
  });
  it("errored repo (behind<0) does not", () => {
    expect(needsRelease(status({ behind: -1 }))).toBe(false);
  });
});

describe("renderRepoReleaseStatusSection", () => {
  it("shows untagged repo as 未tag with a Tag Release button", () => {
    const html = renderRepoReleaseStatusSection([
      status({ repo: "ippoan/foo", hasTag: false }),
    ]);
    expect(html).toContain("未tag");
    expect(html).toContain("Tag Release");
    expect(html).toContain('name="repo" value="ippoan/foo"');
    expect(html).toContain('action="/api/release-wave/tag-release"');
    expect(html).toContain("未tag 1");
  });

  it("shows tagged + up-to-date repo with the tag and no button", () => {
    const html = renderRepoReleaseStatusSection([
      status({ repo: "ippoan/bar", hasTag: true, latestTag: "v2.1.0", behind: 0 }),
    ]);
    expect(html).toContain("v2.1.0");
    expect(html).toContain("最新");
    // legend には "直接 Tag Release できる" の文言があるので、ボタンの有無は
    // form の action (= 実際の発火経路) で判定する。
    expect(html).not.toContain('action="/api/release-wave/tag-release"');
  });

  it("shows behind repo as 要リリース summary + button", () => {
    const html = renderRepoReleaseStatusSection([
      status({ repo: "ippoan/baz", hasTag: true, latestTag: "v1.0.0", behind: 5 }),
    ]);
    expect(html).toContain("5 commits 未リリース");
    expect(html).toContain("要リリース 1");
    expect(html).toContain("Tag Release");
  });

  it("marks tagless repos and does not offer a button", () => {
    const html = renderRepoReleaseStatusSection([
      status({ repo: "ippoan/ci-dashboard", tagless: true }),
    ]);
    expect(html).toContain("tagless");
    expect(html).not.toContain('action="/api/release-wave/tag-release"');
  });

  it("shows errored repo as 取得失敗 with no button", () => {
    const html = renderRepoReleaseStatusSection([
      status({ repo: "ippoan/err", behind: -1 }),
    ]);
    expect(html).toContain("取得失敗");
    expect(html).toContain("error 1");
    expect(html).not.toContain('action="/api/release-wave/tag-release"');
  });

  it("escapes repo names", () => {
    const html = renderRepoReleaseStatusSection([
      status({ repo: 'a/<b>"&', hasTag: false }),
    ]);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("handles empty repo list", () => {
    const html = renderRepoReleaseStatusSection([]);
    expect(html).toContain("監視対象 repo がありません");
  });
});

describe("injectRepoStatusSection", () => {
  it("inserts the section right after the h1", () => {
    const out = injectRepoStatusSection(
      "<body><h1>Release Waves</h1><table></table></body>",
      "<div>SECTION</div>",
    );
    expect(out).toContain("<h1>Release Waves</h1>\n    <div>SECTION</div>");
  });

  it("falls back to before </body> when the h1 marker is missing", () => {
    const out = injectRepoStatusSection("<body>hi</body>", "<div>SECTION</div>");
    expect(out).toContain("<div>SECTION</div>\n</body>");
  });
});

describe("handleReleaseWaveListPageWithRepoStatus", () => {
  function baseEnv(): Env {
    return {
      RELEASE_WAVE_HUB: {
        idFromName: () => ({}),
        get: () => ({ list: async () => [] }),
      },
      CI_HUB: {
        idFromName: () => ({}),
        get: () => ({
          // empty Hub status list — no repos discovered from this source
          fetch: async () =>
            new Response("[]", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      },
      COMPAT_KV: undefined,
    } as unknown as Env;
  }

  /** in-memory KV (allowlist / token lookups miss → discovery yields []). */
  function memKv(): KVNamespace {
    const store = new Map<string, string>();
    return {
      async get(key: string, type?: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      async list({ prefix = "" }: { prefix?: string } = {}) {
        const keys = [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((name) => ({ name }));
        return { keys, list_complete: true, cacheStatus: null };
      },
    } as unknown as KVNamespace;
  }

  it("passes the page through unchanged when CI_STATUS is unbound", async () => {
    const res = await handleReleaseWaveListPageWithRepoStatus(baseEnv());
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Release Waves");
    expect(html).not.toContain("Repo リリース状況");
  });

  it("injects the repo status section when CI_STATUS is bound", async () => {
    const env = { ...baseEnv(), CI_STATUS: memKv() } as unknown as Env;
    const res = await handleReleaseWaveListPageWithRepoStatus(env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Repo リリース状況");
    // no repos discoverable in the test env → empty-list copy
    expect(html).toContain("監視対象 repo がありません");
    // CSP header from the original page is preserved through injection.
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
  });
});
