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
import {
  computeWaveCompatibility,
  computeCompatibility,
  computeGlobalCompatibility,
  getBackendCurrent,
} from "./compat";
import { decideRetestDispatches, dispatchAll, type Dispatch } from "./dispatch";
import {
  getPendingRelease,
  clearPendingRelease,
  listPendingReleases,
  recordPendingRelease,
  recordFlipGroup,
  getFlipGroup,
  clearFlipGroup,
  computeUnifiedPending,
  type PendingReleaseRecord,
  type FlipGroupItem,
  type UnifiedPending,
  type PendingSource,
} from "./pending-release";
import {
  getTraffic,
  getTrafficForRepos,
  type TrafficRecord,
} from "./traffic";
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
// POST /api/release-wave/:wave_id/fail  (force-clear a stuck wave)
// ----------------------------------------------------------------------------

/**
 * in-progress な wave を terminal `failed` へ強制遷移させる (force-clear)。
 *
 * abort は flip 前 (staging / pending-approval) のみ、rollback は flipped のみ
 * 有効なので、flip 途中で callback が来ず `flipping` のまま hang した wave は
 * どちらでも片付けられなかった (= 「失敗してるのに進んでる」stuck 状態)。
 * `fail` event は staging / pending-approval / flipping で有効なので、これを
 * operator 経路として公開して stuck wave を terminal に落とす。`flipped` wave は
 * applyFail が INVALID_TRANSITION で弾く (= rollback を使う)。
 */
export async function handleReleaseWaveForceFail(
  req: Request,
  env: Env,
  wave_id: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }
  let reason = "force-failed via admin UI (stuck wave clear)";
  try {
    const form = await req.formData();
    const r = String(form.get("reason") ?? "").trim();
    if (r) reason = r;
  } catch {
    // form-data 以外は default reason
  }
  // audit: 操作者を reason に併記 (FailInput は actor field を持たないため)
  reason = `${reason} [by ${actorEmail(req)}]`;
  const result = (await hubStub(env).fail({
    wave_id,
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
// POST /api/release-wave/retest-consumer  (Refs #157 / #137)
// ----------------------------------------------------------------------------

/**
 * wave **非依存**で 1 consumer (frontend) の integration retest を起こす。
 *
 * global「Compatibility (all consumers)」グラフの retest ボタンは、backend が
 * 単独 deploy (= `backend::<repo>.wave_id` が null) だと wave-bound な
 * `/api/release-wave/<wave_id>/retest` を呼べず、これまで disabled だった。
 * 本 endpoint はその制約を外し、wave が無くても retest できるようにする。
 *
 * `release-wave-retest` dispatch を frontend repo に送る点・client_payload の
 * shape (`backend_repo` / `backend_image` / `prod_version`) は wave 版と同一で、
 * 違いは `wave_id` を載せない (= null 相当) ことだけ。consumer 側の retest 受け
 * (frontend-ci の `compat_backend_image` 経路 / `report-frontend-compat` action)
 * は `wave_id` を一切参照しないため、無くても動く。
 *
 * form fields:
 *   - `backend_repo` ("owner/name") 必須。`backend::<repo>` record を引く起点。
 *   - `frontend`     ("owner/name") 必須。dispatch 先 consumer repo。
 *   - `backend_image` 任意。未指定なら `backend::<repo>.current_image` を採用
 *     (= グラフが指す「現 prod image」と一致させる)。指定時は値の検証として
 *     現 image との一致を要求しない (= 過去 image での retest も許す)。
 *
 * 検証:
 *   - backend record が無ければ 404。
 *   - 指定 frontend が当該 backend の consumer (= その backend_repo を test した
 *     履歴を持つ) でなければ 404 (= グラフに無い edge への誤射出を防ぐ)。
 * dispatch は best-effort。完了後は一覧ページに 303 redirect する。
 */
export async function handleReleaseWaveRetestConsumer(
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

  let backendRepo = "";
  let frontend = "";
  let backendImage = "";
  try {
    const form = await req.formData();
    backendRepo = String(form.get("backend_repo") ?? "").trim();
    frontend = String(form.get("frontend") ?? "").trim();
    backendImage = String(form.get("backend_image") ?? "").trim();
  } catch {
    // form-data 以外は下で 400
  }
  if (!backendRepo || !frontend) {
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: "form fields 'backend_repo' and 'frontend' are required",
    });
  }

  const backend = await getBackendCurrent(env.COMPAT_KV, backendRepo);
  if (!backend) {
    return jsonResponse(404, {
      code: "NOT_FOUND",
      error: `no backend deploy record for ${backendRepo}`,
    });
  }
  const image = backendImage || backend.current_image;

  // frontend が当該 backend の consumer であることを確認しつつ、その
  // prod_version を取り出す (= report 経路で frontend::<repo> を引く際の version)。
  const compat = await computeCompatibility(
    env.COMPAT_KV,
    backendRepo,
    backend.current_image,
  );
  const edge = compat.matrix.find((m) => m.frontend === frontend);
  if (!edge) {
    return jsonResponse(404, {
      code: "FRONTEND_NOT_CONSUMER",
      error: `${frontend} has no test history against ${backendRepo}`,
    });
  }

  const dispatch: Dispatch = {
    repo: frontend,
    event_type: "release-wave-retest",
    client_payload: {
      // wave 非依存。consumer 側 retest 受けは wave_id を参照しないので省略する
      // (= 既存 wave 版 dispatch との唯一の差分)。
      backend_repo: backendRepo,
      backend_image: image,
      ...(edge.prod_version ? { prod_version: edge.prod_version } : {}),
    },
  };

  const results = await dispatchAll(env, [dispatch]);
  if (!(results.length > 0 && results[0]!.ok)) {
    const err =
      results.length > 0 && !results[0]!.ok ? results[0]!.error : "dispatch failed";
    return jsonResponse(502, {
      code: "DISPATCH_FAILED",
      error: `failed to dispatch retest for ${frontend}: ${err}`,
    });
  }
  return redirectToList();
}

// ----------------------------------------------------------------------------
// Pending release flip / rollback の dispatch ビルダー (single / bulk 共有)
// ----------------------------------------------------------------------------

/**
 * pending release (no-traffic version) を 100% へ flip する dispatch を組む。
 * single (`/pending-release/flip`) と bulk (`/pending-release/flip-all`) で共有。
 */
function buildPendingFlipDispatch(record: PendingReleaseRecord): Dispatch {
  // synthetic wave_id: handler の dispatch job の wave_id 形式検証
  // (^[a-zA-Z0-9._-]{1,128}$) を満たすよう `/` を `-` に潰す。
  const wave_id = `pending-${record.repo.replace(/[^a-zA-Z0-9._-]/g, "-")}-${Date.now()}`;
  return {
    repo: record.repo,
    event_type: "release-wave-flip",
    client_payload: {
      wave_id,
      target_tag: record.tag,
      head_sha: "",
      previewed_version_id: record.version_id,
      // handler が wave flip-report callback を skip するためのマーカー。
      pending_release: true,
    },
  };
}

/**
 * 任意 version への traffic rollback dispatch を組む。single
 * (`/traffic-rollback`) と bulk (flip-group rollback) で共有。
 */
function buildTrafficRollbackDispatch(
  repo: string,
  versionId: string,
  tag: string | null,
): Dispatch {
  const wave_id = `traffic-rollback-${repo.replace(/[^a-zA-Z0-9._-]/g, "-")}-${Date.now()}`;
  return {
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
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/pending-release/flip  (Refs #181 / #174)
// ----------------------------------------------------------------------------

/**
 * 単独 v* リリースの no-traffic version を 100% へ flip する。release-wave の
 * state machine (approve→flip) を起こさずに、frontend-ci が report した pending
 * release を `release-wave-flip` dispatch で promote する。
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
/**
 * pending release flip の core ロジック (HTTP handler と MCP tool が共有)。
 *
 * getPendingRelease → `release-wave-flip` dispatch → 着火成功なら record clear。
 * 戻り値は判別 union で、HTTP handler は status code に、MCP tool は isError に
 * map する。実 flip の成否は GitHub Actions 側で確認する (callback は来ない)。
 */
export type PendingFlipResult =
  | { ok: true; repo: string; tag: string; version_id: string }
  | {
      ok: false;
      code: "KV_NOT_CONFIGURED" | "BAD_REQUEST" | "NOT_FOUND" | "DISPATCH_FAILED";
      error: string;
    };

export async function pendingFlipCore(
  env: Env,
  repo: string,
): Promise<PendingFlipResult> {
  if (!env.COMPAT_KV) {
    return { ok: false, code: "KV_NOT_CONFIGURED", error: "COMPAT_KV is not bound" };
  }
  const r = repo.trim();
  if (!r) {
    return { ok: false, code: "BAD_REQUEST", error: "repo is required" };
  }
  const record = await getPendingRelease(env.COMPAT_KV, r);
  if (!record) {
    return { ok: false, code: "NOT_FOUND", error: `no pending release for ${r}` };
  }
  const results = await dispatchAll(env, [buildPendingFlipDispatch(record)]);
  const ok = results.length > 0 && results[0]!.ok;
  if (!ok) {
    const err = results.length > 0 && !results[0]!.ok ? results[0]!.error : "dispatch failed";
    return {
      ok: false,
      code: "DISPATCH_FAILED",
      error: `failed to dispatch flip for ${r}: ${err}`,
    };
  }
  // 着火できたら record を消す (optimistic)。着火失敗時は上で return 済みなので
  // record は残り、operator が再試行できる。
  await clearPendingRelease(env.COMPAT_KV, r);
  return { ok: true, repo: r, tag: record.tag, version_id: record.version_id };
}

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

  const result = await pendingFlipCore(env, repo);
  if (!result.ok) {
    const status =
      result.code === "KV_NOT_CONFIGURED"
        ? 500
        : result.code === "NOT_FOUND"
          ? 404
          : result.code === "DISPATCH_FAILED"
            ? 502
            : 400;
    return jsonResponse(status, { code: result.code, error: result.error });
  }
  return redirectToList();
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/pending-release/flip-all  (wave 一括 flip, Refs #237)
// ----------------------------------------------------------------------------

/**
 * 「wave = 複数 repo の pending release を一括 flip」。KV の pending-release を
 * 全件まとめて `release-wave-flip` dispatch し、各 repo の **flip 直前の active
 * version (= 戻し先)** を flip-group として記録する。後で
 * `/pending-release/flip-group-rollback` で同じ set を一括 rollback できる。
 *
 * - pending-release が 0 件なら no-op で一覧へ redirect。
 * - 戻し先は flip 前に `traffic::<repo>` から控える (flip CI が traffic を
 *   書き換える前のスナップショット)。取得できない repo は rollback_to=null。
 * - dispatch 成功した repo のみ pending-release を clear し flip-group に積む。
 * - 全 dispatch 失敗時のみ 502。一部成功は成功分を記録して一覧へ redirect。
 */
/**
 * pending release 一括 flip の core ロジック (HTTP handler と MCP tool が共有)。
 *
 * 単一真実の Pending releases を全件 flip し、各 repo の flip 直前 active version
 * を flip-group として記録する (後で一括 rollback 可能)。0 件は no-op で
 * ok:true / flipped:[] を返す。actor は flip-group の audit 記録に使う。
 */
export type PendingFlipAllResult =
  | {
      ok: true;
      flipped: Array<{
        repo: string;
        version_id: string;
        tag: string | null;
        source: PendingSource;
      }>;
    }
  | { ok: false; code: "KV_NOT_CONFIGURED" | "DISPATCH_FAILED"; error: string };

export async function pendingFlipAllCore(
  env: Env,
  actor: string,
): Promise<PendingFlipAllResult> {
  if (!env.COMPAT_KV) {
    return { ok: false, code: "KV_NOT_CONFIGURED", error: "COMPAT_KV is not bound" };
  }

  // Pending releases の単一真実 (workers=traffic:: / cloudrun=pending-release::)
  // を導出する (= 画面の表示と同じ source、Refs #237)。
  const all = await loadUnifiedPending(env);
  // 未 tag version の flip は禁止 (single flip と同じ gate)。tag が無い version は
  // v* tag リリース (= prod テスト gate) を経ていないため、一括 flip でも対象外に
  // する。tag 付き (release 由来) のみ flip する。Refs ippoan/ci-dashboard#237。
  const unified = all.filter((u) => !!u.tag);
  if (unified.length === 0) {
    // flip 可能 (tag 付き) 対象が無ければ no-op。未 tag のみ残っていても flip しない。
    return { ok: true, flipped: [] };
  }

  // source 別に dispatch を組む:
  //  - traffic (workers): traffic-rollback (wrangler versions deploy <id>@100%)
  //  - pending (cloudrun 等): release-wave-flip (handler が platform routing)
  // 戻し先 (rollback_to) は computeUnifiedPending が traffic:: record から控える
  // (traffic source / pending source どちらも、traffic:: があれば現 active)。
  const dispatches = unified.map((u) =>
    u.source === "traffic"
      ? buildTrafficRollbackDispatch(u.repo, u.version_id, u.tag)
      : buildPendingFlipDispatch(unifiedToRecord(u)),
  );
  const results = await dispatchAll(env, dispatches);

  const items: FlipGroupItem[] = [];
  const flipped: Array<{
    repo: string;
    version_id: string;
    tag: string | null;
    source: PendingSource;
  }> = [];
  for (let i = 0; i < unified.length; i++) {
    const u = unified[i]!;
    if (!results[i]?.ok) continue;
    items.push({
      repo: u.repo,
      flipped_version_id: u.version_id,
      flipped_tag: u.tag ?? "",
      rollback_to: u.rollback_to,
      rollback_tag: u.rollback_tag,
    });
    flipped.push({
      repo: u.repo,
      version_id: u.version_id,
      tag: u.tag,
      source: u.source,
    });
    // pending-release:: 由来 (cloudrun) は flip したので消す。traffic 由来は
    // traffic-report (flip 後) が状態を更新するので KV 操作不要。
    if (u.source === "pending") await clearPendingRelease(env.COMPAT_KV, u.repo);
  }

  if (items.length === 0) {
    const failed = results.find((r) => !r.ok);
    const err = failed && !failed.ok ? failed.error : "dispatch failed";
    return {
      ok: false,
      code: "DISPATCH_FAILED",
      error: `failed to dispatch flip for all ${unified.length} pending release(s): ${err}`,
    };
  }

  await recordFlipGroup(env.COMPAT_KV, {
    flipped_at: new Date().toISOString(),
    actor,
    items,
  });
  return { ok: true, flipped };
}

export async function handleReleaseWavePendingReleaseFlipAll(
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
  const result = await pendingFlipAllCore(env, actorEmail(req));
  if (!result.ok) {
    const status = result.code === "KV_NOT_CONFIGURED" ? 500 : 502;
    return jsonResponse(status, { code: result.code, error: result.error });
  }
  return redirectToList();
}

/** UnifiedPending を buildPendingFlipDispatch 用の record 形に変換する。 */
function unifiedToRecord(u: UnifiedPending): PendingReleaseRecord {
  return {
    schema_version: 1,
    repo: u.repo,
    version_id: u.version_id,
    tag: u.tag ?? "",
    preview_url: u.preview_url,
    uploaded_at: u.uploaded_at,
  };
}

/**
 * Pending releases の単一真実リストをサーバ側で導出する (Refs #237)。
 * page.ts の表示と同じ source: workers=traffic:: / cloudrun=pending-release::。
 */
async function loadUnifiedPending(env: Env): Promise<UnifiedPending[]> {
  if (!env.COMPAT_KV) return [];
  let pending: PendingReleaseRecord[] = [];
  try {
    pending = await listPendingReleases(env.COMPAT_KV);
  } catch {
    pending = [];
  }
  // traffic を引く repo = compat グラフ (backend + frontend) ∪ pending repo。
  // pending repo も含めることで、pending source (cloudrun 等で compat グラフに
  // 出ていない repo) でも現 active を rollback 先として控えられる
  // (= 一括 flip → flip-group rollback の戻し先確保、Refs #241)。
  const repos = new Set<string>();
  try {
    const compat = await computeGlobalCompatibility(env.COMPAT_KV);
    for (const b of compat.backends) {
      repos.add(b.backend_repo);
      for (const m of b.matrix) repos.add(m.frontend);
    }
  } catch {
    // compat 取得失敗時は pending repo のみで degrade。
  }
  for (const r of pending) repos.add(r.repo);
  let trafficByRepo = new Map<string, TrafficRecord>();
  try {
    trafficByRepo = await getTrafficForRepos(env.COMPAT_KV, repos);
  } catch {
    // traffic 取得失敗時は pending-release:: のみで degrade。
  }
  return computeUnifiedPending(trafficByRepo, pending);
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/pending-release/flip-group-rollback  (一括 rollback)
// ----------------------------------------------------------------------------

/**
 * 直近の一括 flip (flip-group) を一括 rollback する。各 repo を flip 直前の
 * active version (`rollback_to`) へ `release-wave-traffic-rollback` dispatch で
 * 即 100% に戻す。
 *
 * - flip-group が無ければ 404。
 * - `rollback_to` を記録できていた item のみ対象 (= flip 時に戻し先が判明して
 *   いた repo)。1 件も無ければ 409。
 * - 全 dispatch 失敗時のみ 502。一部でも成功すれば flip-group を clear して
 *   一覧へ redirect (= rollback 済みとみなす)。
 */
export async function handleReleaseWaveFlipGroupRollback(
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

  const group = await getFlipGroup(env.COMPAT_KV);
  if (!group) {
    return jsonResponse(404, {
      code: "NOT_FOUND",
      error: "no flip group to rollback",
    });
  }

  // optional form field `repo`: 指定時はその repo 1 件だけ rollback (= 単一 rollback)。
  // 未指定なら group 全件を一括 rollback (= 従来の Rollback last flip)。
  let repoFilter = "";
  try {
    const form = await req.formData();
    repoFilter = String(form.get("repo") ?? "").trim();
  } catch {
    // form-data 以外 (= bulk ボタンの空 body 等) は repoFilter 無しで全件扱い。
  }

  const rollbackable = group.items.filter(
    (it): it is FlipGroupItem & { rollback_to: string } =>
      typeof it.rollback_to === "string" && it.rollback_to.length > 0,
  );

  // ---- 単一 rollback (repo 指定) ----
  if (repoFilter) {
    const item = rollbackable.find((it) => it.repo === repoFilter);
    if (!item) {
      return jsonResponse(404, {
        code: "NOT_FOUND",
        error: `no rollback target for ${repoFilter} in the latest flip group`,
      });
    }
    const results = await dispatchAll(env, [
      buildTrafficRollbackDispatch(item.repo, item.rollback_to, item.rollback_tag),
    ]);
    if (!(results.length > 0 && results[0]!.ok)) {
      const err =
        results.length > 0 && !results[0]!.ok ? results[0]!.error : "dispatch failed";
      return jsonResponse(502, {
        code: "DISPATCH_FAILED",
        error: `failed to dispatch rollback for ${repoFilter}: ${err}`,
      });
    }
    // rollback で flip 対象 version は再び no-traffic に戻るので、Pending releases
    // に再登録して再 flip できるようにする (Refs ippoan/ci-dashboard#237)。
    await recordPendingRelease(env.COMPAT_KV, {
      repo: item.repo,
      version_id: item.flipped_version_id,
      tag: item.flipped_tag,
      now: new Date().toISOString(),
    });
    // rollback した repo を group から除く。残りが無ければ group ごと消す。
    const remaining = group.items.filter((it) => it.repo !== repoFilter);
    if (remaining.length === 0) {
      await clearFlipGroup(env.COMPAT_KV);
    } else {
      await recordFlipGroup(env.COMPAT_KV, {
        flipped_at: group.flipped_at,
        actor: group.actor,
        items: remaining,
      });
    }
    return redirectToList();
  }

  // ---- 一括 rollback (repo 未指定) ----
  if (rollbackable.length === 0) {
    // 戻し先が 1 件も無い (= flip 時に active を特定できなかった)。group は消す。
    await clearFlipGroup(env.COMPAT_KV);
    return jsonResponse(409, {
      code: "NO_ROLLBACK_TARGET",
      error: "flip group has no recorded rollback targets",
    });
  }

  const dispatches = rollbackable.map((it) =>
    buildTrafficRollbackDispatch(it.repo, it.rollback_to, it.rollback_tag),
  );
  const results = await dispatchAll(env, dispatches);

  if (!results.some((r) => r.ok)) {
    const failed = results.find((r) => !r.ok);
    const err = failed && !failed.ok ? failed.error : "dispatch failed";
    return jsonResponse(502, {
      code: "DISPATCH_FAILED",
      error: `failed to dispatch rollback for flip group (${rollbackable.length} repo(s)): ${err}`,
    });
  }

  // dispatch 成功した repo は flip 対象 version が no-traffic に戻るので、
  // Pending releases に再登録して再 flip できるようにする (Refs ippoan/ci-dashboard#237)。
  const now = new Date().toISOString();
  for (let i = 0; i < rollbackable.length; i++) {
    if (!results[i]?.ok) continue;
    const it = rollbackable[i]!;
    await recordPendingRelease(env.COMPAT_KV, {
      repo: it.repo,
      version_id: it.flipped_version_id,
      tag: it.flipped_tag,
      now,
    });
  }

  await clearFlipGroup(env.COMPAT_KV);
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

  // 未 tag version の 100% flip は禁止。tag が無い version = v* tag リリース
  // (= prod テスト gate) を経ていない version で、これを 100% に上げると
  // 「prod テストなしに本番反映」になる。tag 付き (release 由来) version のみ
  // flip を許可する。Refs ippoan/ci-dashboard#237。
  if (!tag) {
    return jsonResponse(400, {
      code: "UNTAGGED_VERSION_FORBIDDEN",
      error: `version ${versionId} (${repo}) は未 tag (release 由来でない) のため 100% flip できません。未 tag version の flip は tag-release / prod テスト gate を迂回するため禁止です。v* tag リリースで上げた version のみ flip 可能です。`,
    });
  }

  const results = await dispatchAll(env, [
    buildTrafficRollbackDispatch(repo, versionId, tag),
  ]);
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
