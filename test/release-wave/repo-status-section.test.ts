import { describe, it, expect } from "vitest";
import {
  needsRelease,
  isUpToDate,
  renderRepoReleaseStatusSection,
  injectRepoStatusSection,
  renderCompatTagReleaseButtons,
  injectCompatTagReleaseButtons,
  renderTrafficVersionsBlock,
  handleReleaseWaveListPageWithRepoStatus,
} from "../../src/release-wave/repo-status-section";
import type { TrafficRecord } from "../../src/release-wave/traffic";
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

  it("disables (inactive) the button for an up-to-date repo", () => {
    const statusByRepo = new Map([
      [
        "ippoan/rust-alc-api",
        status({ repo: "ippoan/rust-alc-api", hasTag: true, latestTag: "v0.0.75", behind: 0 }),
      ],
    ]);
    const html = renderCompatTagReleaseButtons(
      ["ippoan/rust-alc-api"],
      new Set(),
      statusByRepo,
    );
    expect(html).toContain("Tag Release: ippoan/rust-alc-api");
    expect(html).toContain("disabled");
    // 最新なので submit form は作らない
    expect(html).not.toContain('action="/api/release-wave/tag-release"');
    expect(html).toContain("最新 (v0.0.75)");
  });

  it("keeps the button active for a behind repo", () => {
    const statusByRepo = new Map([
      [
        "ippoan/auth-worker",
        status({ repo: "ippoan/auth-worker", hasTag: true, latestTag: "v0.5.0", behind: 8 }),
      ],
    ]);
    const html = renderCompatTagReleaseButtons(
      ["ippoan/auth-worker"],
      new Set(),
      statusByRepo,
    );
    expect(html).not.toContain("disabled");
    expect(html).toContain('action="/api/release-wave/tag-release"');
    expect(html).toContain('name="repo" value="ippoan/auth-worker"');
  });

  it("keeps the button active for an untagged repo", () => {
    const statusByRepo = new Map([
      ["ippoan/new", status({ repo: "ippoan/new", hasTag: false })],
    ]);
    const html = renderCompatTagReleaseButtons(["ippoan/new"], new Set(), statusByRepo);
    expect(html).not.toContain("disabled");
    expect(html).toContain('action="/api/release-wave/tag-release"');
  });

  it("keeps the button active when status is unknown (repo not in map)", () => {
    const html = renderCompatTagReleaseButtons(
      ["ippoan/unknown"],
      new Set(),
      new Map(),
    );
    expect(html).not.toContain("disabled");
    expect(html).toContain('action="/api/release-wave/tag-release"');
  });

  it("does not disable an errored repo (behind < 0)", () => {
    const statusByRepo = new Map([
      ["ippoan/err", status({ repo: "ippoan/err", hasTag: false, behind: -1 })],
    ]);
    const html = renderCompatTagReleaseButtons(["ippoan/err"], new Set(), statusByRepo);
    expect(html).not.toContain("disabled");
  });
});

describe("renderTrafficVersionsBlock", () => {
  function rec(repo: string, versions: TrafficRecord["versions"]): TrafficRecord {
    return { schema_version: 1, repo, versions, reported_at: "t" };
  }

  it("shows 100% and 0% version ids (+ deploy/upload 日時) for a repo", () => {
    const map = new Map([
      [
        "ippoan/auth-worker",
        rec("ippoan/auth-worker", [
          { version_id: "530b908c-aaaa", percentage: 100, created_on: "2026-05-28T11:37:33Z" },
          { version_id: "1a2b3c4d-bbbb", percentage: 0, created_on: "2026-05-29T07:02:27Z" },
        ]),
      ],
    ]);
    const html = renderTrafficVersionsBlock(["ippoan/auth-worker"], map);
    expect(html).toContain("Traffic (version split)");
    expect(html).toContain("ippoan/auth-worker");
    // % と version id は別セル。short id は 12 文字短縮、full id は title。
    expect(html).toContain(">100%</span>");
    expect(html).toContain(">0%</span>");
    expect(html).toContain("530b908c-aaa");
    expect(html).toContain("1a2b3c4d-bbb");
    expect(html).toContain('title="530b908c-aaaa"');
    expect(html).toContain('title="1a2b3c4d-bbbb"');
    // deploy/upload 日時 (UTC, MM-DD HH:mm)。
    expect(html).toContain("05-28 11:37");
    expect(html).toContain("05-29 07:02");
  });

  it("renders — for a version with no created_on (v1 record)", () => {
    const map = new Map([
      ["ippoan/x", rec("ippoan/x", [{ version_id: "v", percentage: 100 }])],
    ]);
    const html = renderTrafficVersionsBlock(["ippoan/x"], map);
    expect(html).toContain(">100%</span>");
    expect(html).toContain("—");
  });

  it("only lists repos that have a traffic record", () => {
    const map = new Map([
      ["ippoan/a", rec("ippoan/a", [{ version_id: "v", percentage: 100 }])],
    ]);
    const html = renderTrafficVersionsBlock(["ippoan/a", "ippoan/b"], map);
    expect(html).toContain("ippoan/a");
    expect(html).not.toContain("ippoan/b");
  });

  it("returns empty string when no repo has traffic", () => {
    expect(renderTrafficVersionsBlock(["ippoan/a"], new Map())).toBe("");
  });

  it("escapes repo names and version ids", () => {
    const map = new Map([
      ['a/<b>', rec('a/<b>', [{ version_id: '<v>', percentage: 100 }])],
    ]);
    const html = renderTrafficVersionsBlock(['a/<b>'], map);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("hides 0% versions older than the active (100%) version", () => {
    const map = new Map([
      [
        "ippoan/auth-worker",
        rec("ippoan/auth-worker", [
          { version_id: "active-id", percentage: 100, created_on: "2026-05-28T11:00:00Z" },
          { version_id: "newer-zero", percentage: 0, created_on: "2026-05-29T07:00:00Z" },
          { version_id: "older-zero", percentage: 0, created_on: "2026-05-28T02:00:00Z" },
        ]),
      ],
    ]);
    const html = renderTrafficVersionsBlock(["ippoan/auth-worker"], map);
    expect(html).toContain("active-id");
    expect(html).toContain("newer-zero"); // active より新しい 0% は出る
    expect(html).not.toContain("older-zero"); // active より古い 0% は隠す
  });

  it("shows only the newest 0% as a row and folds the rest into a summary", () => {
    const map = new Map([
      [
        "ippoan/auth-worker",
        rec("ippoan/auth-worker", [
          { version_id: "active-id", percentage: 100, created_on: "2026-05-28T00:00:00Z" },
          { version_id: "zero-newest", percentage: 0, created_on: "2026-05-29T09:00:00Z" },
          { version_id: "zero-mid", percentage: 0, created_on: "2026-05-29T08:00:00Z" },
          { version_id: "zero-old", percentage: 0, created_on: "2026-05-29T07:00:00Z" },
        ]),
      ],
    ]);
    const html = renderTrafficVersionsBlock(["ippoan/auth-worker"], map);
    // 最新 0% だけ行表示。
    expect(html).toContain("zero-newest");
    expect(html).not.toContain("zero-mid");
    expect(html).not.toContain("zero-old");
    // 残りは件数サマリ。
    expect(html).toContain("他 2 件 (no-traffic)");
  });
});

describe("isUpToDate", () => {
  it("true only when tagged and behind === 0", () => {
    expect(isUpToDate(status({ hasTag: true, latestTag: "v1.0.0", behind: 0 }))).toBe(true);
    expect(isUpToDate(status({ hasTag: true, latestTag: "v1.0.0", behind: 2 }))).toBe(false);
    expect(isUpToDate(status({ hasTag: false, behind: 0 }))).toBe(false);
    expect(isUpToDate(status({ hasTag: false, behind: -1 }))).toBe(false);
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
    // compat グラフの repo (rust-alc-api) は discovery の (d) ソースで拾われ、
    // 「Repo リリース状況」テーブルにも出る (= 空一覧ではない)。
    expect(html).toContain("ippoan/rust-alc-api");
    expect(html).not.toContain("リリース対象の repo はありません");

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

  it("shows the version traffic split under the compatibility graph", async () => {
    const compatKv = memKv({
      "backend::ippoan/rust-alc-api": {
        schema_version: 1,
        repo: "ippoan/rust-alc-api",
        current_image: "sha-abc123",
        deployed_at: "2026-05-29T00:00:00Z",
        deployed_by: "ci",
        wave_id: null,
      },
      "traffic::ippoan/rust-alc-api": {
        schema_version: 1,
        repo: "ippoan/rust-alc-api",
        versions: [
          { version_id: "full-100-id", percentage: 100 },
          { version_id: "zero-000-id", percentage: 0 },
        ],
        reported_at: "2026-05-29T00:00:00Z",
      },
    });
    const env = {
      ...baseEnv(),
      CI_STATUS: memKv(),
      COMPAT_KV: compatKv,
    } as unknown as Env;
    const res = await handleReleaseWaveListPageWithRepoStatus(env);
    const html = await res.text();
    expect(html).toContain("Traffic (version split)");
    expect(html).toContain(">100%</span>");
    expect(html).toContain("full-100-id");
    expect(html).toContain(">0%</span>");
    expect(html).toContain("zero-000-id");
    // グラフ overlay の Staged previews より前 (= グラフ直下) に出る。
    expect(html.indexOf("Traffic (version split)")).toBeLessThan(
      html.indexOf("Staged previews (active waves)"),
    );
  });
});
