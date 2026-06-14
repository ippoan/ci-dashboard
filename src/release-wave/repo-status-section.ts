/**
 * Release Wave 一覧ページに「Repo リリース状況」セクションを足す薄い wrapper。
 *
 * 監視対象 repo の tag 有無 (tag あり / 未tag) と main HEAD からの乖離を一覧し、
 * 未tag (main しか無い) repo や tag が離れた repo を直接 Tag Release できる
 * ボタンを出す (tag 採番は各 repo の tag-release.yml workflow 側)。
 *
 * tagless repo (TAGLESS_REPOS) は「リリース対象」ではないので一覧から除外する。
 *
 * 配置: page.ts の template を直接いじらず、レンダリング済み HTML の
 * Compatibility section 直後 (= Pending releases section の直前) に string 注入
 * する。これは:
 *   - page.ts が CSP header と COMMON_STYLES (badge / actions 等) を所有しており、
 *     同じページに足せば追加 CSS / header 変更が不要なため。
 *   - section は strict CSP (`default-src 'none'`, JS 無効) でも動くよう、素の
 *     <form method="post"> + inline style だけで構成する (page.ts の他 action と同じ)。
 */

import type { Env } from "../index";
import { handleReleaseWaveListPage, helpMark } from "./page";
import {
  getRepoReleaseStatuses,
  type RepoReleaseStatus,
} from "./repo-release-status";
import {
  computeGlobalCompatibility,
  type WaveCompatibility,
  type WaveBackendCompat,
} from "./compat";
import {
  getBackendTrafficForRepos,
  type BackendTrafficRecord,
} from "./backend-traffic";
import { parseTaglessRepos } from "../tagless-repos";
import {
  getTrafficForRepos,
  type TrafficRecord,
  type TrafficVersion,
} from "./traffic";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** release を促すべき repo か (未tag、または tag が main から離れている)。 */
export function needsRelease(s: RepoReleaseStatus): boolean {
  if (s.behind < 0) return false; // 取得失敗
  if (s.tagless) return false; // tag を打たない方針の repo
  if (!s.hasTag) return true; // 未tag = main しか無い
  return s.behind > 0; // tag が main から離れている
}

const GREEN = "#188038";
const RED = "#d93025";
const AMBER = "#f29900";
const GRAY = "#9aa0a6";
const DARKGRAY = "#5f6368";

/** 監視対象 repo の tag 状況テーブル + サマリを HTML で返す (tagless は除外)。 */
export function renderRepoReleaseStatusSection(
  statuses: RepoReleaseStatus[],
): string {
  // tagless repo はリリース対象ではないので一覧から除外する。
  const visible = statuses.filter((s) => !s.tagless);

  const counts = { untagged: 0, behind: 0, uptodate: 0, error: 0 };
  for (const s of visible) {
    if (s.behind < 0) counts.error++;
    else if (!s.hasTag) counts.untagged++;
    else if (s.behind > 0) counts.behind++;
    else counts.uptodate++;
  }

  const chip = (label: string, color: string): string =>
    `<span class="badge" style="background:${color};margin-right:6px">${escapeHtml(label)}</span>`;
  const summary = [
    counts.untagged ? chip(`未tag ${counts.untagged}`, RED) : "",
    counts.behind ? chip(`要リリース ${counts.behind}`, AMBER) : "",
    counts.uptodate ? chip(`最新 ${counts.uptodate}`, GREEN) : "",
    counts.error ? chip(`error ${counts.error}`, DARKGRAY) : "",
  ].join("");

  const rows = visible
    .map((s) => {
      // tag badge: tag あり=緑(タグ名) / 未tag=赤。
      const tagBadge = s.hasTag
        ? `<span class="badge" style="background:${GREEN}">${escapeHtml(s.latestTag ?? "")}</span>`
        : `<span class="badge" style="background:${RED}">未tag</span>`;

      // 状況セル + 行頭の左帯色で一目で分かるように。
      let statusCell: string;
      let border: string;
      if (s.behind < 0) {
        statusCell = `<span class="err">取得失敗</span>`;
        border = GRAY;
      } else if (!s.hasTag) {
        statusCell = `<span class="err">未リリース (tag 無し / main のみ)</span>`;
        border = RED;
      } else if (s.behind > 0) {
        statusCell = `<span style="color:#b06000">${s.behind} commits 未リリース</span>`;
        border = AMBER;
      } else {
        statusCell = `<span class="ok">最新</span>`;
        border = GREEN;
      }

      const action = needsRelease(s)
        ? `<form method="post" action="/api/release-wave/tag-release" style="margin:0">
             <input type="hidden" name="repo" value="${escapeHtml(s.repo)}">
             <button type="submit" title="tag-release.yml workflow を main で dispatch する">Tag Release</button>
           </form>`
        : `<span class="meta">—</span>`;

      return `
        <tr>
          <td style="border-left:4px solid ${border};padding-left:8px">${escapeHtml(s.repo)}</td>
          <td>${tagBadge}</td>
          <td>${statusCell}</td>
          <td class="actions">${action}</td>
        </tr>`;
    })
    .join("");

  const tableOrEmpty =
    visible.length === 0
      ? `<p class="meta">リリース対象の repo はありません。</p>`
      : `<table>
          <thead>
            <tr><th>Repo</th><th>Latest Tag</th><th>状況</th><th>Action</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;

  return `
    <div class="section">
      <h2>Repo リリース状況${helpMark(
        `監視対象 repo の tag 有無と main HEAD からの乖離 (tagless repo は除外)。
        <span class="badge" style="background:${GREEN}">緑 = tag あり</span>
        <span class="badge" style="background:${RED}">赤 = 未tag</span>
        の repo を直接 Tag Release できる (tag 採番は各 repo の tag-release.yml)。`,
      )}</h2>
      <div style="margin:8px 0">${summary}</div>
      ${tableOrEmpty}
    </div>`;
}

/**
 * flip ガード (未 tag version の 100% flip 禁止, #354) のセルフテストボタン。
 *
 * ここでいう「未 tag version」= **CF worker version の traffic record 上で
 * `tag` フィールドが null の version**（= release tag に紐づかない、no-traffic
 * upload した中間 version 等）。これは **「Repo リリース状況」の『未tag』
 * (= repo に git の v* リリースタグが無い) とは別概念**。tag 付き repo (例:
 * auth-worker = 最新) でも、その CF worker には tag:null version が多数あり得る。
 *
 * 実在の tag:null version に対し実 API (`/api/release-wave/traffic-rollback`) を
 * 叩き、**400 UNTAGGED_VERSION_FORBIDDEN** で拒否されること (= prod テスト gate
 * を経ていない version は本番に出せない) をその場で確認する。guard が dispatch
 * 前に弾くため **実デプロイは起きない**。click 処理は live.js (script-src 'self')
 * が data-flipguard-* 属性を見て wiring する (strict CSP のため inline JS 不可)。
 */
export function renderFlipGuardSelfTest(
  sample?: { repo: string; versionId: string },
): string {
  // 対象 (release tag 未紐付け CF version) が無い時も UI は出すが、ボタンは
  // disabled にして押せないようにする (テストしようがないため)。
  const button = sample
    ? (() => {
        const shortVid =
          sample.versionId.length > 8
            ? sample.versionId.slice(0, 8)
            : sample.versionId;
        return `
        <button type="button"
          data-flipguard-repo="${escapeHtml(sample.repo)}"
          data-flipguard-vid="${escapeHtml(sample.versionId)}"
          title="release tag に紐づかない CF version (${escapeHtml(sample.repo)} ${escapeHtml(shortVid)}…、traffic 上 tag:null) を実 API で 100% flip しようとし、400 UNTAGGED_VERSION_FORBIDDEN で拒否されることを確認する。guard が dispatch 前に弾くため実デプロイは起きない。"
          style="font-size:12px;padding:3px 10px;border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer">
          🔒 flip ガードを試す
        </button>
        <span class="flipguard-result meta" style="margin-left:8px"></span>`;
      })()
    : `
        <button type="button" disabled
          title="テスト対象が無いため押せません。release tag 未紐付け CF version (traffic 上 tag:null) が存在する時だけ試せます。"
          style="font-size:12px;padding:3px 10px;border:1px solid #d0d7de;border-radius:6px;background:#f1f3f4;color:#9aa0a6;cursor:not-allowed">
          🔒 flip ガードを試す
        </button>
        <span class="meta" style="margin-left:8px">テスト対象なし</span>`;

  const note = sample
    ? `対象 (代表 1 件): <code>${escapeHtml(sample.repo)}</code> の <strong>release tag 未紐付け CF version</strong> <code>${escapeHtml(
        sample.versionId.length > 8 ? sample.versionId.slice(0, 8) : sample.versionId,
      )}…</code>（traffic 上 tag:null）。`
    : `現在 <strong>release tag 未紐付け CF version</strong>（traffic 上 tag:null）が見当たらないため、試せる対象がありません（ボタンは無効）。`;

  return `
    <div style="margin-top:12px;padding-top:8px;border-top:1px solid #e8eaed">
      <strong class="meta">flip ガード self-test</strong>
      <div style="margin-top:6px">${button}</div>
      <div class="meta" style="margin-top:4px;font-size:11px">
        ${note}
        ※ ここの「tag 無し」は <em>CF version の tag 注釈</em>のこと。「Repo リリース状況」の <strong>未tag</strong>（= repo の git リリースタグ有無）とは別概念で、tag 付き repo でも tag:null version は持ち得る。実デプロイなし・400 で弾かれることを確認するだけ。guard は全 repo 共通。
      </div>
    </div>`;
}

/**
 * レンダリング済み一覧 HTML に section を注入する。
 *
 * 配置優先順:
 *   1. 右カラムの先頭 (= per-repo tracking section の <div> 直前)。
 *      左カラム = Compatibility / 右カラム = その他、の 2 カラムレイアウト用。
 *   2. 旧 .wave-row (下段 2 カラム) の直前
 *   3. Pending releases section の <div> 直前 (旧 1 列レイアウト互換)
 *   4. h1 (`Release Waves`) 直後
 *   5. </body> 直前
 */
export function injectRepoStatusSection(html: string, section: string): string {
  // 左カラム = Compatibility / 右カラム = その他 の 2 カラムレイアウトでは、
  // repo status は右カラムの先頭 (= per-repo tracking section の直前) に置く。
  const frontends = html.indexOf("<h2>Frontends");
  if (frontends !== -1) {
    const divStart = html.lastIndexOf('<div class="section">', frontends);
    if (divStart !== -1) {
      return html.slice(0, divStart) + section + "\n        " + html.slice(divStart);
    }
  }
  // 旧 下段 2 カラム (.wave-row) レイアウト互換: .wave-row 直前へ入れる。
  const row = html.indexOf('<div class="wave-row">');
  if (row !== -1) {
    return html.slice(0, row) + section + "\n      " + html.slice(row);
  }
  // 旧 1 列レイアウト互換: Pending releases section を起点に、その section の
  // 開始 <div> 直前へ入れる (= Compatibility section の直後)。
  const pending = html.indexOf("<h2>Pending releases");
  if (pending !== -1) {
    const divStart = html.lastIndexOf('<div class="section">', pending);
    if (divStart !== -1) {
      return html.slice(0, divStart) + section + "\n    " + html.slice(divStart);
    }
  }
  const h1Marker = "<h1>Release Waves</h1>";
  const h1 = html.indexOf(h1Marker);
  if (h1 !== -1) {
    const at = h1 + h1Marker.length;
    return html.slice(0, at) + "\n    " + section + html.slice(at);
  }
  return html.replace("</body>", `${section}\n</body>`);
}

/** 最新か (tag あり & main と差分なし)。最新なら release 不要なのでボタンを無効化。 */
export function isUpToDate(s: RepoReleaseStatus): boolean {
  return s.hasTag && s.behind === 0;
}

/**
 * Compatibility (all consumers) グラフに出ている repo (backend + frontend) の
 * Tag Release ボタン群を HTML で返す。tagless repo は除外。1 つも無ければ ""。
 *
 * グラフ内の repo をその場でリリースしたい、という要望 (ここにボタン欲しい) に
 * 応えるための block。グラフ直下に注入する (injectCompatTagReleaseButtons)。
 *
 * `statusByRepo` に該当があり「最新」(tag あり & main と差分なし) の repo は
 * ボタンを `disabled` (inactive) にする (= release 不要)。status 不明の repo は
 * active のまま。
 */
export function renderCompatTagReleaseButtons(
  repos: Iterable<string>,
  tagless: Set<string>,
  statusByRepo?: Map<string, RepoReleaseStatus>,
): string {
  const list = [...new Set(repos)].filter((r) => !tagless.has(r)).sort();
  if (list.length === 0) return "";
  // release 可能 (最新でない / status 不明) な repo。一括 tag release の対象。
  const releasable = list.filter((r) => {
    const st = statusByRepo?.get(r);
    return st ? !isUpToDate(st) : true;
  });
  const buttons = list
    .map((r) => {
      const st = statusByRepo?.get(r);
      const upToDate = st ? isUpToDate(st) : false;
      if (upToDate) {
        const tag = st?.latestTag ? ` (${escapeHtml(st.latestTag)})` : "";
        // 最新 = release 不要。submit させない素の disabled button。
        return `
        <span style="margin:0 6px 6px 0;display:inline-block">
          <button type="button" disabled title="${escapeHtml(r)} は最新${tag} のため release 不要">Tag Release: ${escapeHtml(r)}</button>
        </span>`;
      }
      return `
        <form method="post" action="/api/release-wave/tag-release" style="margin:0 6px 6px 0;display:inline-block">
          <input type="hidden" name="repo" value="${escapeHtml(r)}">
          <button type="submit" title="${escapeHtml(r)} の tag-release.yml workflow を main で dispatch する">Tag Release: ${escapeHtml(r)}</button>
        </form>`;
    })
    .join("");

  // 一括 tag release: release 可能な repo の tag-release.yml をまとめて dispatch。
  // 2 件以上で表示 (1 件なら個別ボタンと同じなので出さない)。最新 repo は除外。
  const bulkBtn =
    releasable.length >= 2
      ? `
        <form method="post" action="/api/release-wave/tag-release-all"
              style="margin:0 6px 8px 0;display:inline-block"
              onsubmit="return confirm('${releasable.length} 件の repo の tag-release.yml をまとめて dispatch します。よろしいですか？');">
          <input type="hidden" name="repos" value="${escapeHtml(releasable.join(","))}">
          <button type="submit" title="release 可能な ${releasable.length} repo の tag-release.yml を一括 dispatch する">
            ⚡ Tag Release all (${releasable.length})
          </button>
        </form>`
      : "";

  return `
    <div class="actions" style="margin-top:10px">
      <strong class="meta">Tag Release (compatibility graph の repo)</strong>
      <div style="margin-top:6px">${bulkBtn}${buttons}</div>
    </div>`;
}

/** 短縮 version id 表示 (full は title に出す)。 */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** ISO 日時を "MM-DD HH:mm" (UTC) に短縮。null は "—"。 */
function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * Compatibility グラフに出ている repo の version traffic split を HTML で返す。
 * frontend CI が報告した `traffic::<repo>` を読み、repo ごとに:
 *   - traffic を受けている version (100% / canary 等、percentage > 0) は全行表示
 *   - 0% (no-traffic) は active より新しいものだけ対象にし、**最新 1 件だけ**行表示
 *     (= 次に flip する候補)。残り件数は最新 0% 行の % セルに「(他N件)」併記
 *   - active より古い 0% は非表示 (= 用済みの過去履歴)
 * 行は created_on 降順 (新しい順) で並べる → 最新 0% が active(100%) より上に出る。
 * traffic 報告のある repo が 1 つも無ければ ""。
 */
export function renderTrafficVersionsBlock(
  repos: Iterable<string>,
  trafficByRepo: Map<string, TrafficRecord>,
): string {
  const list = [...new Set(repos)]
    .filter((r) => trafficByRepo.has(r))
    .sort();
  if (list.length === 0) return "";

  // 1 行 = 1 version。% セルに余剰件数 (extra) を「(他N件)」で併記する。
  const versionRow = (
    repo: string,
    v: TrafficVersion,
    first: boolean,
    extra: number,
    rollback: { cell: string; rowspan: number } | null,
  ): string => {
    // 100% = 緑 / 0% = 灰 / その他 (canary 等) = 黄。
    const color = v.percentage >= 100 ? GREEN : v.percentage <= 0 ? GRAY : AMBER;
    const more = extra > 0 ? ` <span class="meta">(他${extra}件)</span>` : "";
    const pctBadge = `<span class="badge" style="background:${color}">${v.percentage}%</span>${more}`;
    // Version セルは「git tag (upload 時点) + wrangler version id」。tag は
    // 100% (deployed) と 0% (uploaded) で異なり得る。tag 不明なら id のみ。
    const tagPart = v.tag
      ? `<strong>${escapeHtml(v.tag)}</strong> `
      : "";
    const vid = `${tagPart}<code title="${escapeHtml(v.version_id)}">${escapeHtml(shortId(v.version_id))}</code>`;
    const when = `<span class="meta" title="${escapeHtml(v.created_on ?? "")}">${escapeHtml(shortWhen(v.created_on))}</span>`;
    // rollback は repo 単位なので、先頭 version 行にだけ rowspan セルを置き、
    // version 行と同じ行に並べる (別 colspan 行にはしない)。残り行には td 無し。
    const rollbackTd = rollback
      ? `<td rowspan="${rollback.rowspan}">${rollback.cell}</td>`
      : "";
    return `
            <tr>
              <td>${first ? escapeHtml(repo) : ""}</td>
              <td>${pctBadge}</td>
              <td>${vid}</td>
              <td>${when}</td>
              ${rollbackTd}
            </tr>`;
  };

  const rows = list
    .map((repo) => {
      const rec = trafficByRepo.get(repo)!;
      const active = rec.versions.filter((v) => v.percentage > 0);
      // active (100%) version の最新 created_on。これより古い 0% は「もう用済みの
      // 過去履歴」(promote 候補ではない) なので除外する。active に日時が無い /
      // active が無い場合は比較できないので 0% は全件残す。
      const activeNewest = active
        .map((v) => v.created_on)
        .filter((c): c is string => !!c)
        .sort()
        .at(-1);
      const zero = rec.versions
        .filter((v) => v.percentage <= 0)
        .filter((v) => {
          if (!activeNewest) return true; // 比較不能 → 残す
          if (!v.created_on) return false; // 日時不明の古い 0% は落とす
          return v.created_on > activeNewest; // active より新しいものだけ
        });
      // 表示する version = active 全件 + 最新 0% 1 件。残り 0% 件数は最新 0% 行の
      // % セルに「(他N件)」で併記する (= 別行サマリは作らない)。
      const zeroShown = zero.slice(0, 1);
      const zeroExtra = Math.max(0, zero.length - 1);

      const shown = [...active, ...zeroShown];
      // 日時降順 (新しい順) で並べる。created_on 無しは末尾。これで 0% (最新)
      // が 100% (より古い active) の上に来る。
      shown.sort((a, b) => {
        const ca = a.created_on ?? "";
        const cb = b.created_on ?? "";
        if (ca === cb) return 0;
        if (!ca) return 1;
        if (!cb) return -1;
        return ca < cb ? 1 : -1;
      });

      // 直前以前の active version への rollback UI を先頭 version 行と同じ行に置く
      // (no-traffic version の flip は Pending releases に一本化、Refs #237)。
      // 候補が無ければ "—" を出して列を揃える。
      const rollbackInner = renderTrafficRollbackCell(repo, rec);
      const rollbackCell = rollbackInner || `<span class="meta">—</span>`;
      const versionRows = shown
        .map((v, i) =>
          versionRow(
            repo,
            v,
            i === 0,
            // 余剰件数は最新 0% (= zeroShown) の行にだけ付ける。
            v === zeroShown[0] ? zeroExtra : 0,
            // rollback セルは先頭行に rowspan で 1 つだけ。
            i === 0 ? { cell: rollbackCell, rowspan: shown.length } : null,
          ),
        )
        .join("");
      return versionRows;
    })
    .join("");

  return `
    <div style="margin-top:10px">
      <strong class="meta">Traffic (version split)</strong>
      <table style="margin-top:6px">
        <thead><tr><th>Repo</th><th>%</th><th>Tag / Version</th><th>Deployed / Uploaded (UTC)</th><th>Rollback</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * 1 repo の Traffic 行に並べる rollback セルの中身を返す (Refs #196)。
 *
 * - rollback **候補** = `deploy_history` のうち「現 active 以外」(= 過去に active
 *   だった version)。select の option に列挙し、1 ボタンで戻す。
 * - 候補が無ければ "" (Traffic 行が 1 version だけ等)。呼び出し側で "—" 等に
 *   フォールバックして列を揃える。
 *
 * 返すのは `<form>` 単体 (`<tr>`/`<td>` ラッパ無し) で、version 行の rollback 列に
 * rowspan セルとして埋め込まれる。
 *
 * 現 active は traffic の最大 percentage version。deploy_history[0] が現 active と
 * 一致する想定だが、念のため active version_id を除いて候補を作る。
 */
function renderTrafficRollbackCell(repo: string, rec: TrafficRecord): string {
  const versions = rec.versions ?? [];
  const history = rec.deploy_history ?? [];
  const activeId = versions.find((v) => v.percentage > 0)?.version_id ?? null;

  // 候補: 過去に active だった (deploy_history) が現 active でないもの。
  const candidates = history.filter((e) => e.version_id !== activeId);

  // no-traffic (0%) version の flip は「Pending releases」セクションに一本化した
  // (Refs ippoan/ci-dashboard#237)。Traffic セクションの本セルは「過去に active
  // だった version へ戻す」rollback 専用。戻し先が無ければ空を返す。
  if (candidates.length === 0) return "";

  // 候補が増えると button 横並びが画面を埋めるので、select で 1 つ選んで 1 ボタンで
  // 戻す list + button 形式にコンパクト化 (戻し先候補は最新が先頭になるよう降順)。
  const options = candidates
    .map((e) => {
      const label = e.tag ? escapeHtml(e.tag) : escapeHtml(shortId(e.version_id));
      const when = escapeHtml(shortWhen(e.became_active_at));
      return `<option value="${escapeHtml(e.version_id)}" title="${escapeHtml(e.version_id)}">${label} (${when})</option>`;
    })
    .join("");

  return `<form method="post" action="/api/release-wave/traffic-rollback"
                  style="margin:0;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  <input type="hidden" name="repo" value="${escapeHtml(repo)}">
                  <span class="meta">Rollback to:</span>
                  <select name="version_id" style="max-width:280px">${options}</select>
                  <button type="submit" class="danger"
                    title="${escapeHtml(repo)} を選択した version に即 100% で戻す (wrangler versions deploy <id>@100%)">
                    Rollback
                  </button>
                </form>`;
}

/**
 * Compatibility グラフに出ている backend repo の Cloud Run traffic 状態 +
 * rollback ボタンを HTML で返す (Refs #197 / #256)。
 *
 * frontend の「Traffic (version split)」と対称に、各 backend について:
 *   - **traffic 行**: `backend-traffic::<repo>` に GCP の実 traffic split
 *     (`status.traffic[]`) があれば、service × revision ごとに percent badge +
 *     revision sha (full は hover) + revision tag を出す。Cloud Run は tag push →
 *     `--no-traffic` deploy (新 0%) → Flip (新 100%) 運用なので、Flip 前は
 *     「旧 100% + 新 pending 0%」が実態として並ぶ。
 *   - 実 traffic 報告がまだ無い backend は **fallback 行** (`backend::<repo>.
 *     current_image` を 100% と仮定: tag + image sha + deploy 日時)。実 traffic を
 *     報告する配線 (release-wave-handler の cloudrun flip/rollback) が回り始める
 *     までの暫定表示。
 *   - **rollback 行**: `deploy_history` のうち「現 active 以外」(= 過去に active
 *     だった revision) があれば各候補に `Rollback to <tag/sha>` ボタンを出す。
 *
 * backend record (`backend::<repo>`) を持つ repo は traffic 行 or fallback 行を
 * 必ず出す (traffic も current_image も無い稀な record だけ skip)。1 行も出せ
 * なければ ""。
 *
 * **`workerRepos` (CF Workers = `traffic::` を持つ repo) は除外する。** compat の
 * "backend" は「frontend が互換性テストする対象」であって platform を区別しない
 * ため、auth-worker のような Cloudflare Workers backend もここに混ざる。CF Workers
 * は wrangler の version split を `traffic::` で報告し、上の「Traffic (version
 * split)」section に既に出ているので、Cloud Run revision として二重に出さない
 * (Refs #268)。platform 規約は「workers=traffic:: / cloudrun=pending-release::」。
 */
export function renderBackendRollbackBlock(
  compat: WaveCompatibility,
  trafficByRepo?: Map<string, BackendTrafficRecord>,
  workerRepos?: ReadonlySet<string>,
): string {
  const rows = compat.backends
    .filter((b) => !workerRepos?.has(b.backend_repo))
    .map((b) => {
      const traffic = trafficByRepo?.get(b.backend_repo);
      // rollback UI は traffic/fallback 行の先頭に rowspan セルとして並べる
      // (別 colspan 行にはしない)。候補が無ければ "—" で列を揃える。
      const rollbackInner = renderBackendRollbackCell(b);
      const rollbackCell = rollbackInner || `<span class="meta">—</span>`;
      // 実 traffic split (GCP 実態) があれば優先。無ければ current_image fallback。
      const head = hasBackendTraffic(traffic)
        ? renderBackendTrafficRows(b.backend_repo, traffic!, rollbackCell)
        : renderBackendActiveRow(b, rollbackCell);
      if (!head) return ""; // traffic も current_image も無い record は出さない
      return head;
    })
    .filter((r) => r !== "")
    .join("");

  if (rows === "") return "";

  return `
    <div style="margin-top:10px">
      <strong class="meta">Backend traffic / rollback (Cloud Run revision)</strong>${helpMark(
        `Cloud Run の実 traffic split (status.traffic[])。
        tag push → no-traffic deploy (新 0%) → Flip (新 100%) 運用なので、Flip 前は
        「旧 100% + 新 pending 0%」が並ぶ。revision / image sha は hover で full。`,
      )}
      <table style="margin-top:6px">
        <thead><tr><th>Backend repo</th><th>%</th><th>Revision / Image / Tag</th><th>When (UTC)</th><th>Rollback</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** backend に実 traffic split (revision 1 件以上) があるか。 */
function hasBackendTraffic(t: BackendTrafficRecord | undefined): boolean {
  return !!t && t.services.some((s) => s.revisions.length > 0);
}

/**
 * 1 backend の実 traffic 行群 (GCP `status.traffic[]` ベース)。service × revision
 * を percent 降順 (record 側で整列済み) で並べ、各行に percent badge + revision
 * sha (full は hover) + revision tag を出す。repo 名は最初の行だけ。複数 service
 * の repo は service 名も前置する。GCP の traffic には deploy 日時が無いので
 * When 列は "—"。
 */
function renderBackendTrafficRows(
  repo: string,
  traffic: BackendTrafficRecord,
  rollbackCell: string,
): string {
  const multiService = traffic.services.length > 1;
  const flat = traffic.services.flatMap((svc) =>
    svc.revisions.map((rev) => ({ service: svc.service, rev })),
  );
  return flat
    .map(({ service, rev }, i) => {
      // 100% = 緑 / 0% = 灰 / その他 (canary 等) = 黄。
      const color =
        rev.percent >= 100 ? GREEN : rev.percent <= 0 ? GRAY : AMBER;
      const pctBadge = `<span class="badge" style="background:${color}">${rev.percent}%</span>`;
      const svcPart = multiService
        ? `<span class="meta">${escapeHtml(service)}</span> `
        : "";
      // revision 名は <service>-NNNNN-xxx 形式。service prefix を剥がして revision
      // 番号 (00042-abc) を見せる。先頭 12 文字 truncate だと service 名部分で潰れて
      // 読めない (= 全 revision が "rust-alc-api…" になる) ため (Refs #256)。
      const revShort = rev.revision.startsWith(`${service}-`)
        ? rev.revision.slice(service.length + 1)
        : shortId(rev.revision);
      const revCode = `<code title="${escapeHtml(rev.revision)}">${escapeHtml(revShort)}</code>`;
      const tagPart = rev.tag
        ? ` <span class="meta">${escapeHtml(rev.tag)}</span>`
        : "";
      // rollback セルは先頭行に rowspan で 1 つだけ並べる。
      const rollbackTd =
        i === 0 ? `<td rowspan="${flat.length}">${rollbackCell}</td>` : "";
      return `
            <tr>
              <td>${i === 0 ? escapeHtml(repo) : ""}</td>
              <td>${pctBadge}</td>
              <td>${svcPart}${revCode}${tagPart}</td>
              <td><span class="meta">—</span></td>
              ${rollbackTd}
            </tr>`;
    })
    .join("");
}

/**
 * 1 backend の現 active 行 (100% badge + tag + image sha + deployed)。
 * current_image 不明なら "" (= 行を出さない)。
 *
 * Tag (ver) は `<strong>`、image sha は `<code>` (short 表示 / full は title
 * hover) に分けて markup し、「どれが ver でどれが sha か」を一目で区別できる
 * ようにする (= 旧 `Current` 列で tag と image が `·` 区切りで混在していた問題)。
 */
function renderBackendActiveRow(
  b: WaveBackendCompat,
  rollbackCell: string,
): string {
  const image = b.current_image;
  if (!image) return "";
  const tagPart = b.current_tag
    ? `<strong>${escapeHtml(b.current_tag)}</strong> `
    : "";
  const imgCode = `<code title="${escapeHtml(image)}">${escapeHtml(shortId(image))}</code>`;
  const when = `<span class="meta" title="${escapeHtml(b.deployed_at ?? "")}">${escapeHtml(shortWhen(b.deployed_at))}</span>`;
  return `
            <tr>
              <td>${escapeHtml(b.backend_repo)}</td>
              <td><span class="badge" style="background:${GREEN}">100%</span></td>
              <td>${tagPart}${imgCode}</td>
              <td>${when}</td>
              <td>${rollbackCell}</td>
            </tr>`;
}

/**
 * 1 backend の rollback セルの中身 (deploy_history の「現 active 以外」)。候補無しなら ""。
 * frontend の Traffic rollback と同じ方針: 過去 revision を即 100% に戻す。
 *
 * 返すのは `<form>` 単体 (`<tr>`/`<td>` ラッパ無し) で、traffic/fallback 行の
 * rollback 列に rowspan セルとして埋め込まれる。
 */
function renderBackendRollbackCell(b: WaveBackendCompat): string {
  const history = b.deploy_history ?? [];
  const candidates = history.filter((e) => e.image !== b.current_image);
  if (candidates.length === 0) return "";

  // frontend の Traffic rollback と対称に、候補を select で 1 つ選んで 1 ボタンで
  // 戻す list + button 形式にコンパクト化する。
  const options = candidates
    .map((e) => {
      const label = e.tag ? escapeHtml(e.tag) : escapeHtml(shortId(e.image));
      const when = escapeHtml(shortWhen(e.became_active_at));
      return `<option value="${escapeHtml(e.image)}" title="${escapeHtml(e.image)}">${label} (${when})</option>`;
    })
    .join("");

  return `<form method="post" action="/api/release-wave/backend-rollback"
                  style="margin:0;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  <input type="hidden" name="repo" value="${escapeHtml(b.backend_repo)}">
                  <span class="meta">Rollback to:</span>
                  <select name="image" style="max-width:340px">${options}</select>
                  <button type="submit" class="danger"
                    title="${escapeHtml(b.backend_repo)} の Cloud Run traffic を選択した revision に即 100% で戻す">
                    Rollback
                  </button>
                </form>`;
}

/**
 * Compatibility グラフ直下 (= "Staged previews (active waves)" block の直前) に
 * Tag Release ボタン block を注入する。アンカー (グラフの overlay) が無い
 * (compat 未記録) 場合や block 空のときは html をそのまま返す。
 */
export function injectCompatTagReleaseButtons(
  html: string,
  block: string,
): string {
  if (!block) return html;
  const marker = "Staged previews (active waves)";
  const m = html.indexOf(marker);
  if (m === -1) return html;
  const divStart = html.lastIndexOf('<div style="margin-top:10px">', m);
  if (divStart === -1) return html;
  return html.slice(0, divStart) + block + "\n      " + html.slice(divStart);
}

/**
 * GET /release-wave: 既存の一覧ページ + Repo リリース状況 section
 * + Compatibility グラフ内 repo の Tag Release ボタン。
 *
 * CI_STATUS 未 bind (一部 unit test) や release-status 取得失敗時は、元の一覧を
 * そのまま返す (section だけ落として degrade)。COMPAT_KV 未 bind / 取得失敗時は
 * compat ボタンだけ落とす。
 */
export async function handleReleaseWaveListPageWithRepoStatus(
  env: Env,
): Promise<Response> {
  const res = await handleReleaseWaveListPage(env);
  if (!env.CI_STATUS) return res;

  let statuses: RepoReleaseStatus[];
  try {
    statuses = await getRepoReleaseStatuses(env);
  } catch {
    return res;
  }

  // flip-guard self-test ボタン用に、実在の未 tag version を 1 つ探す。
  // compat graph の repo の traffic record (`tag:null` version) から拾う。
  // compat / traffic を後段の block と共有するため、ここで 1 回だけ取得する。
  let compat: WaveCompatibility | null = null;
  const compatRepos = new Set<string>();
  let trafficByRepo = new Map<string, TrafficRecord>();
  let sampleUntagged: { repo: string; versionId: string } | undefined;
  if (env.COMPAT_KV) {
    try {
      compat = await computeGlobalCompatibility(env.COMPAT_KV);
      for (const b of compat.backends) {
        compatRepos.add(b.backend_repo);
        for (const m of b.matrix) compatRepos.add(m.frontend);
      }
      trafficByRepo = await getTrafficForRepos(env.COMPAT_KV, compatRepos);
      for (const [repo, rec] of trafficByRepo) {
        const v = (rec.versions ?? []).find((x) => !x.tag);
        if (v) {
          sampleUntagged = { repo, versionId: v.version_id };
          break;
        }
      }
    } catch {
      // compat 取得失敗 → self-test ボタンは出さない (sampleUntagged 未設定)
    }
  }

  const section = renderRepoReleaseStatusSection(statuses);
  let html = await res.text();
  html = injectRepoStatusSection(html, section);

  // 旧「Start wave」(stage 駆動) フォームは撤去 (Refs #237)。
  // stage は wave と切り離し済み: tag push 時点で frontend-ci が no-traffic upload
  // → ci-dashboard に pending-release 報告される。wave は「Pending releases」の
  // ⚡ Flip all で一括 flip するだけ (wave-state 非依存)。
  // stage 駆動の Start wave は (1) callback 待ちで staging 滞留 → WAVE_IN_PROGRESS、
  // (2) cloudrun は新規 tag push 前提で、実在 tag を渡すと git tag が即失敗、と
  // 新モデルと構造的に非互換だったため UI から外す。
  // backend route (/api/release-wave/start) + handler / start.ts の撤去 (=
  // ci-dashboard 側) は ippoan/ci-workflows#96① で完了済み。

  // Compatibility (all consumers) グラフ内 repo に Tag Release ボタンを足す。
  // compat / compatRepos / trafficByRepo は上の self-test 探索で取得済みを再利用。
  if (env.COMPAT_KV && compat) {
    try {
      const repos = compatRepos;
      const tagless = parseTaglessRepos(env.TAGLESS_REPOS);
      // Repo リリース状況で算出済みの status を repo→status で引けるようにし、
      // 「最新」repo のボタンを inactive にする。
      const statusByRepo = new Map(statuses.map((s) => [s.repo, s]));
      const buttons = renderCompatTagReleaseButtons(repos, tagless, statusByRepo);

      // version traffic split (frontend CI が報告) をグラフ下に出す。
      // flip ガード self-test は version-level の話なので、ここ (version traffic
      // split) の直下に置く。「Repo リリース状況」の repo-level『未tag』と混ざって
      // 紛らわしくならないよう、敢えてこのブロックに同居させる。
      // sampleUntagged が無くても self-test UI 自体は常に出す (ボタンは disabled)。
      const trafficBlock =
        renderTrafficVersionsBlock(repos, trafficByRepo) +
        renderFlipGuardSelfTest(sampleUntagged);

      // backend (Cloud Run) の実 traffic split + rollback ボタンをグラフ下に出す。
      // 実 traffic (backend-traffic::) があれば GCP 実態を、無ければ current_image
      // ベースの fallback を表示する (Refs #197 / #256)。
      const backendTrafficByRepo = await getBackendTrafficForRepos(
        env.COMPAT_KV,
        repos,
      );
      // CF Workers backend (auth-worker 等) は traffic:: を持ち上の version split
      // に出ているので、Cloud Run revision section からは除外する (Refs #268)。
      const backendRollbackBlock = renderBackendRollbackBlock(
        compat,
        backendTrafficByRepo,
        new Set(trafficByRepo.keys()),
      );

      // traffic → backend rollback → Tag Release ボタンの順で 1 回で注入する。
      html = injectCompatTagReleaseButtons(
        html,
        trafficBlock + backendRollbackBlock + buttons,
      );
    } catch {
      // compat 取得失敗時はボタンだけ落とす
    }
  }

  return new Response(html, { status: res.status, headers: res.headers });
}
