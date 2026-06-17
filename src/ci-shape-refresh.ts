// scheduled shape refresh (Refs #402)。
// CIDashboardHub DO の alarm() から 6h 毎に呼ばれて、KV に既に shape entry がある
// 全 repo の `.github/workflows/` を GitHub API で再 scan し、最新 shape を upsert する。
//
// 既存 KV に entry がある = 過去にいずれかの webhook を受けた repo。新規 repo は
// 引き続き ci-shape-report.yml caller の workflow_run で初回登録される。
//
// 「caller workflow file の変更が次の PR まで KV に反映されない」 問題
// (例: `push:main` を切った mcp-relay-rs#21) を、ci-dashboard 側 cron で補う。

import { buildShapePayload } from "./ci-shape-parser";
import { ciShapeKey, listCiShapes } from "./ci-shape-webhook";
import type { Env } from "./index";
import { tokenForOrg } from "./github-api";

const TTL_SECONDS = 90 * 24 * 3600;

interface RepoContentFile {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
}

interface RepoApiResp {
  default_branch: string;
}

/** 1 repo の workflows を GitHub API から取って parser に流し、KV upsert する。 */
export async function refreshShapeForRepo(
  env: Env,
  owner: string,
  repo: string,
  now: () => string = () => new Date().toISOString(),
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  let token: string;
  try {
    token = await tokenForOrg(env, owner);
  } catch (e) {
    return { ok: false, error: `token resolution failed: ${(e as Error).message}` };
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ci-dashboard",
  };

  // default branch 解決 → 該当 branch の sha と workflows ディレクトリ取得
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!repoRes.ok) {
    return { ok: false, error: `GET /repos: ${repoRes.status}` };
  }
  const repoMeta = (await repoRes.json()) as RepoApiResp;
  const defaultBranch = repoMeta.default_branch;

  const contentsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows?ref=${encodeURIComponent(defaultBranch)}`,
    { headers },
  );
  if (contentsRes.status === 404) {
    // workflows ディレクトリ自体無い → empty shape を put (= 既存 entry を消さず stale を表現しない)
    const empty = buildShapePayload(owner, repo, undefined, [], now());
    await env.CI_STATUS.put(ciShapeKey(owner, repo), JSON.stringify({ ...empty, received_at: now() }), {
      expirationTtl: TTL_SECONDS,
    });
    return { ok: true, key: ciShapeKey(owner, repo) };
  }
  if (!contentsRes.ok) {
    return { ok: false, error: `GET /contents: ${contentsRes.status}` };
  }
  const entries = (await contentsRes.json()) as RepoContentFile[];
  const ymlFiles = entries.filter(
    (e) => e.type === "file" && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")) && e.download_url,
  );

  const files: { path: string; content: string }[] = [];
  for (const entry of ymlFiles) {
    if (!entry.download_url) continue;
    const fileRes = await fetch(entry.download_url, { headers });
    if (!fileRes.ok) {
      // fetch_error として 1 entry を立てる (= Python 版 `read-error` と同思想)
      files.push({
        path: entry.path,
        content: `# fetch_error: ${fileRes.status}\n`,
      });
      continue;
    }
    files.push({ path: entry.path, content: await fileRes.text() });
  }

  // head_sha は default branch の最新 commit を別 API で引くより、`refs/heads/<branch>` の
  // sha を `/repos/{}/branches/{}` から取った方が安いが、shape の整合性には必須でない
  // (= Python 版も `GITHUB_SHA` を使っているだけで、scanned_at と head_sha の関係は緩い)。
  // 今回は head_sha を空のままにする (Python 版で空文字列が入る挙動と等価)。
  const payload = buildShapePayload(owner, repo, undefined, files, now());
  await env.CI_STATUS.put(
    ciShapeKey(owner, repo),
    JSON.stringify({ ...payload, received_at: now() }),
    { expirationTtl: TTL_SECONDS },
  );
  return { ok: true, key: ciShapeKey(owner, repo) };
}

/** KV 上に既に shape entry がある全 repo を refresh する。
 *  並列実行は GitHub API rate-limit を考慮して 1 件ずつ直列で回す
 *  (60 repo x ~5 files = 300 req、5000/h の rate limit 内で余裕)。 */
export async function refreshAllShapes(
  env: Env,
  now: () => string = () => new Date().toISOString(),
): Promise<{ scanned: number; ok: number; failed: number; errors: string[] }> {
  const shapes = await listCiShapes(env);
  let ok = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const s of shapes) {
    const res = await refreshShapeForRepo(env, s.owner, s.repo, now);
    if (res.ok) {
      ok += 1;
    } else {
      failed += 1;
      errors.push(`${s.owner}/${s.repo}: ${res.error}`);
    }
  }
  return { scanned: shapes.length, ok, failed, errors };
}
