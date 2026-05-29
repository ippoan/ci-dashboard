/**
 * 監視対象 repo の「リリース状況」算出 (Release Wave ページの Repo 状況 section 用)。
 *
 * 各 repo について以下を求める:
 *   - latestTag    : 最新 semver tag (無ければ null = 未tag)
 *   - hasTag       : tag が 1 つでもあるか
 *   - behind       : 最新 tag から default branch HEAD までの commit 数
 *                    (= まだ release されていない変更量)。-1 は取得失敗。
 *   - tagless      : TAGLESS_REPOS 指定の repo か (tag を打たない方針)
 *
 * repo 一覧の出所は /releases と同じ 3 ソース (Hub status / direct-push
 * allowlist / TAGLESS_REPOS) に加え、Compatibility (all consumers) グラフに出る
 * repo (compat KV の backend + frontend) も含める。後者を足すのは、compat グラフ
 * にしか出ない consumer frontend (例: nuxt-notify。ci-dashboard 宛の CI webhook を
 * 出さず allowlist/tagless でもない) を取りこぼさないため。tag / compare /
 * repo-meta の GitHub 呼び出しは release-cache の KV キャッシュ層を共用するので
 * /releases と同じ rcache: entry を再利用する (二重 fetch にならない)。
 */

import type { Env } from "../index";
import { parseRepo, tokenForOrg } from "../github-api";
import { cachedTags, cachedCompare, cachedRepoMeta } from "../release-cache";
import { loadDirectPushAllowlist } from "../direct-push-allowlist";
import { parseTaglessRepos } from "../tagless-repos";
import { sortSemverDesc } from "../release-helpers";
import { computeGlobalCompatibility } from "./compat";

export interface RepoReleaseStatus {
  repo: string;
  latestTag: string | null;
  /** tag が 1 つでも存在するか (false = 未tag = main しか無い)。 */
  hasTag: boolean;
  /** 最新 tag から default branch HEAD までの commit 数。-1 = 取得失敗。 */
  behind: number;
  /** TAGLESS_REPOS 指定 (tag を打たない方針の repo)。 */
  tagless: boolean;
}

/** 監視対象 repo の集合と tagless set を 4 ソースから組む。 */
async function discoverRepos(
  env: Env,
): Promise<{ repos: string[]; tagless: Set<string> }> {
  const watched = new Set<string>();

  // (a) Hub status cache — これまで CI run を 1 度でも起こした repo。
  try {
    const hubId = env.CI_HUB.idFromName("singleton");
    const hub = env.CI_HUB.get(hubId);
    const res = await hub.fetch(new Request("http://hub/statuses"));
    if (res.ok) {
      const statuses = await res.json<Array<{ repo: string }>>();
      for (const s of statuses) watched.add(s.repo);
    }
  } catch {
    // Hub 不在 → 他ソースに委ねる
  }

  // (b) direct-push-OK allowlist。
  try {
    for (const r of await loadDirectPushAllowlist(env, env.CI_STATUS)) {
      watched.add(r);
    }
  } catch {
    // allowlist 取得失敗 → 既存挙動を壊さず空のまま
  }

  // (c) TAGLESS_REPOS wrangler var。
  const tagless = parseTaglessRepos(env.TAGLESS_REPOS);
  for (const r of tagless) watched.add(r);

  // (d) Compatibility (all consumers) グラフに出る repo (backend + frontend)。
  // compat グラフにしか出ない consumer frontend (nuxt-notify 等) を取りこぼさない。
  if (env.COMPAT_KV) {
    try {
      const compat = await computeGlobalCompatibility(env.COMPAT_KV);
      for (const b of compat.backends) {
        watched.add(b.backend_repo);
        for (const m of b.matrix) watched.add(m.frontend);
      }
    } catch {
      // compat 取得失敗 → 他ソースに委ねる
    }
  }

  return { repos: [...watched].sort(), tagless };
}

/** 1 repo のリリース状況を算出。archived repo は null (= 一覧から除外)。 */
async function computeOne(
  env: Env,
  repo: string,
  taglessSet: Set<string>,
): Promise<RepoReleaseStatus | null> {
  const { owner, repo: name } = parseRepo(repo);
  const full = `${owner}/${name}`;
  const tagless = taglessSet.has(repo) || taglessSet.has(full);

  let token: string;
  try {
    token = await tokenForOrg(env, owner);
  } catch {
    return { repo: full, latestTag: null, hasTag: false, behind: -1, tagless };
  }

  // archived repo は /releases と同様に一覧から外す (release も cut されない)。
  try {
    const meta = await cachedRepoMeta(token, env.CI_STATUS, owner, name);
    if (meta.archived === true) return null;

    const tags = await cachedTags(token, env.CI_STATUS, owner, name, 10);
    const sorted = sortSemverDesc(tags.map((t) => t.name));
    const latestTag = sorted[0] ?? null;
    if (!latestTag) {
      return { repo: full, latestTag: null, hasTag: false, behind: 0, tagless };
    }

    // 最新 tag → default branch の compare で未 release commit 数を数える。
    let behind = 0;
    try {
      const cmp = await cachedCompare(
        token,
        env.CI_STATUS,
        owner,
        name,
        latestTag,
        meta.default_branch,
      );
      behind = cmp.commits.length;
    } catch {
      behind = 0; // compare 失敗時は behind 不明 → 0 扱い (release は促さない)
    }
    return { repo: full, latestTag, hasTag: true, behind, tagless };
  } catch {
    return { repo: full, latestTag: null, hasTag: false, behind: -1, tagless };
  }
}

/** 全監視対象 repo のリリース状況を repo 名昇順で返す。 */
export async function getRepoReleaseStatuses(
  env: Env,
): Promise<RepoReleaseStatus[]> {
  const { repos, tagless } = await discoverRepos(env);
  const results = await Promise.all(
    repos.map((r) => computeOne(env, r, tagless)),
  );
  return results.filter((r): r is RepoReleaseStatus => r !== null);
}
