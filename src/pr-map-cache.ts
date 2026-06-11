import {
  fetchAllOpenPrsByIssue,
  extractIssueRefs,
  sortPrRefs,
  type IssuePrRef,
} from "./issue-prs";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import {
  getRateLimitBackoff,
  isRateLimitError,
  setRateLimitBackoff,
} from "./github-backoff";

// /issues の関連 PR chip 用 KV cache (issues-page.ts から移設、Refs #304)。
// webhook.ts (pull_request patch) と issues-page.ts (SSR read) の両方が
// import するため、page module から独立させて循環 import を避ける。
//
// KV schema:
//   issues-page:pr-map:v2 -> { storedAt, patchedAt?, data: Record<issueKey, IssuePrRef[]> }
//
// `storedAt` は「最後に full 4-call Search fetch が成功した時刻」。webhook
// patch では **触らない** (issue-cache の watermark 規約と同じ — 配信ミスは
// 次の full refresh が必ず救う)。`patchedAt` は observability 用の optional
// field で、旧 entry (無し) もそのまま有効 = key の version bump 不要。
export const PR_MAP_CACHE_KEY = "issues-page:pr-map:v2";

// Webhook patch (applyPullRequestEvent) が PR の open/merge を秒で反映する
// ようになったので、full refresh は安全網に格下げして 120s → 600s に拡大
// (= Search ×4 の頻度を 1/5 に。Refs #304 の rate limit 対策本体)。
// Full 4-search refresh の最短間隔。webhook-primary 化 (Refs #332): chips の
// リアルタイム反映は applyPullRequestEvent (+ recentPatches #330) が担い、
// Search は欠落 healing 用の安全網 — 1h で足りる。
const PR_MAP_FRESH_SECONDS = 3600;
const PR_MAP_STORE_SECONDS = 86400;

// SWR の background refresh が同一 fresh window 内で重複しないための
// soft lock。KV の expirationTtl 最小値が 60s なのでそれに合わせる。
// best-effort (cross-colo の重複は許容 = 従来挙動と同じ無駄撃ちに退化)。
const REFRESH_LOCK_KEY = "issues-page:pr-map:refreshing";
const REFRESH_LOCK_TTL_SECONDS = 60;

interface PrMapCacheEntry {
  storedAt: number;
  patchedAt?: number;
  data: Record<string, IssuePrRef[]>;
  /** webhook patch の直近履歴 (Refs #330)。full refresh は GitHub Search
   *  ベースで、merge 直後の PR は index 未反映のことがある — 取り直した結果で
   *  blob を上書きすると patch したばかりのチップが巻き戻る。refreshPrMap は
   *  fresh 結果を組んだ後にこの履歴 (10 分窓) を再適用する。 */
  recentPatches?: Array<{ key: string; ref: IssuePrRef; at: number }>;
}

// recentPatches の保持窓と上限。窓は GitHub Search index lag の実測上限
// (#311 と同じ 10 分)、上限は CI burst でも entry が肥大しない保険。
const RECENT_PATCH_WINDOW_MS = 10 * 60 * 1000;
const RECENT_PATCH_CAP = 50;

function pruneRecentPatches(
  patches: Array<{ key: string; ref: IssuePrRef; at: number }> | undefined,
  now: number,
): Array<{ key: string; ref: IssuePrRef; at: number }> {
  return (patches ?? [])
    .filter((p) => now - p.at < RECENT_PATCH_WINDOW_MS)
    .slice(-RECENT_PATCH_CAP);
}

export interface PrMapResult {
  map: Map<string, IssuePrRef[]>;
  /** cold start fetch が失敗して何も出せない/古いものしか無い (hard banner)。 */
  stale: boolean;
  /** cache を即返しして refresh を waitUntil に投げた (mild banner)。 */
  refreshing: boolean;
  /** cache が無く背景 fetch 中 (= cold start)。page は loading 表示 +
   *  /issues/decorations poll で部分更新する (Refs #323)。 */
  loading: boolean;
  error: string | null;
}

/** SWR 読み出し: cache があれば常に即返し。stale なら background refresh を
 *  ctx.waitUntil に投げる (reject は必ず pre-catch — 未 catch の reject は
 *  テストの waitOnExecutionContext を fail させる)。cache が全く無い cold
 *  start のみ同期 fetch (従来挙動 = hard banner 維持)。 */
export async function loadPrMap(
  env: AuthClientWorkerEnv,
  mainOrgs: string[],
  yhondaRepos: string[],
  ctx?: ExecutionContext,
): Promise<PrMapResult> {
  const kv = env.CI_STATUS;
  const cached = await kv.get(PR_MAP_CACHE_KEY, "json") as PrMapCacheEntry | null;
  const now = Date.now();
  if (cached) {
    const fresh = now - cached.storedAt < PR_MAP_FRESH_SECONDS * 1000;
    if (!fresh) {
      const p = refreshPrMap(env, mainOrgs, yhondaRepos).catch((err) => {
        console.log(JSON.stringify({
          msg: "pr-map-bg-refresh-failed",
          error: err instanceof Error ? err.message : String(err),
        }));
      });
      if (ctx) ctx.waitUntil(p);
      else void p;
    }
    return {
      map: new Map(Object.entries(cached.data)),
      stale: false,
      refreshing: !fresh,
      loading: false,
      error: null,
    };
  }
  // Cold start: 旧実装は同期 fetch (4 search) でページ全体を塞いでいた。
  // SSR をブロックせず背景 refresh + loading flag を返し、page 側が
  // /issues/decorations を poll して部分更新する (Refs #323)。
  const p = refreshPrMap(env, mainOrgs, yhondaRepos).catch((err) => {
    console.log(JSON.stringify({
      msg: "pr-map-bg-refresh-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  });
  if (ctx) ctx.waitUntil(p);
  else void p;
  return { map: new Map(), stale: false, refreshing: true, loading: true, error: null };
}

/** /issues/decorations 用: cache を KV read だけで返す (GitHub fetch なし)。 */
export async function readPrMapCache(
  kv: KVNamespace,
): Promise<Record<string, IssuePrRef[]> | null> {
  const cached = await kv.get(PR_MAP_CACHE_KEY, "json") as PrMapCacheEntry | null;
  return cached ? cached.data : null;
}

/** full 4-call Search fetch で cache を取り直す (background 実行前提)。
 *  backoff 中 / lock 中 / 既に fresh なら no-op。storedAt は成功時のみ更新
 *  するので、backoff no-op が staleness を複利させることはない。 */
export async function refreshPrMap(
  env: AuthClientWorkerEnv,
  mainOrgs: string[],
  yhondaRepos: string[],
): Promise<void> {
  const kv = env.CI_STATUS;
  if (await getRateLimitBackoff(kv)) return;
  if (await kv.get(REFRESH_LOCK_KEY)) return;
  await kv.put(REFRESH_LOCK_KEY, "1", { expirationTtl: REFRESH_LOCK_TTL_SECONDS });
  // lock 取得後に再読: 並走した refresh が先に完走していたら bail。
  const recheck = await kv.get(PR_MAP_CACHE_KEY, "json") as PrMapCacheEntry | null;
  if (recheck && Date.now() - recheck.storedAt < PR_MAP_FRESH_SECONDS * 1000) return;
  try {
    const fresh = await fetchAllOpenPrsByIssue(env, mainOrgs, yhondaRepos);
    // Search index lag ガード (Refs #330): merge/open 直後の PR は search に
    // まだ載っていないことがある。直近 10 分の webhook patch を fresh 結果に
    // 再適用してから書く (= lag 窓内は patch が full refresh に勝つ)。
    const now = Date.now();
    const recentPatches = pruneRecentPatches(recheck?.recentPatches, now);
    for (const p of recentPatches) {
      const list = (fresh.get(p.key) ?? []).filter(
        (r) => !(r.repo === p.ref.repo && r.number === p.ref.number),
      );
      list.push(p.ref);
      list.sort(sortPrRefs);
      fresh.set(p.key, list);
    }
    const entry: PrMapCacheEntry = {
      storedAt: now,
      data: Object.fromEntries(fresh),
      recentPatches,
    };
    await kv.put(PR_MAP_CACHE_KEY, JSON.stringify(entry), {
      expirationTtl: PR_MAP_STORE_SECONDS,
    });
  } catch (err) {
    if (isRateLimitError(err)) await setRateLimitBackoff(kv, err);
    throw err;
  }
}

// ───── pull_request webhook → pr-map patch ─────

/** webhook.ts の PullRequestPayload と構造互換 (import すると循環するので
 *  ここで最小定義)。title 以下は GitHub の実配信には常に載るが、optional に
 *  して最小 payload (テスト fixture / 将来の field 削減) でも落ちないように
 *  する。 */
export interface PrMapWebhookPayload {
  action: string;
  pull_request: {
    number: number;
    merged: boolean;
    title?: string;
    body?: string | null;
    draft?: boolean;
    html_url?: string;
    updated_at?: string;
  };
  repository: { full_name: string };
}

// title/body/draft/state が変わる action だけ反映する。`synchronize` (push)
// や label / review 系は PR chip の表示内容を変えないので skip。
const PATCH_ACTIONS = new Set([
  "opened",
  "edited",
  "closed",
  "reopened",
  "converted_to_draft",
  "ready_for_review",
]);

/** pull_request event を pr-map cache に反映する。
 *
 *  - cache 不在は no-op (applyIssueCommentEvent と同じ規約 — 空 map に
 *    patch すると次の full fetch まで他 PR が全部隠れる)
 *  - closed && merged → state "merged" で残す (release-close 待ちゾーン)
 *  - closed && !merged → 全 key から除去のみ
 *  - それ以外 → state "open" で extractIssueRefs(title+body) の各 key に配置
 *  - storedAt は触らない (= full refresh の安全網周期を維持)
 */
export async function applyPullRequestEvent(
  kv: KVNamespace,
  payload: PrMapWebhookPayload,
): Promise<void> {
  if (!PATCH_ACTIONS.has(payload.action)) return;
  const cached = await kv.get(PR_MAP_CACHE_KEY, "json") as PrMapCacheEntry | null;
  if (!cached) return;

  const repo = payload.repository.full_name;
  const pr = payload.pull_request;

  // まずこの PR を全 key から除去 (ref の付け替え / close に共通の前処理)。
  const data = cached.data;
  for (const key of Object.keys(data)) {
    const filtered = data[key]!.filter(
      (ref) => !(ref.repo === repo && ref.number === pr.number),
    );
    if (filtered.length === 0) delete data[key];
    else data[key] = filtered;
  }

  // closed-unmerged は除去のみ。title が無い最小 payload も再配置できない
  // ので除去のみ (実配信では title は常に載る)。
  const removeOnly =
    (payload.action === "closed" && !pr.merged) || pr.title === undefined;
  let patchedRef: IssuePrRef | null = null;
  const patchedKeys: string[] = [];
  if (!removeOnly) {
    const state: IssuePrRef["state"] =
      payload.action === "closed" && pr.merged ? "merged" : "open";
    const ref: IssuePrRef = {
      repo,
      number: pr.number,
      title: pr.title!,
      url: pr.html_url ?? `https://github.com/${repo}/pull/${pr.number}`,
      draft: pr.draft ?? false,
      updated_at: pr.updated_at ?? new Date().toISOString(),
      state,
    };
    patchedRef = ref;
    const refs = extractIssueRefs(repo, `${pr.title}\n${pr.body ?? ""}`);
    for (const key of refs) {
      const list = data[key] ?? [];
      list.push(ref);
      list.sort(sortPrRefs);
      data[key] = list;
      patchedKeys.push(key);
    }
  }

  // 直近 patch を記録 (Refs #330)。removeOnly (closed-unmerged) は記録しない —
  // search lag で復活しても最大 10 分チップが残るだけで実害が小さい。
  const now = Date.now();
  const recentPatches = pruneRecentPatches(cached.recentPatches, now);
  if (!removeOnly) {
    for (const key of patchedKeys) {
      recentPatches.push({ key, ref: patchedRef!, at: now });
    }
  }

  const entry: PrMapCacheEntry = {
    storedAt: cached.storedAt,
    patchedAt: now,
    data,
    recentPatches: recentPatches.slice(-RECENT_PATCH_CAP),
  };
  await kv.put(PR_MAP_CACHE_KEY, JSON.stringify(entry), {
    expirationTtl: PR_MAP_STORE_SECONDS,
  });
}

// Test 用に内部定数を公開。production code からは呼ばない。
export const __testing = {
  PR_MAP_FRESH_SECONDS,
  PR_MAP_STORE_SECONDS,
  REFRESH_LOCK_KEY,
};
