import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";
import { GitHubApiError, validateOrg } from "./github-api";
import { getDepGraphMeta, type DepGraphArtifactEnv } from "./dep-graph-artifact";

// `/dep-graph/:owner/:repo` SSR page。Refs ippoan/ci-dashboard#443
//
// 対象 repo の最新 `dep-graph` artifact から meta.json を取って、ヘッダーに
// 「最終更新時刻 / commit SHA / GitHub Actions run へのリンク」を、本文に
// `<img src="/api/dep-graph/.../deps.svg">` で SVG を inline 表示する。
// SVG は CI で graphviz `dot -Tsvg` 生成済みなので、Worker 側に graphviz
// ランタイムを抱えない (= wasm 回避、bundle 軽量)。
//
// repo allowlist は明示。汎用化したくなったら ALLOWED_REPOS に追記。

interface DepGraphRepoDef {
  owner: string;
  repo: string;
  label: string;
  description: string;
}

const ALLOWED_REPOS: ReadonlyArray<DepGraphRepoDef> = [
  {
    owner: "ippoan",
    repo: "rust-alc-api",
    label: "rust-alc-api",
    description: "Cargo workspace (21 crate) の Bazel 依存グラフ",
  },
];

function findRepoDef(owner: string, repo: string): DepGraphRepoDef | null {
  return ALLOWED_REPOS.find((r) => r.owner === owner && r.repo === repo) ?? null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function handleDepGraphPage(
  env: DepGraphArtifactEnv,
  owner: string,
  repo: string,
): Promise<Response> {
  try {
    validateOrg(owner);
  } catch (e) {
    if (e instanceof GitHubApiError) {
      return new Response(e.message, { status: e.status });
    }
    throw e;
  }

  const def = findRepoDef(owner, repo);
  if (!def) {
    return new Response(`Repo not in dep-graph allowlist: ${owner}/${repo}`, {
      status: 404,
    });
  }

  let meta: Awaited<ReturnType<typeof getDepGraphMeta>> = null;
  let metaError: string | null = null;
  try {
    meta = await getDepGraphMeta(env, owner, repo);
  } catch (e) {
    metaError = e instanceof Error ? e.message : String(e);
  }

  const svgUrl = `/api/dep-graph/${owner}/${repo}/deps.svg`;
  const dotUrl = `/api/dep-graph/${owner}/${repo}/deps.dot`;
  const runUrl = meta
    ? `https://github.com/${owner}/${repo}/actions/runs/${encodeURIComponent(meta.workflow_run_id)}`
    : null;
  const commitUrl = meta
    ? `https://github.com/${owner}/${repo}/commit/${encodeURIComponent(meta.commit_sha)}`
    : null;
  const shortSha = meta ? meta.commit_sha.substring(0, 7) : null;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dep Graph — ${escapeHtml(def.label)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${PWA_HEAD_TAGS}
<style>
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 16px; }
  ${TAB_STYLES}
  h1 { font-size: 18px; margin: 0 0 4px 0; }
  .desc { color: #8b949e; font-size: 13px; margin-bottom: 12px; }
  .meta { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; font-size: 13px; }
  .meta-row { display: flex; gap: 16px; flex-wrap: wrap; }
  .meta-key { color: #8b949e; }
  .meta-val { color: #c9d1d9; }
  .meta a { color: #58a6ff; text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  .err { color: #f85149; }
  .graph-wrap { background: #ffffff; border: 1px solid #30363d; border-radius: 6px; padding: 12px; overflow: auto; }
  .graph-wrap img { max-width: 100%; height: auto; display: block; }
  .actions { margin-top: 8px; font-size: 12px; }
  .actions a { color: #58a6ff; text-decoration: none; margin-right: 12px; }
  details.legend { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; margin-top: 16px; font-size: 13px; }
  details.legend > summary { cursor: pointer; color: #c9d1d9; font-weight: 600; user-select: none; }
  details.legend > summary:hover { color: #58a6ff; }
  details.legend[open] > summary { margin-bottom: 8px; border-bottom: 1px solid #30363d; padding-bottom: 6px; }
  details.legend ul { margin: 6px 0; padding-left: 20px; line-height: 1.7; color: #c9d1d9; }
  details.legend li code { background: #0d1117; border: 1px solid #30363d; border-radius: 3px; padding: 1px 5px; font-size: 12px; }
  details.legend p { margin: 6px 0; color: #8b949e; }
  details.legend h3 { font-size: 13px; color: #c9d1d9; margin: 12px 0 4px 0; font-weight: 600; }
</style>
</head>
<body>
${renderTabs("dep-graph")}
<h1>📈 Dep Graph — ${escapeHtml(def.label)}</h1>
<div class="desc">${escapeHtml(def.description)}</div>
<div class="meta">
${
  metaError
    ? `<span class="err">meta load failed: ${escapeHtml(metaError)}</span>`
    : meta && commitUrl && runUrl && shortSha
      ? `<div class="meta-row">
  <span><span class="meta-key">commit:</span> <a href="${commitUrl}" target="_blank" rel="noopener" class="meta-val"><code>${escapeHtml(shortSha)}</code></a></span>
  <span><span class="meta-key">generated:</span> <span class="meta-val">${escapeHtml(meta.generated_at)}</span></span>
  <span><span class="meta-key">workflow run:</span> <a href="${runUrl}" target="_blank" rel="noopener">#${escapeHtml(meta.workflow_run_id)}</a></span>
</div>`
      : `<span class="meta-key">No dep-graph artifact yet. The workflow needs to run once on <code>main</code> first.</span>`
}
</div>
<div class="graph-wrap">
${meta ? `<img src="${svgUrl}" alt="Dependency graph (${escapeHtml(def.label)})">` : `<div style="color:#586069;padding:24px;text-align:center">(no graph yet)</div>`}
</div>
<div class="actions">
  <a href="${dotUrl}" download="${escapeHtml(repo)}-deps.dot">⬇ Download .dot</a>
  <a href="${svgUrl}" download="${escapeHtml(repo)}-deps.svg">⬇ Download .svg</a>
</div>

<details class="legend">
  <summary>📖 グラフの見方</summary>

  <h3>記号</h3>
  <ul>
    <li><b>箱 (ノード)</b> = workspace 内の crate 1 つ (<code>crates/&lt;name&gt;/</code>)</li>
    <li><b>矢印 A → B</b> = A が B に <b>依存している</b> (A の <code>Cargo.toml</code> に B が <code>path = "..."</code> で入っている)</li>
    <li><b>矢印が集まる crate</b> = 多くの crate から使われる <b>共通基盤</b> (例: <code>alc-core</code>)</li>
    <li><b>矢印が出ていない (leaf)</b> = 他の workspace crate に依存しない単独 crate (例: <code>alc-auth-jwt</code> / <code>alc-csv-parser</code>)</li>
    <li><b>孤立ノード</b> = workspace の他 crate に依存も被依存も無い crate</li>
  </ul>

  <h3>除外しているもの (見やすさのため)</h3>
  <ul>
    <li><code>rust_test</code> ターゲット (各 crate に 1 つあって倍になるので)</li>
    <li>external crate (rules_rust crate_universe の <code>tokio</code> / <code>axum</code> / <code>serde</code> 等、数百個ある)</li>
    <li>暗黙依存 (rust toolchain / proc-macro)</li>
  </ul>

  <h3>rust-alc-api 特有の読み方</h3>
  <ul>
    <li><code>alc-core</code> はほぼ全 crate が向く <b>共通型・util の集積点</b>。ここを変えると影響範囲が広い</li>
    <li><code>*-api</code> 末尾の crate (<code>tenko-api</code> / <code>carins-api</code> / <code>dtako-api</code> / <code>trouble-api</code> / <code>alc-camera-api</code>) は per-domain の <b>個別 Cloud Run binary</b>。対応する domain crate (<code>alc-tenko</code> / <code>alc-carins</code> 等) を呼ぶ</li>
    <li><code>gateway</code> が孤立しているのは <b>仕様</b>。HTTP-level reverse proxy で、workspace crate を import せず <code>reqwest</code> で各 API を外部呼び出しする設計 (依存ゼロが正しい)</li>
  </ul>

  <p>生成方法: <code>bazel query "kind('rust_(library|binary)', deps(//crates/...) intersect //crates/...)"</code> → <code>dot -Tsvg</code>。詳細は <a href="https://github.com/ippoan/rust-alc-api/blob/main/.github/workflows/dep-graph.yml" target="_blank" rel="noopener">dep-graph.yml</a> 参照。</p>
</details>

${PWA_REGISTER_SCRIPT}
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
