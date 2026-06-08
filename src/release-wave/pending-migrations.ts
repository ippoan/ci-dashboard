/**
 * Pending migrations preview (Refs ippoan/ci-dashboard#173).
 *
 * release 前に「次の `v*` release で本番 DB に適用される未適用マイグレーション」が
 * 何件あるかを **git ベース**で算出する。定義 = 対象 backend repo の **最新 stable
 * `v*` tag 以降に `migrations/` 配下へ追加された `.sql` ファイル** (= 次 release の
 * migrate job が適用する集合)。DB 接続不要 (GitHub compare API のみ、案 1)。
 *
 *   base = 最新 stable `v*` tag (無ければ status="unknown": baseline 無しで算出不能)
 *   head = repo の default branch (main)
 *   集合 = compare base...head の files[] から status==="added" かつ
 *          `migrations/<name>.sql` に一致するもの
 *
 * GitHub call は cachedTags / cachedRepoMeta (release-cache) + 専用の短命 cached
 * compare を使い、quota / latency を抑える。算出失敗 (token 無し / API error 等) は
 * **fail-soft** で skip し、release-wave ページの描画は止めない。
 *
 * squash merge で commit SHA は変わるが migrations は file 単位なので
 * compare の files[] (path 単位) で正確に拾える (issue #173 の注記)。
 */

import { githubApi, parseRepo, tokenForOrg } from "../github-api";
import { cachedRepoMeta, cachedTags } from "../release-cache";
import { parseStableSemver, sortSemverDesc } from "../release-helpers";
import type { Env } from "../index";

/** 算出結果の状態。 */
export type PendingMigrationsStatus =
  /** 1 件以上の未適用マイグレーションあり (= migrate が DB を変更する)。 */
  | "pending"
  /** baseline tag はあるが追加マイグレーション無し (= migrate は no-op で安全)。 */
  | "none"
  /** baseline (`v*` tag) が無い / 算出不能 (= 判断材料無し)。 */
  | "unknown";

/** 1 backend repo についての未適用マイグレーション算出結果。 */
export interface RepoPendingMigrations {
  /** "owner/name"。 */
  repo: string;
  /** baseline に使った最新 stable `v*` tag。無ければ null (status="unknown")。 */
  base_tag: string | null;
  /** 比較 head (default branch、通常 "main")。 */
  head: string;
  /** base_tag 以降に追加された migration ファイル名 (basename、昇順)。 */
  files: string[];
  count: number;
  status: PendingMigrationsStatus;
}

/**
 * repo ルートの `migrations/<name>.sql` に一致。rust-alc-api 等は repo ルートの
 * `migrations/*.sql` を sqlx migrate が適用する。`docs/migrations/...` のような
 * 別ディレクトリ配下を誤検出しないよう、先頭を `^migrations/` に固定する。
 */
const MIGRATION_FILE_RE = /^migrations\/[^/]+\.sql$/i;

interface CompareFile {
  filename: string;
  status: string;
}
interface CompareWithFiles {
  files?: CompareFile[];
}

const PM_PREFIX = "pm::";
/** head (default branch) が動くので短命 cache に留める。 */
const PM_TTL_SECONDS = 120;

function pmKey(repo: string, base: string): string {
  return `${PM_PREFIX}${repo}::${base}`;
}

/** 最新の stable `v*` tag を解決する (prerelease / 非 semver は除外)。無ければ null。 */
async function latestStableTag(
  token: string,
  kv: KVNamespace | undefined,
  owner: string,
  name: string,
): Promise<string | null> {
  const tags = await cachedTags(token, kv, owner, name, 100);
  const stable = tags
    .map((t) => t.name)
    .filter((n) => parseStableSemver(n) !== null);
  return sortSemverDesc(stable)[0] ?? null;
}

/**
 * 単一 repo の未適用マイグレーションを算出する。GitHub 例外は呼び出し側 (batch)
 * の try/catch で握る前提でそのまま投げる。
 */
export async function computeRepoPendingMigrations(
  token: string,
  kv: KVNamespace | undefined,
  repo: string,
): Promise<RepoPendingMigrations> {
  const { owner, repo: name } = parseRepo(repo);
  const meta = await cachedRepoMeta(token, kv, owner, name);
  const head = meta.default_branch || "main";

  const base = await latestStableTag(token, kv, owner, name);
  if (!base) {
    // baseline 無し (= まだ一度も release tag が無い) → 算出不能。
    return { repo, base_tag: null, head, files: [], count: 0, status: "unknown" };
  }

  // compare base...head の files[] を取る。head が動くので短命 cache。
  const cacheKey = pmKey(repo, base);
  let cmp = kv ? await kv.get<CompareWithFiles>(cacheKey, "json") : null;
  if (!cmp) {
    cmp = await githubApi<CompareWithFiles>(
      token,
      "GET",
      `/repos/${owner}/${name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (kv) {
      await kv.put(cacheKey, JSON.stringify({ files: cmp.files ?? [] }), {
        expirationTtl: PM_TTL_SECONDS,
      });
    }
  }

  const files = (cmp.files ?? [])
    .filter((f) => f.status === "added" && MIGRATION_FILE_RE.test(f.filename))
    .map((f) => f.filename.split("/").pop() as string)
    .sort();

  return {
    repo,
    base_tag: base,
    head,
    files,
    count: files.length,
    status: files.length > 0 ? "pending" : "none",
  };
}

/**
 * 複数 backend repo の未適用マイグレーションをまとめて算出する。
 *
 * token は org-agnostic (auth-worker の単一 user-scope token) なので 1 度だけ
 * 解決して全 repo に流用する。token 解決失敗 (operator 未認証等) は空 Map を返し
 * (= migration 行を一切出さない)、repo 個別の算出失敗も fail-soft で skip する。
 * = release-wave ページが GitHub 依存で落ちないことを最優先にする。
 */
export async function computePendingMigrationsForRepos(
  env: Env,
  repos: string[],
): Promise<Map<string, RepoPendingMigrations>> {
  const out = new Map<string, RepoPendingMigrations>();
  if (repos.length === 0) return out;

  const kv = env.CI_STATUS;
  let token: string;
  try {
    token = await tokenForOrg(env, parseRepo(repos[0] as string).owner);
  } catch {
    return out; // 未認証 / token 解決不能 → 何も出さない (fail-soft)
  }

  for (const repo of repos) {
    try {
      out.set(repo, await computeRepoPendingMigrations(token, kv, repo));
    } catch {
      // この repo は省略 (GitHub error / repo 無し等)。ページ描画は続行する。
    }
  }
  return out;
}
