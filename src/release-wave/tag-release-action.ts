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
