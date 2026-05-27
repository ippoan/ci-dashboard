import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import {
  fetchOrgProjects,
  fetchProjectItems,
  type OrgProject,
  type OrgProjectsResult,
  type ProjectItemSummary,
  type ProjectRef,
} from "./mcp/tools/projects";

// KV schema (Refs #131):
//   project:org-list:<org>            -> OrgProject[]
//   project:items:<org>:<number>      -> ProjectItemSummary[]
//
// 設計方針:
// - TTL 30 分。webhook (projects_v2 / projects_v2_item) が届いたら該当
//   key を delete → 次の SSR hit で refetch。incremental update ではなく
//   invalidation-based (`projects_v2_item.content_node_id` を repo#number に
//   解決するには追加 GraphQL が要るので旨味が薄い)。
// - watermark 不要 (cache 全 replace でよい)。

const ORG_LIST_PREFIX = "project:org-list:";
const ITEMS_PREFIX = "project:items:";
const TTL_SECONDS = 30 * 60;

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

/** Cache-first で per-org の Projects v2 list を返す。miss なら GraphQL に
 *  当てて KV に書き込む。orgs 並列で取りに行く。 */
export async function getOrFetchOrgProjects(
  env: AuthClientWorkerEnv,
  orgs: string[],
): Promise<OrgProjectsResult[]> {
  const kv = env.CI_STATUS;
  return Promise.all(orgs.map(async (org) => {
    const cached = await kv.get(orgListKey(org), "json") as OrgProject[] | null;
    if (cached) return { org, projects: cached };
    const fetched = await fetchOrgProjects(env, { orgs: [org], include_closed: false });
    const list = fetched[0]?.projects ?? [];
    await kv.put(orgListKey(org), JSON.stringify(list), { expirationTtl: TTL_SECONDS });
    return { org, projects: list };
  }));
}

/** Cache-first で 1 つの project の items を返す。miss なら fetch + 保存。 */
export async function getOrFetchProjectItems(
  env: AuthClientWorkerEnv,
  org: string,
  number: number,
): Promise<ProjectItemSummary[]> {
  const kv = env.CI_STATUS;
  const cached = await kv.get(itemsKey(org, number), "json") as ProjectItemSummary[] | null;
  if (cached) return cached;
  const items = await fetchProjectItems(env, org, number);
  await kv.put(itemsKey(org, number), JSON.stringify(items), { expirationTtl: TTL_SECONDS });
  return items;
}

// ───── /issues page 向け project map (Refs #135) ─────

export interface ProjectIssueMapResult {
  map: Map<string, ProjectRef[]>;
  /** True if the result is from cache because fresh fetch failed. 本実装は
   *  cache 層が個別に TTL 管理するため常に false。元の loadProjectMap API と
   *  互換性を保つために残してある。 */
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
  try {
    perOrg = await getOrFetchOrgProjects(env, orgs);
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
          const items = await getOrFetchProjectItems(env, org, p.number);
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

  return { map, stale: false, error: firstError };
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

/** `/issues` page の project map cache (Phase 1 で既存) を flush。
 *  `projects_v2_item` event でカードが移動した時、/issues 側の 5min TTL を
 *  待たずに即反映するために併せて呼ぶ。 */
export async function invalidateIssuesPageProjectMap(kv: KVNamespace): Promise<void> {
  await kv.delete(ISSUES_PAGE_PROJECT_MAP_KEY);
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
  ISSUES_PAGE_PROJECT_MAP_KEY,
  orgListKey,
  itemsKey,
};
