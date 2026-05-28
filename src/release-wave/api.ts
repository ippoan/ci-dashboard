/**
 * Release Wave admin UI の action button が叩く form-POST endpoint。
 *
 * 認証は Cloudflare Access edge で担保される (= /releases, /api/release-close
 * と同じトラストモデル)。本ファイルでは追加 auth check は持たない。
 * 操作者の email は `Cf-Access-Authenticated-User-Email` header から取得し、
 * audit trail に記録する。header 不在時 (= dev mode) は "operator" 既定値。
 *
 * 設計の親 issue: ippoan/ci-dashboard#137 Phase 3e
 */

import type { Env } from "../index";
import type { ReleaseWaveHub, RpcResult } from "./do";
import type { WaveState } from "./types";
import { computeWaveCompatibility } from "./compat";
import { decideRetestDispatches, dispatchAll } from "./dispatch";

function hubStub(env: Env): DurableObjectStub<ReleaseWaveHub> {
  const id = env.RELEASE_WAVE_HUB.idFromName("singleton");
  return env.RELEASE_WAVE_HUB.get(id) as DurableObjectStub<ReleaseWaveHub>;
}

/** CF Access が転送する authenticated user email を取り出す。dev fallback。 */
function actorEmail(req: Request): string {
  const v = req.headers.get("Cf-Access-Authenticated-User-Email");
  return (v && v.trim()) || "operator";
}

/** action 完了後、詳細ページに 303 redirect。 */
function redirectToDetail(wave_id: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/release-wave/${encodeURIComponent(wave_id)}` },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcErrorToHttpStatus(code: string): number {
  if (code === "NOT_FOUND" || code === "REPO_NOT_IN_WAVE") return 404;
  return 409;
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/:wave_id/approve
// ----------------------------------------------------------------------------

export async function handleReleaseWaveApprove(
  req: Request,
  env: Env,
  wave_id: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }
  const result = (await hubStub(env).approve({
    wave_id,
    approved_by: actorEmail(req),
  })) as RpcResult<WaveState>;
  if (!result.ok) {
    return jsonResponse(rpcErrorToHttpStatus(result.code), {
      code: result.code,
      error: result.error,
    });
  }
  return redirectToDetail(wave_id);
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/:wave_id/rollback
// ----------------------------------------------------------------------------

export async function handleReleaseWaveRollback(
  req: Request,
  env: Env,
  wave_id: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }
  // form body 内 `force=true` で unsafe override を許可する経路。
  // UI 側 (page.ts) で rollback.safe=false の wave 詳細ボタンに force input
  // を自動付与している。明示 force 無しなら DO が ROLLBACK_UNSAFE で reject。
  let force = false;
  try {
    const form = await req.formData();
    force = String(form.get("force") ?? "") === "true";
  } catch {
    // form-data 以外 (e.g. fetch from JS) は空 form として扱う
  }
  const result = (await hubStub(env).rollback({
    wave_id,
    rolled_back_by: actorEmail(req),
    force,
  })) as RpcResult<WaveState>;
  if (!result.ok) {
    return jsonResponse(rpcErrorToHttpStatus(result.code), {
      code: result.code,
      error: result.error,
    });
  }
  return redirectToDetail(wave_id);
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/:wave_id/abort
// ----------------------------------------------------------------------------

export async function handleReleaseWaveAbort(
  req: Request,
  env: Env,
  wave_id: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }
  let reason = "aborted via admin UI";
  try {
    const form = await req.formData();
    const r = String(form.get("reason") ?? "").trim();
    if (r) reason = r;
  } catch {
    // form-data 以外は default reason
  }
  const result = (await hubStub(env).abort({
    wave_id,
    aborted_by: actorEmail(req),
    reason,
  })) as RpcResult<WaveState>;
  if (!result.ok) {
    return jsonResponse(rpcErrorToHttpStatus(result.code), {
      code: result.code,
      error: result.error,
    });
  }
  return redirectToDetail(wave_id);
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/:wave_id/retest  (Refs #157 Phase B)
// ----------------------------------------------------------------------------

/**
 * compatibility matrix の赤 frontend に `release-wave-retest` を fan-out する。
 * form field `frontend` を渡せばその 1 件だけ ("Re-test against this image")、
 * 無ければ全 red ("Re-test all reds")。
 *
 * dispatch は best-effort (dispatchAll は throw しない)。完了後は詳細ページに
 * redirect する。matrix は SSR で KV を都度読むため、frontend CI が
 * `frontend-test-report` を打ち KV が更新されれば次回表示で自動 refresh される。
 */
export async function handleReleaseWaveRetest(
  req: Request,
  env: Env,
  wave_id: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }
  let onlyFrontend: string | undefined;
  try {
    const form = await req.formData();
    const f = String(form.get("frontend") ?? "").trim();
    if (f) onlyFrontend = f;
  } catch {
    // form-data 以外は全 red 対象
  }

  const result = (await hubStub(env).get(wave_id)) as RpcResult<WaveState>;
  if (!result.ok) {
    return jsonResponse(rpcErrorToHttpStatus(result.code), {
      code: result.code,
      error: result.error,
    });
  }

  if (env.COMPAT_KV) {
    const compat = await computeWaveCompatibility(
      env.COMPAT_KV,
      result.data.repos.map((r) => r.repo),
    );
    const dispatches = decideRetestDispatches(wave_id, compat, onlyFrontend);
    if (dispatches.length > 0) {
      await dispatchAll(env, dispatches);
    }
  }
  return redirectToDetail(wave_id);
}
