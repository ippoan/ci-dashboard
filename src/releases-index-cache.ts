// /releases index page の SWR blob cache (Refs #325)。
//
// blob の SoT は **CIDashboardHub DO の `this.ctx.storage`** (強整合、Refs #409)。
// CI_STATUS KV は **backup / external dump** 用 (eventual consistency)。
//
// 旧設計 (v3 以前) は KV をそのまま SoT にしていたが、CF KV の global
// propagation lag (最大 60s) と WS auto-reload (~10s) が噛み合い、close 直後の
// 「reload で復活」事故 (#400 bug 1) が確定したため、SoT を DO に移した。
//
// public API は env (CI_HUB binding 経由) を受け取り、内部で Hub DO に fetch:
//   readReleasesIndexBlob(env)            → POST /releases-index-read
//   writeReleasesIndexBlob(env, views)    → POST /releases-index-write
//   writePatchedReleasesIndexBlob(env, blob) → POST /releases-index-write-patched
//   markReleasesIndexStale(env, repo?)    → POST /releases-index-mark-stale
//
// Hub DO は write 完了後、WEBHOOK_QUEUE に `{kind: "releases-index-kv-backup"}`
// を best-effort で投函し、consumer が事後に KV を更新する (失敗は drop OK、
// KV は backup でしかない)。
//
// このモジュールは views の中身は関知しない generic。compute は releases-page.ts
// 側 — webhook.ts が import しても page 描画コードを引き込まない。

export interface ReleasesIndexBlob<T = unknown> {
  storedAt: number;
  views: T;
  /** stale 化の原因 repo (Refs #327)。/releases が「🔄 更新中」バッジを
   *  repo card 単位で出すのに使う。refresh 完了 (blob 再生成) でリセット。 */
  staleRepos?: string[];
}

// staleRepos の肥大防止 (CI burst で merge が連発しても note が溢れない)。
const STALE_REPOS_CAP = 20;

// version bump で SWR blob を即時 flush する pattern (Refs #400):
//   v1 → v2: pr-map gate (PR #403) を追加
//   v2 → v3: cross-repo refs の scope filter を追加
//   v3 → v4: blob SoT を DO storage に移行 (#409)。本 key は KV backup の場所
export const RELEASES_INDEX_KEY = "releases:index:v4";
// 鮮度は WS event 起点の refresh (#327) が担保するため、この window は
// 「refresh の最短間隔」としてだけ機能する。
export const RELEASES_INDEX_FRESH_SECONDS = 3600;
export const RELEASES_INDEX_STORE_SECONDS = 86400;

// refresh の重複排除 lock。fan-out は 35s かかり得るので余裕を持って 120s。
export const RELEASES_INDEX_REFRESH_LOCK = "releases:index:refreshing";
export const RELEASES_INDEX_REFRESH_LOCK_TTL = 120;

/** Hub DO の storage key (this.ctx.storage 内、本キーで blob を持つ)。 */
export const RELEASES_INDEX_DO_KEY = "releases-index";

/** Hub DO fetch 用の最小 env。CI_HUB は必須、CI_STATUS は legacy fallback と
 *  bootstrap migration 用 (DO storage 空 → KV v3 を seed)。 */
export interface ReleasesIndexCacheEnv {
  CI_HUB: DurableObjectNamespace;
  CI_STATUS: KVNamespace;
}

function getHubStub(env: ReleasesIndexCacheEnv): DurableObjectStub {
  const id = env.CI_HUB.idFromName("singleton");
  return env.CI_HUB.get(id);
}

async function hubFetch(
  env: ReleasesIndexCacheEnv,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return getHubStub(env).fetch(new Request(`http://hub${path}`, init));
}

/** DO storage から blob を 1 件読む。Hub DO は内部で「DO 空 → KV v3 から seed」の
 *  bootstrap migration を 1 回だけ行うので、deploy 直後でも空 blob を返さない
 *  (Refs #409 の段階移行)。net 不通や DO 障害時の最終 fallback として KV v4 を
 *  read する (= KV backup の唯一の reader 経路、観測 SLO は低い)。 */
export async function readReleasesIndexBlob<T>(
  env: ReleasesIndexCacheEnv,
): Promise<ReleasesIndexBlob<T> | null> {
  try {
    const res = await hubFetch(env, "/releases-index-read");
    if (res.ok) {
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text) as ReleasesIndexBlob<T>;
    }
  } catch {
    /* fall through to KV backup */
  }
  // Hub 到達不能時の最終 fallback (KV backup、eventual)。
  return await env.CI_STATUS.get(RELEASES_INDEX_KEY, "json") as ReleasesIndexBlob<T> | null;
}

/** 全集計 (refresh) の結果を blob として書き込む。storedAt は now で更新する。 */
export async function writeReleasesIndexBlob(
  env: ReleasesIndexCacheEnv,
  views: unknown,
): Promise<void> {
  const blob: ReleasesIndexBlob = { storedAt: Date.now(), views };
  await hubFetch(env, "/releases-index-write", {
    method: "POST",
    body: JSON.stringify(blob),
  });
}

/** webhook 直接 patch (Refs #339) 用の書き戻し。storedAt / staleRepos を
 *  変えない — storedAt は「最後の full snapshot 時刻」の意味を保ち、patch は
 *  内容を現にするだけなので更新中バッジも出さない。 */
export async function writePatchedReleasesIndexBlob(
  env: ReleasesIndexCacheEnv,
  blob: ReleasesIndexBlob,
): Promise<void> {
  await hubFetch(env, "/releases-index-write", {
    method: "POST",
    body: JSON.stringify(blob),
  });
}

/** blob を stale 化する (storedAt:0 へ書き換え)。delete にしないのは、close /
 *  merge の度に index が cold start (同期 16s 生成) へ戻るのを避けるため —
 *  古い表示を即出しして背景 refresh で追い付く。blob 不在は no-op。
 *  `repo` を渡すと staleRepos に記録され、/releases が該当 card に
 *  「🔄 更新中」バッジを出す (Refs #327)。 */
export async function markReleasesIndexStale(
  env: ReleasesIndexCacheEnv,
  repo?: string,
): Promise<void> {
  const blob = await readReleasesIndexBlob(env);
  if (!blob) return;
  const staleRepos = new Set(blob.staleRepos ?? []);
  if (repo) staleRepos.add(repo);
  const next: ReleasesIndexBlob = {
    ...blob,
    storedAt: 0,
    staleRepos: [...staleRepos].slice(0, STALE_REPOS_CAP),
  };
  await hubFetch(env, "/releases-index-write", {
    method: "POST",
    body: JSON.stringify(next),
  });
}
