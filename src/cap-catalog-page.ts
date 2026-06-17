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
    max-width: 1080px;
    margin: 0 auto;
    line-height: 1.5;
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
  const data = JSON.parse(document.getElementById('catalog-data').textContent);

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
    // 2 軸 hide を AND で適用: module が hide ∨ 所属 feature が全部 hide なら drop。
    // 「feature が全部 hide」= 表示すべき feature が 1 つも残らない (= 全 tag が消されてる)。
    const matched = queryFiltered.filter(function(s){
      if (moduleAxis.hidden.has(rootSegment(s.fq_path))) return false;
      const feats = symbolFeatures(s);
      const visibleFeats = feats.filter(function(f){ return !featureAxis.hidden.has(f); });
      return visibleFeats.length > 0;
    });
    const hiddenCount = queryFiltered.length - matched.length;

    meta.textContent = matched.length + ' / ' + data.length + ' symbol(s)'
      + (hiddenCount > 0 ? ' (' + hiddenCount + ' hidden by filter)' : '');
    if (matched.length === 0) {
      list.innerHTML = '<div class="empty">no match</div>';
      return;
    }

    const groups = {};
    matched.forEach(function(s) {
      (groups[s.repo] = groups[s.repo] || []).push(s);
    });

    list.innerHTML = Object.keys(groups).sort().map(function(repo) {
      const items = groups[repo].map(function(s) {
        const ghLink = buildGitHubLink(s.repo, s.file, s.line);
        const fileBit = s.file
          ? '<span class="file">' + (ghLink
              ? '<a href="' + escape(ghLink) + '" target="_blank" rel="noopener">' + escape(s.file) + (s.line != null ? ':' + s.line : '') + '</a>'
              : escape(s.file) + (s.line != null ? ':' + s.line : '')
            ) + '</span>'
          : '';
        const sig = s.signature ? '<div class="sig">' + escape(s.signature) + '</div>' : '';
        // 検索 query が doc に match している時は、その match を含む行を
        // 1 行目の代わりに表示する (= なぜ hit したか視覚的に分かる)。
        // query 無し or 1 行目に match があれば従来通り 1 行目を出す。
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
        return '<div class="sym">'
          + '<div class="header">'
          +   '<span class="kind">' + escape(s.kind) + '</span>'
          +   '<span class="fq">' + fqHtml + '</span>'
          +   fileBit
          + '</div>'
          + sig + doc + feats
          + '</div>';
      }).join('');
      return '<div class="repo-group">'
        + '<h2><a href="https://github.com/' + escape(repo) + '" target="_blank" rel="noopener">' + escape(repo) + '</a></h2>'
        + items
        + '</div>';
    }).join('');
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
    const chips = axis.allKeys.map(function(k){
      const visible = !axis.hidden.has(k);
      return '<button type="button" class="chip" data-axis="' + escape(axis.lsKey) + '" data-key="' + escape(k) + '" aria-pressed="' + visible + '" title="' + (visible ? 'click to hide' : 'click to show') + '">'
        + escape(k)
        + '<span class="chip-count">' + counts[k] + '</span>'
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

  input.addEventListener('input', function(){ render(input.value); });

  // URL param ?q=foo は初期 query
  const url = new URL(location.href);
  const initQ = url.searchParams.get('q') || '';
  if (initQ) input.value = initQ;
  renderFilters();
  render(initQ);

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
  <div class="controls">
    <input id="q" type="search" placeholder="fq_path / name / doc / feature で検索…" autocomplete="off">
  </div>
  <div class="filters filters-row"><span class="axis-label">feature:</span><div id="feature-filters" class="filters-axis"></div></div>
  <div class="filters filters-row"><span class="axis-label">module:</span><div id="module-filters" class="filters-axis"></div></div>
  <div id="meta" class="meta"></div>
  <div id="list"></div>

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
