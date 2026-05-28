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
  const compatSection = renderGlobalCompatibilitySection(globalCompat);

  const rows = waves.length === 0
    ? `<tr><td colspan="7" class="empty">No release waves yet.</td></tr>`
    : waves
        .map((w) => {
          const repos = w.repos.map((r) => escapeHtml(r.repo)).join(", ");

          // preview URL は repo ごとに stage callback で報告される。set 済みの
          // ものだけ http/https に絞って link 化し、repo 名付きで列挙する。
          const previewLines = w.repos
            .map((r) => {
              const safe = safeHttpUrl(r.preview_url);
              if (!safe) return null;
              return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.repo)}</a>`;
            })
            .filter((x): x is string => x !== null);
          const previewCell = previewLines.length > 0
            ? previewLines.join("<br>")
            : `<span class="meta">—</span>`;

          // 一括 flip = Approve & Flip。pending-approval の時だけ有効。
          // 一覧では force を付けない (compat gate ブロック時は失敗 → 詳細ページで
          // override する運用)。CSP 上 JS 無しで POST form として動かす。
          const canApprove = w.state === "pending-approval";
          const flipButton = `
            <form method="post" action="/api/release-wave/${encodeURIComponent(w.wave_id)}/approve" style="margin:0">
              <button type="submit" ${canApprove ? "" : "disabled"}
                title="Approve & flip this wave (enabled only in pending-approval; no compat-gate override here)">
                Approve &amp; Flip
              </button>
            </form>`;

          return `
            <tr>
              <td><a href="/release-wave/${encodeURIComponent(w.wave_id)}">${escapeHtml(w.wave_id)}</a></td>
              <td><span class="badge" style="background:${stateColor(w.state)}">${escapeHtml(w.state)}</span></td>
              <td class="meta">${escapeHtml(w.started_at)}</td>
              <td class="meta">${escapeHtml(w.flip_policy)}</td>
              <td class="meta">${repos}</td>
              <td>${previewCell}</td>
              <td class="actions">${flipButton}</td>
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
    ${compatSection}
    <table>
      <thead>
        <tr>
          <th>Wave ID</th>
          <th>State</th>
          <th>Started At</th>
          <th>Flip Policy</th>
          <th>Repos</th>
          <th>Preview</th>
          <th>Actions</th>
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
 * Release Wave 一覧ページ用の wave 非依存 compatibility 俯瞰セクション。
 * 全 `backend::` record とその consumer frontend の突合グラフ (SVG) を出す。
 * backend record が無ければ案内文のみ。
 */
function renderGlobalCompatibilitySection(
  compat: WaveCompatibility | null,
): string {
  if (!compat || compat.backends.length === 0) {
    return `
    <div class="section">
      <h2>Compatibility (all consumers)</h2>
      <p class="meta">No backend deploy records yet. backend deploy が
        <code>backend-deploy-report</code> を打ち、consumer frontend が
        integration test green で <code>frontend-test-report</code> を打つと、
        ここに wave 横断の俯瞰グラフが出る。
        Refs <a href="https://github.com/ippoan/ci-dashboard/issues/157">#157</a>.</p>
    </div>`;
  }
  const verdict = !compat.checked
    ? `<span class="meta">no consuming frontends recorded</span>`
    : compat.verified
    ? `<span class="ok"><strong>all consumers tested</strong></span>`
    : `<span class="err"><strong>some consumers untested</strong></span>`;
  const svg = renderCompatibilitySvg(compat);
  const body = svg
    ? svg
    : `<p class="meta">backend record はあるが、まだどの frontend も test 履歴を
        report していない (consumer edge 無し)。</p>`;
  return `
    <div class="section">
      <h2>Compatibility (all consumers) — ${verdict}</h2>
      <p class="meta">全 backend の<strong>現 production image</strong>を既 deploy
        frontend が integration test 済みか (wave 横断)。緑 = tested / 赤 = untested。
        個別 wave の retest 操作は各 wave 詳細ページで。
        Refs <a href="https://github.com/ippoan/ci-dashboard/issues/157">#157</a>.</p>
      ${body}
    </div>`;
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
        matrix が自動更新される。edge / node に hover すると過去 test 履歴が出る。
        Refs <a href="https://github.com/ippoan/ci-dashboard/issues/157">#157</a>.</p>
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
function renderCompatibilitySvg(compat: WaveCompatibility): string {
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
  const boxH = 38;
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
  ): string => {
    return `<g><title>${escapeHtml(fullTitle)}</title>
      <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="6"
        fill="#ffffff" stroke="${border}" stroke-width="1.5"/>
      <text x="${x + 10}" y="${y + 15}" font-family="monospace" font-size="12"
        fill="#202124">${escapeHtml(truncLabel(line1, 32))}</text>
      <text x="${x + 10}" y="${y + 29}" font-family="monospace" font-size="10.5"
        fill="${GRAY}">${escapeHtml(truncLabel(line2, 36))}</text>
    </g>`;
  };

  const backendSvg = backendOrder
    .map((repo) => {
      const img = backendImage.get(repo) ?? "—";
      return node(
        leftX,
        bY(repo),
        repo,
        `@ ${shortSha(img)}`,
        BLUE,
        `${repo}\ncurrent image: ${img ?? "—"}`,
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
      // line2 に突合 SHA を出して backend ノードの @<sha> と目視照合できるように
      // する。tested 済 image が無ければ prod version に fallback。
      const line2 = testedImg ? `${ver} · vs @${shortSha(testedImg)}` : `prod ${ver}`;
      return node(
        rightX,
        fY(repo),
        repo,
        line2,
        border,
        `${repo}\nprod version: ${ver}\ntested vs image: ${testedImg ?? "—"}\n${verdictTxt}`,
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
