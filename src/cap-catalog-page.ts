// cap-catalog viewer (Refs ippoan/cap-catalog#1 #10).
//
// SSR + client-side filter. データは現状 ippoan/cap-catalog の self-dogfood
// extract (PR #17/#18 run) からインライン保持。R2 upload (cap-catalog 後段 PR)
// が landed したら fetch に置き換える前提で、本 page は表示骨格を確定させる役割。
//
// Catalog の symbols 1 件 = SSR ページに `<script type="application/json">` で
// 全部埋め込み、`?q=` の query は JS で in-memory filter する (= 1 req で完結、
// extra fetch なし)。data set は MVP として ~10 行、scale すれば paging を追加。

import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";

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
  .banner code { background: rgba(0,0,0,.25); padding: 1px 5px; border-radius: 3px; }
  .controls {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-bottom: 16px;
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
  .empty {
    text-align: center;
    color: #6e7681;
    padding: 32px;
    font-size: 13px;
  }
`;

function renderSampleData(): string {
  return SAMPLE_SYMBOLS
    .map((s) => JSON.stringify(s))
    .join(",\n");
}

const CLIENT_SCRIPT = `
(function() {
  const input = document.getElementById('q');
  const list = document.getElementById('list');
  const meta = document.getElementById('meta');
  const data = JSON.parse(document.getElementById('catalog-data').textContent);

  function escape(s) {
    return String(s)
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'", '&#39;');
  }

  function buildGitHubLink(repo, file, line) {
    if (!repo || !file) return '';
    const path = encodeURI(file);
    const anchor = line != null ? '#L' + line : '';
    return 'https://github.com/' + repo + '/blob/main/' + path + anchor;
  }

  function render(q) {
    const needle = (q || '').toLowerCase().trim();
    const matched = needle === ''
      ? data
      : data.filter(function(s) {
          if (s.fq_path.toLowerCase().includes(needle)) return true;
          if (s.name.toLowerCase().includes(needle)) return true;
          if (s.doc && s.doc.toLowerCase().includes(needle)) return true;
          if (s.features && s.features.some(function(f){ return f.toLowerCase().includes(needle); })) return true;
          return false;
        });

    meta.textContent = matched.length + ' / ' + data.length + ' symbol(s)';
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
        const doc = s.doc ? '<div class="doc">' + escape(s.doc.split('\\n')[0]) + '</div>' : '';
        const feats = s.features && s.features.length
          ? '<div class="features">' + s.features.map(function(f){ return '<span class="feat">' + escape(f) + '</span>'; }).join('') + '</div>'
          : '';
        return '<div class="sym">'
          + '<div class="header">'
          +   '<span class="kind">' + escape(s.kind) + '</span>'
          +   '<span class="fq">' + escape(s.fq_path) + '</span>'
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

  input.addEventListener('input', function(){ render(input.value); });

  // URL param ?q=foo は初期 query
  const url = new URL(location.href);
  const initQ = url.searchParams.get('q') || '';
  if (initQ) input.value = initQ;
  render(initQ);

  input.addEventListener('change', function() {
    const url = new URL(location.href);
    if (input.value) url.searchParams.set('q', input.value);
    else url.searchParams.delete('q');
    history.replaceState(null, '', url.toString());
  });
})();
`;

export function handleCapCatalogPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cap Catalog (Preview) — ci-dashboard</title>
  ${PWA_HEAD_TAGS}
  <style>${TAB_STYLES}${PAGE_STYLES}</style>
</head>
<body>
  ${renderTabs("cap-catalog" as never)}
  <h1>🗂️ Cap Catalog (Preview)</h1>
  <p class="lede">
    機能単位の横断シンボル検索。<a href="https://github.com/ippoan/cap-catalog/issues/1" target="_blank" rel="noopener">cap-catalog#1</a>
    で進めているカタログ基盤の display-only consumer (issue #10)。FTS5 検索 / R2 配布まで来たら
    server-side クエリに切り替える。
  </p>
  <div class="banner">
    ⚠️ <strong>Preview</strong>: 表示データは ippoan/cap-catalog 自身の self-dogfood 実 extract
    (5 symbol) を inline 保持。R2 upload workflow (<code>#7</code> 後段) が landed したら
    catalog.sqlite を fetch して全 repo の symbol を出す。client filter は実装済み。
  </div>
  <div class="controls">
    <input id="q" type="search" placeholder="fq_path / name / doc / feature で検索…" autocomplete="off">
  </div>
  <div id="meta" class="meta"></div>
  <div id="list"></div>

  <script type="application/json" id="catalog-data">[${renderSampleData()}]</script>
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
