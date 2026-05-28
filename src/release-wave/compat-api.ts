/**
 * Release Wave compatibility の read-only HTTP endpoint 2 本。
 *
 *   GET /compatibility?backend_repo=...&backend_target_image=...
 *     → 指定 backend を target image に flip する際の frontend 互換性 matrix
 *
 *   GET /backend-current-image?repo=...
 *     → 指定 backend の現 production image (frontend CI が test 対象を知る用)
 *
 * 認証は ci-dashboard 全体に被さる Cloudflare Access edge gate に委譲
 * (= /releases, /status と同じトラストモデル)。write は webhook.ts の
 * shared-secret endpoint 側にあり、こちらは read 専用。
 *
 * 設計の親 issue: ippoan/ci-dashboard#157 (Phase A)
 */

import type { Env } from "../index";
import { computeCompatibility, getBackendCurrent } from "./compat";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ----------------------------------------------------------------------------
// GET /compatibility
// ----------------------------------------------------------------------------

export async function handleCompatibility(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const backend_repo = url.searchParams.get("backend_repo")?.trim();
  const backend_target_image = url.searchParams
    .get("backend_target_image")
    ?.trim();

  if (!backend_repo || !backend_target_image) {
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: "backend_repo and backend_target_image query params are required",
    });
  }

  const result = await computeCompatibility(
    env.COMPAT_KV,
    backend_repo,
    backend_target_image,
  );
  return jsonResponse(200, result);
}

// ----------------------------------------------------------------------------
// GET /backend-current-image
// ----------------------------------------------------------------------------

export async function handleBackendCurrentImage(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const repo = url.searchParams.get("repo")?.trim();

  if (!repo) {
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: "repo query param is required",
    });
  }

  const record = await getBackendCurrent(env.COMPAT_KV, repo);
  if (!record) {
    return jsonResponse(404, {
      code: "NOT_FOUND",
      error: `no backend deploy record for ${repo}`,
    });
  }
  return jsonResponse(200, {
    repo: record.repo,
    current_image: record.current_image,
    deployed_at: record.deployed_at,
  });
}
