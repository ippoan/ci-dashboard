// /releases index page の SWR blob cache (Refs #325)。
//
// index page は監視 repo (~30) × (repo meta + tags + compare + per-issue
// fetch + PR follow-up) を fan-out するため、同期生成は実測で平均 16s /
// p90 35s かかっていた。生成済みの RepoView[] を 1 blob として持ち、SSR は
// blob を即 render する。refresh は #320 の queue consumer (15 分上限) で
// 実行する — waitUntil の 30s 上限では fan-out が切られ得るため。
//
// このモジュールは KV の read/write/stale 化だけを持つ (views の中身は
// 関知しない generic)。compute は releases-page.ts 側 — webhook.ts が
// stale 化のためにここだけ import しても page 描画コードを引き込まない。

export interface ReleasesIndexBlob<T = unknown> {
  storedAt: number;
  views: T;
}

export const RELEASES_INDEX_KEY = "releases:index:v1";
export const RELEASES_INDEX_FRESH_SECONDS = 60;
const RELEASES_INDEX_STORE_SECONDS = 86400;

// refresh の重複排除 lock。fan-out は 35s かかり得るので余裕を持って 120s。
export const RELEASES_INDEX_REFRESH_LOCK = "releases:index:refreshing";
export const RELEASES_INDEX_REFRESH_LOCK_TTL = 120;

export async function readReleasesIndexBlob<T>(
  kv: KVNamespace,
): Promise<ReleasesIndexBlob<T> | null> {
  return await kv.get(RELEASES_INDEX_KEY, "json") as ReleasesIndexBlob<T> | null;
}

export async function writeReleasesIndexBlob(
  kv: KVNamespace,
  views: unknown,
): Promise<void> {
  await kv.put(
    RELEASES_INDEX_KEY,
    JSON.stringify({ storedAt: Date.now(), views }),
    { expirationTtl: RELEASES_INDEX_STORE_SECONDS },
  );
}

/** blob を stale 化する (storedAt:0 へ書き換え)。delete にしないのは、close /
 *  merge の度に index が cold start (同期 16s 生成) へ戻るのを避けるため —
 *  古い表示を即出しして背景 refresh で追い付く。blob 不在は no-op。 */
export async function markReleasesIndexStale(kv: KVNamespace): Promise<void> {
  const blob = await kv.get(RELEASES_INDEX_KEY, "json") as ReleasesIndexBlob | null;
  if (!blob) return;
  await kv.put(
    RELEASES_INDEX_KEY,
    JSON.stringify({ ...blob, storedAt: 0 }),
    { expirationTtl: RELEASES_INDEX_STORE_SECONDS },
  );
}
