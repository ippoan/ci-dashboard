// `/ci-matrix` SSR ページ。Refs ippoan/ci-dashboard#377.
//
// データは `data/ci-matrix.json` (scanner workflow が main に commit-back) を
// `raw.githubusercontent.com` 経由で fetch する。Worker 内で短期 cache。
// `?refresh=1` を付けるとキャッシュを bypass。
//
// 設計分離:
// - `analyzeMatrix(...)` は pure。jsonl payload → cell matrix + deviation list
//   を返す。worker / vitest 双方からテストする
// - `handleCiMatrixPage` は I/O (fetch + HTML 組み立て + Response)
// - 表示前提のスタイルは inline (= cap-catalog と同じ self-contained 方針)

import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";

const SOURCE_REPO = "ippoan/ci-dashboard";
const SOURCE_BRANCH = "main";
const SOURCE_PATH = "data/ci-matrix.json";
const RAW_URL = `https://raw.githubusercontent.com/${SOURCE_REPO}/${SOURCE_BRANCH}/${SOURCE_PATH}`;

const CACHE_TTL_MS = 5 * 60 * 1000;

// scanner と同じカテゴリ順を UI 側でも保持。新 reusable を増やしたら
// scanner 側 (`REUSABLE_CATEGORIES`) と本 array を同時に更新する。
export const COLUMN_ORDER: ReadonlyArray<string> = [
  "frontend-ci",
  "go-ci",
  "lib-ci",
  "rust-ci",
  "cloud-run-deploy",
  "auto-merge",
  "secret-verify",
  "skills-check",
  "cap-catalog-extract",
  "release-wave",
  "tag-release",
  "dev-tag-release",
  "lib-publish",
  "rust-binary-release",
  "ci-shape-report",
];

// scanner の output schema を反映 (緩めに opt-in 系を optional に)。
export interface ScannerReusableCall {
  job_id: string;
  target_owner: string;
  target_repo: string;
  target_file: string;
  reusable_name: string;
  ref: string;
  pinned_sha: boolean;
  secrets_inherit: boolean;
}

export interface ScannerWorkflow {
  file: string;
  name?: string | null;
  triggers?: string[];
  permissions?: Record<string, string>;
  job_permissions_union?: string[];
  reusable_calls?: ScannerReusableCall[];
  self_jobs?: string[];
  deviations?: string[];
  parse_error?: string;
  fetch_error?: boolean;
}

export interface ScannerRepo {
  owner: string;
  repo: string;
  scanned_at: string;
  error?: string;
  workflows: ScannerWorkflow[];
  summary?: {
    total_workflows: number;
    reusable_caller_workflows: number;
    used_reusable_categories: string[];
    deviation_flags: string[];
  };
}

export interface ScannerPayload {
  schema_version: number;
  generated_at: string;
  scan_source: string;
  orgs: string[];
  reusable_categories: Record<string, string>;
  repos: ScannerRepo[];
}

export type CellState =
  | { kind: "none" }
  | { kind: "self" }                          // 自前 (= reusable 呼ばず実 job 群)
  | { kind: "reusable"; ref: string; pinned: boolean; mutable: boolean };

export interface MatrixRow {
  owner: string;
  repo: string;
  scanned_at: string;
  cells: Record<string, CellState>;
  total_workflows: number;
  reusable_caller_workflows: number;
  deviations: string[];
  has_error: boolean;
}

export interface DeviationItem {
  owner: string;
  repo: string;
  file: string;
  flag: string;
  ref?: string;
}

/** Pure: scanner payload を UI 行 + 逸脱リストに畳む。 */
export function analyzeMatrix(payload: ScannerPayload): {
  rows: MatrixRow[];
  deviations: DeviationItem[];
  columns: string[];
  categories: Record<string, string>;
} {
  const categories = { ...payload.reusable_categories };
  const rows: MatrixRow[] = [];
  const deviations: DeviationItem[] = [];

  for (const r of payload.repos) {
    const cells: Record<string, CellState> = {};
    for (const col of COLUMN_ORDER) cells[col] = { kind: "none" };

    for (const wf of r.workflows ?? []) {
      // self_jobs があるなら「自前 workflow が存在」シグナル。
      // reusable caller があれば該当 column を上書きする (後勝ち)。
      const calls = wf.reusable_calls ?? [];
      if (calls.length === 0 && (wf.self_jobs?.length ?? 0) > 0) {
        // 自前 workflow は「その他」枠としてのみ存在 — column には影響しない
        // (column = reusable category 軸)。逸脱だけ拾う。
      }
      for (const c of calls) {
        const cat = categories[c.reusable_name];
        if (!cat || !COLUMN_ORDER.includes(cat)) continue;
        cells[cat] = {
          kind: "reusable",
          ref: c.ref,
          pinned: c.pinned_sha,
          mutable: !c.pinned_sha,
        };
      }
      for (const d of wf.deviations ?? []) {
        deviations.push({
          owner: r.owner,
          repo: r.repo,
          file: wf.file,
          flag: d,
          ref: firstUnpinnedRef(wf),
        });
      }
    }

    rows.push({
      owner: r.owner,
      repo: r.repo,
      scanned_at: r.scanned_at,
      cells,
      total_workflows: r.summary?.total_workflows ?? r.workflows.length,
      reusable_caller_workflows: r.summary?.reusable_caller_workflows ?? 0,
      deviations: r.summary?.deviation_flags ?? [],
      has_error: Boolean(r.error),
    });
  }

  // 既定 sort: owner → repo
  rows.sort((a, b) => {
    if (a.owner !== b.owner) return a.owner.localeCompare(b.owner);
    return a.repo.localeCompare(b.repo);
  });

  return { rows, deviations, columns: [...COLUMN_ORDER], categories };
}

function firstUnpinnedRef(wf: ScannerWorkflow): string | undefined {
  for (const c of wf.reusable_calls ?? []) {
    if (!c.pinned_sha) return c.ref;
  }
  return undefined;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const PAGE_STYLES = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    padding: 24px;
    max-width: 1400px;
    margin: 0 auto;
    line-height: 1.5;
  }
  h1 { font-size: 22px; margin-bottom: 8px; color: #58a6ff; }
  p.lede { font-size: 13px; color: #8b949e; margin-bottom: 16px; }
  p.lede a { color: #58a6ff; }
  p.lede code {
    background: #161b22; border: 1px solid #30363d; border-radius: 4px;
    padding: 1px 6px; font-size: 12px;
  }
  .banner {
    background: #1d2233; border: 1px solid #30363d;
    border-left: 3px solid #d29922; border-radius: 4px;
    padding: 10px 14px; margin-bottom: 18px; font-size: 13px; color: #d29922;
  }
  .banner.banner-ok { border-left-color: #3fb950; color: #3fb950; }
  .controls { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
  .controls input[type="search"] {
    flex: 1; background: #0d1117; color: #c9d1d9;
    border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px;
    font: inherit; font-size: 14px;
  }
  .controls input[type="search"]:focus { border-color: #58a6ff; outline: none; }
  .view-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
  .view-tabs button {
    background: #161b22; border: 1px solid #30363d; color: #8b949e;
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 13px;
  }
  .view-tabs button.active { background: #1d2233; color: #58a6ff; border-color: #58a6ff; }
  .matrix-wrap { overflow-x: auto; }
  table.matrix { border-collapse: collapse; font-size: 12px; min-width: 100%; }
  table.matrix th, table.matrix td {
    padding: 6px 8px; border-bottom: 1px solid #21262d; white-space: nowrap;
    text-align: center;
  }
  table.matrix th {
    position: sticky; top: 0; background: #0d1117; color: #8b949e; font-weight: 600;
    font-size: 11px; border-bottom: 1px solid #30363d;
  }
  table.matrix th.repo-col, table.matrix td.repo-col {
    text-align: left; position: sticky; left: 0; background: #0d1117; z-index: 1;
  }
  table.matrix td.repo-col a { color: #58a6ff; text-decoration: none; }
  table.matrix td.repo-col a:hover { text-decoration: underline; }
  table.matrix tbody tr:hover td { background: #161b22; }
  /* セル状態 */
  .cell { display: inline-block; min-width: 64px; padding: 2px 6px; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; }
  .cell-none   { color: #484f58; }
  .cell-self   { background: #1f2d44; color: #79c0ff; border: 1px solid #1f6feb; }
  .cell-pinned { background: #14361f; color: #3fb950; border: 1px solid #238636; }
  .cell-mutable{ background: #3a2d12; color: #d29922; border: 1px solid #9e6a03; }
  /* 逸脱タブ */
  .dev-list { display: grid; gap: 8px; }
  .dev-item {
    background: #161b22; border: 1px solid #30363d; border-left: 3px solid #d29922;
    border-radius: 4px; padding: 10px 14px; font-size: 12px;
  }
  .dev-item .dev-flag {
    display: inline-block; background: #3a2d12; color: #d29922;
    padding: 1px 6px; border-radius: 3px; font-family: ui-monospace, monospace;
    margin-right: 8px;
  }
  .dev-item a { color: #58a6ff; text-decoration: none; }
  .dev-item a:hover { text-decoration: underline; }
  .meta { font-size: 12px; color: #8b949e; margin-bottom: 8px; }
  .summary {
    display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: #8b949e;
    margin-bottom: 12px;
  }
  .summary .badge {
    background: #161b22; border: 1px solid #30363d; border-radius: 3px; padding: 3px 8px;
  }
  .summary .badge strong { color: #c9d1d9; }
`;

interface CacheEntry {
  payload: ScannerPayload;
  fetched_at: number;
}
let memCache: CacheEntry | null = null;

async function loadPayload(refresh: boolean): Promise<{
  payload: ScannerPayload | null;
  source: "cache" | "live" | "error";
  error?: string;
}> {
  if (!refresh && memCache && Date.now() - memCache.fetched_at < CACHE_TTL_MS) {
    return { payload: memCache.payload, source: "cache" };
  }
  try {
    const res = await fetch(RAW_URL, {
      headers: { "User-Agent": "ci-dashboard-matrix" },
      // Cloudflare Workers の fetch cache を 5 分に。
      cf: { cacheTtl: 300, cacheEverything: true } as never,
    });
    if (!res.ok) {
      return { payload: null, source: "error", error: `raw fetch ${res.status}` };
    }
    const payload = (await res.json()) as ScannerPayload;
    memCache = { payload, fetched_at: Date.now() };
    return { payload, source: "live" };
  } catch (e: unknown) {
    return { payload: null, source: "error", error: (e as Error).message };
  }
}

export function renderMatrixPage(payload: ScannerPayload | null, errorMsg?: string): string {
  const tabs = renderTabs("ci-matrix");
  const head = `
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CI Matrix · ci-dashboard</title>
${PWA_HEAD_TAGS}
<style>${TAB_STYLES}${PAGE_STYLES}</style>
</head>
<body>
${tabs}
<h1>🧩 CI Matrix</h1>
<p class="lede">
  どの repo が <a href="https://github.com/ippoan/ci-workflows" target="_blank" rel="noopener"><code>ippoan/ci-workflows</code></a>
  の reusable workflow を使ってるかの一覧。データは
  <a href="https://github.com/ippoan/ci-dashboard/blob/main/data/ci-matrix.json" target="_blank" rel="noopener"><code>data/ci-matrix.json</code></a>
  (6 時間ごとの scanner workflow が更新)。
  <a href="?refresh=1">[キャッシュを破棄して再 fetch]</a>
</p>`;

  if (!payload) {
    return (
      head +
      `<div class="banner">⚠️ scanner JSON が読めません: ${escapeHtml(errorMsg ?? "unknown")}</div></body></html>`
    );
  }

  const analyzed = analyzeMatrix(payload);
  const totalRepos = analyzed.rows.length;
  const reusableAdopters = analyzed.rows.filter(
    (r) => r.reusable_caller_workflows > 0,
  ).length;
  const adoptionPct = totalRepos === 0 ? 0 : Math.round((reusableAdopters / totalRepos) * 100);

  const summary = `
<div class="summary">
  <span class="badge">scan: <strong>${escapeHtml(payload.scan_source)}</strong></span>
  <span class="badge">generated: <strong>${escapeHtml(payload.generated_at)}</strong></span>
  <span class="badge">repos: <strong>${totalRepos}</strong></span>
  <span class="badge">reusable 採用: <strong>${reusableAdopters} (${adoptionPct}%)</strong></span>
  <span class="badge">逸脱件数: <strong>${analyzed.deviations.length}</strong></span>
</div>`;

  // header row
  const headerCells = analyzed.columns
    .map((c) => `<th title="${escapeHtml(c)}">${escapeHtml(c)}</th>`)
    .join("");
  const matrixHeader = `<tr><th class="repo-col">repo</th>${headerCells}<th>逸脱</th></tr>`;

  const matrixBody = analyzed.rows
    .map((r) => {
      const repoUrl = `https://github.com/${r.owner}/${r.repo}`;
      const repoCol = `<td class="repo-col"><a href="${repoUrl}" target="_blank" rel="noopener">${escapeHtml(r.owner)}/${escapeHtml(r.repo)}</a></td>`;
      const cells = analyzed.columns
        .map((col) => {
          const s = r.cells[col]!;
          if (s.kind === "none") return `<td><span class="cell cell-none">—</span></td>`;
          if (s.kind === "self") return `<td><span class="cell cell-self">self</span></td>`;
          const cls = s.pinned ? "cell-pinned" : "cell-mutable";
          const refLabel = s.ref.length === 40 ? `@${s.ref.slice(0, 7)}` : `@${s.ref}`;
          return `<td title="${escapeHtml(s.ref)}"><span class="cell ${cls}">${escapeHtml(refLabel)}</span></td>`;
        })
        .join("");
      const dev = r.deviations.length === 0 ? "—" : String(r.deviations.length);
      return `<tr data-repo="${escapeHtml(r.owner + "/" + r.repo)}">${repoCol}${cells}<td>${escapeHtml(dev)}</td></tr>`;
    })
    .join("");

  // deviations tab
  const devItems =
    analyzed.deviations.length === 0
      ? `<p class="meta">逸脱なし 🎉</p>`
      : analyzed.deviations
          .map((d) => {
            const fileUrl = `https://github.com/${d.owner}/${d.repo}/blob/main/${d.file}`;
            const refSuffix = d.ref ? ` <code>@${escapeHtml(d.ref)}</code>` : "";
            return `<div class="dev-item">
  <span class="dev-flag">${escapeHtml(d.flag)}</span>${refSuffix}
  <a href="${fileUrl}" target="_blank" rel="noopener">${escapeHtml(d.owner)}/${escapeHtml(d.repo)} · ${escapeHtml(d.file)}</a>
</div>`;
          })
          .join("");

  const body = `
${summary}
<div class="view-tabs">
  <button class="active" data-view="matrix">Matrix</button>
  <button data-view="deviations">逸脱 (${analyzed.deviations.length})</button>
</div>
<div class="controls">
  <input type="search" id="repo-filter" placeholder="repo name で絞り込み (例: nuxt, rust)" />
</div>

<section data-view="matrix">
  <div class="matrix-wrap">
    <table class="matrix">
      <thead>${matrixHeader}</thead>
      <tbody id="matrix-body">${matrixBody}</tbody>
    </table>
  </div>
</section>

<section data-view="deviations" hidden>
  <div class="dev-list">${devItems}</div>
</section>

<script>
${PWA_REGISTER_SCRIPT}
(function() {
  const filter = document.getElementById('repo-filter');
  filter.addEventListener('input', () => {
    const q = filter.value.toLowerCase();
    document.querySelectorAll('#matrix-body tr').forEach((tr) => {
      const repo = (tr.getAttribute('data-repo') || '').toLowerCase();
      tr.style.display = repo.includes(q) ? '' : 'none';
    });
  });
  const tabs = document.querySelectorAll('.view-tabs button');
  tabs.forEach((b) => {
    b.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.toggle('active', x === b));
      const target = b.getAttribute('data-view');
      document.querySelectorAll('section[data-view]').forEach((s) => {
        s.hidden = s.getAttribute('data-view') !== target;
      });
    });
  });
})();
</script>
</body>
</html>`;
  return head + body;
}

export async function handleCiMatrixPage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const { payload, source, error } = await loadPayload(refresh);
  const html = renderMatrixPage(payload, error);
  return new Response(html, {
    status: payload ? 200 : 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": source === "live" ? "public, max-age=120" : "no-store",
      "X-CI-Matrix-Source": source,
    },
  });
}

/** test fixture 用に in-memory cache を reset する。 */
export function _resetMatrixCacheForTest(): void {
  memCache = null;
}
