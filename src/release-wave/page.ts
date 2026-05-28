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
import { computeWaveCompatibility, type WaveCompatibility } from "./compat";

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
 * preview_url は repo 側 release-wave handler が `release_wave_stage`
 * MCP tool で報告する値 = handler が compromise されれば任意値を入れられる
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
      // Defense in depth against XSS:
      // - `script-src 'none'` で <script> / event handler 経由の実行をブロック
      // - `style-src 'self' 'unsafe-inline'` は本ページが inline <style> を
      //   使うため許可 (= injected style での data exfil は別軸の懸念だが、
      //   本ページの content は admin trusted DO state なのでバランス内)
      // - `default-src 'none'` で他リソース読み込みを全 deny
      // - `connect-src 'none'` で fetch / XHR 全 deny (本ページに JS 無し)
      // - preview link は target=_blank で別タブに飛ばすため frame-src 不要
      "Content-Security-Policy":
        "default-src 'none'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
  .container { max-width: 1100px; margin: 0 auto; }
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
`;

// ----------------------------------------------------------------------------
// Hub access
// ----------------------------------------------------------------------------

function hubStub(env: Env): DurableObjectStub<ReleaseWaveHub> {
  const id = env.RELEASE_WAVE_HUB.idFromName("singleton");
  return env.RELEASE_WAVE_HUB.get(id) as DurableObjectStub<ReleaseWaveHub>;
}

// ----------------------------------------------------------------------------
// GET /release-wave  →  全 wave 一覧
// ----------------------------------------------------------------------------

export async function handleReleaseWaveListPage(env: Env): Promise<Response> {
  const waves = (await hubStub(env).list()) as WaveState[];

  const rows = waves.length === 0
    ? `<tr><td colspan="5" class="empty">No release waves yet.</td></tr>`
    : waves
        .map((w) => {
          const repos = w.repos.map((r) => escapeHtml(r.repo)).join(", ");
          return `
            <tr>
              <td><a href="/release-wave/${encodeURIComponent(w.wave_id)}">${escapeHtml(w.wave_id)}</a></td>
              <td><span class="badge" style="background:${stateColor(w.state)}">${escapeHtml(w.state)}</span></td>
              <td class="meta">${escapeHtml(w.started_at)}</td>
              <td class="meta">${escapeHtml(w.flip_policy)}</td>
              <td class="meta">${repos}</td>
            </tr>`;
        })
        .join("");

  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Release Waves</title>
  <style>${COMMON_STYLES}${TAB_STYLES}</style>
</head>
<body>
  <div class="container">
    ${renderTabs("release-wave")}
    <h1>Release Waves</h1>
    <p class="meta">
      Cross-repo coordinated release flows. Refs
      <a href="https://github.com/ippoan/ci-dashboard/issues/137">#137</a>.
    </p>
    <table>
      <thead>
        <tr>
          <th>Wave ID</th>
          <th>State</th>
          <th>Started At</th>
          <th>Flip Policy</th>
          <th>Repos</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
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

  // ---- Actions (state-dependent) ----
  const canApprove = w.state === "pending-approval";
  const canRollback = w.state === "flipped";
  const canAbort = w.state === "staging" || w.state === "pending-approval";

  const rollbackDisabledNote = !w.rollback.safe
    ? `<div class="unsafe">
         Rollback is <strong>unsafe</strong> (${escapeHtml(w.rollback.unsafe_reason ?? "")}).
         The button below will pass <code>force=true</code> — manual DB recovery
         is your responsibility.
       </div>`
    : "";

  const actionsBlock = `
    <div class="actions">
      <form method="post" action="/api/release-wave/${encodeURIComponent(w.wave_id)}/approve">
        <button type="submit" ${canApprove ? "" : "disabled"}
          title="Approve a pending-approval wave to proceed to flipping">
          Approve &amp; Flip
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
    </div>
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
  // COMPAT_KV 未 bind / 算出失敗時は section を出さない。
  let compatHtml = "";
  if (env.COMPAT_KV) {
    try {
      const compat = await computeWaveCompatibility(
        env.COMPAT_KV,
        w.repos.map((r) => r.repo),
      );
      compatHtml = renderCompatibilitySection(compat, w.wave_id);
    } catch {
      compatHtml = "";
    }
  }

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
// Compatibility matrix section (Refs #157 Phase A)
// ----------------------------------------------------------------------------

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
      <h2>Compatibility (frontend ↔ backend)</h2>
      <p class="meta">No backend deploy records for this wave's repos yet
        (nothing to check against).</p>
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
        <span class="meta">@ ${escapeHtml(b.current_image ?? "—")}</span>
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
      <h2>Compatibility (frontend ↔ backend) — ${verdict}</h2>
      <p class="meta">既 deploy frontend が wave 内 backend の<strong>現 production
        image</strong>を integration test 済みか。赤は未検証 — "Re-test" で
        <code>release-wave-retest</code> を frontend に dispatch し、green 化後に
        matrix が自動更新される。Refs
        <a href="https://github.com/ippoan/ci-dashboard/issues/157">#157</a>.</p>
      ${retestAllBlock}
      ${blocks}
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
