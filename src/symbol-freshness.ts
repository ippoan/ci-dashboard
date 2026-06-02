// cross-repo symbol index — 鮮度比較 (skills/map staleness)。
//
// D1 の repos.src_hash (= generator が index した時の tree hash) と、各 repo の
// **現在の default branch の root tree hash** を比べ、ズレている repo を返す。
// ズレ = index/derived skill が repo より古い ＝ stale。
//
// 設計: ippoan/claude-skills の cross-repo-symbol-index skill。
// hook (claude-hooks) がこの endpoint を叩いて Claude に警告する想定。
// 値 (tree hash) は機微でないので read は open。

import { githubApi, parseRepo, tokenForOrg } from "./github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { readRepos, isStale, readRepoHead, type D1Like } from "./symbol-index";

type FreshnessEnv = AuthClientWorkerEnv & { SYMBOL_INDEX?: D1Database };

interface CommitListItem {
  commit: { tree: { sha: string } };
}

export interface FreshnessRow {
  repo: string;
  indexed_src_hash: string | null;
  current_tree_sha: string | null;
  stale: boolean;
  indexed_at: number | null;
}

/**
 * D1 の各 repo について現在の tree hash を取得して baseline と比較する。
 * current 取得失敗 (削除/権限/ネットワーク) の repo は current=null・stale=false
 * (= 判定不能を stale に倒さない)。
 */
export async function computeFreshness(
  db: D1Like,
  fetchCurrentTreeSha: (repo: string) => Promise<string | null>,
): Promise<FreshnessRow[]> {
  const repos = await readRepos(db);
  const rows: FreshnessRow[] = [];
  for (const r of repos) {
    let current: string | null = null;
    try {
      current = await fetchCurrentTreeSha(r.repo);
    } catch {
      current = null;
    }
    rows.push({
      repo: r.repo,
      indexed_src_hash: r.src_hash,
      current_tree_sha: current,
      stale: isStale(r.src_hash, current),
      indexed_at: r.updated_at,
    });
  }
  return rows;
}

/** GitHub API で repo の default branch 最新 commit の root tree sha を取る。 */
async function currentTreeShaFromGitHub(
  env: AuthClientWorkerEnv,
  repo: string,
): Promise<string | null> {
  const { owner, repo: name } = parseRepo(repo);
  const token = await tokenForOrg(env, owner);
  const data = await githubApi<CommitListItem[]>(
    token, "GET", `/repos/${owner}/${name}/commits`, undefined, { per_page: "1" },
  );
  return data[0]?.commit?.tree?.sha ?? null;
}

/** GET /symbol-index/freshness の handler。 */
export async function handleFreshness(_request: Request, env: FreshnessEnv): Promise<Response> {
  if (!env.SYMBOL_INDEX) {
    return json(503, { error: "SYMBOL_INDEX (D1) is not bound" });
  }
  const rows = await computeFreshness(env.SYMBOL_INDEX, (repo) =>
    currentTreeShaFromGitHub(env, repo),
  );
  const stale = rows.filter((r) => r.stale);
  return json(200, {
    total: rows.length,
    stale_count: stale.length,
    stale: stale.map((r) => r.repo),
    repos: rows,
  });
}

/**
 * GET /symbol-index/head/:repo の handler。generator が incremental 差分の
 * 基点 (前回 index した head_sha) を取るための read。未 index は head_sha=null
 * → generator はフルスキャンに倒す。
 */
export async function handleRepoHead(repo: string, env: FreshnessEnv): Promise<Response> {
  if (!env.SYMBOL_INDEX) return json(503, { error: "SYMBOL_INDEX (D1) is not bound" });
  if (!repo) return json(400, { error: "repo is required" });
  const row = await readRepoHead(env.SYMBOL_INDEX, repo);
  return json(200, { repo, head_sha: row?.head_sha ?? null, src_hash: row?.src_hash ?? null });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
