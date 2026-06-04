/**
 * Release Wave ページの「Tag Release」ボタン (form-POST) を受ける handler。
 *
 * /release-wave ページは strict CSP (`default-src 'none'`, script 無効) なので、
 * /releases ページのような JS fetch は使えない。代わりに素の <form method="post">
 * から叩き、Post/Redirect/Get で 303 redirect して一覧に戻す。
 *
 * tag 採番は各 repo の tag-release.yml workflow 側で行う (dispatchTagRelease は
 * dispatch するだけ)。
 */

import type { Env } from "../index";
import { dispatchTagRelease } from "../tag-release";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** POST /api/release-wave/tag-release  (form field `repo`)。 */
export async function handleReleaseWaveTagRelease(
  req: Request,
  env: Env,
): Promise<Response> {
  let repo: string | null = null;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const body = await req.text();
    repo = new URLSearchParams(body).get("repo");
  } else {
    // JSON でも一応受ける (curl / test 用)。
    try {
      const j = await req.json<{ repo?: string }>();
      repo = j.repo ?? null;
    } catch {
      repo = null;
    }
  }

  const result = await dispatchTagRelease(env, repo ?? "");
  if (!result.ok) {
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>Tag release failed</title></head><body>
<p>tag-release failed: ${escapeHtml(result.error ?? "unknown error")}</p>
<p><a href="/release-wave">&larr; Release Wave に戻る</a></p>
</body></html>`;
    return new Response(html, {
      status: result.status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // PRG: reload で再 dispatch されないよう 303 で一覧へ戻す。
  return new Response(null, {
    status: 303,
    headers: { Location: "/release-wave" },
  });
}

/**
 * POST /api/release-wave/tag-release-all  (form field `repos` = カンマ区切り)。
 *
 * Compatibility グラフの「⚡ Tag Release all」ボタンから、release 可能な repo の
 * tag-release.yml をまとめて dispatch する。各 repo の tag 採番は workflow 側。
 * 1 件でも失敗したら失敗 repo を一覧して報告する (成功分は dispatch 済み)。
 */
export async function handleReleaseWaveTagReleaseAll(
  req: Request,
  env: Env,
): Promise<Response> {
  let reposRaw: string | null = null;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const body = await req.text();
    reposRaw = new URLSearchParams(body).get("repos");
  } else {
    try {
      const j = await req.json<{ repos?: string | string[] }>();
      reposRaw = Array.isArray(j.repos) ? j.repos.join(",") : j.repos ?? null;
    } catch {
      reposRaw = null;
    }
  }

  const repos = (reposRaw ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  if (repos.length === 0) {
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>Tag release failed</title></head><body>
<p>tag-release-all failed: no repos provided</p>
<p><a href="/release-wave">&larr; Release Wave に戻る</a></p>
</body></html>`;
    return new Response(html, {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const failures: string[] = [];
  for (const repo of repos) {
    const result = await dispatchTagRelease(env, repo);
    if (!result.ok) {
      failures.push(`${repo}: ${result.error ?? "unknown error"}`);
    }
  }

  if (failures.length > 0) {
    const items = failures
      .map((f) => `<li>${escapeHtml(f)}</li>`)
      .join("");
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>Tag release partially failed</title></head><body>
<p>tag-release-all: ${repos.length - failures.length}/${repos.length} dispatched, ${failures.length} failed:</p>
<ul>${items}</ul>
<p><a href="/release-wave">&larr; Release Wave に戻る</a></p>
</body></html>`;
    return new Response(html, {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // PRG: reload で再 dispatch されないよう 303 で一覧へ戻す。
  return new Response(null, {
    status: 303,
    headers: { Location: "/release-wave" },
  });
}
