import { unzipSync, strFromU8 } from "fflate";
import { GitHubApiError, githubApi, tokenForOrg, validateOrg } from "./github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";

// dep-graph artifact から個別 file を取り出して返す薄い service。
//
// rust-alc-api (および将来の他 repo) の `.github/workflows/dep-graph.yml` が
// `bazel query` で生成して GitHub Actions artifact `dep-graph` に投げた
// `deps.dot` / `deps.svg` / `meta.json` を、ci-dashboard の SSR page から
// 取れるようにする。
//
// Refs ippoan/ci-dashboard#443

// 公開する file は allowlist 化 (任意 file 名を path traversal 的に取らせない)。
export const DEP_GRAPH_FILES = ["deps.svg", "deps.dot", "meta.json"] as const;
export type DepGraphFile = (typeof DEP_GRAPH_FILES)[number];

const ARTIFACT_NAME = "dep-graph";
const CACHE_TTL_SECONDS = 300; // 5 分

export interface DepGraphArtifactEnv extends AuthClientWorkerEnv {
  CI_STATUS: KVNamespace;
}

interface ListArtifactsResponse {
  artifacts: Array<{
    id: number;
    name: string;
    created_at: string;
    workflow_run: { head_sha: string; head_branch: string };
    expired: boolean;
  }>;
}

export function cacheKey(owner: string, repo: string, file: DepGraphFile): string {
  return `dep-graph:${owner}/${repo}:${file}`;
}

export function contentType(file: DepGraphFile): string {
  switch (file) {
    case "deps.svg":
      return "image/svg+xml; charset=utf-8";
    case "deps.dot":
      return "text/vnd.graphviz; charset=utf-8";
    case "meta.json":
      return "application/json; charset=utf-8";
  }
}

export function isDepGraphFile(name: string): name is DepGraphFile {
  return (DEP_GRAPH_FILES as readonly string[]).includes(name);
}

/**
 * Latest non-expired `dep-graph` artifact (main branch only).
 * `name=` query で filter すると最新 100 件しか見られないが、頻度上問題ない。
 */
export async function findLatestDepGraphArtifact(
  token: string,
  owner: string,
  repo: string,
): Promise<{ id: number; head_sha: string } | null> {
  const res = await githubApi<ListArtifactsResponse>(
    token,
    "GET",
    `/repos/${owner}/${repo}/actions/artifacts`,
    undefined,
    { name: ARTIFACT_NAME, per_page: "30" },
  );
  const usable = res.artifacts.find(
    (a) => !a.expired && a.workflow_run.head_branch === "main",
  );
  if (!usable) return null;
  return { id: usable.id, head_sha: usable.workflow_run.head_sha };
}

/**
 * artifact zip を download (REST API は 302 → blob storage、fetch redirect:follow で透過)
 * → fflate でメモリ展開 → 各 file を Uint8Array で返す。
 */
export async function downloadAndExtract(
  token: string,
  owner: string,
  repo: string,
  artifactId: number,
): Promise<Record<string, Uint8Array>> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ci-dashboard",
      },
      redirect: "follow",
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new GitHubApiError(res.status, `artifact download ${res.status}: ${text}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return unzipSync(buf);
}

/**
 * Get a single file from the latest dep-graph artifact, with KV cache.
 * Returns null when no usable artifact is found (= workflow has not run yet).
 */
export async function getDepGraphFile(
  env: DepGraphArtifactEnv,
  owner: string,
  repo: string,
  file: DepGraphFile,
): Promise<{ body: Uint8Array; cached: boolean } | null> {
  validateOrg(owner);

  const key = cacheKey(owner, repo, file);
  const cached = await env.CI_STATUS.get(key, "arrayBuffer");
  if (cached) {
    return { body: new Uint8Array(cached), cached: true };
  }

  const token = await tokenForOrg(env, owner);
  const latest = await findLatestDepGraphArtifact(token, owner, repo);
  if (!latest) return null;

  const entries = await downloadAndExtract(token, owner, repo, latest.id);
  // 3 file 全部 KV に投入しておく (1 回の zip 展開で 3 cache hit 取れる)
  for (const name of DEP_GRAPH_FILES) {
    const data = entries[name];
    if (!data) continue;
    // fflate の Uint8Array は SharedArrayBuffer backing でないので cast 安全。
    // KVNamespace.put が ArrayBufferLike を受け取らない (SharedArrayBuffer reject)
    // 都合のためだけの cast。
    await env.CI_STATUS.put(
      cacheKey(owner, repo, name),
      data.buffer as ArrayBuffer,
      { expirationTtl: CACHE_TTL_SECONDS },
    );
  }

  const data = entries[file];
  if (!data) return null;
  return { body: data, cached: false };
}

/**
 * meta.json を parse して返す。dep-graph page のヘッダー (最終更新時刻 / SHA)
 * 表示用。
 */
export async function getDepGraphMeta(
  env: DepGraphArtifactEnv,
  owner: string,
  repo: string,
): Promise<{
  repo: string;
  commit_sha: string;
  ref: string;
  generated_at: string;
  workflow_run_id: string;
} | null> {
  const got = await getDepGraphFile(env, owner, repo, "meta.json");
  if (!got) return null;
  return JSON.parse(strFromU8(got.body));
}
