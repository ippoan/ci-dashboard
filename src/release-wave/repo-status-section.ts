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

/**
 * GET /release-wave: 既存の一覧ページ + Repo リリース状況 section。
 *
 * CI_STATUS 未 bind (一部 unit test) や release-status 取得失敗時は、元の一覧を
 * そのまま返す (section だけ落として degrade)。
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
  const html = await res.text();
  const injected = injectRepoStatusSection(html, section);
  return new Response(injected, { status: res.status, headers: res.headers });
}
