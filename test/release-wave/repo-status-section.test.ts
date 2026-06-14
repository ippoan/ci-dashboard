import { describe, it, expect } from "vitest";
import {
  needsRelease,
  isUpToDate,
  renderRepoReleaseStatusSection,
  injectRepoStatusSection,
  renderCompatTagReleaseButtons,
  injectCompatTagReleaseButtons,
  renderTrafficVersionsBlock,
  renderBackendRollbackBlock,
  renderFlipGuardSelfTest,
  handleReleaseWaveListPageWithRepoStatus,
} from "../../src/release-wave/repo-status-section";
import type { TrafficRecord } from "../../src/release-wave/traffic";
import type { WaveCompatibility } from "../../src/release-wave/compat";
import type { BackendTrafficRecord } from "../../src/release-wave/backend-traffic";
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

describe("renderFlipGuardSelfTest", () => {
  it("renders an active button with data-flipguard attrs when a sample is given", () => {
    const html = renderFlipGuardSelfTest({
      repo: "ippoan/nuxt-items",
      versionId: "bc961392-b62f-47e8-88c4-64d53fce1713",
    });
    expect(html).toContain("flip ガードを試す");
    expect(html).toContain('data-flipguard-repo="ippoan/nuxt-items"');
    expect(html).toContain('data-flipguard-vid="bc961392-b62f-47e8-88c4-64d53fce1713"');
    expect(html).toContain("flipguard-result");
    expect(html).not.toContain("disabled");
    // repo の git tag (Repo リリース状況の未tag) とは別概念だと明記している
    expect(html).toContain("release tag 未紐付け CF version");
    expect(html).toContain("Repo リリース状況");
  });

  it("renders a disabled button (no data-flipguard) when no sample is given", () => {
    const html = renderFlipGuardSelfTest();
    // UI は出るがボタンは disabled・押せない
    expect(html).toContain("flip ガードを試す");
    expect(html).toContain("disabled");
    expect(html).toContain("テスト対象なし");
    // 押下対象が無いので data-flipguard は付けない (live.js が拾わない)
    expect(html).not.toContain("data-flipguard-repo");
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

  // flip ガード self-test は version-level の話なので「Repo リリース状況」表には
  // 出さない (repo-level の『未tag』と紛らわしいため)。
  it("does not embed the flip-guard self-test in the Repo リリース状況 section", () => {
    const html = renderRepoReleaseStatusSection([
      status({ repo: "ippoan/foo", hasTag: true, latestTag: "v1.0.0", behind: 0 }),
    ]);
    expect(html).not.toContain("data-flipguard-repo");
    expect(html).not.toContain("flip ガードを試す");
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

  it("renders a 一括 Tag Release all button for 2+ releasable repos", () => {
    const html = renderCompatTagReleaseButtons(
      ["ippoan/a", "ippoan/b", "ippoan/c"],
      new Set(),
    );
    expect(html).toContain("⚡ Tag Release all (3)");
    expect(html).toContain('action="/api/release-wave/tag-release-all"');
    // hidden field に release 可能 repo を sort 済みカンマ区切りで載せる
    expect(html).toContain('name="repos" value="ippoan/a,ippoan/b,ippoan/c"');
  });

  it("excludes up-to-date repos from the 一括 Tag Release all set", () => {
    const statusByRepo = new Map([
      ["ippoan/a", status({ repo: "ippoan/a", hasTag: true, latestTag: "v1", behind: 0 })],
      ["ippoan/b", status({ repo: "ippoan/b", hasTag: true, latestTag: "v1", behind: 3 })],
      ["ippoan/c", status({ repo: "ippoan/c", hasTag: true, latestTag: "v1", behind: 5 })],
    ]);
    const html = renderCompatTagReleaseButtons(
      ["ippoan/a", "ippoan/b", "ippoan/c"],
      new Set(),
      statusByRepo,
    );
    // a は最新なので一括対象から外れ、b/c の 2 件だけ
    expect(html).toContain("⚡ Tag Release all (2)");
    expect(html).toContain('name="repos" value="ippoan/b,ippoan/c"');
  });

  it("omits the 一括 Tag Release all button when only one repo is releasable", () => {
    const html = renderCompatTagReleaseButtons(["ippoan/only"], new Set());
    expect(html).not.toContain("Tag Release all");
    expect(html).toContain("Tag Release: ippoan/only");
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

  it("shows the per-version git tag next to the version id", () => {
    const map = new Map([
      [
        "ippoan/auth-worker",
        rec("ippoan/auth-worker", [
          { version_id: "deployed-id", percentage: 100, created_on: "2026-05-28T11:00:00Z", tag: "v0.2.42" },
          { version_id: "uploaded-id", percentage: 0, created_on: "2026-05-29T08:00:00Z", tag: "v0.2.43" },
        ]),
      ],
    ]);
    const html = renderTrafficVersionsBlock(["ippoan/auth-worker"], map);
    // 100% (deployed) と 0% (uploaded) で別 tag が出る。
    expect(html).toContain("v0.2.42");
    expect(html).toContain("v0.2.43");
    expect(html).toContain("deployed-id");
    expect(html).toContain("uploaded-id");
  });

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

  it("shows only the newest 0% as a row and folds the rest into the % cell", () => {
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
    // 残り件数は % セルに「(他N件)」併記 (別サマリ行ではない)。
    expect(html).toContain("(他2件)");
    // 0% (最新) が 100% (より古い active) より上に来る (日時降順)。
    expect(html.indexOf("zero-newest")).toBeLessThan(html.indexOf("active-id"));
  });

  it("renders a Rollback button for prior deployed versions (Refs #196)", () => {
    const r: TrafficRecord = {
      schema_version: 4,
      repo: "ippoan/auth-worker",
      versions: [{ version_id: "cur", percentage: 100, tag: "v0.2.50" }],
      deploy_history: [
        { version_id: "cur", tag: "v0.2.50", became_active_at: "2026-05-29T09:30:00Z" },
        { version_id: "prev", tag: "v0.2.49", became_active_at: "2026-05-28T11:37:00Z" },
      ],
      reported_at: "t",
    };
    const html = renderTrafficVersionsBlock(["ippoan/auth-worker"], new Map([["ippoan/auth-worker", r]]));
    expect(html).toContain("/api/release-wave/traffic-rollback");
    // list + button 形式: select の option に過去 version、ボタンは 1 つ。
    expect(html).toContain('<select name="version_id"');
    expect(html).toContain('<option value="prev"');
    expect(html).toContain("v0.2.49 (");
    // 現 active (cur) は戻し先候補にしない (option に出さない)。
    expect(html).not.toContain('value="cur"');
    // rollback は version 行と同じ行 (Rollback 列の rowspan セル) に並ぶ。
    // 旧実装の別 colspan 行は廃止した。
    expect(html).toContain("<th>Rollback</th>");
    expect(html).toContain('<td rowspan="1">');
    expect(html).not.toContain('colspan="3"');
  });

  it("renders no Rollback button when deploy_history has only the active version", () => {
    const r: TrafficRecord = {
      schema_version: 4,
      repo: "ippoan/x",
      versions: [{ version_id: "cur", percentage: 100 }],
      deploy_history: [{ version_id: "cur", tag: null, became_active_at: "t" }],
      reported_at: "t",
    };
    const html = renderTrafficVersionsBlock(["ippoan/x"], new Map([["ippoan/x", r]]));
    expect(html).not.toContain("/api/release-wave/traffic-rollback");
  });

  it("no longer renders a Flip button in the Traffic section for no-traffic 0% versions (moved to Pending releases, Refs #237)", () => {
    // 現 active 1 つ + 0% no-traffic のみ。deploy_history は現 active だけなので
    // 過去 active への rollback 候補は 0 件。0% no-traffic version の flip は
    // 「Pending releases」セクションに一本化した (#237) ので、Traffic セクションの
    // 本ブロックには flip ボタンも、戻し先ゼロの rollback 行も出ない。
    const r: TrafficRecord = {
      schema_version: 4,
      repo: "ippoan/auth-worker",
      versions: [
        { version_id: "active-id", percentage: 100, created_on: "2026-05-28T11:37:00Z", tag: "v0.2.48" },
        { version_id: "pending-id", percentage: 0, created_on: "2026-05-29T09:07:00Z", tag: "v0.2.49" },
      ],
      deploy_history: [
        { version_id: "active-id", tag: "v0.2.48", became_active_at: "2026-05-28T11:37:00Z" },
      ],
      reported_at: "t",
    };
    const html = renderTrafficVersionsBlock(
      ["ippoan/auth-worker"],
      new Map([["ippoan/auth-worker", r]]),
    );
    // 0% no-traffic version は version split の行としては引き続き表示される。
    expect(html).toContain("pending-id");
    expect(html).toContain("v0.2.49");
    // が、Traffic セクションからの flip 経路 (二重表示の片割れ) は撤去された。
    expect(html).not.toContain("no-traffic version を 100% に flip:");
    expect(html).not.toContain('action="/api/release-wave/traffic-rollback"');
    expect(html).not.toContain('value="pending-id"');
    // 過去 active への rollback 候補が無いので rollback 行自体も出ない。
    expect(html).not.toContain("Rollback to (過去の deployed version):");
  });
});

describe("renderBackendRollbackBlock", () => {
  function compat(backends: WaveCompatibility["backends"]): WaveCompatibility {
    return { verified: true, checked: true, backends };
  }

  it("renders the current active row (100% + tag + image sha + deployed) and Rollback buttons for prior Cloud Run revisions (Refs #197)", () => {
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "rust-alc-api-00042-abc",
          current_tag: "v1.4.2",
          deployed_at: "2026-05-29T09:30:00Z",
          deploy_history: [
            { image: "rust-alc-api-00042-abc", tag: "v1.4.2", became_active_at: "2026-05-29T09:30:00Z" },
            { image: "rust-alc-api-00041-xyz", tag: "v1.4.1", became_active_at: "2026-05-28T11:37:00Z" },
          ],
          matrix: [],
        },
      ]),
    );
    expect(html).toContain("Backend traffic / rollback (Cloud Run revision)");
    // 現 active 行: 100% badge + tag (ver) + image sha (full は title) + deployed。
    expect(html).toContain(">100%</span>");
    expect(html).toContain("v1.4.2");
    expect(html).toContain('title="rust-alc-api-00042-abc"'); // image full は hover
    expect(html).toContain("05-29 09:30"); // deployed (UTC, MM-DD HH:mm)
    // rollback 行: list + button 形式 (select の option に過去 revision)。
    expect(html).toContain("/api/release-wave/backend-rollback");
    expect(html).toContain('<select name="image"');
    expect(html).toContain('<option value="rust-alc-api-00041-xyz"');
    expect(html).toContain("v1.4.1 (");
    // 現 active (00042) は戻し先候補にしない (option value に出さない)。
    expect(html).not.toContain('value="rust-alc-api-00042-abc"');
    // rollback は traffic/fallback 行と同じ行 (Rollback 列) に並ぶ。
    // 旧実装の別 colspan 行は廃止した。
    expect(html).toContain("<th>Rollback</th>");
    expect(html).not.toContain('colspan="3"');
  });

  it("shows the current active row even without rollback candidates (deploy 直後で履歴 1 件)", () => {
    // 過去 active が無くても image sha / tag / 100% / deployed は出す。従来はここで
    // "" を返して Cloud Run repo が丸ごと不可視だった (ver も sha も traffic も
    // 見えない、が今回の修正動機)。
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "c1b3e5146b15deadbeef",
          current_tag: null,
          deployed_at: "2026-06-03T15:00:00Z",
          deploy_history: [
            { image: "c1b3e5146b15deadbeef", tag: null, became_active_at: "2026-06-03T15:00:00Z" },
          ],
          matrix: [],
        },
      ]),
    );
    expect(html).toContain("Backend traffic / rollback (Cloud Run revision)");
    expect(html).toContain(">100%</span>");
    expect(html).toContain("c1b3e5146b15"); // image sha short 表示 (12 文字)
    expect(html).toContain('title="c1b3e5146b15deadbeef"'); // full は hover
    expect(html).toContain("06-03 15:00"); // deployed (UTC)
    // 過去 revision が無いので rollback ボタンは出さない。
    expect(html).not.toContain("/api/release-wave/backend-rollback");
  });

  it("renders — for deployed_at when the record has no timestamp", () => {
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: "ippoan/x",
          current_image: "img-1",
          current_tag: "v0.1.0",
          deployed_at: null,
          deploy_history: [],
          matrix: [],
        },
      ]),
    );
    expect(html).toContain(">100%</span>");
    expect(html).toContain("v0.1.0");
    expect(html).toContain("—"); // deployed_at 無し → "—"
  });

  it("returns empty string when a backend record has no current_image", () => {
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: null,
          current_tag: null,
          deployed_at: null,
          deploy_history: [],
          matrix: [],
        },
      ]),
    );
    expect(html).toBe("");
  });

  it("escapes repo names, tags and image ids", () => {
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: 'a/<b>"&',
          current_image: "<img>",
          current_tag: "<tag>",
          deployed_at: "2026-06-03T15:00:00Z",
          deploy_history: [
            { image: "<img>", tag: "<tag>", became_active_at: "2026-06-03T15:00:00Z" },
          ],
          matrix: [],
        },
      ]),
    );
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;img&gt;");
    expect(html).not.toContain("<tag>");
    expect(html).toContain("&lt;tag&gt;");
  });

  it("renders the real traffic split (100% active + pending 0%) when backend-traffic exists", () => {
    const trafficByRepo = new Map<string, BackendTrafficRecord>([
      [
        "ippoan/rust-alc-api",
        {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          services: [
            {
              service: "rust-alc-api",
              revisions: [
                { revision: "rust-alc-api-00042-abc", percent: 100, tag: "v1.4.2" },
                { revision: "rust-alc-api-00043-xyz", percent: 0, tag: "pending-v1-4-3" },
              ],
            },
          ],
          reported_at: "2026-06-04T00:00:00Z",
        },
      ],
    ]);
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "v1.4.2",
          current_tag: "v1.4.2",
          deployed_at: "2026-06-03T00:00:00Z",
          deploy_history: [],
          matrix: [],
        },
      ]),
      trafficByRepo,
    );
    // 実 traffic split: 100% active + 0% pending の 2 revision が並ぶ。
    expect(html).toContain(">100%</span>");
    expect(html).toContain(">0%</span>");
    expect(html).toContain('title="rust-alc-api-00042-abc"'); // revision full は hover
    expect(html).toContain(">00042-abc</code>"); // service prefix を剥がした revision 番号 (Refs #256)
    expect(html).toContain('title="rust-alc-api-00043-xyz"');
    expect(html).toContain("pending-v1-4-3"); // revision tag
  });

  it("prefixes the service name when a repo has multiple services", () => {
    const trafficByRepo = new Map<string, BackendTrafficRecord>([
      [
        "ippoan/rust-alc-api",
        {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          services: [
            { service: "rust-alc-api", revisions: [{ revision: "api-1", percent: 100, tag: null }] },
            { service: "rust-alc-api-gateway", revisions: [{ revision: "gw-1", percent: 100, tag: null }] },
          ],
          reported_at: "t",
        },
      ],
    ]);
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "x",
          current_tag: null,
          deployed_at: null,
          deploy_history: [],
          matrix: [],
        },
      ]),
      trafficByRepo,
    );
    expect(html).toContain("rust-alc-api-gateway"); // 複数 service は service 名を前置
    expect(html).toContain("api-1");
    expect(html).toContain("gw-1");
  });

  it("falls back to the current_image row when no backend-traffic is given", () => {
    // trafficByRepo を渡さない → current_image を 100% で表示 (PR #258 の挙動)。
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "c1b3e5146b15deadbeef",
          current_tag: "v1.4.2",
          deployed_at: "2026-06-03T15:00:00Z",
          deploy_history: [],
          matrix: [],
        },
      ]),
    );
    expect(html).toContain(">100%</span>");
    expect(html).toContain('title="c1b3e5146b15deadbeef"');
    expect(html).toContain("v1.4.2");
  });

  it("excludes CF Workers backends (workerRepos) from the Cloud Run section (Refs #268)", () => {
    // auth-worker は CF Worker だが compat 上は backend (frontend が互換性テスト
    // する対象) なので backend record を持つ。Cloud Run revision section には
    // 出さず、上の version split section に任せる。
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: "ippoan/auth-worker",
          current_image: "v0.2.52",
          current_tag: "v0.2.52",
          deployed_at: "2026-06-03T23:52:00Z",
          deploy_history: [],
          matrix: [],
        },
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "rust-alc-api-00042-abc",
          current_tag: "v1.4.2",
          deployed_at: "2026-06-03T15:00:00Z",
          deploy_history: [],
          matrix: [],
        },
      ]),
      undefined,
      new Set(["ippoan/auth-worker"]),
    );
    // Cloud Run backend (rust-alc-api) は出るが、CF Worker (auth-worker) は出ない。
    expect(html).toContain("ippoan/rust-alc-api");
    expect(html).not.toContain("ippoan/auth-worker");
  });

  it("renders the whole block empty when every backend is a CF Worker (Refs #268)", () => {
    const html = renderBackendRollbackBlock(
      compat([
        {
          backend_repo: "ippoan/auth-worker",
          current_image: "v0.2.52",
          current_tag: "v0.2.52",
          deployed_at: "2026-06-03T23:52:00Z",
          deploy_history: [],
          matrix: [],
        },
      ]),
      undefined,
      new Set(["ippoan/auth-worker"]),
    );
    // 全 backend が CF Worker なら section ごと出さない。
    expect(html).toBe("");
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
