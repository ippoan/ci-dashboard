import {
  contentType,
  getDepGraphFile,
  isDepGraphFile,
  type DepGraphArtifactEnv,
} from "./dep-graph-artifact";
import { GitHubApiError, validateOrg } from "./github-api";

/**
 * GET /api/dep-graph/:owner/:repo/:file
 *
 * `file` は `deps.svg` / `deps.dot` / `meta.json` のいずれか。
 * 200 で artifact 内の生 file を passthrough する (SVG なら image/svg+xml)。
 * Browser から `<img src=...>` でそのまま読める。
 *
 * 404: artifact がまだ無い / file がそろっていない (workflow 初回 push 待ち)。
 * 400: file 名が allowlist 外 (path traversal 防止)。
 * 403: org が allowlist 外。
 */
export async function handleDepGraphFile(
  env: DepGraphArtifactEnv,
  owner: string,
  repo: string,
  file: string,
): Promise<Response> {
  if (!isDepGraphFile(file)) {
    return new Response(`Unknown file: ${file}`, { status: 400 });
  }
  try {
    validateOrg(owner);
  } catch (e) {
    if (e instanceof GitHubApiError) {
      return new Response(e.message, { status: e.status });
    }
    throw e;
  }

  try {
    const got = await getDepGraphFile(env, owner, repo, file);
    if (!got) {
      return new Response("dep-graph artifact not found (workflow has not run yet?)", {
        status: 404,
      });
    }
    // SVG は HTML/JS と同じく browser がスクリプト実行できるドキュメント形式。
    // dep-graph SVG は graphviz `dot -Tsvg` 出力で実際にはスクリプトを含まないが、
    // ci-dashboard.ippoan.org と同一 origin で配信するため、defense in depth:
    //   - CSP `sandbox` で同一 origin であっても script/cookie/storage を遮断
    //   - `nosniff` で content-type 推測 (image/svg+xml → text/html 化) を防止
    // `<img src=...>` レンダリング (page-view の使い方) には影響しない。
    const headers: Record<string, string> = {
      "content-type": contentType(file),
      "cache-control": "public, max-age=300",
      "x-cache": got.cached ? "HIT" : "MISS",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    };
    return new Response(got.body, { status: 200, headers });
  } catch (e) {
    if (e instanceof GitHubApiError) {
      return new Response(`upstream ${e.status}: ${e.message}`, { status: 502 });
    }
    throw e;
  }
}
