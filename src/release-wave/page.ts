/**
 * Release Wave admin UI (HTML server-side rendering)。
 *
 * 設計の親 issue: ippoan/ci-dashboard#137 Phase 3e
 *
 * 認証は Cloudflare Access edge (= ci-dashboard.ippoan.org 全体に被さる
 * Google OAuth + email allowlist) で担保される前提。本ファイル内で追加の
 * auth check は持たない (= /releases や /issues と同じトラストモデル)。
 *
 * 提供する 2 ページ:
 *   GET /release-wave            → 全 wave 一覧
 *   GET /release-wave/<wave_id>  → 1 wave の詳細 + action ボタン
 */

import type { Env } from "../index";
import type { ReleaseWaveHub, RpcResult } from "./do";
import type { WaveState, WaveStateName } from "./types";
import { renderTabs, TAB_STYLES } from "../nav-tabs";
import {
  computeWaveCompatibility,
  computeGlobalCompatibility,
  type WaveCompatibility,
} from "./compat";
import {
  listPendingReleases,
  getFlipGroup,
  computeUnifiedPending,
  type PendingReleaseRecord,
  type FlipGroupRecord,
  type UnifiedPending,
} from "./pending-release";
import { getTrafficForRepos, type TrafficRecord } from "./traffic";

// ----------------------------------------------------------------------------
// Small HTML helpers
// ----------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * URL を http(s) のみに絞って返す。`javascript:`, `data:`, `vbscript:` 等の
 * scheme を持つ値は null を返して link 化させない (= XSS 防止)。
 *
 * `escapeHtml` は content escape のみで scheme injection を防げない:
 * `javascript:alert(1)` には HTML 特殊文字が無いため escape 後も生のまま
 * `<a href="...">` に乗り、クリックすると script 実行される。
 *
 * preview_url は repo 側 release-wave handler / pending-release webhook が
 * 報告する値 = handler が compromise されれば任意値を入れられる
 * = trust boundary を越える input なので必ず scheme check を入れる。
 */
function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** state name → 表示色 (CSS hex)。 */
function stateColor(state: WaveStateName): string {
  switch (state) {
    case "staging":
      return "#9aa0a6"; // gray
    case "pending-approval":
      return "#f29900"; // amber
    case "flipping":
      return "#1a73e8"; // blue
    case "flipped":
      return "#188038"; // green
    case "rolled-back":
      return "#a142f4"; // purple
    case "failed":
      return "#d93025"; // red
    case "aborted":
      return "#5f6368"; // dark gray
  }
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 「更新（ハードリセット）」ボタン用: ページは SSR で DO/KV の現在状態を
      // 毎回引き直す。no-store でブラウザ/bfcache のキャッシュを一切無効化し、
      // リンク再訪時に必ずサーバから取り直させる (= ハードリロード相当)。
      // strict CSP (script-src 無し) で JS の location.reload(true) が使えないため、
      // キャッシュ制御は response header 側で担保する。
      "Cache-Control": "no-store, must-revalidate",
      // Defense in depth against XSS:
      // - `script-src 'self'` で **外部ファイル 1 個** (/release-wave/live.js) のみ
      //   許可。inline JS / event handler 経由の実行は引き続き全ブロックされる
      //   ため injected script は動かない (Refs #275: live 更新を最小緩和で実現)
      // - `style-src 'self' 'unsafe-inline'` は本ページが inline <style> を
      //   使うため許可 (= injected style での data exfil は別軸の懸念だが、
      //   本ページの content は admin trusted DO state なのでバランス内)
      // - `default-src 'none'` で他リソース読み込みを全 deny
      // - `connect-src 'self'` で同一オリジン wss (= live 更新 WebSocket) のみ許可。
      //   外部 origin への fetch / XHR / WS は引き続き deny
      // - preview link は target=_blank で別タブに飛ばすため frame-src 不要
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const COMMON_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif; background: #f8f9fa; color: #202124;
    margin: 0; padding: 20px; }
  h1, h2, h3 { margin-top: 0; }
  a { color: #1a73e8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; background: #fff; margin: 8px 0; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e8eaed; }
  th { background: #f1f3f4; font-weight: 600; font-size: 13px; color: #5f6368; }
  td { font-size: 14px; }
  /* フル HD (1920px) / WQHD などのワイド画面で横幅を活用する。table は
     width:100% なので container 拡大に追従して広がり、左右の余白が減る。 */
  .container { max-width: 1600px; margin: 0 auto; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px;
    color: #fff; font-size: 12px; font-weight: 600; }
  .empty { padding: 24px; color: #5f6368; text-align: center; font-style: italic; }
  .actions { margin: 12px 0; }
  .actions form { display: inline-block; margin-right: 8px; }
  .actions button { background: #1a73e8; color: #fff; border: none;
    padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px;
    font-weight: 500; }
  .actions button.danger { background: #d93025; }
  .actions button.warn { background: #f29900; }
  .actions button:disabled { background: #dadce0; cursor: not-allowed; }
  .preview-inline { font-size: 12px; color: #5f6368; }
  .preview-inline a { margin-right: 6px; }
  pre { background: #f1f3f4; padding: 12px; border-radius: 4px; overflow: auto;
    font-size: 12px; line-height: 1.5; }
  .section { background: #fff; padding: 16px 20px; margin: 16px 0;
    border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .nav { color: #5f6368; font-size: 13px; margin-bottom: 12px; }
  .breadcrumb a { color: #5f6368; }
  .meta { color: #5f6368; font-size: 13px; }
  .unsafe { background: #fce8e6; border: 1px solid #d93025; padding: 8px 12px;
    border-radius: 4px; margin: 8px 0; color: #a50e0e; font-size: 13px; }
  .ok { color: #188038; }
  .err { color: #d93025; }
  .pending { color: #9aa0a6; }
  .toolbar { margin: 8px 0 16px; display: flex; gap: 8px; align-items: center; }
  .page-header { display: flex; align-items: baseline; gap: 12px; margin: 8px 0 16px;
    flex-wrap: wrap; }
  .page-header h1 { margin: 0; }
  .page-header .refresh-btn { margin-left: auto; }
  .refresh-btn { display: inline-block; background: #1a73e8; color: #fff;
    padding: 8px 16px; border-radius: 4px; font-size: 14px; font-weight: 500;
    text-decoration: none; cursor: pointer; }
  .refresh-btn:hover { background: #1765cc; text-decoration: none; }
  .help-tip { display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; margin-left: 6px; border-radius: 50%;
    background: #dadce0; color: #3c4043; font-size: 11px; font-weight: 700;
    line-height: 1; cursor: help; position: relative; vertical-align: middle;
    user-select: none; }
  .help-tip .help-pop { display: none; position: absolute; top: 100%; left: 0;
    z-index: 30; width: max-content; max-width: 420px; margin-top: 4px;
    padding: 10px 12px; background: #202124; color: #e8eaed; font-size: 12px;
    font-weight: 400; line-height: 1.6; border-radius: 6px; white-space: normal;
    text-align: left; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
  .help-tip .help-pop code { background: rgba(255,255,255,0.12); color: #fff;
    padding: 1px 4px; border-radius: 3px; }
  .help-tip .help-pop strong { color: #fff; }
  .help-tip .help-pop a { color: #8ab4f8; }
  .help-tip:hover .help-pop, .help-tip:focus .help-pop,
  .help-tip:focus-within .help-pop { display: block; }
  /* 画面幅に応じて動的に 2 カラムへ段組みする。左カラムに Compatibility
     (互換グラフ)、右カラムにその他 (リリース状況 / per-repo tracking /
     no-traffic) を縦積みする。狭い画面では auto-fit + minmax により自動で
     1 列に折り返す (メディアクエリ不要)。各カラムは内容量で高さが決まるよう
     align-items:start。min-width:0 で子のテーブル / pre が overflow しても
     カラムが伸びないようにする。gap を使うので子 .section の縦 margin は
     打ち消す。 */
  .wave-grid { display: grid; gap: 16px; align-items: start;
    grid-template-columns: repeat(auto-fit, minmax(560px, 1fr)); }
  .wave-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .wave-col > .section { margin: 0; }
`;

/**
 * セクション見出しの右に出す「?」ヘルプアイコン。hover / focus で説明文を
 * ツールチップ表示する。説明は rich HTML (code / strong / a) を保持できる。
 * 従来 <h2> 直下に <p class="meta"> で出していた説明をここに畳む用途。
 */
export function helpMark(html: string): string {
  return `<span class="help-tip" tabindex="0" role="note"
    aria-label="説明"><span aria-hidden="true">?</span><span class="help-pop">${html}</span></span>`;
}

// ----------------------------------------------------------------------------
// Hub access
// ----------------------------------------------------------------------------

function hubStub(env: Env): DurableObjectStub<ReleaseWaveHub> {
  const id = env.RELEASE_WAVE_HUB.idFromName("singleton");
  return env.RELEASE_WAVE_HUB.get(id) as DurableObjectStub<ReleaseWaveHub>;
}

// ----------------------------------------------------------------------------
// frontend 単位の追跡
// ----------------------------------------------------------------------------

/** frontend (repo) 1 つの追跡サマリ。`computeFrontendTracks` が wave 群から導出。 */
interface FrontendTrack {
  repo: string;
  /** この repo を含む最新 wave。 */
  latestWaveId: string;
  latestWaveState: WaveStateName;
  latestAt: string;
  /** この repo が最後に flip (deploy) された wave。未 deploy なら null。 */
  lastFlipWaveId: string | null;
  lastFlipAt: string | null;
  lastFlipTag: string | null;
  /** 最新 flip 以降で preview_url を持つ最新 wave のもの (古い preview は隠す)。 */
  previewUrl: string | null;
  previewWaveId: string | null;
  previewSha: string | null;
}

/**
 * 全 wave を repo (frontend) 単位に畳んで、各 frontend の「最新 preview URL /
 * 最後の flip (deploy) / 最新 wave」を導出する。
 *
 * preview は各 frontend の **最新 flip より前のものを隠す** (= deploy 済みの
 * frontend について、その deploy より古い stale preview link を出さない)。
 * まだ flip されていない frontend は最新の preview をそのまま見せる。
 */
function computeFrontendTracks(waves: WaveState[]): FrontendTrack[] {
  // started_at 降順に揃える (list() は降順だが sort 順に依存しないよう copy-sort)。
  const sorted = [...waves].sort((a, b) =>
    a.started_at < b.started_at ? 1 : -1,
  );

  const tracks = new Map<string, FrontendTrack>();

  // pass 1: 最新 wave (= 最初に出会う) と最後の flip を記録。
  for (const w of sorted) {
    for (const r of w.repos) {
      let t = tracks.get(r.repo);
      if (!t) {
        t = {
          repo: r.repo,
          latestWaveId: w.wave_id,
          latestWaveState: w.state,
          latestAt: w.started_at,
          lastFlipWaveId: null,
          lastFlipAt: null,
          lastFlipTag: null,
          previewUrl: null,
          previewWaveId: null,
          previewSha: null,
        };
        tracks.set(r.repo, t);
      }
      if (t.lastFlipAt === null && r.flip_status === "done") {
        t.lastFlipWaveId = w.wave_id;
        t.lastFlipAt = w.started_at;
        t.lastFlipTag = r.target_tag;
      }
    }
  }

  // pass 2: 最新 flip 以降で preview を持つ最新 wave を採用 (古い preview は除外)。
  for (const w of sorted) {
    for (const r of w.repos) {
      const t = tracks.get(r.repo);
      if (!t || t.previewUrl !== null) continue;
      const safe = safeHttpUrl(r.preview_url);
      if (!safe) continue;
      if (t.lastFlipAt !== null && w.started_at < t.lastFlipAt) continue;
      t.previewUrl = safe;
      t.previewWaveId = w.wave_id;
      t.previewSha = r.head_sha ? r.head_sha.slice(0, 7) : null;
    }
  }

  return [...tracks.values()].sort((a, b) => (a.repo < b.repo ? -1 : 1));
}

/**
 * frontend (repo) の現 live deploy (traffic で最大 % の version) を解決する。
 * traffic:: record の versions から percentage 最大の version を採用する。
 * traffic 無 / 全 0% (= まだ live でない) なら `live: null`。
 */
function resolveLiveDeploy(
  traffic: TrafficRecord | undefined,
): { live: TrafficRecord["versions"][number] | null } {
  const tv = traffic?.versions ?? [];
  if (tv.length === 0) return { live: null };
  const top = [...tv].sort((a, b) => b.percentage - a.percentage)[0];
  return { live: top && top.percentage > 0 ? top : null };
}

/** live version の表示セル (tag / short id + %)。live が無ければ "—"。 */
function liveDeployCell(live: TrafficRecord["versions"][number] | null): string {
  if (!live) return `<span class="meta">—</span>`;
  const label =
    live.tag ??
    (live.version_id.length > 12
      ? `${live.version_id.slice(0, 12)}…`
      : live.version_id);
  return `<span class="ok">${escapeHtml(label)}</span> <span class="meta">${live.percentage}%</span>`;
}

/**
 * frontend (repo) 単位の追跡セクション。各 frontend の最新 preview URL、現 live
 * deploy (traffic 100%)、最後に flip された wave、最新 wave を 1 行ずつ出す。
 * preview を wave 行ではなく frontend 行に分けて持つことで「どの front の
 * preview がどれか」を分離する。
 *
 * 「Latest wave」のバッジは frontend の**現在の健全性**を表す:
 * - live deploy (traffic 100%) が出ていれば緑 **live** (= 今は OK)。直近 wave が
 *   failed でも、その後 flip 済み = 現状 OK なので failed バッジは出さない。
 * - live deploy が無ければ直近 wave の実 state (failed / aborted 等) を出す
 *   (= まだ deploy されていない / 失敗したまま、を赤で示す)。
 */
function renderFrontendSection(
  tracks: FrontendTrack[],
  trafficByRepo?: Map<string, TrafficRecord>,
): string {
  const rows =
    tracks.length === 0
      ? `<tr><td colspan="5" class="empty">No frontends tracked yet.</td></tr>`
      : tracks
          .map((t) => {
            const previewCell = t.previewUrl
              ? `<a href="${escapeHtml(t.previewUrl)}" target="_blank" rel="noopener noreferrer">preview</a>
                 ${t.previewSha ? `<span class="meta">${escapeHtml(t.previewSha)}</span>` : ""}
                 <span class="meta">(${escapeHtml(t.previewWaveId ?? "")})</span>`
              : `<span class="meta">—</span>`;
            const { live } = resolveLiveDeploy(trafficByRepo?.get(t.repo));
            const liveCell = liveDeployCell(live);
            const deployCell = t.lastFlipWaveId
              ? `<a href="/release-wave/${encodeURIComponent(t.lastFlipWaveId)}">${escapeHtml(t.lastFlipTag ?? t.lastFlipWaveId)}</a>
                 <span class="meta">${escapeHtml(t.lastFlipAt ?? "")}</span>`
              : `<span class="meta">not deployed</span>`;
            // live なら緑 "live" (failed wave でも現状 OK)。live でなければ
            // 直近 wave の実 state を出す。
            const waveBadge = live
              ? `<span class="badge" style="background:#188038" title="traffic 100% で live。直近 wave が failed でも現状は OK">live</span>`
              : `<span class="badge" style="background:${stateColor(t.latestWaveState)}">${escapeHtml(t.latestWaveState)}</span>`;
            const latestCell = `<a href="/release-wave/${encodeURIComponent(t.latestWaveId)}">${escapeHtml(t.latestWaveId)}</a>
                ${waveBadge}`;
            return `
              <tr>
                <td>${escapeHtml(t.repo)}</td>
                <td>${previewCell}</td>
                <td>${liveCell}</td>
                <td class="meta">${deployCell}</td>
                <td>${latestCell}</td>
              </tr>`;
          })
          .join("");

  return `
    <div class="section">
      <h2>Frontends (per-repo tracking)${helpMark(
        `repo (frontend) ごとの最新 preview URL、現 live deploy
        (traffic 100%)、最後にデプロイ (flip) された wave、最新 wave。
        <strong>Current (live)</strong> は traffic 100% の実 version。
        <strong>Latest wave</strong> のバッジは現在の健全性を示す:
        live deploy があれば緑 <strong>live</strong> (直近 wave が failed でも
        その後 flip 済み = 現状 OK)、live deploy が無ければ直近 wave の実 state
        (failed 等) を出す。preview は各 frontend の最新 flip より前のものは隠す。`,
      )}</h2>
      <table>
        <thead>
          <tr>
            <th>Repo</th>
            <th>Latest preview</th>
            <th>Current (live)</th>
            <th>Last deploy (flip)</th>
            <th>Latest wave</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ----------------------------------------------------------------------------
// GET /release-wave  →  全 wave 一覧
// ----------------------------------------------------------------------------

export async function handleReleaseWaveListPage(env: Env): Promise<Response> {
  const waves = (await hubStub(env).list()) as WaveState[];

  // 全 backend:: record に対する wave 非依存の compatibility 俯瞰グラフ。
  // 個別 wave に入っていない既 deploy frontend (consumer) も含めて、現
  // production backend image を test 済みか一目で見える (Refs #157)。
  let globalCompat: WaveCompatibility | null = null;
  if (env.COMPAT_KV) {
    try {
      globalCompat = await computeGlobalCompatibility(env.COMPAT_KV);
    } catch {
      globalCompat = null;
    }
  }
  // 単独 v* リリースで upload された no-traffic version の一覧 (Refs #181)。
  // + 直近の一括 flip (flip-group) — 一括 rollback 用 (Refs #237)。
  // traffic fetch より先に引く: pending repo の traffic も併せて取得して、
  // computeUnifiedPending が pending source の rollback 先を埋められるようにする
  // (= flip-all / flip-group rollback と表示を揃える、Refs #241)。
  let pendingReleases: PendingReleaseRecord[] = [];
  let flipGroup: FlipGroupRecord | null = null;
  if (env.COMPAT_KV) {
    try {
      pendingReleases = await listPendingReleases(env.COMPAT_KV);
    } catch {
      pendingReleases = [];
    }
    try {
      flipGroup = await getFlipGroup(env.COMPAT_KV);
    } catch {
      flipGroup = null;
    }
  }

  // frontend (repo) 単位の追跡 (全 wave から導出)。各 repo の現 live deploy
  // (traffic 100%) も併記するため、traffic 取得対象にこの repo 群も足す。
  const allTracks = computeFrontendTracks(waves);

  // compat グラフに出る repo (backend + frontend) + pending repo + 追跡 repo の
  // version traffic を引く。グラフの frontend ノード hover に「現 active version の
  // % / id」を出す用 + Pending releases の単一真実導出用 + Frontends セクションの
  // 「Current (live)」列 + frontend/backend 判定用 (Refs #237 / #268)。
  let trafficByRepo: Map<string, TrafficRecord> = new Map();
  if (env.COMPAT_KV) {
    const repos = new Set<string>();
    if (globalCompat) {
      for (const b of globalCompat.backends) {
        repos.add(b.backend_repo);
        for (const m of b.matrix) repos.add(m.frontend);
      }
    }
    for (const r of pendingReleases) repos.add(r.repo);
    for (const t of allTracks) repos.add(t.repo);
    try {
      trafficByRepo = await getTrafficForRepos(env.COMPAT_KV, repos);
    } catch {
      trafficByRepo = new Map();
    }
  }

  // Frontends セクションは frontend (= CF Worker) repo だけを出す。wave には
  // backend も混ざるが、**Cloud Run backend (例: rust-alc-api) は除外**する。
  // ただし CF Worker は compat 上 `backend::` を持っていても (auth-worker 等)
  // frontend として残す。判定軸は #268 と同じ: CF Worker は version traffic
  // (`traffic::` = trafficByRepo) を持ち、Cloud Run backend は持たない。
  // => 除外条件 = 「`backend::` を持ち、かつ traffic:: が無い (= Cloud Run)」。
  // globalCompat 未取得 (COMPAT_KV 未 bind) 時は判別不能なので全件出す (degrade)。
  const backendRepos = new Set(
    (globalCompat?.backends ?? []).map((b) => b.backend_repo),
  );
  const frontendTracks = allTracks.filter(
    (t) => !backendRepos.has(t.repo) || trafficByRepo.has(t.repo),
  );
  // Pending releases は単一真実 (Refs #237): workers=traffic:: の no-traffic
  // version / cloudrun=pending-release:: を統合し、Traffic セクションと一致させる。
  // compat section の「Staged previews」内 ⚡ Flip all ボタンの出し分けに件数を使う
  // ため、compatSection より先に算出する。
  const unifiedPending = computeUnifiedPending(trafficByRepo, pendingReleases);
  const compatSection = renderGlobalCompatibilitySection(
    globalCompat,
    buildActiveWaveInfo(waves),
    trafficByRepo,
    unifiedPending.length,
  );
  const pendingReleaseSection = renderPendingReleaseSection(
    unifiedPending,
    flipGroup,
  );

  // frontend (repo) 単位の追跡セクション。wave 中心の一覧テーブルは廃止し、
  // frontend 単位の追跡 + compat グラフ (Tag Release / Staged previews + 一括
  // flip) に集約した。完了/失敗した個別 wave は `/release-wave/<id>` 直リンクで
  // 参照可能。Latest wave (= 最新 wave の state) と Current (live) (= traffic
  // 100% の実 deploy) の両方を出す (failed wave の後に flip 済みでも実態が見える)。
  const frontendSection = renderFrontendSection(frontendTracks, trafficByRepo);

  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Release Waves</title>
  <style>${COMMON_STYLES}${TAB_STYLES}</style>
  <script src="/release-wave/live.js" defer></script>
</head>
<body>
  <div class="container">
    ${renderTabs("release-wave")}
    <div class="page-header">
      <h1>Release Waves</h1>
      <span class="meta">Cross-repo coordinated release flows. Refs <a href="https://github.com/ippoan/ci-dashboard/issues/137">#137</a>.</span>
      <a class="refresh-btn" href="/release-wave"
        title="ページを再取得して最新状態に更新する (ブラウザキャッシュ無視 = ハードリセット)">🔄 更新（ハードリセット）</a>
    </div>
    <div class="wave-grid">
      <div class="wave-col">
        ${compatSection}
      </div>
      <div class="wave-col">
        ${frontendSection}
        ${pendingReleaseSection}
      </div>
    </div>
  </div>
</body>
</html>`;

  return htmlResponse(html);
}

// ----------------------------------------------------------------------------
// GET /release-wave/<wave_id>  →  詳細 + action buttons
// ----------------------------------------------------------------------------

export async function handleReleaseWaveDetailPage(
  env: Env,
  wave_id: string,
): Promise<Response> {
  const result = (await hubStub(env).get(wave_id)) as RpcResult<WaveState>;
  if (!result.ok) {
    if (result.code === "NOT_FOUND") {
      return htmlResponse(notFoundHtml(wave_id), 404);
    }
    return htmlResponse(errorHtml(result.code, result.error), 500);
  }
  const w = result.data;

  // ---- Compatibility (matrix section + gate 判定で共有) ----
  let compat: WaveCompatibility | null = null;
  if (env.COMPAT_KV) {
    try {
      compat = await computeWaveCompatibility(
        env.COMPAT_KV,
        w.repos.map((r) => r.repo),
      );
    } catch {
      compat = null;
    }
  }
  const gateBlockers = computeGateBlockers(w, compat);
  const gateBlocked = gateBlockers.length > 0;

  // ---- Actions (state-dependent) ----
  const canApprove = w.state === "pending-approval";
  const canRollback = w.state === "flipped";
  const canAbort = w.state === "staging" || w.state === "pending-approval";
  // force-fail (stuck wave clear): in-progress (staging / pending-approval /
  // flipping) で有効。flipped は rollback を使うので対象外、terminal は不可。
  const canForceFail =
    w.state === "staging" ||
    w.state === "pending-approval" ||
    w.state === "flipping";

  const rollbackDisabledNote = !w.rollback.safe
    ? `<div class="unsafe">
         Rollback is <strong>unsafe</strong> (${escapeHtml(w.rollback.unsafe_reason ?? "")}).
         The button below will pass <code>force=true</code> — manual DB recovery
         is your responsibility.
       </div>`
    : "";

  // compatibility gate (Refs #157 Phase C): blocked 時は approve に force を
  // 付けて override 可にし、警告を出す。
  const gateNote = gateBlocked
    ? `<div class="unsafe">
         Compatibility gate <strong>blocks approve</strong>:
         ${escapeHtml(gateBlockers.join("; "))}.
         The button below passes <code>force=true</code> to override —
         flipping with untested frontends is your call.
       </div>`
    : "";

  const actionsBlock = `
    <div class="actions">
      <form method="post" action="/api/release-wave/${encodeURIComponent(w.wave_id)}/approve">
        ${gateBlocked ? `<input type="hidden" name="force" value="true">` : ""}
        <button type="submit" ${canApprove ? "" : "disabled"}
          title="Approve a pending-approval wave to proceed to flipping">
          Approve &amp; Flip${gateBlocked ? " (override compat gate)" : ""}
        </button>
      </form>
      <form method="post" action="/api/release-wave/${encodeURIComponent(w.wave_id)}/rollback">
        ${!w.rollback.safe ? `<input type="hidden" name="force" value="true">` : ""}
        <button type="submit" class="danger" ${canRollback ? "" : "disabled"}
          title="Roll the wave back to pre-flip revisions">
          Rollback${!w.rollback.safe ? " (force)" : ""}
        </button>
      </form>
      <form method="post" action="/api/release-wave/${encodeURIComponent(w.wave_id)}/abort">
        <button type="submit" class="warn" ${canAbort ? "" : "disabled"}
          title="Abort before flip (valid in staging / pending-approval only)">
          Abort
        </button>
      </form>
      <form method="post" action="/api/release-wave/${encodeURIComponent(w.wave_id)}/fail">
        <button type="submit" class="danger" ${canForceFail ? "" : "disabled"}
          title="Force-fail a stuck wave to terminal 'failed' (valid in staging / pending-approval / flipping). Use when a flip hung without a callback. For a flipped wave use Rollback instead.">
          Force-fail (clear)
        </button>
      </form>
    </div>
    ${gateNote}
    ${rollbackDisabledNote}
  `;

  // ---- Repos table ----
  const reposRows = w.repos
    .map((r) => {
      const stageCell = r.stage_status === "done"
        ? `<span class="ok">done</span>`
        : r.stage_status === "failed"
        ? `<span class="err">failed</span>`
        : `<span class="pending">pending</span>`;
      const flipCell = r.flip_status === "done"
        ? `<span class="ok">done</span>`
        : r.flip_status === "failed"
        ? `<span class="err">failed</span>`
        : `<span class="pending">pending</span>`;
      // preview_url は scheme を http/https に絞ってから link 化する。
      // javascript: / data: 等の dangerous scheme は null 化して text-only 表示。
      const safePreview = safeHttpUrl(r.preview_url);
      const previewCell = safePreview
        ? `<a href="${escapeHtml(safePreview)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safePreview)}</a>`
        : r.preview_url
        ? `<span class="meta" title="non-http(s) scheme rejected">${escapeHtml(r.preview_url)}</span>`
        : `<span class="meta">—</span>`;
      const rollbackTargetCell = r.flip_from_revision
        ? escapeHtml(r.flip_from_revision)
        : `<span class="meta">—</span>`;
      const errCell = r.stage_error || r.flip_error
        ? `<span class="err">${escapeHtml(r.stage_error ?? r.flip_error ?? "")}</span>`
        : `<span class="meta">—</span>`;
      return `
        <tr>
          <td>${escapeHtml(r.repo)}</td>
          <td>${escapeHtml(r.target_tag)}</td>
          <td>${stageCell}</td>
          <td>${flipCell}</td>
          <td>${previewCell}</td>
          <td class="meta">${rollbackTargetCell}</td>
          <td>${errCell}</td>
        </tr>`;
    })
    .join("");

  // ---- Events timeline (newest first) ----
  const eventsHtml = w.events
    .slice()
    .reverse()
    .map((e) => {
      return `<li><span class="meta">${escapeHtml(e.at)}</span> &mdash; <strong>${escapeHtml(e.kind)}</strong>: ${escapeHtml(e.summary)}</li>`;
    })
    .join("");

  // ---- Compatibility matrix (Refs #157 Phase A) ----
  // 上で算出した compat を再利用。null (未 bind / 失敗) 時は section を出さない。
  const compatHtml = compat
    ? renderCompatibilitySection(compat, w.wave_id)
    : "";

  const rollbackSafetyHtml = w.rollback.safe
    ? `<p class="ok">rollback.safe = <strong>true</strong> (no contract migration applied yet)</p>`
    : `<p class="err">rollback.safe = <strong>false</strong></p>
       <p class="meta">unsafe_reason: ${escapeHtml(w.rollback.unsafe_reason ?? "")}</p>
       <p class="meta">unsafe_since: ${escapeHtml(w.rollback.unsafe_since ?? "")}</p>
       <p class="meta">unsafe_by_migration: ${escapeHtml(w.rollback.unsafe_by_migration ?? "")}</p>`;

  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Wave ${escapeHtml(w.wave_id)} &mdash; ci-dashboard</title>
  <style>${COMMON_STYLES}${TAB_STYLES}</style>
  <script src="/release-wave/live.js" defer></script>
</head>
<body>
  <div class="container">
    ${renderTabs("release-wave")}
    <div class="nav breadcrumb">
      <a href="/release-wave">Release Waves</a> &raquo; ${escapeHtml(w.wave_id)}
    </div>
    <h1>
      ${escapeHtml(w.wave_id)}
      <span class="badge" style="background:${stateColor(w.state)}">${escapeHtml(w.state)}</span>
    </h1>
    <div class="toolbar">
      <a class="refresh-btn" href="/release-wave/${encodeURIComponent(w.wave_id)}"
        title="この wave の状態を再取得して更新する (ブラウザキャッシュ無視 = ハードリセット)">🔄 更新（ハードリセット）</a>
    </div>
    <p class="meta">
      flip_policy: <strong>${escapeHtml(w.flip_policy)}</strong> &middot;
      started_at: ${escapeHtml(w.started_at)}
      ${w.note ? ` &middot; note: ${escapeHtml(w.note)}` : ""}
    </p>

    <div class="section">
      <h2>Actions</h2>
      ${actionsBlock}
    </div>

    <div class="section">
      <h2>Rollback Safety</h2>
      ${rollbackSafetyHtml}
    </div>

    <div class="section">
      <h2>Repos</h2>
      <table>
        <thead>
          <tr>
            <th>Repo</th>
            <th>Target Tag</th>
            <th>Stage</th>
            <th>Flip</th>
            <th>Preview URL</th>
            <th>Rollback Target</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>${reposRows}</tbody>
      </table>
    </div>

    ${compatHtml}

    <div class="section">
      <h2>Events</h2>
      <ul>${eventsHtml}</ul>
    </div>

    <div class="section">
      <h2>Raw State (JSON)</h2>
      <pre>${escapeHtml(JSON.stringify(w, null, 2))}</pre>
    </div>
  </div>
</body>
</html>`;

  return htmlResponse(html);
}

// ----------------------------------------------------------------------------
// Pending releases section (Refs #181 / #174)
// ----------------------------------------------------------------------------

/**
 * 単独 v* リリースで upload された no-traffic version の一覧 + Flip ボタン。
 *
 * frontend-ci の release deploy が `wrangler versions upload` した version を
 * `pending-release::<repo>` として KV に持つ。各行の Flip ボタンは
 * `/api/release-wave/pending-release/flip` に repo を POST し、handler 経由で
 * `wrangler versions deploy <version_id>@100%` を発火する。
 *
 * record が無ければセクション自体は出すが「pending release はありません」を表示
 * (= 「ここで単独リリースを flip できる」affordance を常設)。
 */
function renderPendingReleaseSection(
  records: UnifiedPending[],
  flipGroup: FlipGroupRecord | null,
): string {
  const rows = records
    .map((r) => {
      const safe = safeHttpUrl(r.preview_url);
      const previewCell = safe
        ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">preview</a>`
        : `<span class="meta">—</span>`;
      const shortVid =
        r.version_id.length > 8 ? r.version_id.slice(0, 8) : r.version_id;
      const tagCell = r.tag ? escapeHtml(r.tag) : `<span class="meta">—</span>`;
      // flip 入口は source 別:
      //  - traffic (workers): /traffic-rollback に version_id を渡して
      //    `wrangler versions deploy <id>@100%`。
      //  - pending (cloudrun 等): /pending-release/flip に repo を渡す
      //    (handler が platform で routing、cloudrun は target_tag→pending-<tag>)。
      const flipForm =
        r.source === "traffic"
          ? `<form method="post" action="/api/release-wave/traffic-rollback" style="margin:0">
              <input type="hidden" name="repo" value="${escapeHtml(r.repo)}">
              <input type="hidden" name="version_id" value="${escapeHtml(r.version_id)}">
              <button type="submit"
                title="Promote this no-traffic version to 100% (wrangler versions deploy ${escapeHtml(r.version_id)}@100%)">
                Flip to 100%
              </button>
            </form>`
          : `<form method="post" action="/api/release-wave/pending-release/flip" style="margin:0">
              <input type="hidden" name="repo" value="${escapeHtml(r.repo)}">
              <button type="submit"
                title="Promote this no-traffic release to 100% traffic">
                Flip to 100%
              </button>
            </form>`;
      return `
        <tr>
          <td>${escapeHtml(r.repo)}</td>
          <td class="meta">${tagCell}</td>
          <td class="meta" title="${escapeHtml(r.version_id)}">${escapeHtml(shortVid)}…</td>
          <td>${previewCell}</td>
          <td class="meta">${escapeHtml(r.uploaded_at)}</td>
          <td class="actions">${flipForm}</td>
        </tr>`;
    })
    .join("");

  // wave = 一括 flip。pending が 2 件以上なら「全部まとめて flip」ボタンを出す
  // (Refs #237)。1 件でも押せるが、単独行の Flip と機能は同じなので 2 件以上で表示。
  const flipAllBtn =
    records.length >= 2
      ? `<form method="post" action="/api/release-wave/pending-release/flip-all"
              style="margin:0 0 8px 0"
              onsubmit="return confirm('${records.length} 件の pending release を一括で 100% flip します。よろしいですか？');">
           <button type="submit"
             title="全 pending release を一括で 100% traffic へ flip (wave)">
             ⚡ Flip all ${records.length} to 100% (wave)
           </button>
         </form>`
      : "";

  const body = records.length > 0
    ? `${flipAllBtn}<table>
        <thead>
          <tr>
            <th>Repo</th><th>Tag</th><th>Version</th><th>Preview</th>
            <th>Uploaded</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<p class="meta">flip 待ちの no-traffic version はありません。
        v* tag を打つと no-traffic で deploy され、ここに出ます。</p>`;

  return `
    <div class="section">
      <h2>Pending releases (no-traffic)${helpMark(
        `flip 待ちの no-traffic version (= Cloudflare 実機 0% / cloudrun
        pending revision)。Flip で 100% traffic へ promote する。Traffic セクションと
        同じ単一真実 (traffic 由来) から導出。
        Refs <a href="https://github.com/ippoan/ci-dashboard/issues/237">#237</a>.`,
      )}</h2>
      ${body}
      ${renderFlipGroupRollback(flipGroup)}
    </div>`;
}

/**
 * 直近の一括 flip (flip-group) の rollback パネル。flip-group があれば「直前の
 * active version へ一括で戻す」ボタンを出す。戻し先 (rollback_to) を控えられた
 * repo のみが対象。Refs #237。
 */
function renderFlipGroupRollback(flipGroup: FlipGroupRecord | null): string {
  if (!flipGroup || flipGroup.items.length === 0) return "";
  const rollbackable = flipGroup.items.filter((it) => it.rollback_to);
  const repoList = flipGroup.items
    .map((it) => {
      // 単一 rollback: repo を指定して flip-group-rollback に POST (= その repo
      // だけ flip 直前の version へ戻す)。戻し先未記録の repo はボタンを出さない。
      const single = it.rollback_to
        ? `→ ${escapeHtml((it.rollback_tag ?? it.rollback_to).slice(0, 16))}
           <form method="post" action="/api/release-wave/pending-release/flip-group-rollback"
                 style="display:inline;margin-left:6px"
                 onsubmit="return confirm('${escapeHtml(it.repo)} を flip 直前の version へ rollback します。よろしいですか？');">
             <input type="hidden" name="repo" value="${escapeHtml(it.repo)}">
             <button type="submit"
               title="この repo だけ flip 直前の version へ rollback">↩ Rollback</button>
           </form>`
        : `<span class="meta">(戻し先不明)</span>`;
      return `<li>${escapeHtml(it.repo)} <span class="meta">${escapeHtml(it.flipped_tag)}</span> ${single}</li>`;
    })
    .join("");
  const btn =
    rollbackable.length > 0
      ? `<form method="post" action="/api/release-wave/pending-release/flip-group-rollback"
              style="margin:8px 0 0 0"
              onsubmit="return confirm('直近の一括 flip (${rollbackable.length} repo) を直前の version へ一括 rollback します。よろしいですか？');">
           <button type="submit"
             title="直近の一括 flip を一括 rollback (各 repo を flip 直前の version へ戻す)">
             ↩ Rollback last flip (${rollbackable.length} repo)
           </button>
         </form>`
      : `<p class="meta">この flip-group には戻し先が記録された repo がありません
          (各行の traffic-rollback で個別に戻してください)。</p>`;
  return `
    <div class="subsection" style="margin-top:12px;border-top:1px solid #2a2a2a;padding-top:10px">
      <h3 style="margin:0 0 4px 0;font-size:0.95em">直近の一括 flip
        <span class="meta">(${escapeHtml(flipGroup.flipped_at)} by ${escapeHtml(flipGroup.actor)})</span>
      </h3>
      <ul class="meta" style="margin:4px 0">${repoList}</ul>
      ${btn}
    </div>`;
}

// ----------------------------------------------------------------------------
// Compatibility matrix section (Refs #157 Phase A)
// ----------------------------------------------------------------------------

/**
 * Release Wave 一覧ページ用の wave 非依存 compatibility 俯瞰セクション。
 * 全 `backend::` record とその consumer frontend の突合グラフ (SVG) を出す。
 * backend record が無ければ案内文のみ。
 */
/**
 * 全体俯瞰グラフ (wave 非依存) に重ねる「現在進行中の wave」由来の情報。
 *
 * - `preview`:  frontend repo → 今 staging / pending-approval 中の wave の
 *   preview URL。複数 active wave がある場合は list 末尾 (= 最新) が勝つ。
 * - `waveOf`:   frontend repo → その active wave の wave_id (node を詳細ページへ
 *   link するため)。
 * - `pendingFlips`: pending-approval の wave 群 (Approve & Flip ボタン用)。
 */
interface ActiveWaveInfo {
  preview: Map<string, { url: string; wave_id: string }>;
  waveOf: Map<string, string>;
  pendingFlips: Array<{ wave_id: string }>;
}

/** active な (staging / pending-approval) wave から ActiveWaveInfo を組む。 */
function buildActiveWaveInfo(waves: WaveState[]): ActiveWaveInfo {
  const preview = new Map<string, { url: string; wave_id: string }>();
  const waveOf = new Map<string, string>();
  const pendingFlips: Array<{ wave_id: string }> = [];
  for (const w of waves) {
    if (w.state !== "staging" && w.state !== "pending-approval") continue;
    if (w.state === "pending-approval") pendingFlips.push({ wave_id: w.wave_id });
    for (const r of w.repos) {
      waveOf.set(r.repo, w.wave_id);
      const safe = safeHttpUrl(r.preview_url);
      if (safe) preview.set(r.repo, { url: safe, wave_id: w.wave_id });
    }
  }
  return { preview, waveOf, pendingFlips };
}

function renderGlobalCompatibilitySection(
  compat: WaveCompatibility | null,
  active?: ActiveWaveInfo,
  trafficByRepo?: Map<string, TrafficRecord>,
  pendingFlipCount = 0,
): string {
  if (!compat || compat.backends.length === 0) {
    return `
    <div class="section">
      <h2>Compatibility (all consumers)${helpMark(
        `No backend deploy records yet. backend deploy が
        <code>backend-deploy-report</code> を打ち、consumer frontend が
        integration test green で <code>frontend-test-report</code> を打つと、
        ここに wave 横断の俯瞰グラフが出る。
        Refs <a href="https://github.com/ippoan/ci-dashboard/issues/157">#157</a>.`,
      )}</h2>
    </div>`;
  }
  const verdict = !compat.checked
    ? `<span class="meta">no consuming frontends recorded</span>`
    : compat.verified
    ? `<span class="ok"><strong>all consumers tested</strong></span>`
    : `<span class="err"><strong>some consumers untested</strong></span>`;
  const svg = renderCompatibilitySvg(compat, active, trafficByRepo);
  const body = svg
    ? svg
    : `<p class="meta">backend record はあるが、まだどの frontend も test 履歴を
        report していない (consumer edge 無し)。</p>`;
  return `
    <div class="section">
      <h2>Compatibility (all consumers) — ${verdict}${helpMark(
        `全 backend の<strong>現 production image</strong>を既 deploy
        frontend が integration test 済みか (wave 横断)。緑 = tested / 赤 = untested。
        赤 (untested) の consumer は下のボタンから直接 retest できる。
        Refs <a href="https://github.com/ippoan/ci-dashboard/issues/157">#157</a>.`,
      )}</h2>
      ${body}
      ${renderGlobalRetestButtons(compat)}
      ${renderActiveWaveOverlay(active, pendingFlipCount)}
    </div>`;
}

/**
 * global (wave 非依存) Compatibility グラフの直下に、untested edge
 * (backend × frontend) ごとの "Re-test" ボタングリッドを描画する (Refs #157)。
 *
 * global グラフ自体が wave 非依存なので、retest も wave 非依存の
 * `/api/release-wave/retest-consumer` に統一して POST する。これにより backend
 * が単独 deploy (wave 未紐付け = `wave_id` null) でも retest できる
 * (旧実装は wave-bound endpoint しか無く no-wave backend のボタンを disabled に
 * していた。Refs #137 (A))。`backend_repo` + `frontend` を hidden field で渡し、
 * backend image は handler 側が `backend::<repo>.current_image` を採用する。
 *
 * JS 不使用 (form POST のみ) なので strict CSP `default-src 'none'` のまま動く。
 */
function renderGlobalRetestButtons(compat: WaveCompatibility): string {
  const groups: string[] = [];
  for (const b of compat.backends) {
    const reds = b.matrix.filter((m) => !m.tested_against_target);
    if (reds.length === 0) continue;
    const buttons = reds
      .map((m) => {
        const waveNote = b.wave_id
          ? ` (wave ${escapeHtml(b.wave_id)})`
          : " (no wave)";
        return `<form method="post" action="/api/release-wave/retest-consumer" style="display:inline; margin:0">
            <input type="hidden" name="backend_repo" value="${escapeHtml(b.backend_repo)}">
            <input type="hidden" name="frontend" value="${escapeHtml(m.frontend)}">
            <button type="submit" class="warn"
              title="Re-test ${escapeHtml(m.frontend)} against ${escapeHtml(b.backend_repo)} の現 image${waveNote}">
              Re-test ${escapeHtml(m.frontend)}
            </button>
          </form>`;
      })
      .join(" ");
    groups.push(`
      <div style="margin-top:8px">
        <strong class="meta">${escapeHtml(b.backend_repo)}
          ${b.wave_id ? `<span class="meta">(wave ${escapeHtml(b.wave_id)})</span>` : `<span class="meta">(no wave)</span>`}</strong>
        <div class="actions" style="margin-top:4px">${buttons}</div>
      </div>`);
  }
  if (groups.length === 0) return "";
  return `
    <div style="margin-top:10px">
      <strong class="meta">Re-test untested consumers</strong>
      ${groups.join("")}
    </div>`;
}

/**
 * 俯瞰グラフ直下に、進行中 wave の preview link と Approve & Flip ボタンを出す。
 * SVG node に直接埋めると anchor のネストや座標管理が破綻するため、HTML として
 * グラフの下にまとめて描画する (= preview を「ここ (compat section)」に出す)。
 *
 * active wave が無い時も block 自体は常に描画し、placeholder / disabled ボタンを
 * 出す (= UI affordance を常設して「ここで flip できる」ことを見せる)。
 */
function renderActiveWaveOverlay(
  active?: ActiveWaveInfo,
  pendingFlipCount = 0,
): string {
  const previewEntries = active ? [...active.preview.entries()] : [];
  const pendingFlips = active ? active.pendingFlips : [];

  const previews = previewEntries
    .map(
      ([repo, p]) =>
        `<li><code>${escapeHtml(repo)}</code> →
          <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.url)}</a>
          <span class="meta">(${escapeHtml(p.wave_id)})</span></li>`,
    )
    .join("");
  const previewBlock = `
    <div style="margin-top:10px">
      <strong class="meta">Staged previews (active waves)</strong>
      ${previews
        ? `<ul style="margin:4px 0 0; padding-left:20px">${previews}</ul>`
        : `<p class="meta" style="margin:4px 0 0">active な wave (staging / pending-approval) はありません。</p>`}
    </div>`;

  // 一括 flip: 全 pending release (no-traffic version) を 100% へ promote する。
  // Pending releases セクションの "⚡ Flip all" と同じ endpoint を叩く (= staged
  // preview を確認した上でここから直接まとめて flip できる affordance)。
  // **flip 対象 (pending release) が 0 件なら出さない** — 「active な wave は
  // ありません」と矛盾するため (= 何も flip できないのにボタンを出さない)。
  const bulkFlipBtn =
    pendingFlipCount > 0
      ? `
    <form method="post" action="/api/release-wave/pending-release/flip-all"
          style="margin:0 8px 0 0"
          onsubmit="return confirm('${pendingFlipCount} 件の pending release (no-traffic version) を一括で 100% flip します。よろしいですか？');">
      <button type="submit"
        title="全 pending release (no-traffic version) を一括で 100% traffic へ flip">
        ⚡ Flip all to 100% (${pendingFlipCount})
      </button>
    </form>`
      : "";

  // pending-approval の wave ごとに Approve & Flip ボタン。一覧 (list page) と
  // 同じく force は付けない (compat gate ブロック時は詳細ページで override)。
  const flips = pendingFlips
    .map(
      (f) => `
        <form method="post" action="/api/release-wave/${encodeURIComponent(f.wave_id)}/approve" style="margin:0">
          <button type="submit"
            title="Approve & flip ${escapeHtml(f.wave_id)} (no compat-gate override here)">
            Approve &amp; Flip: ${escapeHtml(f.wave_id)}
          </button>
        </form>`,
    )
    .join("");

  // flip 対象も active wave も無ければ actions block 自体を出さない
  // (空の <div> でボタン枠だけ残るのを防ぐ)。
  const flipBlock =
    bulkFlipBtn || flips
      ? `
    <div class="actions" style="margin-top:10px">
      ${bulkFlipBtn}
      ${flips}
    </div>`
      : "";

  return previewBlock + flipBlock;
}

/**
 * wave 内 backend の現 image に対する既 deploy frontend の突合 matrix を描画する。
 * 緑 (tested) / 赤 (untested) を highlight する。read-only / 非 block。
 */
function renderCompatibilitySection(
  compat: WaveCompatibility,
  wave_id: string,
): string {
  if (compat.backends.length === 0) {
    return `
    <div class="section">
      <h2>Compatibility (frontend ↔ backend)${helpMark(
        `No backend deploy records for this wave's repos yet
        (nothing to check against).`,
      )}</h2>
    </div>`;
  }

  const verdict = !compat.checked
    ? `<span class="meta">no consuming frontends recorded</span>`
    : compat.verified
    ? `<span class="ok"><strong>verified</strong></span>`
    : `<span class="err"><strong>not verified</strong> — some frontends untested</span>`;

  const retestAction = encodeURIComponent(wave_id);
  // 赤が 1 つでもあれば "Re-test all reds" ボタンを出す。
  const hasReds = compat.backends.some((b) =>
    b.matrix.some((m) => !m.tested_against_target),
  );
  const retestAllBlock = hasReds
    ? `<div class="actions">
         <form method="post" action="/api/release-wave/${retestAction}/retest">
           <button type="submit" class="warn"
             title="Dispatch release-wave-retest to every untested frontend">
             Re-test all reds
           </button>
         </form>
       </div>`
    : "";

  const blocks = compat.backends
    .map((b) => {
      const rows =
        b.matrix.length === 0
          ? `<tr><td colspan="5" class="empty">No frontend has tested against this backend.</td></tr>`
          : b.matrix
              .map((m) => {
                const statusCell = m.tested_against_target
                  ? `<span class="ok">tested</span>`
                  : `<span class="err">untested</span>`;
                const at = m.tested_against_at
                  ? `<span class="meta">${escapeHtml(m.tested_against_at)}</span>`
                  : `<span class="meta">—</span>`;
                const last = m.tested_against_target
                  ? `<span class="meta">—</span>`
                  : `<span class="meta">${escapeHtml(m.last_tested_image ?? "—")}</span>`;
                // 赤行のみ per-frontend の Re-test ボタンを出す。
                const actionCell = m.tested_against_target
                  ? `<span class="meta">—</span>`
                  : `<form method="post" action="/api/release-wave/${retestAction}/retest" style="margin:0">
                       <input type="hidden" name="frontend" value="${escapeHtml(m.frontend)}">
                       <button type="submit" class="warn" title="Re-test this frontend against the current image">Re-test</button>
                     </form>`;
                return `
                <tr>
                  <td>${escapeHtml(m.frontend)}</td>
                  <td class="meta">${escapeHtml(m.prod_version ?? "—")}</td>
                  <td>${statusCell} ${at}</td>
                  <td>${last}</td>
                  <td>${actionCell}</td>
                </tr>`;
              })
              .join("");
      return `
      <h3>${escapeHtml(b.backend_repo)}
        <span class="meta">${b.current_tag ? `${escapeHtml(b.current_tag)} · ` : ""}@ ${escapeHtml(b.current_image ?? "—")}</span>
      </h3>
      <table>
        <thead>
          <tr>
            <th>Frontend</th>
            <th>Prod Version</th>
            <th>Tested vs current image</th>
            <th>Last tested image</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
    })
    .join("");

  return `
    <div class="section">
      <h2>Compatibility (frontend ↔ backend) — ${verdict}${helpMark(
        `既 deploy frontend が wave 内 backend の<strong>現 production
        image</strong>を integration test 済みか。赤は未検証 — "Re-test" で
        <code>release-wave-retest</code> を frontend に dispatch し、green 化後に
        matrix が自動更新される。edge / node に hover すると過去 test 履歴が出る。
        Refs <a href="https://github.com/ippoan/ci-dashboard/issues/157">#157</a>.`,
      )}</h2>
      ${renderCompatibilitySvg(compat)}
      ${retestAllBlock}
      ${blocks}
    </div>`;
}

/**
 * compatibility gate (Refs #157 Phase C) の blocker 説明配列を返す。
 * `require_compatibility=true` な backend のうち未 test frontend を持つもの。
 * compat が無い (COMPAT_KV 未 bind) 場合は gate を素通り ([])。
 */
function computeGateBlockers(
  w: WaveState,
  compat: WaveCompatibility | null,
): string[] {
  if (!compat) return [];
  const required = w.repos
    .filter((r) => r.require_compatibility)
    .map((r) => r.repo);
  if (required.length === 0) return [];
  const blockers: string[] = [];
  for (const b of compat.backends) {
    if (!required.includes(b.backend_repo)) continue;
    const reds = b.matrix
      .filter((m) => !m.tested_against_target)
      .map((m) => m.frontend);
    if (reds.length > 0) {
      blockers.push(`${b.backend_repo}: ${reds.join(", ")}`);
    }
  }
  return blockers;
}

/** 長い識別子を省略表示 (full 値は <title> 等に別途載せる)。 */
function truncLabel(s: string, max = 30): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * backend ↔ frontend 結合を二部グラフの inline SVG で描く (Refs #157)。
 *
 * - 左列 = backend (現 image)、右列 = frontend (prod version)
 * - edge: 緑 = 現 image を test 済み / 赤 = 未 test
 * - hover: edge / node の `<title>` に過去 test 履歴 (OS ネイティブ tooltip)
 *
 * JS を使わず SVG + inline style のみ (= ページの strict CSP `default-src 'none'`
 * のまま動く)。
 */
function renderCompatibilitySvg(
  compat: WaveCompatibility,
  active?: ActiveWaveInfo,
  trafficByRepo?: Map<string, TrafficRecord>,
): string {
  type Edge = {
    backend: string;
    frontend: string;
    tested: boolean;
    title: string;
  };
  const edges: Edge[] = [];
  const backendOrder: string[] = [];
  const frontendOrder: string[] = [];
  const backendImage = new Map<string, string | null>();
  // backend image に対応する git release tag (v2 record のみ)。node line2 に併記。
  const backendTag = new Map<string, string | null>();
  const frontendVersion = new Map<string, string | null>();
  // frontend が 1 つでも赤 edge を持てば赤扱い (node 枠色)。
  const frontendHasRed = new Map<string, boolean>();
  // frontend が突合した backend image (= 緑なら current と同一 SHA、赤なら最後に
  // test した stale SHA)。両ノードに short SHA を出して一致を目視できるようにする。
  const frontendTestedImg = new Map<string, string | null>();

  // 長い image 識別子 (git SHA / revision) を先頭 12 文字に短縮する。完全値は
  // hover (title) 側に出す。
  const shortSha = (s: string | null | undefined): string =>
    !s ? "—" : s.length > 14 ? `${s.slice(0, 12)}…` : s;

  for (const b of compat.backends) {
    if (!backendOrder.includes(b.backend_repo)) {
      backendOrder.push(b.backend_repo);
      backendImage.set(b.backend_repo, b.current_image);
      backendTag.set(b.backend_repo, b.current_tag ?? null);
    }
    for (const m of b.matrix) {
      if (!frontendOrder.includes(m.frontend)) {
        frontendOrder.push(m.frontend);
        frontendVersion.set(m.frontend, m.prod_version);
        frontendHasRed.set(m.frontend, false);
      }
      if (!m.tested_against_target) frontendHasRed.set(m.frontend, true);
      // 突合 SHA を表示用に記録。緑 (current image を test 済) があればそれを
      // 優先し、無ければ最後に test した image を出す。
      if (m.tested_against_target) {
        frontendTestedImg.set(m.frontend, b.current_image);
      } else if (!frontendTestedImg.has(m.frontend)) {
        frontendTestedImg.set(m.frontend, m.last_tested_image ?? null);
      }

      const histLines = m.history.length
        ? m.history
            .map((h) => `  ${h.tested_at}  ${h.backend_image}`)
            .join("\n")
        : "  (no prior test recorded)";
      const head = m.tested_against_target
        ? `TESTED ${m.frontend} ✓ ${b.backend_repo}@${b.current_image ?? "?"}`
        : `UNTESTED ${m.frontend} ✗ ${b.backend_repo}@${b.current_image ?? "?"}`;
      edges.push({
        backend: b.backend_repo,
        frontend: m.frontend,
        tested: m.tested_against_target,
        title: `${head}\n— history (newest first) —\n${histLines}`,
      });
    }
  }

  // backend も frontend も無ければ描かない。backend record だけある (consumer
  // edge 0) 場合は backend ノードだけ描画して現 image (SHA) を見せる。
  if (backendOrder.length === 0 && frontendOrder.length === 0) return "";

  // ---- layout ----
  const boxW = 250;
  // 3 行 (repo / deployed・latest tag / traffic %) 入るよう高さを確保。
  const boxH = 54;
  const vGap = 22;
  const topPad = 28; // legend 用
  const sidePad = 16;
  const width = 760;
  const leftX = sidePad;
  const rightX = width - boxW - sidePad;
  const nMax = Math.max(backendOrder.length, frontendOrder.length);
  const innerH = nMax * boxH + Math.max(0, nMax - 1) * vGap;
  const height = topPad + innerH + sidePad;

  const colY = (i: number, count: number): number => {
    const colH = count * boxH + Math.max(0, count - 1) * vGap;
    const start = topPad + (innerH - colH) / 2;
    return start + i * (boxH + vGap);
  };
  const bY = (repo: string) =>
    colY(backendOrder.indexOf(repo), backendOrder.length);
  const fY = (repo: string) =>
    colY(frontendOrder.indexOf(repo), frontendOrder.length);

  const GREEN = "#188038";
  const RED = "#d93025";
  const BLUE = "#1a73e8";
  const GRAY = "#5f6368";

  // ---- edges (node の下に描く) ----
  const edgeSvg = edges
    .map((e) => {
      const x1 = leftX + boxW;
      const y1 = bY(e.backend) + boxH / 2;
      const x2 = rightX;
      const y2 = fY(e.frontend) + boxH / 2;
      const mx = (x1 + x2) / 2;
      const color = e.tested ? GREEN : RED;
      const dash = e.tested ? "" : ` stroke-dasharray="5 4"`;
      return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2"${dash} opacity="0.85"><title>${escapeHtml(e.title)}</title></path>`;
    })
    .join("");

  // ---- node box helper ----
  const node = (
    x: number,
    y: number,
    line1: string,
    line2: string,
    border: string,
    fullTitle: string,
    href?: string,
    line3?: string,
  ): string => {
    const line3Svg = line3
      ? `<text x="${x + 10}" y="${y + 45}" font-family="monospace" font-size="10.5"
        fill="${GRAY}">${escapeHtml(truncLabel(line3, 40))}</text>`
      : "";
    const g = `<g><title>${escapeHtml(fullTitle)}</title>
      <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="6"
        fill="#ffffff" stroke="${border}" stroke-width="1.5"/>
      <text x="${x + 10}" y="${y + 16}" font-family="monospace" font-size="12"
        fill="#202124">${escapeHtml(truncLabel(line1, 32))}</text>
      <text x="${x + 10}" y="${y + 31}" font-family="monospace" font-size="10.5"
        fill="${GRAY}">${escapeHtml(truncLabel(line2, 40))}</text>
      ${line3Svg}
    </g>`;
    // active wave 中の frontend node は詳細ページへの link にする (node link 化)。
    return href
      ? `<a href="${escapeHtml(href)}" style="cursor:pointer">${g}</a>`
      : g;
  };

  const backendSvg = backendOrder
    .map((repo) => {
      const img = backendImage.get(repo) ?? "—";
      const tag = backendTag.get(repo) ?? null;
      // line2: git tag があれば "<tag> · @ <sha>"、無ければ従来の "@ <sha>"。Refs #197。
      const line2 = tag ? `${tag} · @ ${shortSha(img)}` : `@ ${shortSha(img)}`;
      return node(
        leftX,
        bY(repo),
        repo,
        line2,
        BLUE,
        `${repo}\ncurrent image: ${img ?? "—"}${tag ? `\ncurrent tag: ${tag}` : ""}`,
      );
    })
    .join("");

  const frontendSvg = frontendOrder
    .map((repo) => {
      const ver = frontendVersion.get(repo) ?? "—";
      const testedImg = frontendTestedImg.get(repo) ?? null;
      const border = frontendHasRed.get(repo) ? RED : GREEN;
      const verdictTxt = frontendHasRed.get(repo)
        ? "has untested edge(s)"
        : "all tested";
      const waveId = active?.waveOf.get(repo);
      const href = waveId
        ? `/release-wave/${encodeURIComponent(waveId)}`
        : undefined;
      const previewNote = active?.preview.has(repo)
        ? `\npreview: ${active.preview.get(repo)!.url}`
        : "";

      // traffic (version split) からノードに出す値を組む:
      //   - deployed: 現在 traffic を受けている (percentage 最大) version の tag
      //   - latest:   created_on が最新 (= 直近 upload) version の tag
      //   - traffic %: 各 version の % を簡潔に (例 "100% / 0%×N")
      const traffic = trafficByRepo?.get(repo);
      const tv = traffic?.versions ?? [];
      const labelOf = (v: TrafficRecord["versions"][number] | undefined): string =>
        v ? (v.tag ?? shortSha(v.version_id)) : "—";
      const deployed = tv.length
        ? [...tv].sort((a, b) => b.percentage - a.percentage)[0]
        : undefined;
      const latest = tv.length
        ? [...tv].sort((a, b) => (a.created_on ?? "") < (b.created_on ?? "") ? 1 : -1)[0]
        : undefined;
      // line2: deployed tag / latest tag (異なる時だけ latest も出す)。traffic が
      // 無ければ従来どおり prod version + tested image SHA。
      let line2: string;
      let line3: string | undefined;
      if (tv.length) {
        const dep = labelOf(deployed);
        const lat = labelOf(latest);
        line2 =
          deployed && latest && deployed.version_id !== latest.version_id
            ? `deploy ${dep} · new ${lat}`
            : `deploy ${dep}`;
        // line3: traffic %。100% version と「promote 待ち」の 0% 件数。
        // deployed(active) より古い 0% は用済みの過去履歴なので数えない
        // (テーブル renderRepoReleaseStatusSection と同じ絞り込み)。
        const pos = tv.filter((v) => v.percentage > 0);
        const depWhen = deployed?.created_on ?? null;
        const zeroPending = tv.filter(
          (v) =>
            v.percentage <= 0 &&
            (!depWhen || (v.created_on != null && v.created_on > depWhen)),
        ).length;
        const posPart = pos.map((v) => `${v.percentage}%`).join("/") || "—";
        line3 =
          zeroPending > 0 ? `traffic ${posPart} · 0%×${zeroPending}` : `traffic ${posPart}`;
      } else {
        line2 = testedImg ? `${ver} · vs @${shortSha(testedImg)}` : `prod ${ver}`;
      }

      // hover (title) には全 version の % / tag / id を列挙。
      const trafficNote = tv.length
        ? "\ntraffic:\n" +
          tv
            .map(
              (v) =>
                `  ${v.percentage}% ${v.tag ? v.tag + " " : ""}${v.version_id}`,
            )
            .join("\n")
        : "";
      return node(
        rightX,
        fY(repo),
        repo,
        line2,
        border,
        `${repo}\nprod version: ${ver}\ntested vs image: ${testedImg ?? "—"}\n${verdictTxt}${previewNote}${trafficNote}`,
        href,
        line3,
      );
    })
    .join("");

  // ---- legend ----
  const legend = `
    <g font-family="-apple-system, sans-serif" font-size="11" fill="${GRAY}">
      <line x1="${leftX}" y1="14" x2="${leftX + 22}" y2="14" stroke="${GREEN}" stroke-width="2"/>
      <text x="${leftX + 28}" y="17">tested (green)</text>
      <line x1="${leftX + 130}" y1="14" x2="${leftX + 152}" y2="14" stroke="${RED}" stroke-width="2" stroke-dasharray="5 4"/>
      <text x="${leftX + 158}" y="17">untested (red)</text>
      <text x="${rightX}" y="17">hover an edge/box for history</text>
    </g>`;

  return `
    <div style="overflow-x:auto; margin:8px 0;">
      <svg viewBox="0 0 ${width} ${height}" width="100%"
        style="max-width:${width}px; height:auto; background:#fafafa; border:1px solid #e8eaed; border-radius:8px;"
        role="img" aria-label="frontend backend compatibility graph">
        ${legend}
        ${edgeSvg}
        ${backendSvg}
        ${frontendSvg}
      </svg>
    </div>`;
}

// ----------------------------------------------------------------------------
// 404 / 500 HTML
// ----------------------------------------------------------------------------

function notFoundHtml(wave_id: string): string {
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>Wave not found</title><style>${COMMON_STYLES}</style></head>
<body><div class="container">
  <div class="nav breadcrumb">
    <a href="/">ci-dashboard</a> &raquo; <a href="/release-wave">Release Waves</a> &raquo; (not found)
  </div>
  <h1>Wave not found</h1>
  <p>No wave with id <code>${escapeHtml(wave_id)}</code> exists in the hub.</p>
</div></body></html>`;
}

function errorHtml(code: string, error: string): string {
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>Error</title><style>${COMMON_STYLES}</style></head>
<body><div class="container">
  <h1>Error</h1>
  <p><strong>${escapeHtml(code)}</strong>: ${escapeHtml(error)}</p>
</div></body></html>`;
}
