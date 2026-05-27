// KV-backed cache for the GitHub fan-out behind /releases.
//
// Background: /releases (both the index and the per-tag detail view) runs N×M
// GitHub REST calls per page load — tags / compare ranges / per-issue lookups
// for every watched repo. None of that was cached, so each refresh paid the
// full round-trip cost. This module wraps the calls that releases-page.ts and
// release-alert.ts make so the second-and-later loads hit KV instead of the
// GitHub API.
//
// TTL strategy (key invariant: the cache is best-effort, never authoritative):
//   - `tags`        300 s   — new tags appear, but a 5-min lag at release time
//                              is fine for a confirmation UI.
//   - `compare`     24 h    — once both endpoints exist as tags, the diff is
//                              immutable. Long TTL is safe.
//   - `commits`     60 s    — synthetic-block HEAD listing; HEAD moves often.
//   - `repo-meta`   1 h     — default_branch rarely changes.
//   - `pr`          24 h    — body / head.ref are frozen after merge (we only
//                              look up PRs that came in from a compare commit).
//   - `issue`       60 s    — state changes any time; close paths actively
//                              invalidate via `invalidateIssue`.
//
// All keys live under `rcache:v1:` so a schema bump (new key shape, TTL change
// that needs a flush) is a 1-line rename. Tests should `clearReleaseCache` in
// afterEach to keep KV pollution from leaking across fixtures.

import { githubApi } from "./github-api";

const PREFIX = "rcache:v1:";

const TTL_TAGS = 300;
const TTL_COMPARE = 86400;
const TTL_COMMITS = 60;
const TTL_REPO_META = 3600;
const TTL_PR = 86400;
const TTL_ISSUE = 60;

// Minimum KV expirationTtl is 60s; everything above respects that.

interface TagListItem { name: string; commit: { sha: string } }
interface RawCommit { sha: string; commit: { message: string } }
interface CompareResponse { commits: RawCommit[] }
interface PrResponse { head: { ref: string }; body: string | null }
interface RepoMeta { default_branch: string }
export interface RawIssue {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  html_url: string;
  updated_at: string;
  pull_request?: unknown;
}

// Generic wrapper. `kv` is optional so unit tests (and the no-binding path)
// fall through directly to the loader.
async function kvCached<T>(
  kv: KVNamespace | undefined,
  key: string,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (!kv) return loader();
  const cached = await kv.get<T>(key, "json");
  if (cached !== null && cached !== undefined) return cached;
  const fresh = await loader();
  // Fire-and-forget the write; freshness already in hand.
  await kv.put(key, JSON.stringify(fresh), { expirationTtl: ttlSec });
  return fresh;
}

export async function cachedTags(
  token: string,
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
  perPage: number,
): Promise<TagListItem[]> {
  const key = `${PREFIX}tags:${owner}/${name}:${perPage}`;
  return kvCached(kv, key, TTL_TAGS, () =>
    githubApi<TagListItem[]>(
      token, "GET", `/repos/${owner}/${name}/tags`, undefined,
      { per_page: String(perPage) },
    ),
  );
}

export async function cachedCompare(
  token: string,
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
  prev: string,
  curr: string,
): Promise<CompareResponse> {
  const key = `${PREFIX}cmp:${owner}/${name}:${prev}..${curr}`;
  return kvCached(kv, key, TTL_COMPARE, () =>
    githubApi<CompareResponse>(
      token, "GET", `/repos/${owner}/${name}/compare/${prev}...${curr}`,
    ),
  );
}

export async function cachedCommits(
  token: string,
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
  sha: string,
  perPage: number,
): Promise<RawCommit[]> {
  const key = `${PREFIX}commits:${owner}/${name}:${sha}:${perPage}`;
  return kvCached(kv, key, TTL_COMMITS, () =>
    githubApi<RawCommit[]>(
      token, "GET", `/repos/${owner}/${name}/commits`, undefined,
      { sha, per_page: String(perPage) },
    ),
  );
}

export async function cachedRepoMeta(
  token: string,
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
): Promise<RepoMeta> {
  const key = `${PREFIX}repo:${owner}/${name}`;
  return kvCached(kv, key, TTL_REPO_META, () =>
    githubApi<RepoMeta>(token, "GET", `/repos/${owner}/${name}`),
  );
}

export async function cachedPullRequest(
  token: string,
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
  n: number,
): Promise<PrResponse> {
  const key = `${PREFIX}pr:${owner}/${name}:${n}`;
  return kvCached(kv, key, TTL_PR, () =>
    githubApi<PrResponse>(token, "GET", `/repos/${owner}/${name}/pulls/${n}`),
  );
}

// Tagless-repo PR-merge detection walks every commit in a merged PR to harvest
// `Refs #N` from squash / rebase / merge variants. Same TTL as cachedPullRequest
// — once the PR is merged the commit list is frozen.
export async function cachedPullRequestCommits(
  token: string,
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
  n: number,
): Promise<RawCommit[]> {
  const key = `${PREFIX}prcommits:${owner}/${name}:${n}`;
  return kvCached(kv, key, TTL_PR, () =>
    githubApi<RawCommit[]>(
      token, "GET", `/repos/${owner}/${name}/pulls/${n}/commits`,
      undefined,
      { per_page: "100" },
    ),
  );
}

export async function cachedIssue(
  token: string,
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
  n: number,
): Promise<RawIssue> {
  const key = `${PREFIX}issue:${owner}/${name}:${n}`;
  return kvCached(kv, key, TTL_ISSUE, () =>
    githubApi<RawIssue>(token, "GET", `/repos/${owner}/${name}/issues/${n}`),
  );
}

// Drop the cached issue snapshot so a close roundtrip immediately reflects on
// the next /releases load instead of showing the still-open row for 60 s.
export async function invalidateIssue(
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
  n: number,
): Promise<void> {
  if (!kv) return;
  await kv.delete(`${PREFIX}issue:${owner}/${name}:${n}`);
}

// Phase 3 (Refs #133): webhook 駆動 invalidation の helper 群。`release` /
// `push` (tag) / `push` (default branch) event を受け取った時に該当 repo の
// 関連 cache を一括 flush する。TTL (300s / 60s) は据え置き、これら helper
// は freshness 向上のための追加レイヤー。

async function invalidateRepoPrefix(
  kv: KVNamespace | undefined,
  prefix: string,
): Promise<void> {
  if (!kv) return;
  let cursor: string | undefined;
  do {
    const list = await kv.list({ prefix, cursor });
    await Promise.all(list.keys.map((k) => kv.delete(k.name)));
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

/** 該当 repo の tag list cache を flush。`release` event / tag push 時に呼ぶ。 */
export async function invalidateRepoTags(
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
): Promise<void> {
  await invalidateRepoPrefix(kv, `${PREFIX}tags:${owner}/${name}:`);
}

/** 該当 repo の commits cache (synthetic-block 用 HEAD listing) を flush。
 *  default branch への push 時に呼ぶ。 */
export async function invalidateRepoCommits(
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
): Promise<void> {
  await invalidateRepoPrefix(kv, `${PREFIX}commits:${owner}/${name}:`);
}

/** 該当 repo の repo-meta (default_branch 等) cache を flush。
 *  `repository` event (rename / default_branch 変更) で呼ぶ想定。
 *  現状の webhook handler では未使用だが API 表面として用意しておく。 */
export async function invalidateRepoMeta(
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
): Promise<void> {
  if (!kv) return;
  await kv.delete(`${PREFIX}repo:${owner}/${name}`);
}

// Exposed for tests so afterEach can wipe inter-fixture pollution; production
// callers never need this (TTL handles eviction).
export async function clearReleaseCache(kv: KVNamespace): Promise<void> {
  let cursor: string | undefined;
  do {
    const list = await kv.list({ prefix: PREFIX, cursor });
    await Promise.all(list.keys.map((k) => kv.delete(k.name)));
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}
