import type { Env } from "./index";
import { tokenForOrg } from "./github-api";

export interface TagReleaseResult {
  ok: boolean;
  /** ok=false のとき HTTP status のヒント (400 / 403 / 502)。 */
  status: number;
  error?: string;
}

/**
 * repo の `tag-release.yml` workflow を main 上で dispatch する。
 *
 * tag 採番 + GitHub Release 作成は各 repo の workflow 側に任せる
 * (semver bump ロジックを ci-dashboard に持たない設計)。JSON API (/releases)
 * と form-POST (/release-wave) の両経路から共有するため、純粋に dispatch の
 * 成否だけを返す薄い関数として切り出す。
 */
export async function dispatchTagRelease(
  env: Env,
  repo: string,
): Promise<TagReleaseResult> {
  if (!repo) {
    return { ok: false, status: 400, error: "Missing repo" };
  }
  const [owner] = repo.split("/", 1);
  if (!owner) {
    return { ok: false, status: 400, error: "Bad repo" };
  }
  let token: string;
  try {
    token = await tokenForOrg(env, owner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 403, error: msg };
  }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/tag-release.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ci-dashboard",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: 502, error: `GitHub API ${res.status}: ${text}` };
  }

  return { ok: true, status: 200 };
}

/** JSON API: POST /api/tag-release (/releases ページの JS fetch から)。 */
export async function handleTagRelease(
  request: Request,
  env: Env,
): Promise<Response> {
  const { repo } = await request.json<{ repo: string }>();
  const result = await dispatchTagRelease(env, repo);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ ok: true, repo });
}
