import { describe, it, expect } from "vitest";
import {
  needsRelease,
  renderRepoReleaseStatusSection,
  injectRepoStatusSection,
  renderCompatTagReleaseButtons,
  injectCompatTagReleaseButtons,
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

  it("filters out tagless repos entirely", () => {
    const html = renderRepoReleaseStatusSection([
      status({ repo: "ippoan/ci-dashboard", tagless: true }),
    ]);
    expect(html).not.toContain("ippoan/ci-dashboard");
    expect(html).not.toContain('action="/api/release-wave/tag-release"');
    // 全部 tagless なら一覧は空扱い
    expect(html).toContain("リリース対象の repo はありません");
  });

  it("keeps non-tagless repos while dropping tagless ones in a mixed list", () => {
    const html = renderRepoReleaseStatusSection([
      status({ repo: "ippoan/keep", hasTag: false }),
      status({ repo: "ippoan/drop", tagless: true }),
    ]);
    expect(html).toContain("ippoan/keep");
    expect(html).not.toContain("ippoan/drop");
    expect(html).toContain("未tag 1");
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
    expect(html).toContain("リリース対象の repo はありません");
  });
});

describe("injectRepoStatusSection", () => {
  it("inserts the section below Compatibility (just before the Pending releases section)", () => {
    const html =
      '<div class="section"><h2>Compatibility (all consumers)</h2></div>' +
      '<div class="section">\n      <h2>Pending releases (no-traffic)</h2></div>';
    const out = injectRepoStatusSection(html, "<!--RS-->");
    expect(out.indexOf("Compatibility")).toBeLessThan(out.indexOf("<!--RS-->"));
    expect(out.indexOf("<!--RS-->")).toBeLessThan(out.indexOf("Pending releases"));
  });

  it("falls back to after the h1 when the Pending section is missing", () => {
    const out = injectRepoStatusSection(
      "<body><h1>Release Waves</h1><table></table></body>",
      "<div>SECTION</div>",
    );
    expect(out).toContain("<h1>Release Waves</h1>\n    <div>SECTION</div>");
  });

  it("falls back to before </body> when no markers are present", () => {
    const out = injectRepoStatusSection("<body>hi</body>", "<div>SECTION</div>");
    expect(out).toContain("<div>SECTION</div>\n</body>");
  });
});

describe("renderCompatTagReleaseButtons", () => {
  it("renders one Tag Release button per repo, excluding tagless", () => {
    const html = renderCompatTagReleaseButtons(
      ["ippoan/rust-alc-api", "ippoan/auth-worker", "ippoan/ci-dashboard"],
      new Set(["ippoan/ci-dashboard"]),
    );
    expect(html).toContain("Tag Release: ippoan/rust-alc-api");
    expect(html).toContain("Tag Release: ippoan/auth-worker");
    expect(html).not.toContain("ippoan/ci-dashboard");
    expect(html).toContain('action="/api/release-wave/tag-release"');
    expect(html).toContain('name="repo" value="ippoan/auth-worker"');
  });

  it("dedupes repos", () => {
    const html = renderCompatTagReleaseButtons(
      ["ippoan/a", "ippoan/a", "ippoan/b"],
      new Set(),
    );
    expect(html.match(/Tag Release: ippoan\/a/g)?.length).toBe(1);
  });

  it("returns empty string when every repo is tagless", () => {
    const html = renderCompatTagReleaseButtons(
      ["ippoan/ci-dashboard"],
      new Set(["ippoan/ci-dashboard"]),
    );
    expect(html).toBe("");
  });

  it("returns empty string for an empty repo set", () => {
    expect(renderCompatTagReleaseButtons([], new Set())).toBe("");
  });

  it("escapes repo names", () => {
    const html = renderCompatTagReleaseButtons(['a/<b>"&'], new Set());
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("injectCompatTagReleaseButtons", () => {
  const overlay =
    'graph</svg></div>\n    <div style="margin-top:10px">\n      <strong class="meta">Staged previews (active waves)</strong></div>';

  it("inserts the buttons right before the Staged previews block", () => {
    const out = injectCompatTagReleaseButtons(overlay, "<!--BTN-->");
    expect(out).toContain("<!--BTN-->");
    expect(out.indexOf("<!--BTN-->")).toBeLessThan(
      out.indexOf("Staged previews (active waves)"),
    );
    // graph (= svg) は ボタンより前
    expect(out.indexOf("</svg>")).toBeLessThan(out.indexOf("<!--BTN-->"));
  });

  it("returns html unchanged when the block is empty", () => {
    expect(injectCompatTagReleaseButtons(overlay, "")).toBe(overlay);
  });

  it("returns html unchanged when the overlay anchor is missing", () => {
    const html = "<div>no compat overlay here</div>";
    expect(injectCompatTagReleaseButtons(html, "<!--BTN-->")).toBe(html);
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
  function memKv(seed: Record<string, unknown> = {}): KVNamespace {
    const store = new Map<string, string>(
      Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
    );
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

  it("injects the repo status section between Compatibility and Pending releases", async () => {
    // backend:: record を 1 件入れて Compatibility (all consumers) section を
    // 実際にレンダリングさせる (record が無いと俯瞰グラフ section の verdict 付き
    // 見出しは出ない)。
    const compatKv = memKv({
      "backend::ippoan/rust-alc-api": {
        schema_version: 1,
        repo: "ippoan/rust-alc-api",
        current_image: "sha-abc123",
        deployed_at: "2026-05-29T00:00:00Z",
        deployed_by: "ci",
        wave_id: null,
      },
    });
    const env = {
      ...baseEnv(),
      CI_STATUS: memKv(),
      COMPAT_KV: compatKv,
    } as unknown as Env;
    const res = await handleReleaseWaveListPageWithRepoStatus(env);
    const html = await res.text();
    expect(res.status).toBe(200);

    const compatIdx = html.indexOf("Compatibility (all consumers)");
    const repoIdx = html.indexOf("Repo リリース状況");
    const pendingIdx = html.indexOf("Pending releases");
    expect(compatIdx).toBeGreaterThanOrEqual(0);
    expect(repoIdx).toBeGreaterThanOrEqual(0);
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    // Compatibility の下、Pending releases の上に置かれる。
    expect(compatIdx).toBeLessThan(repoIdx);
    expect(repoIdx).toBeLessThan(pendingIdx);
    // discovery では repo が見つからないので空一覧コピー。
    expect(html).toContain("リリース対象の repo はありません");

    // CSP header は injection 後も維持される。
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
  });

  it("adds a Tag Release button for repos in the compatibility graph", async () => {
    const compatKv = memKv({
      "backend::ippoan/rust-alc-api": {
        schema_version: 1,
        repo: "ippoan/rust-alc-api",
        current_image: "sha-abc123",
        deployed_at: "2026-05-29T00:00:00Z",
        deployed_by: "ci",
        wave_id: null,
      },
    });
    const env = {
      ...baseEnv(),
      CI_STATUS: memKv(),
      COMPAT_KV: compatKv,
    } as unknown as Env;
    const res = await handleReleaseWaveListPageWithRepoStatus(env);
    const html = await res.text();
    expect(html).toContain("Tag Release: ippoan/rust-alc-api");
    expect(html).toContain('name="repo" value="ippoan/rust-alc-api"');
  });
});
