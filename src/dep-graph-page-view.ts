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
</style>
</head>
<body>
${renderTabs("dashboard")}
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
${PWA_REGISTER_SCRIPT}
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
