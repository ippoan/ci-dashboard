import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import {
  fetchOrgProjects,
  fetchProjectItems,
  type OrgProject,
  type OrgProjectsResult,
  type ProjectItemSummary,
  type ProjectRef,
} from "./mcp/tools/projects";
import {
  getRateLimitBackoff,
  isRateLimitError,
  setRateLimitBackoff,
} from "./github-backoff";

// KV schema (Refs #131, envelope 化は Refs #304):
//   project:org-list:<org>            -> { storedAt, data: OrgProject[] }
//   project:items:<org>:<number>      -> { storedAt, data: ProjectItemSummary[] }
//
// 設計方針:
// - 鮮度 30 分 (FRESH) は envelope の storedAt で判定し、KV 上の値自体は
//   24h (STORE) 残す。旧実装は expirationTtl=30min で値ごと消えるため、
//   「TTL 切れ + GraphQL quota 枯渇」が重なると stale fallback が存在せず
//   生エラーがページに出ていた (Refs #304 — issue 一覧 / PR map と同じ
//   stale-serving に揃える)。
// - fetch 失敗時は stale を返す (stale flag → info バナー)。rate limit は
//   共有 backoff marker (github-backoff.ts) を立てて 5 分間 GraphQL を
//   叩かない。
// - webhook (projects_v2 / projects_v2_item) が届いたら該当 key を delete
//   → 次の SSR hit で refetch。incremental update ではなく invalidation-based
//   (`projects_v2_item.content_node_id` を repo#number に解決するには追加
//   GraphQL が要るので旨味が薄い)。
// - watermark 不要 (cache 全 replace でよい)。

const ORG_LIST_PREFIX = "project:org-list:";
const ITEMS_PREFIX = "project:items:";
const TTL_SECONDS = 30 * 60;
const STORE_TTL_SECONDS = 86400;

interface CacheEnvelope<T> {
  storedAt: number;
  data: T;
}

/** KV から envelope を読む。旧形式 (素の配列、expirationTtl 30min の移行期
 *  データ) は storedAt:0 = 常に stale として包んで返す。 */
async function readEnvelope<T>(kv: KVNamespace, key: string): Promise<CacheEnvelope<T> | null> {
  const raw = await kv.get(key, "json");
  if (raw === null) return null;
  if (Array.isArray(raw)) return { storedAt: 0, data: raw as T };
  return raw as CacheEnvelope<T>;
}

/** fresh → cache 即返し / stale or 無し → fetch、失敗時は stale fallback。
 *  backoff marker 中は GraphQL を叩かず stale (無ければ cooldown error)。 */
async function getWithStaleFallback<T>(
  env: AuthClientWorkerEnv,
  key: string,
  fetcher: () => Promise<T>,
): Promise<{ data: T; stale: boolean }> {
  const kv = env.CI_STATUS;
  const envl = await readEnvelope<T>(kv, key);
  const now = Date.now();
  if (envl && now - envl.storedAt < TTL_SECONDS * 1000) {
    return { data: envl.data, stale: false };
  }
  if (await getRateLimitBackoff(kv)) {
    if (envl) return { data: envl.data, stale: true };
    throw new Error("GitHub rate-limit cooldown — cached project data unavailable");
  }
  try {
    const data = await fetcher();
    await kv.put(key, JSON.stringify({ storedAt: now, data }), {
      expirationTtl: STORE_TTL_SECONDS,
    });
    return { data, stale: false };
  } catch (err) {
    if (isRateLimitError(err)) await setRateLimitBackoff(kv, err);
    if (envl) return { data: envl.data, stale: true };
    throw err;
  }
}

// `/issues` SSR 側の project map cache key。Phase 1 (#129) で導入済み。
// `projects_v2_item` event が来た時に併せて invalidate して /issues 側も
// 同期する (TTL 5min より早く反映される)。
const ISSUES_PAGE_PROJECT_MAP_KEY = "issues-page:project-map";

function orgListKey(org: string): string {
  return `${ORG_LIST_PREFIX}${org}`;
}

function itemsKey(org: string, number: number): string {
  return `${ITEMS_PREFIX}${org}:${number}`;
}

/** per-org の Projects v2 list を staleness 付きで返す (内部用)。 */
async function getOrgProjectsWithMeta(
  env: AuthClientWorkerEnv,
  orgs: string[],
): Promise<{ results: OrgProjectsResult[]; stale: boolean }> {
  let anyStale = false;
  const results = await Promise.all(orgs.map(async (org) => {
    const { data, stale } = await getWithStaleFallback<OrgProject[]>(
      env,
      orgListKey(org),
      async () => {
        const fetched = await fetchOrgProjects(env, { orgs: [org], include_closed: false });
        return fetched[0]?.projects ?? [];
      },
    );
    if (stale) anyStale = true;
    return { org, projects: data };
  }));
  return { results, stale: anyStale };
}

/** 1 つの project の items を staleness 付きで返す (内部用)。 */
async function getProjectItemsWithMeta(
  env: AuthClientWorkerEnv,
  org: string,
  number: number,
): Promise<{ items: ProjectItemSummary[]; stale: boolean }> {
  const { data, stale } = await getWithStaleFallback<ProjectItemSummary[]>(
    env,
    itemsKey(org, number),
    () => fetchProjectItems(env, org, number),
  );
  return { items: data, stale };
}

/** Cache-first で per-org の Projects v2 list を返す。fresh window (30min)
 *  内は API 0 call、stale なら refetch。**fetch 失敗時は stale fallback**
 *  (旧実装は値ごと expire していたため失敗が即エラーになっていた、Refs #304)。 */
export async function getOrFetchOrgProjects(
  env: AuthClientWorkerEnv,
  orgs: string[],
): Promise<OrgProjectsResult[]> {
  return (await getOrgProjectsWithMeta(env, orgs)).results;
}

/** Cache-first で 1 つの project の items を返す。stale fallback は
 *  getOrFetchOrgProjects と同じ。 */
export async function getOrFetchProjectItems(
  env: AuthClientWorkerEnv,
  org: string,
  number: number,
): Promise<ProjectItemSummary[]> {
  return (await getProjectItemsWithMeta(env, org, number)).items;
}

// ───── /issues page 向け project map (Refs #135) ─────

export interface ProjectIssueMapResult {
  map: Map<string, ProjectRef[]>;
  /** いずれかの層 (org list / project items) が fetch 失敗 or backoff で
   *  stale cache を返した。/issues は info バナー「from the last successful
   *  sync」を出す (Refs #304)。 */
  stale: boolean;
  /** いずれかの per-project fetch / org list fetch が失敗した場合の最初の
   *  メッセージ。map は best-effort で部分結果を返す。 */
  error: string | null;
}

/** `/issues` page の `Project 付き` セクション用に `repo#number → ProjectRef[]`
 *  map を返す。`/projects` page と同じ KV cache (`project:org-list:*` /
 *  `project:items:*`) を共有するので、片方を warm にしておくともう片方の
 *  初回ロードが速い。Refs #135 (旧 issues-page:project-map cache の置換)。 */
export async function getOrFetchProjectIssueMap(
  env: AuthClientWorkerEnv,
  orgs: string[],
): Promise<ProjectIssueMapResult> {
  let perOrg: OrgProjectsResult[];
  let anyStale = false;
  try {
    const meta = await getOrgProjectsWithMeta(env, orgs);
    perOrg = meta.results;
    anyStale = meta.stale;
  } catch (err) {
    return {
      map: new Map(),
      stale: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const map = new Map<string, ProjectRef[]>();
  let firstError: string | null = null;

  await Promise.all(
    perOrg.flatMap(({ org, projects }) =>
      projects.map(async (p) => {
        try {
          const { items, stale } = await getProjectItemsWithMeta(env, org, p.number);
          if (stale) anyStale = true;
          for (const item of items) {
            if (item.content.type !== "issue") continue;
            const c = item.content;
            const key = `${c.repo}#${c.number}`;
            const ref: ProjectRef = {
              org, number: p.number, title: p.title, url: p.url,
            };
            const cur = map.get(key);
            if (cur) cur.push(ref);
            else map.set(key, [ref]);
          }
        } catch (err) {
          if (!firstError) {
            firstError = err instanceof Error ? err.message : String(err);
          }
        }
      }),
    ),
  );

  return { map, stale: anyStale, error: firstError };
}

/** 該当 org の board list cache だけ flush。`projects_v2` event 用 (board
 *  の create/close/delete/edit で list そのものが変わる)。 */
export async function invalidateOrgList(kv: KVNamespace, org: string): Promise<void> {
  await kv.delete(orgListKey(org));
}

/** 該当 org の全 project items cache を flush。`projects_v2_item` event 用
 *  (個別 item の add/edit/delete で該当 project の items が変わる)。
 *
 *  本来は project number 単位で精密に消したいが、event payload には
 *  `project_node_id` (global node ID) しか入っておらず number への解決に
 *  追加 GraphQL が要るため over-invalidation を選ぶ。org 当たりの active
 *  project 数は 10 件程度なので影響限定的。 */
export async function invalidateOrgItems(kv: KVNamespace, org: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: `${ITEMS_PREFIX}${org}:`, cursor });
    await Promise.all(page.keys.map((k) => kv.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

/** `/issues` page の project map blob を stale 化する。delete ではなく
 *  storedAt:0 への書き換えにするのは、webhook (projects_v2*) の度に /issues
 *  が loading 状態 (= チップ無し) に戻るのを避けるため — 古いチップを出し
 *  つつ背景 refresh で追い付く (Refs #323)。blob が無ければ no-op。 */
export async function invalidateIssuesPageProjectMap(kv: KVNamespace): Promise<void> {
  const blob = await kv.get(ISSUES_PAGE_PROJECT_MAP_KEY, "json") as ProjectMapBlobEntry | null;
  if (!blob) return;
  await kv.put(
    ISSUES_PAGE_PROJECT_MAP_KEY,
    JSON.stringify({ ...blob, storedAt: 0 }),
    { expirationTtl: PROJECT_MAP_STORE_SECONDS },
  );
}

// ───── /issues page 向け SWR blob (Refs #323) ─────
//
// getOrFetchProjectIssueMap は層別 KV cache (org list 30min + per-board items)
// を持つが、TTL 切れの SSR hit が GraphQL fan-out を**同期で**待っていた
// (実測: /issues 平均 wall 13.8s / p90 35s、CPU 28ms = ほぼ全部この待ち)。
// pr-map-cache と同じ SWR pattern で結合済み map を 1 blob として持ち、
// warm/stale は即返し + 背景 refresh、cold は loading flag で SSR を
// ブロックしない (page 側が /issues/decorations を poll して部分更新する)。

interface ProjectMapBlobEntry {
  storedAt: number;
  data: Record<string, ProjectRef[]>;
}

// Blob 再構築の最短間隔。webhook-primary 化 (Refs #332): projects_v2* event
// が層別 cache + blob を invalidation する (= 変化は即 stale 化される) ため、
// 時間ベースの取り直しは安全網 — 1h で足りる。
const PROJECT_MAP_FRESH_SECONDS = 3600;
const PROJECT_MAP_STORE_SECONDS = 86400;
const PROJECT_MAP_REFRESH_LOCK = "issues-page:project-map:refreshing";
const PROJECT_MAP_REFRESH_LOCK_TTL = 60;

export interface ProjectIssueMapSwrResult {
  map: Map<string, ProjectRef[]>;
  /** blob が無く背景 fetch 中 (= cold start)。page は loading 表示 +
   *  /issues/decorations poll で部分更新する。 */
  loading: boolean;
  /** stale blob を即返しして背景 refresh 中 (mild banner)。 */
  refreshing: boolean;
}

/** SWR 読み出し: blob があれば常に即返し (stale なら背景 refresh)。blob が
 *  無い cold start も同期 fetch せず、背景 refresh + loading flag を返す。 */
export async function loadProjectIssueMapSwr(
  env: AuthClientWorkerEnv,
  orgs: string[],
  ctx?: ExecutionContext,
): Promise<ProjectIssueMapSwrResult> {
  const kv = env.CI_STATUS;
  const blob = await kv.get(ISSUES_PAGE_PROJECT_MAP_KEY, "json") as ProjectMapBlobEntry | null;
  const now = Date.now();
  const kick = () => {
    const p = refreshProjectIssueMapBlob(env, orgs).catch(async (err) => {
      const { noteGitHubAuthBroken } = await import("./github-backoff");
      await noteGitHubAuthBroken(env.CI_STATUS, err);
      console.log(JSON.stringify({
        msg: "project-map-bg-refresh-failed",
        error: err instanceof Error ? err.message : String(err),
      }));
    });
    if (ctx) ctx.waitUntil(p);
    else void p;
  };

  if (blob) {
    const fresh = now - blob.storedAt < PROJECT_MAP_FRESH_SECONDS * 1000;
    if (!fresh) kick();
    return {
      map: new Map(Object.entries(blob.data)),
      loading: false,
      refreshing: !fresh,
    };
  }
  kick();
  return { map: new Map(), loading: true, refreshing: true };
}

/** blob を取り直す (背景実行前提)。層別 cache 持ちの
 *  getOrFetchProjectIssueMap に委譲するので、warm な層は GraphQL 0 call。
 *  backoff / lock / 既に fresh なら no-op。 */
export async function refreshProjectIssueMapBlob(
  env: AuthClientWorkerEnv,
  orgs: string[],
): Promise<void> {
  const kv = env.CI_STATUS;
  if (await getRateLimitBackoff(kv)) return;
  if (await kv.get(PROJECT_MAP_REFRESH_LOCK)) return;
  await kv.put(PROJECT_MAP_REFRESH_LOCK, "1", { expirationTtl: PROJECT_MAP_REFRESH_LOCK_TTL });
  const recheck = await kv.get(ISSUES_PAGE_PROJECT_MAP_KEY, "json") as ProjectMapBlobEntry | null;
  if (recheck && Date.now() - recheck.storedAt < PROJECT_MAP_FRESH_SECONDS * 1000) return;

  const res = await getOrFetchProjectIssueMap(env, orgs);
  const entry: ProjectMapBlobEntry = {
    storedAt: Date.now(),
    data: Object.fromEntries(res.map),
  };
  await kv.put(ISSUES_PAGE_PROJECT_MAP_KEY, JSON.stringify(entry), {
    expirationTtl: PROJECT_MAP_STORE_SECONDS,
  });
}

/** /issues/decorations 用: blob を KV read だけで返す (GitHub fetch なし)。 */
export async function readProjectIssueMapBlob(
  kv: KVNamespace,
): Promise<Record<string, ProjectRef[]> | null> {
  const blob = await kv.get(ISSUES_PAGE_PROJECT_MAP_KEY, "json") as ProjectMapBlobEntry | null;
  return blob ? blob.data : null;
}

// ───── Webhook payload types ─────

export interface ProjectsV2WebhookPayload {
  action: string;
  projects_v2: {
    id: number;
    node_id: string;
    owner?: { login: string };
  };
  organization?: { login: string };
}

export interface ProjectsV2ItemWebhookPayload {
  action: string;
  projects_v2_item: {
    id: number;
    node_id: string;
    project_node_id: string;
    content_node_id: string;
    content_type: "Issue" | "PullRequest" | "DraftIssue";
  };
  organization?: { login: string };
}

/** `projects_v2` event 適用。board level (create/close/delete/edit/reopened)
 *  なので list と items 両方を flush。 */
export async function applyProjectsV2Event(
  kv: KVNamespace,
  p: ProjectsV2WebhookPayload,
): Promise<void> {
  const org = p.organization?.login ?? p.projects_v2.owner?.login;
  if (!org) return;
  await invalidateOrgList(kv, org);
  await invalidateOrgItems(kv, org);
  await invalidateIssuesPageProjectMap(kv);
}

/** `projects_v2_item` event 適用。item の add/edit/delete/archive/reorder
 *  で該当 project の items が変わる。list 自体は変わらないので list cache
 *  は保つ。issues-page project map も items 変化で stale になるので併せて
 *  flush。 */
export async function applyProjectsV2ItemEvent(
  kv: KVNamespace,
  p: ProjectsV2ItemWebhookPayload,
): Promise<void> {
  const org = p.organization?.login;
  if (!org) return;
  await invalidateOrgItems(kv, org);
  await invalidateIssuesPageProjectMap(kv);
}

export const __testing = {
  ORG_LIST_PREFIX,
  ITEMS_PREFIX,
  TTL_SECONDS,
  STORE_TTL_SECONDS,
  ISSUES_PAGE_PROJECT_MAP_KEY,
  PROJECT_MAP_FRESH_SECONDS,
  PROJECT_MAP_REFRESH_LOCK,
  orgListKey,
  itemsKey,
};
