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
import { computeWaveCompatibility, getBackendCurrent } from "./compat";
import { decideRetestDispatches, dispatchAll, type Dispatch } from "./dispatch";
import { getPendingRelease, clearPendingRelease } from "./pending-release";
import { getTraffic } from "./traffic";
import { serviceNameFromRevision } from "./revision";

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

/** action 完了後、一覧ページに 303 redirect。 */
function redirectToList(): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/release-wave` },
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
  // form body 内 `force=true` で compatibility gate を override する経路
  // (Refs #157 Phase C)。UI 側は gate blocked 時のみ force 付きボタンを出す。
  let force = false;
  try {
    const form = await req.formData();
    force = String(form.get("force") ?? "") === "true";
  } catch {
    // form-data 以外は force なし
  }
  const result = (await hubStub(env).approve({
    wave_id,
    approved_by: actorEmail(req),
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

// ----------------------------------------------------------------------------
// POST /api/release-wave/pending-release/flip  (Refs #181 / #174)
// ----------------------------------------------------------------------------

/**
 * 単独 v* リリースの no-traffic version を 100% へ flip する。release-wave
 * (stage→approve→flip) を起こさずに、frontend-ci が report した pending release
 * を `release-wave-flip` dispatch で promote する。
 *
 * - form field `repo` ("owner/name") を受け、KV の pending-release record を引く。
 *   record が無い repo は 404 (= flip 対象が存在しない)。
 * - dispatch の client_payload に `previewed_version_id` (= upload した version) と
 *   `pending_release: true` マーカーを載せる。handler は marker を見て wave
 *   flip-report callback を skip する (対応する wave が無いため)。
 * - dispatch 成功なら record を clear (= 一覧から消える)。dispatch 自体が失敗
 *   したら record を残す (operator が再試行できる)。
 *
 * 実 flip の成否は GitHub Actions 側で確認する (callback は来ない)。
 */
export async function handleReleaseWavePendingReleaseFlip(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }
  if (!env.COMPAT_KV) {
    return jsonResponse(500, {
      code: "KV_NOT_CONFIGURED",
      error: "COMPAT_KV is not bound",
    });
  }

  let repo = "";
  try {
    const form = await req.formData();
    repo = String(form.get("repo") ?? "").trim();
  } catch {
    // form-data 以外は repo 無し → 下で 400
  }
  if (!repo) {
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: "form field 'repo' is required",
    });
  }

  const record = await getPendingRelease(env.COMPAT_KV, repo);
  if (!record) {
    return jsonResponse(404, {
      code: "NOT_FOUND",
      error: `no pending release for ${repo}`,
    });
  }

  // synthetic wave_id: handler の dispatch job の wave_id 形式検証
  // (^[a-zA-Z0-9._-]{1,128}$) を満たすよう `/` を `-` に潰す。
  const wave_id = `pending-${repo.replace(/[^a-zA-Z0-9._-]/g, "-")}-${Date.now()}`;
  const dispatch: Dispatch = {
    repo,
    event_type: "release-wave-flip",
    client_payload: {
      wave_id,
      target_tag: record.tag,
      head_sha: "",
      previewed_version_id: record.version_id,
      // handler が wave flip-report を skip するためのマーカー。
      pending_release: true,
    },
  };

  const results = await dispatchAll(env, [dispatch]);
  const ok = results.length > 0 && results[0]!.ok;
  if (ok) {
    // dispatch が着火できたら record を消す (optimistic)。実 flip の成否は
    // GitHub Actions 側で確認する。着火失敗時は record を残し再試行可能にする。
    await clearPendingRelease(env.COMPAT_KV, repo);
  } else {
    const err = results.length > 0 && !results[0]!.ok ? results[0]!.error : "dispatch failed";
    return jsonResponse(502, {
      code: "DISPATCH_FAILED",
      error: `failed to dispatch flip for ${repo}: ${err}`,
    });
  }
  return redirectToList();
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/traffic-rollback  (Refs #196)
// ----------------------------------------------------------------------------

/**
 * frontend worker の traffic を任意の過去 version に即 100% で戻す。
 *
 * - form field `repo` ("owner/name") + `version_id` を受ける。
 * - `traffic::<repo>` の deploy_history / versions に含まれる version_id のみ許可
 *   (= 未知の version への誤 flip を防ぐ。任意選択だが「履歴にある」ことは強制)。
 * - dispatch `release-wave-traffic-rollback` を frontend repo に送る。handler は
 *   `wrangler versions deploy <version_id>@100%` で即 100% に戻す (canary 無し)。
 * - wave 非依存なので callback は来ない。実 flip の成否は GitHub Actions 側で確認。
 *
 * `version_id` から tag を引いて payload の target_tag に載せる (handler の
 * checkout ref には使わないが audit / 表示用)。tag 不明なら省略。
 */
export async function handleReleaseWaveTrafficRollback(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }
  if (!env.COMPAT_KV) {
    return jsonResponse(500, {
      code: "KV_NOT_CONFIGURED",
      error: "COMPAT_KV is not bound",
    });
  }

  let repo = "";
  let versionId = "";
  try {
    const form = await req.formData();
    repo = String(form.get("repo") ?? "").trim();
    versionId = String(form.get("version_id") ?? "").trim();
  } catch {
    // form-data 以外は下で 400
  }
  if (!repo || !versionId) {
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: "form fields 'repo' and 'version_id' are required",
    });
  }

  const traffic = await getTraffic(env.COMPAT_KV, repo);
  if (!traffic) {
    return jsonResponse(404, {
      code: "NOT_FOUND",
      error: `no traffic record for ${repo}`,
    });
  }
  // version_id は履歴 (deploy_history) か現配分 (versions) のどちらかに居ること。
  const fromHistory = (traffic.deploy_history ?? []).find(
    (e) => e.version_id === versionId,
  );
  const fromVersions = traffic.versions.find((v) => v.version_id === versionId);
  if (!fromHistory && !fromVersions) {
    return jsonResponse(404, {
      code: "VERSION_NOT_FOUND",
      error: `version ${versionId} is not in traffic history for ${repo}`,
    });
  }
  const tag = fromHistory?.tag ?? fromVersions?.tag ?? null;

  const wave_id = `traffic-rollback-${repo.replace(/[^a-zA-Z0-9._-]/g, "-")}-${Date.now()}`;
  const dispatch: Dispatch = {
    repo,
    event_type: "release-wave-traffic-rollback",
    client_payload: {
      wave_id,
      ...(tag ? { target_tag: tag } : {}),
      head_sha: "",
      // handler が `wrangler versions deploy <id>@100%` の対象にする version。
      previewed_version_id: versionId,
      // handler が wave callback を skip するためのマーカー。
      traffic_rollback: true,
    },
  };

  const results = await dispatchAll(env, [dispatch]);
  if (!(results.length > 0 && results[0]!.ok)) {
    const err = results.length > 0 && !results[0]!.ok ? results[0]!.error : "dispatch failed";
    return jsonResponse(502, {
      code: "DISPATCH_FAILED",
      error: `failed to dispatch traffic-rollback for ${repo}: ${err}`,
    });
  }
  return redirectToList();
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/backend-rollback  (Refs #197)
// ----------------------------------------------------------------------------

/**
 * backend (Cloud Run) の traffic を任意の過去 revision に即 100% で戻す。
 *
 * - form field `repo` ("owner/name") + `image` (Cloud Run revision name) を受ける。
 * - `backend::<repo>` の deploy_history に含まれる image のみ許可。
 * - dispatch `release-wave-backend-rollback` を backend repo に送る。handler は
 *   既存 `/cloudrun/rollback` 経路で `rollback_target[<service>]` の revision に
 *   即 100% traffic を振る。
 * - service 名は revision name (`<service>-NNNNN-suffix`) から逆算して
 *   `rollback_target` map を組む。逆算できない場合も `rollback_revision` 単一値を
 *   載せ、handler 側 fallback に委ねる。
 */
export async function handleReleaseWaveBackendRollback(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }
  if (!env.COMPAT_KV) {
    return jsonResponse(500, {
      code: "KV_NOT_CONFIGURED",
      error: "COMPAT_KV is not bound",
    });
  }

  let repo = "";
  let image = "";
  try {
    const form = await req.formData();
    repo = String(form.get("repo") ?? "").trim();
    image = String(form.get("image") ?? "").trim();
  } catch {
    // form-data 以外は下で 400
  }
  if (!repo || !image) {
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: "form fields 'repo' and 'image' are required",
    });
  }

  const backend = await getBackendCurrent(env.COMPAT_KV, repo);
  if (!backend) {
    return jsonResponse(404, {
      code: "NOT_FOUND",
      error: `no backend deploy record for ${repo}`,
    });
  }
  const entry = (backend.deploy_history ?? []).find((e) => e.image === image);
  if (!entry) {
    return jsonResponse(404, {
      code: "REVISION_NOT_FOUND",
      error: `revision ${image} is not in deploy history for ${repo}`,
    });
  }

  const service = serviceNameFromRevision(image);
  const wave_id = `backend-rollback-${repo.replace(/[^a-zA-Z0-9._-]/g, "-")}-${Date.now()}`;
  const dispatch: Dispatch = {
    repo,
    event_type: "release-wave-backend-rollback",
    client_payload: {
      wave_id,
      ...(entry.tag ? { target_tag: entry.tag } : {}),
      head_sha: "",
      // 既存 /cloudrun/rollback の戻し先 map。service 別。
      rollback_target: service ? { [service]: image } : {},
      // service 名を逆算できなかった場合の単一値 fallback。
      rollback_revision: image,
      backend_rollback: true,
    },
  };

  const results = await dispatchAll(env, [dispatch]);
  if (!(results.length > 0 && results[0]!.ok)) {
    const err = results.length > 0 && !results[0]!.ok ? results[0]!.error : "dispatch failed";
    return jsonResponse(502, {
      code: "DISPATCH_FAILED",
      error: `failed to dispatch backend-rollback for ${repo}: ${err}`,
    });
  }
  return redirectToList();
}
