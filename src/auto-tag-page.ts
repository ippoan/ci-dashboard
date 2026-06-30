// /auto-tag SSR page (Refs #460).
//
// operator 用の admin UI。Hub DO storage の auto-tag set (`autoTag:repos`) を
// textarea に展開し、submit で全置換する。Cloudflare Access (zone-level) で
// gate される前提なので、page 内で追加の認証は行わない。
//
// `<input type="checkbox">` のリストではなく textarea (1 行 1 repo) にした
// のは:
//   - 候補 repo の正本がこの worker 内に無い (release-wave-targets.yaml は
//     別 repo の reusable workflow 側) → list 生成のために GitHub API を叩く
//     のは権限と速度の両面で割に合わない
//   - 大半の operator は数 repo だけを on にする運用想定で、それを vim 風に
//     列挙する方が直感的
//   - 後で `release-wave-targets.yaml` を pull できるようになったら checkbox
//     形式にスイッチできる (本 page は単純なので差し替えは安い)

import type { Env } from "./index";
import { readAutoTagRepos, writeAutoTagRepos } from "./auto-tag";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(repos: string[], flash: string | null): string {
  const initial = escapeHtml(repos.join("\n"));
  const flashHtml = flash
    ? `<p class="flash" role="status">${escapeHtml(flash)}</p>`
    : "";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Auto-tag on PR merge — ci-dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  textarea { width: 100%; height: 16rem; font-family: ui-monospace, monospace; font-size: 0.95rem; }
  .flash { background: #e6ffed; border: 1px solid #34d058; padding: 0.5rem 0.75rem; border-radius: 4px; }
  .help { color: #586069; font-size: 0.9rem; }
  .actions { margin-top: 0.75rem; display: flex; gap: 0.5rem; }
  button { padding: 0.4rem 0.9rem; cursor: pointer; }
  code { background: #f6f8fa; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style>
</head>
<body>
<h1>Auto-tag on PR merge</h1>
<p class="help">
  ここに <code>owner/name</code> 形式で 1 行 1 repo を列挙すると、その repo の
  PR が default branch に merge されるたびに <code>tag-release.yml</code> が
  workflow_dispatch で自動起動されます。
  空行 / 重複 / 前後の空白は自動で整理されます。
</p>
${flashHtml}
<form method="POST" action="/auto-tag">
  <textarea name="repos" spellcheck="false" autocomplete="off">${initial}</textarea>
  <div class="actions">
    <button type="submit">保存</button>
    <a href="/release-wave">← /release-wave に戻る</a>
  </div>
</form>
</body>
</html>`;
}

export async function handleAutoTagPage(
  hub: DurableObjectStub,
): Promise<Response> {
  const repos = await readAutoTagRepos(hub);
  return new Response(renderPage(repos, null), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function handleAutoTagPagePost(
  request: Request,
  hub: DurableObjectStub,
): Promise<Response> {
  const form = await request.formData();
  const raw = form.get("repos");
  const lines = typeof raw === "string" ? raw.split(/\r?\n/) : [];
  const ok = await writeAutoTagRepos(hub, lines);
  if (!ok) {
    const repos = await readAutoTagRepos(hub);
    return new Response(
      renderPage(repos, "保存に失敗しました (Hub DO 不達)。"),
      { status: 502, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  // 保存成功時は再 GET させて strongly consistent な現在値を取り直す
  // (= PUT 後の正規化結果が UI に必ず反映される)。
  const next = await readAutoTagRepos(hub);
  return new Response(renderPage(next, "保存しました。"), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
