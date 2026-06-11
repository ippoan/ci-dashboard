import type { OrgIssue, FetchOrgIssuesParams } from "./mcp/tools/issues";
import { fetchOrgIssues } from "./mcp/tools/issues";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import {
  getRateLimitBackoff,
  isRateLimitError,
  setRateLimitBackoff,
  clearGitHubAuthBroken,
} from "./github-backoff";

// KV schema:
//   issue:<owner>/<name>#<number>  -> OrgIssue JSON   (open issues only;
//                                                      closed → delete)
//   issues:watermark               -> ISO timestamp   (last successful
//                                                      list-since reconcile)
//
// 設計方針 (Refs #129):
// - SSR は KV から read のみ。reconcile は watermark が古い時だけ走り、その時
//   GitHub の現在の open 集合を full snapshot で取り直して KV を一致させる。
// - Webhook (issues / issue_comment) は個別 issue を patch するが watermark
//   は触らない。watermark の意味は「ここまでは full snapshot が確実に拾った」。
//   webhook 配信ミスは次の reconcile の full snapshot が必ず救う。

const KEY_WATERMARK = "issues:watermark";
const KEY_PREFIX = "issue:";

// Reconcile (Search full snapshot) の最短間隔。webhook-primary 化 (Refs #332):
// リアルタイム反映は webhook (queue + retry #320) + WS reload が担うため、
// Search は「webhook 欠落の healing」専用の安全網 — 1h に 1 回で足りる。
// 旧値 60s は WS 自動 reload (#322/#327) と組み合わさると reload のたびに
// full snapshot が走り、rate limit の構造要因になっていた (Refs #329)。
// issues-page のバナー (「裏で更新中」判定) からも参照するため export。
export const FRESH_THRESHOLD_MS = 60 * 60 * 1000;

// Watermark は `now - SAFETY_WINDOW_MS` でセット。full snapshot 方式では
// delta query が無いので overlap の意味は無く、次 reconcile の fresh 判定を
// 5s ぶん早く解除する保険として残す (= 連続アクセス時の取りこぼし余地を縮める)。
const SAFETY_WINDOW_MS = 5 * 1000;

// SWR 化 (Refs #304) で background reconcile が並走し得るため、fetch+write
// 区間を soft lock で重複排除する。KV expirationTtl の最小値 60s に合わせる。
// best-effort: cross-colo の重複は許容 (= 従来挙動の無駄撃ちに退化するだけ)。
const RECONCILE_LOCK_KEY = "issues:reconciling";
const RECONCILE_LOCK_TTL_SECONDS = 60;

// Evict の search-index-lag ガード (Refs #311)。reconcile の full snapshot は
// GitHub Search ベースで、作成・更新直後の issue は index 未反映のことがある
// (`incomplete_results` は timeout 指標で index lag では立たない)。webhook が
// KV に upsert した直後の entry を「snapshot に居ない」だけで evict すると、
// open issue が /issues から一時的に消える (2026-06-11 nuxt-trouble#138 で実害)。
// 直近 EVICT_GRACE_MS 以内に更新された entry は evict 対象から除外する。
// closed への遷移は webhook の delete が即時反映するので、この猶予で stale が
// 残るのは「close webhook も配信ミスした」場合の最大 10 分のみ。
export const EVICT_GRACE_MS = 10 * 60 * 1000;

export function issueKey(repo: string, number: number): string {
  return `${KEY_PREFIX}${repo}#${number}`;
}

/** /issues バナー表示用: 最後に full snapshot が成功した時刻 (ISO 文字列)。 */
export async function getIssuesWatermark(kv: KVNamespace): Promise<string | null> {
  return kv.get(KEY_WATERMARK);
}

/** Webhook 経路から呼ぶ単一 issue 反映。open → put / closed → delete。
 *  watermark は意図的に touch しない (上記設計方針参照)。 */
export async function upsertIssue(
  kv: KVNamespace,
  issue: OrgIssue,
): Promise<void> {
  const key = issueKey(issue.repo, issue.number);
  if (issue.state === "open") {
    await kv.put(key, JSON.stringify(issue));
  } else {
    await kv.delete(key);
  }
}

/** Cache 上の全 open issue を返す。KV.list で prefix 走査。現状 issue 数
 *  数百のオーダーなので 1-2 page で完了する。 */
export async function listCachedOpenIssues(kv: KVNamespace): Promise<OrgIssue[]> {
  const out: OrgIssue[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: KEY_PREFIX, cursor });
    const vals = await Promise.all(
      page.keys.map((k) => kv.get(k.name, "json") as Promise<OrgIssue | null>),
    );
    for (const v of vals) if (v) out.push(v);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export interface ReconcileParams {
  mainOrgs: string[];
  yhondaRepos: string[];
}

export interface ReconcileResult {
  /** Number of issues touched by this reconcile. 0 if cache was fresh. */
  patched: number;
  /** Whether we actually hit GitHub. false = within FRESH_THRESHOLD_MS. */
  fetched: boolean;
  /** Stale entries evicted (open in KV but no longer in GitHub's open set).
   *  0 when the snapshot was incomplete (eviction skipped) or fresh window hit. */
  removed: number;
}

/** GitHub の現在の open 集合を full snapshot で取得し、KV をそれに一致させる。
 *  fresh window 内なら no-op。auth error 等はそのまま throw。
 *
 *  旧実装は初回 cold start (state:open) の後ずっと `state:all + updated:>=`
 *  の warm delta しか走らせなかったため、per_page:100 truncation や KV write
 *  欠落で一度漏れた open issue を二度と復活できず、特定 repo の section が
 *  丸ごと消えていた (= MCP の list_org_issues は直叩きで全件見えるのに /issues
 *  だけ欠ける非対称)。毎回 state:open を引き直し「KV にあるが GitHub の open
 *  集合に無い entry」を削除すれば、漏れも stale も構造的に起きない。SSR は
 *  従来どおり KV read のみなので高速性は維持される (Refs #129)。 */
export async function reconcileIssues(
  env: AuthClientWorkerEnv,
  params: ReconcileParams,
): Promise<ReconcileResult> {
  const kv = env.CI_STATUS;
  const watermark = await kv.get(KEY_WATERMARK);
  const now = Date.now();
  if (watermark && now - Date.parse(watermark) < FRESH_THRESHOLD_MS) {
    return { patched: 0, fetched: false, removed: 0 };
  }

  // Rate-limit backoff 中は GitHub を叩かない (Refs #304)。watermark を
  // 書かないので、marker (TTL 300s) が切れた後の最初のリクエストで即
  // refresh が走る = staleness は複利しない。
  if (await getRateLimitBackoff(kv)) {
    return { patched: 0, fetched: false, removed: 0 };
  }

  // Background reconcile の重複排除 (best-effort soft lock)。watermark は
  // 成功時にしか進まないため、SWR で並んだ N リクエストが全部 fetch する
  // のを防ぐ。
  if (await kv.get(RECONCILE_LOCK_KEY)) {
    return { patched: 0, fetched: false, removed: 0 };
  }
  await kv.put(RECONCILE_LOCK_KEY, "1", {
    expirationTtl: RECONCILE_LOCK_TTL_SECONDS,
  });

  // 2-query pattern: GitHub search は org: と repo: を混ぜると repo: 側を黙って
  // drop するので、yhonda-ohishi の特定 repo だけ別 query に分離する
  // (mcp/tools/issues.ts 参照)。両方とも state:open の full snapshot。
  const mainParams: FetchOrgIssuesParams = {
    orgs: params.mainOrgs,
    state: "open",
    per_page: 100,
  };
  const yhondaParams: FetchOrgIssuesParams = {
    orgs: ["yhonda-ohishi"],
    state: "open",
    per_page: 100,
    query: params.yhondaRepos.map((r) => `repo:${r}`).join(" "),
  };

  let main: Awaited<ReturnType<typeof fetchOrgIssues>>;
  let yhonda: Awaited<ReturnType<typeof fetchOrgIssues>>;
  try {
    [main, yhonda] = await Promise.all([
      fetchOrgIssues(env, mainParams),
      fetchOrgIssues(env, yhondaParams),
    ]);
  } catch (err) {
    if (isRateLimitError(err)) await setRateLimitBackoff(kv, err);
    throw err;
  }

  const fresh = [...main.items, ...yhonda.items];
  const freshKeys = new Set(fresh.map((i) => issueKey(i.repo, i.number)));

  // GitHub search が truncate された (incomplete_results) snapshot は不完全
  // なので削除を skip する (= まだ open な issue を誤って evict しない)。upsert
  // は常に安全。yhonda は repo: pin で件数が小さく truncate しないが、main は
  // 将来 open が 100 超になり得るのでガードする。100 を恒常的に超えたら
  // per_page pagination を入れる (現状 ippoan+ohishi-exp は ~70 件)。
  const complete = !main.incomplete && !yhonda.incomplete;
  let removed = 0;
  if (complete) {
    const existing = await listCachedOpenIssues(kv);
    for (const e of existing) {
      if (!freshKeys.has(issueKey(e.repo, e.number))) {
        // Search index lag ガード (Refs #311): 直近に作成/更新された entry は
        // index がまだ追い付いていないだけの可能性があるので残す。updated_at
        // が parse 不能 (NaN) な entry は従来どおり evict する。
        const updatedMs = Date.parse(e.updated_at);
        if (Number.isFinite(updatedMs) && now - updatedMs < EVICT_GRACE_MS) {
          continue;
        }
        await kv.delete(issueKey(e.repo, e.number));
        removed++;
      }
    }
  }

  for (const issue of fresh) {
    await kv.put(issueKey(issue.repo, issue.number), JSON.stringify(issue));
  }

  const newWm = new Date(now - SAFETY_WINDOW_MS).toISOString();
  await kv.put(KEY_WATERMARK, newWm);
  // token 取得が成功した = 認証は生きている。失効 banner を自動回復 (Refs #334)。
  await clearGitHubAuthBroken(kv);

  return { patched: fresh.length, fetched: true, removed };
}

// ───── Webhook payload → OrgIssue 正規化 ─────

export interface IssueWebhookPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    state: "open" | "closed";
    user: { login: string } | null;
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;
    comments: number;
    created_at: string;
    updated_at: string;
    html_url: string;
  };
  repository: { full_name: string };
}

export function webhookIssueToOrgIssue(p: IssueWebhookPayload): OrgIssue {
  return {
    repo: p.repository.full_name,
    number: p.issue.number,
    title: p.issue.title,
    state: p.issue.state,
    author: p.issue.user?.login ?? "",
    labels: p.issue.labels.map((l) => l.name),
    assignees: p.issue.assignees.map((a) => a.login),
    comments: p.issue.comments,
    created_at: p.issue.created_at,
    updated_at: p.issue.updated_at,
    url: p.issue.html_url,
  };
}

export interface IssueCommentWebhookPayload {
  action: "created" | "edited" | "deleted";
  issue: { number: number };
  repository: { full_name: string };
}

/** issue_comment event を反映。comment 数だけ inc/dec する。`edited` は
 *  comment 数を変えないので skip。cache miss (該当 issue が KV に居ない)
 *  は no-op — どうせ次の reconcile delta で full record が来る。 */
export async function applyIssueCommentEvent(
  kv: KVNamespace,
  p: IssueCommentWebhookPayload,
): Promise<void> {
  if (p.action === "edited") return;
  const key = issueKey(p.repository.full_name, p.issue.number);
  const existing = await kv.get(key, "json") as OrgIssue | null;
  if (!existing) return;
  existing.comments += p.action === "created" ? 1 : -1;
  if (existing.comments < 0) existing.comments = 0;
  existing.updated_at = new Date().toISOString();
  await kv.put(key, JSON.stringify(existing));
}

// Test 用に内部定数を公開。production code からは呼ばない。
export const __testing = {
  KEY_WATERMARK,
  KEY_PREFIX,
  FRESH_THRESHOLD_MS,
  SAFETY_WINDOW_MS,
  RECONCILE_LOCK_KEY,
};
