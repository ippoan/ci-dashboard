// ----------------------------------------------------------------------------
// GET /release-wave/debug-kv  →  COMPAT_KV の生データ閲覧 (read-only debug)
// ----------------------------------------------------------------------------
//
// Release Wave の表示 (Pending releases / Frontends / Traffic) は COMPAT_KV の
// `traffic::<repo>` / `pending-release::<repo>` / `flip-group::latest` /
// compat 系 record から導出される (src/release-wave/{traffic,pending-release,
// compat}.ts)。「flip 済みなのに Pending に残る」「Traffic % が実機と合わない」
// 等は **大半が KV の stale record が原因**で、コードのバグではない。
//
// そういう時に「dashboard が今どの値を読んでいるか」を生で確認するための
// read-only ビュー。値の編集はしない (= 表示専用)。app 全体が Cloudflare Access
// (Google OAuth) の背後なので人間認証は app レベルで担保される。COMPAT_KV は
// version id / traffic % / image tag 等の **メタデータのみ**で secret は持たない。
//
// query:
//   ?prefix=traffic::   … 指定 prefix のキーだけに絞る (既定: 全キー)
//   ?key=traffic::ippoan/alc-app … 単一キーの値だけを表示
//   ?format=json        … HTML ではなく JSON で返す (機械処理 / コピペ用)

import type { Env } from "../index";
import { renderTabs } from "../nav-tabs";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const MAX_KEYS = 1000;

interface KvEntry {
  name: string;
  /** JSON parse できた場合は parsed 値、できなければ生文字列、欠落は null。 */
  value: unknown;
  /** value が JSON として parse できなかった (生テキスト) 場合 true。 */
  raw: boolean;
}

/** COMPAT_KV の (prefix で絞った) 全キーを列挙し、各 value を読む。 */
async function collectEntries(
  kv: KVNamespace,
  prefix: string,
  only: string | null,
): Promise<{ entries: KvEntry[]; truncated: boolean }> {
  const names: string[] = [];
  if (only) {
    names.push(only);
  } else {
    let cursor: string | undefined;
    // KV list は 1 回最大 1000 件 + cursor。COMPAT_KV は小さい前提だが、
    // 暴走防止に MAX_KEYS で打ち切る。
    for (;;) {
      const page = await kv.list({ prefix: prefix || undefined, cursor });
      for (const k of page.keys) names.push(k.name);
      if (page.list_complete || names.length >= MAX_KEYS) break;
      cursor = page.cursor;
    }
  }
  const truncated = names.length > MAX_KEYS;
  const slice = names.slice(0, MAX_KEYS).sort();

  const entries: KvEntry[] = [];
  for (const name of slice) {
    const text = await kv.get(name);
    if (text === null) {
      entries.push({ name, value: null, raw: false });
      continue;
    }
    try {
      entries.push({ name, value: JSON.parse(text), raw: false });
    } catch {
      entries.push({ name, value: text, raw: true });
    }
  }
  return { entries, truncated };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate",
      // /release-wave と同じ strict CSP (inline JS 不可、inline style のみ許可)。
      "Content-Security-Policy":
        "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const STYLES = `
  body { font-family: system-ui, sans-serif; margin: 0; background: #f6f8fa; color: #1f2328; }
  .container { max-width: 1100px; margin: 0 auto; padding: 16px; }
  .page-header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
  h1 { font-size: 20px; margin: 0; }
  .meta { color: #57606a; font-size: 12px; }
  a { color: #0969da; }
  .filters { margin: 8px 0 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .filters a { display: inline-block; padding: 2px 8px; border: 1px solid #d0d7de;
    border-radius: 6px; background: #fff; text-decoration: none; font-size: 12px; }
  .kv { border: 1px solid #d0d7de; border-radius: 8px; background: #fff; margin: 0 0 12px; overflow: hidden; }
  .kv > .key { font-family: ui-monospace, monospace; font-size: 13px; font-weight: 600;
    padding: 8px 12px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; word-break: break-all; }
  .kv > pre { margin: 0; padding: 12px; font-size: 12px; line-height: 1.5;
    overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .tag-raw { color: #9a6700; font-weight: 400; font-size: 11px; }
  .empty { color: #57606a; padding: 16px; }
`;

/**
 * COMPAT_KV の生データ閲覧ページ (read-only)。
 * Refs ippoan/ci-dashboard — Pending/Traffic の stale record デバッグ用。
 */
export async function handleReleaseWaveDebugKvPage(
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") ?? "";
  const only = url.searchParams.get("key");
  const format = url.searchParams.get("format");

  if (!env.COMPAT_KV) {
    if (format === "json") {
      return jsonResponse({ error: "COMPAT_KV is not bound" }, 503);
    }
    return htmlResponse(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8">
       <title>KV debug</title><style>${STYLES}</style></head><body>
       <div class="container"><p class="empty">COMPAT_KV binding がありません。</p></div>
       </body></html>`,
      503,
    );
  }

  const { entries, truncated } = await collectEntries(
    env.COMPAT_KV,
    prefix,
    only,
  );

  if (format === "json") {
    return jsonResponse({ prefix, key: only, count: entries.length, truncated, entries });
  }

  // よく使う prefix のクイックフィルタ。
  const quick = ["", "traffic::", "pending-release::", "flip-group::"];
  const filterLinks = quick
    .map((p) => {
      const label = p === "" ? "all" : escapeHtml(p);
      const href = p === "" ? "/release-wave/debug-kv" : `/release-wave/debug-kv?prefix=${encodeURIComponent(p)}`;
      const cur = !only && prefix === p ? " style=\"font-weight:700;border-color:#0969da\"" : "";
      return `<a href="${href}"${cur}>${label}</a>`;
    })
    .join("");

  const rows =
    entries.length === 0
      ? `<p class="empty">該当キーはありません${
          prefix ? ` (prefix=<code>${escapeHtml(prefix)}</code>)` : ""
        }。</p>`
      : entries
          .map((e) => {
            const pretty =
              e.value === null
                ? "(null / 値なし)"
                : e.raw
                  ? String(e.value)
                  : JSON.stringify(e.value, null, 2);
            const rawTag = e.raw ? ` <span class="tag-raw">(raw text)</span>` : "";
            return `<div class="kv">
              <div class="key">${escapeHtml(e.name)}${rawTag}</div>
              <pre>${escapeHtml(pretty)}</pre>
            </div>`;
          })
          .join("");

  const scope = only
    ? `key=<code>${escapeHtml(only)}</code>`
    : prefix
      ? `prefix=<code>${escapeHtml(prefix)}</code>`
      : "全キー";
  const jsonHref = `/release-wave/debug-kv?${url.searchParams.toString()}${
    url.searchParams.has("format") ? "" : (url.searchParams.toString() ? "&" : "") + "format=json"
  }`;

  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>KV debug — Release Wave</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="container">
    ${renderTabs("release-wave")}
    <div class="page-header">
      <h1>COMPAT_KV debug</h1>
      <span class="meta">read-only。Pending / Traffic の stale record 確認用。${scope}・${entries.length} 件${
        truncated ? ` (${MAX_KEYS} 件で打ち切り)` : ""
      }</span>
      <a class="meta" href="/release-wave">← Release Waves に戻る</a>
      <a class="meta" href="${escapeHtml(jsonHref)}">JSON で見る</a>
    </div>
    <div class="filters">${filterLinks}</div>
    ${rows}
  </div>
</body>
</html>`;

  return htmlResponse(html);
}
