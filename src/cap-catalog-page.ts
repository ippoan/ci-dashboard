// cap-catalog viewer (Refs ippoan/cap-catalog#1 #10).
//
// SSR + client-side filter. データは R2 binding (`CAP_CATALOG_R2`) から
// `v1/latest.jsonl` を fetch し、JSONL 1 行 = symbol として parse する。
// R2 が空 / unreachable / binding 未設定なら inline SAMPLE_SYMBOLS に fallback
// (= ローカル dev、staging 初期投入前、または upload pipeline 障害時)。
//
// Catalog の symbols は SSR ページに `<script type="application/json">` で
// 全部埋め込み、`?q=` の query は JS で in-memory filter する (= 1 req で完結、
// extra fetch なし)。jsonl size が現状 ~数 KB なので問題ない。scale すれば
// `?q=` を server-side 引きにする (FTS5 trigram + porter)。

import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";
import type { Env } from "./index";

// catalog-extract.jsonl の 1 行に対応 (schema/catalog.sql の symbols + features)
interface CatalogSymbol {
  repo: string;
  language: string;
  kind: string;
  name: string;
  fq_path: string;
  signature?: string | null;
  doc?: string | null;
  file?: string | null;
  line?: number | null;
  commit_sha?: string | null;
  features?: string[];
}

// R2 key (cap-catalog#7 の catalog-build-upload.yml が push する path と
// 一致)。schema_version=1 を前提に `v1/` prefix を付ける。CLI は同じ key を
// download する。
const R2_KEY_LATEST_JSONL = "v1/latest.jsonl";

interface CatalogSource {
  symbols: ReadonlyArray<CatalogSymbol>;
  /** "r2" = R2 fetch 成功、"sample" = fallback (binding 無し or fetch fail) */
  origin: "r2" | "sample";
  /** R2 origin 時の last_modified (UTC ISO)、debug 表示用。 */
  lastModified?: string;
  /** fallback 理由 (warn 表示用)。 */
  fallbackReason?: string;
}

// ippoan/cap-catalog の PR #17 dogfood + #18 fix 後にローカル extract した実
// データを **そのまま保持** (5 件)。R2 upload (#7 後段) が動いたら fetch に
// 差し替えるので、この const は dev fallback として残る想定。
const SAMPLE_SYMBOLS: ReadonlyArray<CatalogSymbol> = [
  {
    repo: "ippoan/cap-catalog",
    language: "rust",
    kind: "module",
    name: "cap",
    fq_path: "cap",
    doc: "`cap` CLI entrypoint (#8).",
    file: "crates/cap-cli/src/main.rs",
    line: 1,
    features: [],
  },
  {
    repo: "ippoan/cap-catalog",
    language: "rust",
    kind: "module",
    name: "cap_catalog_build",
    fq_path: "cap_catalog_build",
    doc: "`cap-catalog-build`: catalog-extract.jsonl の集合から catalog.sqlite を build する。",
    file: "crates/cap-catalog-builder/src/main.rs",
    line: 1,
    features: [],
  },
  {
    repo: "ippoan/cap-catalog",
    language: "rust",
    kind: "module",
    name: "cap_catalog_schema",
    fq_path: "cap_catalog_schema",
    doc: "`catalog.sqlite` schema DDL + version constant.",
    file: "crates/cap-catalog-schema/src/lib.rs",
    line: 1,
    features: [],
  },
  {
    repo: "ippoan/cap-catalog",
    language: "rust",
    kind: "const",
    name: "SCHEMA_VERSION",
    fq_path: "cap_catalog_schema::SCHEMA_VERSION",
    signature: "pub const SCHEMA_VERSION: u32 = 1",
    doc: "catalog.sqlite が require する schema version。",
    file: "crates/cap-catalog-schema/src/lib.rs",
    line: 12,
    features: [],
  },
  {
    repo: "ippoan/cap-catalog",
    language: "rust",
    kind: "const",
    name: "CATALOG_SQL",
    fq_path: "cap_catalog_schema::CATALOG_SQL",
    signature: "pub const CATALOG_SQL: &str",
    doc: "catalog.sqlite を build する DDL (1 ファイル、idempotent)。",
    file: "crates/cap-catalog-schema/src/lib.rs",
    line: 18,
    features: [],
  },
];

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
  /* 全体を 2 column に: 左 sidebar (★ list) + 右 main (filter + list)。
     幅 < 900px ではモバイル想定で縦積み。 */
  .layout {
    display: flex;
    gap: 20px;
    align-items: flex-start;
  }
  .layout > .main { flex: 1; min-width: 0; }
  .layout > .sidebar {
    flex: 0 0 280px;
    position: sticky;
    top: 24px;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px;
  }
  .sidebar h3 {
    margin: 0 0 10px 0;
    font-size: 13px;
    color: #ffd33d;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .sidebar h3 .count {
    color: #6e7681;
    font-size: 11px;
    font-weight: normal;
  }
  .sidebar .empty {
    padding: 12px 0;
    text-align: left;
    color: #6e7681;
    font-size: 12px;
    line-height: 1.5;
  }
  .sidebar-item {
    padding: 6px 4px 6px 0;
    border-top: 1px solid #21262d;
    font-size: 12px;
  }
  .sidebar-item:first-of-type { border-top: none; }
  .sidebar-item .row {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .sidebar-item .name {
    flex: 1;
    min-width: 0;
    color: #c9d1d9;
    font-family: ui-monospace, SFMono-Regular, monospace;
    word-break: break-all;
  }
  .sidebar-item .name:hover { color: #58a6ff; cursor: pointer; }
  .sidebar-item .repo {
    color: #6e7681;
    font-size: 10px;
    margin-top: 2px;
    font-family: ui-monospace, SFMono-Regular, monospace;
  }
  .sidebar-item .ctl {
    background: transparent;
    border: none;
    color: #6e7681;
    cursor: pointer;
    padding: 0 2px;
    font-size: 13px;
    line-height: 1;
  }
  .sidebar-item .ctl:hover { color: #ffd33d; }
  .sidebar-item .ctl[disabled] { opacity: 0.3; cursor: default; }
  /* main column 内の symbol card が ★ 状態の時、左 border を黄色に */
  .sym.is-fav { border-left: 3px solid #ffd33d; }
  /* 検索 hit → 該当 card を 1.5s だけ flash */
  .sym.flash { animation: flash-bg 1.5s ease-out; }
  @keyframes flash-bg {
    0%   { background: #3a2f0d; }
    100% { background: #161b22; }
  }
  @media (max-width: 900px) {
    .layout { flex-direction: column-reverse; }
    .layout > .sidebar { flex: 1 1 auto; position: static; max-height: none; width: 100%; box-sizing: border-box; }
  }
  h1 { font-size: 22px; margin-bottom: 8px; color: #58a6ff; }
  p.lede { font-size: 13px; color: #8b949e; margin-bottom: 16px; }
  p.lede a { color: #58a6ff; }
  p.lede code {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 12px;
  }
  .banner {
    background: #1d2233;
    border: 1px solid #30363d;
    border-left: 3px solid #d29922;
    border-radius: 4px;
    padding: 10px 14px;
    margin-bottom: 18px;
    font-size: 13px;
    color: #d29922;
  }
  .banner.banner-ok {
    border-left-color: #3fb950;
    color: #3fb950;
  }
  .banner code { background: rgba(0,0,0,.25); padding: 1px 5px; border-radius: 3px; }
  .controls {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-bottom: 12px;
  }
  .controls input[type="search"] {
    flex: 1;
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 8px 12px;
    font: inherit;
    font-size: 14px;
  }
  .controls input[type="search"]:focus {
    border-color: #58a6ff;
    outline: none;
  }
  /* fq_path root segment (= crate / 一番上の module) ごとの toggle chip。
     state は localStorage(\`cap-catalog:hiddenModules\`) に保存。schema 系は
     default-off (= user 指示: 基本的に schema は不要)。 */
  .filters {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 8px;
    font-size: 12px;
    color: #8b949e;
  }
  .filters-row { align-items: baseline; }
  .filters-row .axis-label {
    flex: 0 0 auto;
    color: #6e7681;
    min-width: 60px;
  }
  .filters-axis {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .filters .chip {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 999px;
    padding: 3px 10px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
  }
  .filters .chip:hover { border-color: #58a6ff; }
  .filters .chip[aria-pressed="false"] {
    background: transparent;
    color: #6e7681;
    text-decoration: line-through;
    text-decoration-color: #6e7681;
  }
  .filters .chip .chip-count {
    color: #6e7681;
    font-weight: normal;
    margin-left: 4px;
  }
  .filters .chip[aria-pressed="true"] .chip-count { color: #8b949e; }
  /* feature chip 内の ★ button (= feature を fav に追加 / 解除)。 */
  .filters .chip .chip-star {
    margin-left: 6px;
    color: #6e7681;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  }
  .filters .chip .chip-star:hover { color: #ffd33d; }
  .filters .chip .chip-star[aria-pressed="true"] { color: #ffd33d; }
  /* sidebar entry の種別 badge (fn / struct / feature 等)。 */
  .sidebar-item .badge {
    display: inline-block;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 9px;
    text-transform: lowercase;
    font-weight: 600;
    margin-right: 4px;
  }
  .sidebar-item .badge-sym { background: #21262d; color: #d29922; }
  .sidebar-item .badge-feat { background: #1f2d3d; color: #79c0ff; }
  .sidebar-feats {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .sidebar-feats .feat {
    background: #1f2d3d;
    color: #79c0ff;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    cursor: pointer;
  }
  .sidebar-feats .feat:hover { background: #2a3f5a; }
  .filters .chip-reset {
    background: transparent;
    color: #58a6ff;
    border: none;
    cursor: pointer;
    padding: 3px 4px;
    font-size: 11px;
    font-family: inherit;
  }
  .filters .chip-reset:hover { text-decoration: underline; }
  .meta {
    font-size: 12px;
    color: #8b949e;
    margin-bottom: 8px;
  }
  .repo-group {
    margin-bottom: 24px;
  }
  .repo-group h2 {
    font-size: 14px;
    color: #8b949e;
    margin: 0 0 8px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid #21262d;
  }
  .repo-group h2 a { color: #58a6ff; text-decoration: none; }
  .repo-group h2 a:hover { text-decoration: underline; }
  .sym {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .sym .header {
    display: flex;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .sym .kind {
    color: #d29922;
    font-size: 11px;
    text-transform: lowercase;
    font-weight: 600;
    background: #21262d;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .sym .fq {
    color: #c9d1d9;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 13px;
    font-weight: 600;
  }
  .sym a.fq-link {
    text-decoration: none;
    color: inherit;
    border-bottom: 1px dotted #6e7681;
  }
  .sym a.fq-link:hover {
    color: #58a6ff;
    border-bottom-color: #58a6ff;
  }
  .sym a.fq-link:hover::after {
    content: ' ↗';
    font-weight: 400;
    color: #58a6ff;
  }
  .sym .file {
    font-size: 11px;
    color: #6e7681;
    font-family: ui-monospace, SFMono-Regular, monospace;
    margin-left: auto;
  }
  .sym .file a { color: #6e7681; text-decoration: none; }
  .sym .file a:hover { color: #58a6ff; text-decoration: underline; }
  .sym .sig {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 12px;
    color: #79c0ff;
    margin: 4px 0;
  }
  .sym .doc {
    font-size: 12px;
    color: #8b949e;
    margin: 4px 0 0 0;
    line-height: 1.4;
  }
  .sym .features {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .sym .feat {
    background: #1f2d3d;
    color: #79c0ff;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, monospace;
  }
  /* お気に入り ★ button (card header 右端)。localStorage 永続。 */
  .sym .star {
    background: transparent;
    border: none;
    color: #6e7681;
    cursor: pointer;
    font-size: 16px;
    padding: 0 2px;
    line-height: 1;
    margin-left: 6px;
  }
  .sym .star:hover { color: #ffd33d; }
  .sym .star[aria-pressed="true"] { color: #ffd33d; }
  /* 上部 fav-only toggle (★ 付きだけ表示モード)。 */
  .fav-bar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
    font-size: 12px;
    color: #8b949e;
  }
  .fav-toggle {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 999px;
    padding: 3px 12px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .fav-toggle:hover { border-color: #ffd33d; }
  .fav-toggle[aria-pressed="true"] {
    background: #3a2f0d;
    border-color: #ffd33d;
    color: #ffd33d;
  }
  .fav-toggle .fav-count {
    margin-left: 4px;
    color: #6e7681;
  }
  .fav-toggle[aria-pressed="true"] .fav-count { color: #ffd33d; }
  /* 検索 query と一致する部分の highlight。dark theme に合わせて琥珀色。 */
  mark.hit {
    background: #ffd33d;
    color: #0d1117;
    padding: 0 1px;
    border-radius: 2px;
    font-weight: 600;
  }
  .empty {
    text-align: center;
    color: #6e7681;
    padding: 32px;
    font-size: 13px;
  }
`;

/**
 * R2 から `v1/latest.jsonl` を fetch して symbols 配列に parse する。
 * fail (binding 無し / object 無し / parse error) なら sample fallback。
 *
 * いずれの経路でも throw しない (= UI page の SSR を壊さない)。
 */
async function fetchCatalogSource(env: Env): Promise<CatalogSource> {
  if (!env.CAP_CATALOG_R2) {
    return {
      symbols: SAMPLE_SYMBOLS,
      origin: "sample",
      fallbackReason: "CAP_CATALOG_R2 binding not configured",
    };
  }
  let obj: R2ObjectBody | null;
  try {
    obj = await env.CAP_CATALOG_R2.get(R2_KEY_LATEST_JSONL);
  } catch (e: unknown) {
    return {
      symbols: SAMPLE_SYMBOLS,
      origin: "sample",
      fallbackReason: `R2 get failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!obj) {
    return {
      symbols: SAMPLE_SYMBOLS,
      origin: "sample",
      fallbackReason: `R2 object ${R2_KEY_LATEST_JSONL} not found`,
    };
  }
  let body: string;
  try {
    body = await obj.text();
  } catch (e: unknown) {
    return {
      symbols: SAMPLE_SYMBOLS,
      origin: "sample",
      fallbackReason: `R2 body read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const symbols: CatalogSymbol[] = [];
  let parseErrors = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as CatalogSymbol;
      // 必須 field の最低限の shape check (= upload pipeline からの想定外 row を弾く)
      if (
        typeof row.repo === "string" &&
        typeof row.language === "string" &&
        typeof row.kind === "string" &&
        typeof row.name === "string" &&
        typeof row.fq_path === "string"
      ) {
        symbols.push(row);
      } else {
        parseErrors++;
      }
    } catch {
      parseErrors++;
    }
  }
  if (symbols.length === 0) {
    return {
      symbols: SAMPLE_SYMBOLS,
      origin: "sample",
      fallbackReason: `R2 jsonl had 0 valid rows (parse errors: ${parseErrors})`,
    };
  }
  return {
    symbols,
    origin: "r2",
    lastModified: obj.uploaded.toISOString(),
  };
}

function renderBanner(source: CatalogSource): string {
  if (source.origin === "r2") {
    const ts = source.lastModified ? ` <code>${escapeHtml(source.lastModified)}</code>` : "";
    return `
      <div class="banner banner-ok">
        ✅ <strong>R2 live</strong>: <code>cap-catalog/v1/latest.jsonl</code> から ${source.symbols.length} symbol を fetch。${ts}
      </div>`;
  }
  const reason = source.fallbackReason ? escapeHtml(source.fallbackReason) : "unknown";
  return `
    <div class="banner">
      ⚠️ <strong>Sample fallback</strong>: ${source.symbols.length} symbol を inline 表示中
      (理由: <code>${reason}</code>)。
    </div>`;
}

const CLIENT_SCRIPT = `
(function() {
  const input = document.getElementById('q');
  const list = document.getElementById('list');
  const meta = document.getElementById('meta');
  const moduleFiltersEl = document.getElementById('module-filters');
  const featureFiltersEl = document.getElementById('feature-filters');
  const favToggleEl = document.getElementById('fav-only-toggle');
  const sidebarEl = document.getElementById('favorites-sidebar');
  const data = JSON.parse(document.getElementById('catalog-data').textContent);

  // お気に入り: 順序付き fq_path key Array で保持 (= 順位変更可能)。
  // key は 'repo|language|fq_path' (= extract-rust.py の dedupe key と同じ)。
  function symbolKey(s) {
    return s.repo + '|' + s.language + '|' + s.fq_path;
  }
  const FAV_LS = 'cap-catalog:favorites';
  const FAV_ONLY_LS = 'cap-catalog:favOnly';
  function loadFavorites() {
    try {
      const raw = localStorage.getItem(FAV_LS);
      if (raw != null) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.filter(function(x){ return typeof x === 'string'; });
      }
    } catch (_) {}
    return [];
  }
  function saveFavorites(arr) {
    try { localStorage.setItem(FAV_LS, JSON.stringify(arr)); } catch (_) {}
  }
  function loadFavOnly() {
    try { return localStorage.getItem(FAV_ONLY_LS) === '1'; } catch (_) { return false; }
  }
  function saveFavOnly(on) {
    try { localStorage.setItem(FAV_ONLY_LS, on ? '1' : '0'); } catch (_) {}
  }
  let favorites = loadFavorites();
  let favOnly = loadFavOnly();

  // server-side persistence (CF Access email 単位、CI_STATUS KV)。
  // hydrate: load 時に GET → 成功なら local を上書き (= cross-device 共有)。
  // PUT は debounce してから走らせる (= rapid star toggle / 順位変更で
  // KV を叩きすぎない)。401 (= 未認証) なら以後の同期を諦め、localStorage のみで運用。
  let syncEnabled = true;
  let pendingPut = null;
  function schedulePut() {
    if (!syncEnabled) return;
    if (pendingPut != null) clearTimeout(pendingPut);
    pendingPut = setTimeout(function(){
      pendingPut = null;
      fetch('/api/cap-catalog/favorites', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: favorites, favOnly: favOnly }),
      }).then(function(res){
        if (res.status === 401) syncEnabled = false;
      }).catch(function(){ /* offline: localStorage に既に保存済 */ });
    }, 600);
  }
  function hydrateFromServer() {
    fetch('/api/cap-catalog/favorites', { headers: { 'accept': 'application/json' } })
      .then(function(res){
        if (res.status === 401) { syncEnabled = false; return null; }
        if (!res.ok) return null;
        return res.json();
      })
      .then(function(remote){
        if (!remote || !Array.isArray(remote.keys)) return;
        // server を真実とする。local と差があれば server で上書きして再描画。
        const same = remote.keys.length === favorites.length
          && remote.keys.every(function(k, i){ return k === favorites[i]; })
          && (remote.favOnly === true) === favOnly;
        if (same) return;
        favorites = remote.keys.slice();
        favOnly = remote.favOnly === true;
        saveFavorites(favorites);
        saveFavOnly(favOnly);
        renderFavToggle();
        renderSidebar();
        render(input.value);
      })
      .catch(function(){ /* network failure: localStorage で続行 */ });
  }

  // favorites の entry は 2 種類混在可能:
  //   - symbol key:  '<repo>|<lang>|<fq_path>'   (PR #380 から、prefix 無し)
  //   - feature key: 'feat:<name>'               (本 PR から、ippoan/cap-catalog#1)
  // 区別は 'feat:' prefix。repo 名に ':' が入らない (= owner/name 形式) ので
  // collision 不能。
  const FEATURE_PREFIX = 'feat:';
  function featureKey(name) { return FEATURE_PREFIX + name; }
  function isFeatureKey(k) { return typeof k === 'string' && k.indexOf(FEATURE_PREFIX) === 0; }
  function featureName(k) { return k.slice(FEATURE_PREFIX.length); }

  function isFavKey(k) { return favorites.indexOf(k) !== -1; }
  function isFav(s) { return isFavKey(symbolKey(s)); }
  function toggleFavKey(k) {
    const i = favorites.indexOf(k);
    if (i === -1) favorites.push(k); else favorites.splice(i, 1);
    saveFavorites(favorites);
    schedulePut();
  }
  function moveFavKey(k, dir) {
    const i = favorites.indexOf(k);
    if (i === -1) return;
    const j = i + dir;
    if (j < 0 || j >= favorites.length) return;
    const tmp = favorites[i];
    favorites[i] = favorites[j];
    favorites[j] = tmp;
    saveFavorites(favorites);
    schedulePut();
  }

  // fq_path の root segment (= crate / 最上位 module) で symbol を group する。
  // "cap_catalog_schema::SCHEMA_VERSION" → "cap_catalog_schema"
  // "cap" → "cap"
  function rootSegment(fq) {
    if (!fq) return '';
    const i = fq.indexOf('::');
    return i < 0 ? fq : fq.slice(0, i);
  }

  // 「feature 軸」(= @feature: tag) の集約。symbol が feature を 1 つも持たない
  // 場合は専用 sentinel '(unfeatured)' に集める (= annotation 漏れ可視化、Refs cap-catalog#24)。
  const UNFEATURED = '(unfeatured)';
  function symbolFeatures(s) {
    if (!s.features || s.features.length === 0) return [UNFEATURED];
    return s.features;
  }

  // 軸毎に localStorage key を分けて hide set を持つ。default-off は軸毎に判定:
  //   - module: name に /schema/i を含む root を hide (user 指示「schema は基本不要」)
  //   - feature: 「(unfeatured)」を default-off (annotation 漏れ item を default で隠す)
  function makeAxis(lsKey, allKeys, defaultHideFn) {
    function load() {
      try {
        const raw = localStorage.getItem(lsKey);
        if (raw != null) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) return new Set(arr.filter(function(x){ return typeof x === 'string'; }));
        }
      } catch (_) {}
      const def = new Set();
      allKeys.forEach(function(k){ if (defaultHideFn(k)) def.add(k); });
      return def;
    }
    function save(set) {
      try { localStorage.setItem(lsKey, JSON.stringify(Array.from(set))); } catch (_) {}
    }
    return { lsKey: lsKey, allKeys: allKeys, hidden: load(), save: save };
  }

  function escape(s) {
    return String(s)
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'", '&#39;');
  }

  // 検索 query (= needle) と一致する substring を <mark> で囲んで返す。
  // 1. raw → escape() で HTML 化
  // 2. needle も同じく escape (= DOM 上で実際に出る形と合致)
  // 3. 正規表現特殊文字を backslash escape
  // 4. case-insensitive 置換、マッチ箇所は <mark class="hit">…</mark>
  // needle が空なら escape() のみ (= 通常表示)。
  function highlight(raw, needle) {
    const safe = escape(raw);
    if (!needle) return safe;
    const needleEsc = escape(needle);
    const reSafe = needleEsc.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    return safe.replace(new RegExp(reSafe, 'gi'), function(m){ return '<mark class="hit">' + m + '</mark>'; });
  }

  function buildGitHubLink(repo, file, line) {
    if (!repo || !file) return '';
    const path = encodeURI(file);
    const anchor = line != null ? '#L' + line : '';
    return 'https://github.com/' + repo + '/blob/main/' + path + anchor;
  }

  function render(q) {
    const needle = (q || '').toLowerCase().trim();
    const queryFiltered = needle === ''
      ? data
      : data.filter(function(s) {
          if (s.fq_path.toLowerCase().includes(needle)) return true;
          if (s.name.toLowerCase().includes(needle)) return true;
          if (s.doc && s.doc.toLowerCase().includes(needle)) return true;
          if (s.features && s.features.some(function(f){ return f.toLowerCase().includes(needle); })) return true;
          return false;
        });
    // favOnly モードは module/feature filter を **bypass** し ★ symbol だけ表示。
    // 通常モードは 2 軸 hide を AND で適用 (module hide ∨ 全 feature hide → drop)。
    const matched = favOnly
      ? queryFiltered.filter(isFav)
      : queryFiltered.filter(function(s){
          if (moduleAxis.hidden.has(rootSegment(s.fq_path))) return false;
          const feats = symbolFeatures(s);
          const visibleFeats = feats.filter(function(f){ return !featureAxis.hidden.has(f); });
          return visibleFeats.length > 0;
        });
    const hiddenCount = queryFiltered.length - matched.length;

    meta.textContent = matched.length + ' / ' + data.length + ' symbol(s)'
      + (favOnly ? ' (★ favorites only)' : (hiddenCount > 0 ? ' (' + hiddenCount + ' hidden by filter)' : ''));
    if (matched.length === 0) {
      list.innerHTML = '<div class="empty">' + (favOnly ? '★ お気に入りはありません。各 symbol の ★ ボタンで追加してください。' : 'no match') + '</div>';
      return;
    }

    // favOnly モードは保存順 (= 順位) を尊重して repo を跨いで 1 list に並べる。
    // 通常モードは従来通り repo 単位で group。
    if (favOnly) {
      const ordered = [];
      const seen = new Set();
      favorites.forEach(function(k){
        const s = matched.find(function(x){ return symbolKey(x) === k; });
        if (s && !seen.has(k)) { ordered.push(s); seen.add(k); }
      });
      list.innerHTML = '<div class="repo-group"><h2>★ Favorites (順位は ↑↓ で変更)</h2>'
        + ordered.map(function(s, idx){ return renderSymbol(s, needle, idx, ordered.length); }).join('')
        + '</div>';
      return;
    }

    const groups = {};
    matched.forEach(function(s) {
      (groups[s.repo] = groups[s.repo] || []).push(s);
    });

    list.innerHTML = Object.keys(groups).sort().map(function(repo) {
      const items = groups[repo].map(function(s) { return renderSymbol(s, needle, -1, 0); }).join('');
      return '<div class="repo-group">'
        + '<h2><a href="https://github.com/' + escape(repo) + '" target="_blank" rel="noopener">' + escape(repo) + '</a></h2>'
        + items
        + '</div>';
    }).join('');
  }

  // symbol 1 件を card HTML に。favOnly モード (idx >= 0) なら ↑↓ button も
  // 出して順位変更可能にする。それ以外は ★ button のみ。
  function renderSymbol(s, needle, idx, total) {
    const ghLink = buildGitHubLink(s.repo, s.file, s.line);
    const fileBit = s.file
      ? '<span class="file">' + (ghLink
          ? '<a href="' + escape(ghLink) + '" target="_blank" rel="noopener">' + escape(s.file) + (s.line != null ? ':' + s.line : '') + '</a>'
          : escape(s.file) + (s.line != null ? ':' + s.line : '')
        ) + '</span>'
      : '';
    const sig = s.signature ? '<div class="sig">' + escape(s.signature) + '</div>' : '';
    // 検索 query が doc に match している時は、その match を含む行を 1 行目の
    // 代わりに表示する (= なぜ hit したか視覚的に分かる)。
    let docLineRaw = '';
    if (s.doc) {
      const lines = s.doc.split('\\n');
      if (needle && !lines[0].toLowerCase().includes(needle)) {
        const hit = lines.find(function(l){ return l.toLowerCase().includes(needle); });
        docLineRaw = hit || lines[0];
      } else {
        docLineRaw = lines[0];
      }
    }
    const doc = docLineRaw ? '<div class="doc">' + highlight(docLineRaw, needle) + '</div>' : '';
    const feats = s.features && s.features.length
      ? '<div class="features">' + s.features.map(function(f){ return '<span class="feat">' + highlight(f, needle) + '</span>'; }).join('') + '</div>'
      : '';
    const fqInner = highlight(s.fq_path, needle);
    const fqHtml = ghLink
      ? '<a href="' + escape(ghLink) + '" class="fq-link" target="_blank" rel="noopener" title="Open ' + escape(s.fq_path) + ' on GitHub">' + fqInner + '</a>'
      : fqInner;
    const starred = isFav(s);
    const k = symbolKey(s);
    const reorder = (idx >= 0 && total > 0)
      ? '<button type="button" class="star" data-fav-move="up" data-key="' + escape(k) + '" title="上へ"' + (idx === 0 ? ' disabled' : '') + '>↑</button>'
        + '<button type="button" class="star" data-fav-move="down" data-key="' + escape(k) + '" title="下へ"' + (idx === total - 1 ? ' disabled' : '') + '>↓</button>'
      : '';
    const starBtn = '<button type="button" class="star" data-fav-toggle="1" data-key="' + escape(k) + '" aria-pressed="' + starred + '" title="' + (starred ? 'お気に入りから外す' : 'お気に入りに追加') + '">' + (starred ? '★' : '☆') + '</button>';
    return '<div class="sym' + (starred ? ' is-fav' : '') + '" data-symkey="' + escape(k) + '">'
      + '<div class="header">'
      +   '<span class="kind">' + escape(s.kind) + '</span>'
      +   '<span class="fq">' + fqHtml + '</span>'
      +   fileBit
      +   reorder
      +   starBtn
      + '</div>'
      + sig + doc + feats
      + '</div>';
  }

  // 左 sidebar の ★ list (保存順)。data に該当 symbol が無い key も "stale"
  // として表示し、削除手段 (✕) を残す (= R2 jsonl が refresh されてない時の救済)。
  function renderSidebar() {
    if (!sidebarEl) return;
    if (favorites.length === 0) {
      sidebarEl.innerHTML = '<h3>★ Favorites <span class="count">(0)</span></h3>'
        + '<div class="empty">各 symbol の ★ で追加。ここで ↑↓ 順位変更、✕ で削除。</div>';
      return;
    }
    const byKey = {};
    data.forEach(function(s){ byKey[symbolKey(s)] = s; });
    const items = favorites.map(function(k, idx){
      const upDisabled = idx === 0 ? ' disabled' : '';
      const downDisabled = idx === favorites.length - 1 ? ' disabled' : '';
      const controls =
          '<button type="button" class="ctl" data-fav-move="up" data-key="' + escape(k) + '" title="上へ"' + upDisabled + '>↑</button>'
        + '<button type="button" class="ctl" data-fav-move="down" data-key="' + escape(k) + '" title="下へ"' + downDisabled + '>↓</button>'
        + '<button type="button" class="ctl" data-fav-toggle="1" data-key="' + escape(k) + '" title="お気に入りから削除">✕</button>';

      if (isFeatureKey(k)) {
        const name = featureName(k);
        // 該当 feature を持つ symbol が data 内に存在するかで stale 判定。
        const hit = data.some(function(x){ return (x.features || []).indexOf(name) !== -1; });
        const nameHtml = hit
          ? '<span class="name" data-jump-feat="' + escape(name) + '" title="この feature を持つ最初の card へ scroll">' + escape(name) + '</span>'
          : '<span class="name" style="color:#6e7681">(missing) ' + escape(name) + '</span>';
        return '<div class="sidebar-item">'
          + '<div class="row">' + nameHtml + controls + '</div>'
          + '<div class="repo"><span class="badge badge-feat">feature</span></div>'
          + '</div>';
      }

      const s = byKey[k];
      if (!s) {
        return '<div class="sidebar-item">'
          + '<div class="row"><span class="name" style="color:#6e7681">(missing) ' + escape(k) + '</span>' + controls + '</div>'
          + '<div class="repo"><span class="badge badge-sym">symbol</span></div>'
          + '</div>';
      }
      // sidebar entry にも feature tag を出す (= sidebar から「この symbol は
      // 何の能力か」一目で分かる)。tag を click で「その feature を持つ最初の
      // card に jump」できるようにすると、symbol ↔ feature の関連 navigation が
      // sidebar 内で完結する (Refs ippoan/cap-catalog#1)。
      const feats = (s.features || []).length
        ? '<div class="sidebar-feats">' + (s.features || []).map(function(f){
            return '<span class="feat" data-jump-feat="' + escape(f) + '" title="この feature を持つ最初の card へ scroll">' + escape(f) + '</span>';
          }).join('') + '</div>'
        : '';
      return '<div class="sidebar-item">'
        + '<div class="row"><span class="name" data-jump-key="' + escape(k) + '" title="main list へ scroll">' + escape(s.name) + '</span>' + controls + '</div>'
        + '<div class="repo"><span class="badge badge-sym">' + escape(s.kind) + '</span> ' + escape(s.repo) + '</div>'
        + feats
        + '</div>';
    }).join('');
    sidebarEl.innerHTML = '<h3>★ Favorites <span class="count">(' + favorites.length + ')</span></h3>' + items;
  }

  // 軸毎の集計: data 全体での key → 出現回数。chip render に使う。
  function tally(keyExtractor) {
    const counts = {};
    data.forEach(function(s){
      const keys = keyExtractor(s);
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach(function(k){
        if (k === '' || k == null) return;
        counts[k] = (counts[k] || 0) + 1;
      });
    });
    return counts;
  }
  const moduleCounts = tally(function(s){ return rootSegment(s.fq_path); });
  const featureCounts = tally(symbolFeatures);
  const allModules = Object.keys(moduleCounts).sort();
  const allFeatures = Object.keys(featureCounts).sort(function(a, b){
    // (unfeatured) は末尾に固定 (= 通常 feature の検索 UX を邪魔しない)
    if (a === UNFEATURED) return 1;
    if (b === UNFEATURED) return -1;
    return a.localeCompare(b);
  });

  const moduleAxis = makeAxis('cap-catalog:hiddenModules', allModules,
    function(k){ return /schema/i.test(k); });
  const featureAxis = makeAxis('cap-catalog:hiddenFeatures', allFeatures,
    function(k){ return k === UNFEATURED; });

  function renderChips(el, axis, counts) {
    if (!el) return;
    if (axis.allKeys.length === 0) { el.innerHTML = ''; return; }
    // feature 軸の chip だけ ★ button を中に持つ (= feature を fav 化できる)。
    // module 軸の chip は star 無し (= module は navigation 軸であり「能力」では
    // ないので fav の対象にしない)。(unfeatured) sentinel も fav 対象外。
    const isFeatureAxis = axis.lsKey === 'cap-catalog:hiddenFeatures';
    const chips = axis.allKeys.map(function(k){
      const visible = !axis.hidden.has(k);
      const showStar = isFeatureAxis && k !== UNFEATURED;
      const star = showStar
        ? '<span role="button" class="chip-star" data-fav-toggle="1" data-key="' + escape(featureKey(k)) + '" aria-pressed="' + isFavKey(featureKey(k)) + '" title="お気に入りに追加 / 解除">' + (isFavKey(featureKey(k)) ? '★' : '☆') + '</span>'
        : '';
      return '<button type="button" class="chip" data-axis="' + escape(axis.lsKey) + '" data-key="' + escape(k) + '" aria-pressed="' + visible + '" title="' + (visible ? 'click to hide' : 'click to show') + '">'
        + escape(k)
        + '<span class="chip-count">' + counts[k] + '</span>'
        + star
        + '</button>';
    }).join('');
    el.innerHTML = chips
      + '<button type="button" class="chip-reset" data-axis="' + escape(axis.lsKey) + '" data-action="show-all">show all</button>';
  }
  function renderFilters() {
    renderChips(moduleFiltersEl, moduleAxis, moduleCounts);
    renderChips(featureFiltersEl, featureAxis, featureCounts);
  }

  function bindAxisClick(el) {
    if (!el) return;
    el.addEventListener('click', function(ev){
      // chip 内の ★ click は fav handler に任せる (= 同一 chip 内で hide-toggle
      // と fav-toggle が両方発火しないよう priority 付け)。
      if (ev.target.closest('[data-fav-toggle]')) return;
      const t = ev.target.closest('[data-axis]');
      if (!t) return;
      const axisKey = t.dataset.axis;
      const axis = axisKey === moduleAxis.lsKey ? moduleAxis
                 : axisKey === featureAxis.lsKey ? featureAxis : null;
      if (!axis) return;
      if (t.dataset.action === 'show-all') {
        axis.hidden.clear();
      } else if (t.dataset.key) {
        const k = t.dataset.key;
        if (axis.hidden.has(k)) axis.hidden.delete(k); else axis.hidden.add(k);
      }
      axis.save(axis.hidden);
      renderFilters();
      render(input.value);
    });
  }
  bindAxisClick(moduleFiltersEl);
  bindAxisClick(featureFiltersEl);

  function renderFavToggle() {
    if (!favToggleEl) return;
    favToggleEl.setAttribute('aria-pressed', favOnly ? 'true' : 'false');
    favToggleEl.innerHTML = (favOnly ? '★ Favorites only' : '☆ Show favorites only')
      + '<span class="fav-count">(' + favorites.length + ')</span>';
  }
  favToggleEl && favToggleEl.addEventListener('click', function(){
    favOnly = !favOnly;
    saveFavOnly(favOnly);
    schedulePut();
    renderFavToggle();
    renderSidebar();
    render(input.value);
  });

  // ★ toggle / ↑↓ 順位変更は main list + sidebar + feature chip 共通の click
  // delegation。sidebar の name click は main list の該当 card へ scroll + flash:
  //   - data-jump-key:  symbol key '<repo>|<lang>|<fq>' → .sym[data-symkey=]
  //   - data-jump-feat: feature 名                       → そのタグを持つ最初の .sym
  function safeCss(v) {
    if (window.CSS && CSS.escape) return CSS.escape(v);
    return v.replace(/[\\\\"]/g, '\\\\$&');
  }
  function flashCard(card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash');
    setTimeout(function(){ card.classList.remove('flash'); }, 1500);
  }
  function handleFavClick(ev) {
    const target = ev.target;
    const jumpSym = target.closest('[data-jump-key]');
    if (jumpSym) {
      const card = document.querySelector('.sym[data-symkey="' + safeCss(jumpSym.dataset.jumpKey) + '"]');
      if (card) flashCard(card);
      return;
    }
    const jumpFeat = target.closest('[data-jump-feat]');
    if (jumpFeat) {
      const name = jumpFeat.dataset.jumpFeat;
      // data から最初に name を含む symbol を探し、その card を flash
      const s = data.find(function(x){ return (x.features || []).indexOf(name) !== -1; });
      if (s) {
        const card = document.querySelector('.sym[data-symkey="' + safeCss(symbolKey(s)) + '"]');
        if (card) flashCard(card);
      }
      return;
    }
    const t = target.closest('[data-fav-toggle], [data-fav-move]');
    if (!t) return;
    const k = t.dataset.key;
    if (!k) return;
    if (t.dataset.favToggle) {
      toggleFavKey(k);
    } else if (t.dataset.favMove) {
      moveFavKey(k, t.dataset.favMove === 'up' ? -1 : 1);
    }
    renderFavToggle();
    renderSidebar();
    renderFilters(); // feature chip の ★ 状態 update
    render(input.value);
  }
  list && list.addEventListener('click', handleFavClick);
  sidebarEl && sidebarEl.addEventListener('click', handleFavClick);
  // feature chip area の click も同じ handler。chip 自体の hide-toggle と
  // 競合しないよう bindAxisClick 側で [data-fav-toggle] を除外している。
  featureFiltersEl && featureFiltersEl.addEventListener('click', handleFavClick);

  input.addEventListener('input', function(){ render(input.value); });

  // URL param ?q=foo は初期 query
  const url = new URL(location.href);
  const initQ = url.searchParams.get('q') || '';
  if (initQ) input.value = initQ;
  renderFilters();
  renderFavToggle();
  renderSidebar();
  render(initQ);
  // localStorage で先に paint してから server を確認する (= 初回 fetch を待たず
  // 即表示)。server が新しければ上書き再描画。
  hydrateFromServer();

  input.addEventListener('change', function() {
    const url = new URL(location.href);
    if (input.value) url.searchParams.set('q', input.value);
    else url.searchParams.delete('q');
    history.replaceState(null, '', url.toString());
  });
})();
`;

export async function handleCapCatalogPage(env: Env, _ctx?: ExecutionContext): Promise<Response> {
  const source = await fetchCatalogSource(env);
  // `<` を `<` に escape して `<script>` 内の JSON literal を
  // HTML tokenizer から完全に隠す。Rust doc-comment 等に `</script>` /
  // `<!--` が混入していても tag break-out 不可能になる。`<` は valid な
  // JSON escape なので client-side `JSON.parse` で `<` に正しく戻る。
  const dataJson = source.symbols
    .map((s) => JSON.stringify(s).replace(/</g, "\\u003c"))
    .join(",\n");
  const banner = renderBanner(source);

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cap Catalog — ci-dashboard</title>
  ${PWA_HEAD_TAGS}
  <style>${TAB_STYLES}${PAGE_STYLES}</style>
</head>
<body>
  ${renderTabs("cap-catalog" as never)}
  <h1>🗂️ Cap Catalog</h1>
  <p class="lede">
    機能単位の横断シンボル検索。<a href="https://github.com/ippoan/cap-catalog/issues/1" target="_blank" rel="noopener">cap-catalog#1</a>
    で進めているカタログ基盤の display-only consumer (issue #10)。R2 binding
    <code>CAP_CATALOG_R2</code> 経由で <code>v1/latest.jsonl</code> を fetch して表示。
  </p>
  ${banner}
  <div class="layout">
    <aside id="favorites-sidebar" class="sidebar"></aside>
    <div class="main">
      <div class="controls">
        <input id="q" type="search" placeholder="fq_path / name / doc / feature で検索…" autocomplete="off">
      </div>
      <div class="fav-bar">
        <button id="fav-only-toggle" type="button" class="fav-toggle" aria-pressed="false">☆ Show favorites only<span class="fav-count">(0)</span></button>
      </div>
      <div class="filters filters-row"><span class="axis-label">feature:</span><div id="feature-filters" class="filters-axis"></div></div>
      <div class="filters filters-row"><span class="axis-label">module:</span><div id="module-filters" class="filters-axis"></div></div>
      <div id="meta" class="meta"></div>
      <div id="list"></div>
    </div>
  </div>

  <script type="application/json" id="catalog-data">[${dataJson}]</script>
  <script>${CLIENT_SCRIPT}</script>
  ${PWA_REGISTER_SCRIPT}
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
