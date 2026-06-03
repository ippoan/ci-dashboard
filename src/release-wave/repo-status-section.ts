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
import { handleReleaseWaveListPage } from "./page";
import {
  getRepoReleaseStatuses,
  type RepoReleaseStatus,
} from "./repo-release-status";
import { computeGlobalCompatibility, type WaveCompatibility } from "./compat";
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
      <h2>Repo リリース状況</h2>
      <p class="meta">監視対象 repo の tag 有無と main HEAD からの乖離 (tagless repo は除外)。
        <span class="badge" style="background:${GREEN}">緑 = tag あり</span>
        <span class="badge" style="background:${RED}">赤 = 未tag</span>
        の repo を直接 Tag Release できる (tag 採番は各 repo の tag-release.yml)。</p>
      <div style="margin:8px 0">${summary}</div>
      ${tableOrEmpty}
    </div>`;
}

/**
 * レンダリング済み一覧 HTML に section を注入する。
 *
 * 配置優先順:
 *   1. Compatibility section の直後 (= Pending releases section の <div> 直前)
 *   2. h1 (`Release Waves`) 直後
 *   3. </body> 直前
 */
export function injectRepoStatusSection(html: string, section: string): string {
  // Pending releases section を起点に、その section の開始 <div> 直前へ入れる。
  // = Compatibility (all consumers) section の直後。
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
  return `
    <div class="actions" style="margin-top:10px">
      <strong class="meta">Tag Release (compatibility graph の repo)</strong>
      <div style="margin-top:6px">${buttons}</div>
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
    return `
            <tr>
              <td>${first ? escapeHtml(repo) : ""}</td>
              <td>${pctBadge}</td>
              <td>${vid}</td>
              <td>${when}</td>
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

      const versionRows = shown
        .map((v, i) =>
          versionRow(
            repo,
            v,
            i === 0,
            // 余剰件数は最新 0% (= zeroShown) の行にだけ付ける。
            v === zeroShown[0] ? zeroExtra : 0,
          ),
        )
        .join("");
      // 直前以前の active version への rollback ボタン + 表示中 no-traffic
      // (zeroShown) の Flip ボタン行を続ける。
      return versionRows + renderTrafficRollbackRow(repo, rec, zeroShown);
    })
    .join("");

  return `
    <div style="margin-top:10px">
      <strong class="meta">Traffic (version split)</strong>
      <table style="margin-top:6px">
        <thead><tr><th>Repo</th><th>%</th><th>Tag / Version</th><th>Deployed / Uploaded (UTC)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * 1 repo の Traffic 行に続けて、rollback 行を返す (Refs #196)。
 *
 * - rollback **候補** = `deploy_history` のうち「現 active 以外」(= 過去に active
 *   だった version)。各候補に `Rollback to <tag/id>` ボタンを出す。
 * - rollback **候補外** = `versions` のうち 0% (no-traffic) でまだ一度も active に
 *   なっていない version (= deploy_history に載っていない)。rollback 先になれない
 *   が、「なぜボタンが無いか」を画面で分かるよう理由付きで併記する。
 * - 候補も候補外も無ければ "" (Traffic 行が 1 version だけ等)。
 *
 * 現 active は traffic の最大 percentage version。deploy_history[0] が現 active と
 * 一致する想定だが、念のため active version_id を除いて候補を作る。
 */
function renderTrafficRollbackRow(
  repo: string,
  rec: TrafficRecord,
  promotable: TrafficVersion[],
): string {
  const versions = rec.versions ?? [];
  const history = rec.deploy_history ?? [];
  const activeId = versions.find((v) => v.percentage > 0)?.version_id ?? null;

  // 候補: 過去に active だった (deploy_history) が現 active でないもの。
  const candidates = history.filter((e) => e.version_id !== activeId);

  // promotable = renderTrafficVersionsBlock が「行として表示する no-traffic
  // version」(= active より新しい最新 0% = zeroShown)。flip ボタンの対象を
  // これに揃えることで、行表示と flip ボタンの対象がずれない (古い / 隠した
  // 0% を勝手にボタン化しない)。active 自身は念のため除く。Refs ippoan/ci-dashboard#237。
  const noTraffic = promotable.filter((v) => v.version_id !== activeId);

  // 候補も no-traffic も無ければ従来どおり行を出さない。
  if (candidates.length === 0 && noTraffic.length === 0) return "";

  const buttons = candidates
    .map((e) => {
      const label = e.tag ? escapeHtml(e.tag) : escapeHtml(shortId(e.version_id));
      const when = escapeHtml(shortWhen(e.became_active_at));
      return `
            <form method="post" action="/api/release-wave/traffic-rollback" style="margin:0 6px 4px 0;display:inline-block">
              <input type="hidden" name="repo" value="${escapeHtml(repo)}">
              <input type="hidden" name="version_id" value="${escapeHtml(e.version_id)}">
              <button type="submit" class="danger"
                title="${escapeHtml(repo)} を ${escapeHtml(e.version_id)} に即 100% で戻す (wrangler versions deploy ${escapeHtml(e.version_id)}@100%)">
                Rollback to ${label} <span class="meta">(${when})</span>
              </button>
            </form>`;
    })
    .join("");

  // 候補が 1 件も無いとき、行が黙って消える挙動をやめて理由を出す (Refs #196)。
  const noCandidateNote =
    candidates.length === 0
      ? `<div class="meta" style="margin-top:4px">過去に active だった version がまだないため、戻せる先がありません。</div>`
      : "";

  // 表示中の no-traffic (0%) version に「Flip to 100%」を出す (Refs ippoan/ci-dashboard#237)。
  // flip → rollback で no-traffic に戻った version が Pending releases にも rollback
  // 候補にも出ず再 flip できなくなる事故の救済経路。traffic-rollback endpoint は
  // versions[] にある version をそのまま `wrangler versions deploy <id>@100%` する。
  const flipButtons = noTraffic
    .map((v) => {
      const label = v.tag ? escapeHtml(v.tag) : escapeHtml(shortId(v.version_id));
      const when = escapeHtml(shortWhen(v.created_on));
      return `
            <form method="post" action="/api/release-wave/traffic-rollback" style="margin:0 6px 4px 0;display:inline-block">
              <input type="hidden" name="repo" value="${escapeHtml(repo)}">
              <input type="hidden" name="version_id" value="${escapeHtml(v.version_id)}">
              <button type="submit"
                title="${escapeHtml(repo)} の no-traffic version ${escapeHtml(v.version_id)} を即 100% に flip (wrangler versions deploy ${escapeHtml(v.version_id)}@100%)">
                Flip to ${label} <span class="meta">(0% · ${when})</span>
              </button>
            </form>`;
    })
    .join("");
  const nonActiveBlock =
    noTraffic.length > 0
      ? `<div style="margin-top:6px">
                <span class="meta">no-traffic version を 100% に flip:</span>
                <div style="margin-top:4px">${flipButtons}</div>
              </div>`
      : "";

  return `
            <tr>
              <td></td>
              <td colspan="3">
                <span class="meta">Rollback to (過去の deployed version):</span>
                ${noCandidateNote}
                ${buttons ? `<div style="margin-top:4px">${buttons}</div>` : ""}
                ${nonActiveBlock}
              </td>
            </tr>`;
}

/**
 * Compatibility グラフに出ている backend repo の Cloud Run revision rollback
 * ボタンを HTML で返す (Refs #197)。`backend::<repo>.deploy_history` から
 * 「現 active 以外」の過去 revision を rollback 先候補とし、各候補に
 * `Rollback to <tag/revision>` ボタンを出す。候補がある repo が無ければ ""。
 *
 * frontend の Traffic rollback と方針を揃える: 任意の過去 revision を選択 / 即 100%。
 */
export function renderBackendRollbackBlock(compat: WaveCompatibility): string {
  const rows = compat.backends
    .map((b) => {
      const history = b.deploy_history ?? [];
      if (history.length === 0) return "";
      const candidates = history.filter((e) => e.image !== b.current_image);
      if (candidates.length === 0) return "";

      const buttons = candidates
        .map((e) => {
          const label = e.tag ? escapeHtml(e.tag) : escapeHtml(shortId(e.image));
          const when = escapeHtml(shortWhen(e.became_active_at));
          return `
            <form method="post" action="/api/release-wave/backend-rollback" style="margin:0 6px 4px 0;display:inline-block">
              <input type="hidden" name="repo" value="${escapeHtml(b.backend_repo)}">
              <input type="hidden" name="image" value="${escapeHtml(e.image)}">
              <button type="submit" class="danger"
                title="${escapeHtml(b.backend_repo)} の Cloud Run traffic を ${escapeHtml(e.image)} に即 100% で戻す">
                Rollback to ${label} <span class="meta">(${when})</span>
              </button>
            </form>`;
        })
        .join("");

      const curTag = b.current_tag ? `${escapeHtml(b.current_tag)} · ` : "";
      return `
        <tr>
          <td>${escapeHtml(b.backend_repo)}</td>
          <td class="meta" title="${escapeHtml(b.current_image ?? "—")}">${curTag}${escapeHtml(shortId(b.current_image ?? "—"))}</td>
          <td><div>${buttons}</div></td>
        </tr>`;
    })
    .filter((r) => r !== "")
    .join("");

  if (rows === "") return "";

  return `
    <div style="margin-top:10px">
      <strong class="meta">Backend rollback (Cloud Run revision)</strong>
      <table style="margin-top:6px">
        <thead><tr><th>Backend repo</th><th>Current</th><th>Rollback to (過去 revision)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
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
  // backend route (/api/release-wave/start) と handler stage job の撤去は
  // ippoan/ci-workflows#96 で段階的に行う。

  // Compatibility (all consumers) グラフ内 repo に Tag Release ボタンを足す。
  if (env.COMPAT_KV) {
    try {
      const compat = await computeGlobalCompatibility(env.COMPAT_KV);
      const repos = new Set<string>();
      for (const b of compat.backends) {
        repos.add(b.backend_repo);
        for (const m of b.matrix) repos.add(m.frontend);
      }
      const tagless = parseTaglessRepos(env.TAGLESS_REPOS);
      // Repo リリース状況で算出済みの status を repo→status で引けるようにし、
      // 「最新」repo のボタンを inactive にする。
      const statusByRepo = new Map(statuses.map((s) => [s.repo, s]));
      const buttons = renderCompatTagReleaseButtons(repos, tagless, statusByRepo);

      // version traffic split (frontend CI が報告) をグラフ下に出す。
      const trafficByRepo = await getTrafficForRepos(env.COMPAT_KV, repos);
      const trafficBlock = renderTrafficVersionsBlock(repos, trafficByRepo);

      // backend (Cloud Run) revision の rollback ボタンをグラフ下に出す (Refs #197)。
      const backendRollbackBlock = renderBackendRollbackBlock(compat);

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
