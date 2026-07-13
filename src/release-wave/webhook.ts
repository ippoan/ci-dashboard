/**
 * GitHub Actions step が叩く HTTP webhook 群。MCP 経路と機能等価だが、
 * OAuth 不要の shared secret 認証で Actions 側を curl 1 行で済むようにする。
 *
 * 全 endpoint 共通:
 *   POST 必須、`X-Release-Wave-Webhook-Secret` header の constant-time 比較、
 *   Secrets Store binding `RELEASE_WAVE_WEBHOOK_SECRET` から expected 値取得、
 *   body は JSON、エラーは JSON `{ code, error }` で返す。
 *
 * 主な endpoint (stage-report は stage phase 撤去で削除済み, Refs ippoan/ci-workflows#96①):
 *   POST /webhooks/release-wave/flip-report        — flip 完了後に呼ぶ
 *      (= release_wave_flip MCP tool 等価)
 *   POST /webhooks/release-wave/contract-applied   — migration deploy 後に呼ぶ
 *      (= release_wave_contract_applied MCP tool 等価)
 *
 * 設計の親 issue: ippoan/ci-dashboard#137 Phase 3d + Phase 4
 */

import { z } from "zod";
import type { Env } from "../index";
import type { ReleaseWaveHub, RpcResult } from "./do";
import type { WaveState } from "./types";
import {
  recordFrontendTest,
  recordBackendDeploy,
  getBackendCurrent,
  computeCompatibility,
} from "./compat";
import { recordPendingRelease } from "./pending-release";
import { maybeAutoFlip, scheduleAutoFlipRecheck } from "./auto-flip";
import { recordTraffic } from "./traffic";
import { dispatchAll, decideBackendDeployRetestDispatches } from "./dispatch";
import {
  recordBackendTraffic,
  type BackendServiceTraffic,
} from "./backend-traffic";

// ----------------------------------------------------------------------------
// Common helpers
// ----------------------------------------------------------------------------

/** constant-time string compare (= timing attack 防止)。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** RpcError code → HTTP status の共通 map。 */
function rpcErrorToHttpStatus(code: string): number {
  if (code === "NOT_FOUND" || code === "REPO_NOT_IN_WAVE") return 404;
  return 409;
}

/** ReleaseWaveHub stub 取得。 */
function hubStub(env: Env): DurableObjectStub<ReleaseWaveHub> {
  const id = env.RELEASE_WAVE_HUB.idFromName("singleton");
  return env.RELEASE_WAVE_HUB.get(id) as DurableObjectStub<ReleaseWaveHub>;
}

/**
 * `/release-wave` を開いている全ブラウザに「変わったよ」シグナルを送る (Refs #479)。
 *
 * DO state を変える webhook (contract-applied / flip-report) は `saveWave` 経由で
 * 既に broadcast するが、KV だけを書く report 系 (traffic / pending-release /
 * backend-deploy / frontend-test / backend-traffic) は DO を通らないため、ここで
 * 明示的に broadcast して live 更新を発火させる。best-effort — DO 呼び出しの失敗で
 * report の 200 応答を止めない (次の report / 手動リロードで追従できる)。
 */
async function broadcastChange(env: Env): Promise<void> {
  try {
    await hubStub(env).broadcast();
  } catch {
    // broadcast 失敗は live 更新の取りこぼしに留め、report 自体は成功扱いにする。
  }
}

/**
 * 共通 prologue: method check + secret check + body parse + zod validate。
 * 成功時に validated body を返し、失敗時に Response を返す (caller は早期 return)。
 */
async function validateAndAuth<S extends z.ZodTypeAny>(
  request: Request,
  env: Env,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  if (request.method !== "POST") {
    return {
      ok: false,
      response: jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" }),
    };
  }

  const provided = request.headers.get("X-Release-Wave-Webhook-Secret") ?? "";
  const expected = await env.RELEASE_WAVE_WEBHOOK_SECRET.get();
  if (!expected) {
    return {
      ok: false,
      response: jsonResponse(500, {
        code: "SECRET_NOT_CONFIGURED",
        error: "RELEASE_WAVE_WEBHOOK_SECRET is not bound",
      }),
    };
  }
  if (!constantTimeEqual(provided, expected)) {
    return {
      ok: false,
      response: jsonResponse(401, {
        code: "UNAUTHORIZED",
        error: "invalid webhook secret",
      }),
    };
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonResponse(400, {
        code: "BAD_JSON",
        error: "request body is not valid JSON",
      }),
    };
  }
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    const issuesText = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      response: jsonResponse(400, {
        code: "BAD_REQUEST",
        error: issuesText || parsed.error.message || "validation failed",
      }),
    };
  }
  return { ok: true, data: parsed.data };
}

/** DO RpcResult → HTTP Response の共通 map。 */
function rpcResultToResponse(result: RpcResult<WaveState>): Response {
  if (result.ok) {
    return jsonResponse(200, { ok: true, state: result.data });
  }
  return jsonResponse(rpcErrorToHttpStatus(result.code), {
    ok: false,
    code: result.code,
    error: result.error,
  });
}

// ----------------------------------------------------------------------------
// /webhooks/release-wave/contract-applied  (Phase 3d, 既存)
// ----------------------------------------------------------------------------

const contractAppliedSchema = z.object({
  wave_id: z.string().min(1),
  repo: z.string().min(1),
  migration_id: z.string().min(1),
});

export async function handleContractAppliedWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const v = await validateAndAuth(request, env, contractAppliedSchema);
  if (!v.ok) return v.response;
  const result = (await hubStub(env).contractApplied({
    wave_id: v.data.wave_id,
    repo: v.data.repo,
    migration_id: v.data.migration_id,
  })) as RpcResult<WaveState>;
  return rpcResultToResponse(result);
}

// ----------------------------------------------------------------------------
// /webhooks/release-wave/flip-report  (Phase 4 NEW)
// ----------------------------------------------------------------------------

/**
 * flip-report body:
 *   {
 *     "wave_id": "wave_...",
 *     "repo": "ippoan/rust-alc-api",
 *     "ok": true,
 *     "error": "patch denied",       // ok=false 時のみ
 *     "version_id": "530b908c-...",  // 100% に flip した version (CF Workers、任意)
 *     "worker_name": "notify-email-receiver"  // monorepo unit (任意)
 *   }
 *
 * `version_id` / `worker_name` は Refs #427 Phase 2 で追加。RepoState.deployed_version
 * を保持し、monorepo の per-unit flip を audit するため。旧 handler は送らない (= 任意)。
 */
const flipReportSchema = z.object({
  wave_id: z.string().min(1),
  repo: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  version_id: z.string().min(1).nullish(),
  worker_name: z.string().min(1).nullish(),
});

export async function handleFlipReportWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const v = await validateAndAuth(request, env, flipReportSchema);
  if (!v.ok) return v.response;
  const result = (await hubStub(env).flipReport({
    wave_id: v.data.wave_id,
    repo: v.data.repo,
    ok: v.data.ok,
    error: v.data.error ?? null,
    version_id: v.data.version_id ?? null,
    worker_name: v.data.worker_name ?? null,
  })) as RpcResult<WaveState>;
  return rpcResultToResponse(result);
}

// ----------------------------------------------------------------------------
// /webhooks/release-wave/frontend-test-report  (compatibility, Refs #157/#158)
// ----------------------------------------------------------------------------

/**
 * frontend CI が integration test green 時に打つ。ci-dashboard 側で
 * `frontend::<repo>` を read-modify-write し `tested_against` に append する。
 *
 * body:
 *   {
 *     "repo": "ippoan/auth-worker",
 *     "prod_version": "v0.5.32",
 *     "tested": {
 *       "backend_repo": "ippoan/rust-alc-api",
 *       "backend_image": "rust-alc-api-00042-abc",
 *       "ci_run_url": "https://github.com/.../runs/123"   // optional
 *     }
 *   }
 */
const frontendTestReportSchema = z.object({
  repo: z.string().min(1),
  prod_version: z.string().min(1),
  tested: z.object({
    backend_repo: z.string().min(1),
    backend_image: z.string().min(1),
    ci_run_url: z.string().url().optional(),
  }),
});

export async function handleFrontendTestReportWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const v = await validateAndAuth(request, env, frontendTestReportSchema);
  if (!v.ok) return v.response;
  const record = await recordFrontendTest(env.COMPAT_KV, {
    repo: v.data.repo,
    prod_version: v.data.prod_version,
    tested: {
      backend_repo: v.data.tested.backend_repo,
      backend_image: v.data.tested.backend_image,
      ci_run_url: v.data.tested.ci_run_url,
    },
    now: new Date().toISOString(),
  });
  // compatibility グラフ (tested/untested) が変わった → live 更新。
  await broadcastChange(env);
  return jsonResponse(200, { ok: true, record });
}

// ----------------------------------------------------------------------------
// /webhooks/release-wave/backend-deploy-report  (compatibility, Refs #157/#158)
// ----------------------------------------------------------------------------

/**
 * backend deploy 成功時に release-wave-gcp / 各 backend deploy workflow が打つ。
 * ci-dashboard 側で `backend::<repo>` を upsert する。
 *
 * body:
 *   {
 *     "repo": "ippoan/rust-alc-api",
 *     "current_image": "rust-alc-api-00042-abc",
 *     "current_tag": "v1.4.2",          // optional (image に対応する git tag、Refs #197)
 *     "deployed_by": "release-wave-gcp",
 *     "wave_id": "wave_2026_05_27_01"   // optional (単独 deploy 時は省略)
 *   }
 */
const backendDeployReportSchema = z.object({
  repo: z.string().min(1),
  current_image: z.string().min(1),
  // null / undefined / 省略すべて許容 (旧 deploy workflow は載せない)。
  current_tag: z.string().min(1).nullish(),
  deployed_by: z.string().min(1),
  wave_id: z.string().min(1).nullable().optional(),
});

export async function handleBackendDeployReportWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const v = await validateAndAuth(request, env, backendDeployReportSchema);
  if (!v.ok) return v.response;
  const record = await recordBackendDeploy(env.COMPAT_KV, {
    repo: v.data.repo,
    current_image: v.data.current_image,
    current_tag: v.data.current_tag ?? null,
    deployed_by: v.data.deployed_by,
    wave_id: v.data.wave_id ?? null,
    now: new Date().toISOString(),
  });

  // 新 image が prod に出たので、その image を未 test の consumer (frontend) に
  // integration retest を自動 fan-out する (Refs #157)。手動 "Re-test" ボタンと
  // 等価だが deploy 報告を起点に自動化する。best-effort: dispatch 失敗
  // (token 取得失敗 / GitHub non-2xx 等) は dispatchAll が per-repo に握り潰し、
  // report の 200 応答は止めない。COMPAT_KV は validateAndAuth より前段の
  // recordBackendDeploy が触れている = この時点で bound 確定。
  const compat = await computeCompatibility(
    env.COMPAT_KV,
    v.data.repo,
    v.data.current_image,
  );
  const dispatches = decideBackendDeployRetestDispatches(compat);
  if (dispatches.length > 0) {
    await dispatchAll(env, dispatches);
  }

  // 新 backend image が prod に出た → 開いている /release-wave を live 更新。
  await broadcastChange(env);
  return jsonResponse(200, { ok: true, record });
}

// ----------------------------------------------------------------------------
// /webhooks/release-wave/pending-release  (Refs #181 / #174)
// ----------------------------------------------------------------------------

/**
 * frontend-ci.yml の release deploy が `wrangler versions upload` (no-traffic)
 * 後に打つ。ci-dashboard 側で `pending-release::<repo>` を upsert し、
 * /release-wave 一覧の「Pending releases」セクションに出して Flip させる。
 *
 * best-effort 報告 (失敗してもリリースは止めない) なので、shared secret 認証は
 * 他 webhook と同じだが、対応する wave は存在しない (= 単独 release)。
 *
 * body:
 *   {
 *     "repo": "ippoan/auth-worker",
 *     "version_id": "530b908c-5385-451c-b163-747caaedafd3",  // wrangler version id (UUID)
 *     "tag": "v0.2.38",
 *     "preview_url": "https://<hash>-auth-worker.<sub>.workers.dev"   // optional
 *   }
 */
const pendingReleaseSchema = z.object({
  repo: z.string().min(1),
  // monorepo unit worker 名 (CF script 名)。省略時は単一 worker / legacy = repo-key。
  worker_name: z.string().min(1).nullish(),
  // version_id:
  //   - cloudflare-workers: wrangler の version id (UUID)。flip 時に
  //     `wrangler versions deploy <id>@100%` に渡る。
  //   - cloudrun: 単一 version id が無いので revision tag (例 `pending-v0-0-79`)
  //     を入れる。flip-cloudrun は target_tag から `pending-<tag>` を再計算し
  //     previewed_version_id は使わないため UUID でなくてよい。
  // よって UUID 強制はやめ非空のみ要求する (flip 側が platform ごとに検証/無視)。
  // Refs ippoan/ci-dashboard#237。
  version_id: z.string().min(1),
  tag: z.string().min(1),
  preview_url: z.string().url().optional(),
  // flip 前 (no-traffic 0%) production image の識別子 (= deploy した git SHA)。
  // 設定すると、consumer (frontend) に **flip 前** retest を fan-out して、その
  // image に対する互換性を flip 前に検証する (Refs ippoan/ci-dashboard#427)。
  // cloudrun backend の release で渡す。frontend 単独 release では省略。
  staged_image: z.string().min(1).nullish(),
});

export async function handlePendingReleaseWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const v = await validateAndAuth(request, env, pendingReleaseSchema);
  if (!v.ok) return v.response;
  const stagedImage = v.data.staged_image ?? null;
  const record = await recordPendingRelease(env.COMPAT_KV, {
    repo: v.data.repo,
    worker_name: v.data.worker_name ?? null,
    version_id: v.data.version_id,
    tag: v.data.tag,
    preview_url: v.data.preview_url ?? null,
    staged_image: stagedImage,
    now: new Date().toISOString(),
  });

  // staged_image (= flip 前の no-traffic production image) が渡された場合、その
  // image を **未 test の consumer に flip 前 retest として fan-out** する
  // (Refs #427)。これにより「tag → no-traffic upload → 自動 retest → 全 green を
  // 確認 → flip」になり、壊れた backend が 100% traffic に乗る前に互換性を検証
  // できる (backend-deploy-report の retest は flip 後に走るので手遅れだった)。
  // backend-deploy-report と同じ best-effort: dispatch 失敗は dispatchAll が
  // per-repo に握り潰し、report の 200 応答は止めない。
  if (stagedImage) {
    const compat = await computeCompatibility(
      env.COMPAT_KV,
      v.data.repo,
      stagedImage,
    );
    const dispatches = decideBackendDeployRetestDispatches(compat);
    if (dispatches.length > 0) {
      await dispatchAll(env, dispatches);
    }
  }

  // Auto-flip (armed 機構, Refs #476 / #481)。この repo の release が pending に
  // 載ったので、armed set の全 repo が揃ったか判定し、揃って compat gate も通れば
  // flip all を自動発火する。`v.data.repo` を justReleasedRepo hint として渡し、
  // 自分の書き込みが `kv.list` に未反映でも released 扱いで即 flip できるようにする。
  // さらに、webhook 到達と切り離した recheck ループを (未起動なら) 予約して、list
  // ラグ・取りこぼし・flip 失敗を後追いで回収する。best-effort — armed 判定 / flip の
  // 失敗で report 200 は止めない。
  try {
    const outcome = await maybeAutoFlip(
      env,
      new Date().toISOString(),
      v.data.repo,
    );
    console.log(
      JSON.stringify({
        msg: "auto-flip",
        trigger: "pending-release",
        repo: v.data.repo,
        outcome,
      }),
    );
    await scheduleAutoFlipRecheck(env);
  } catch {
    // armed 機構の失敗は release 報告を妨げない (armed record は残り timeout で中断)。
  }

  // Pending releases / auto-flip 進捗が変わった → 開いている /release-wave を live 更新。
  await broadcastChange(env);
  return jsonResponse(200, { ok: true, record });
}

// ----------------------------------------------------------------------------
// GET /webhooks/release-wave/backend-current-image  (compatibility, Refs #157)
// ----------------------------------------------------------------------------

/**
 * frontend CI が「現 production backend image」を解決する用の read endpoint。
 *
 * compat-api.ts の `GET /backend-current-image` と機能等価だが、そちらは
 * ci-dashboard host 全体に被さる Cloudflare Access edge gate の背後にあり
 * GitHub Actions runner からは 302 で到達できない。本 endpoint は CF Access が
 * bypass している `/webhooks/*` prefix 配下に置き、代わりに shared secret
 * (`X-Release-Wave-Webhook-Secret`) で認証する。
 */
export async function handleBackendCurrentImageWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use GET" });
  }
  const provided = request.headers.get("X-Release-Wave-Webhook-Secret") ?? "";
  const expected = await env.RELEASE_WAVE_WEBHOOK_SECRET.get();
  if (!expected) {
    return jsonResponse(500, {
      code: "SECRET_NOT_CONFIGURED",
      error: "RELEASE_WAVE_WEBHOOK_SECRET is not bound",
    });
  }
  if (!constantTimeEqual(provided, expected)) {
    return jsonResponse(401, {
      code: "UNAUTHORIZED",
      error: "invalid webhook secret",
    });
  }

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

// ----------------------------------------------------------------------------
// /webhooks/release-wave/traffic-report  (Refs #137)
// ----------------------------------------------------------------------------

/**
 * frontend CI が deploy 時に worker の version traffic split を報告する。
 * `wrangler deployments list` 相当の「version_id → percentage」配列を受け取り、
 * `traffic::<repo>` (COMPAT_KV) に upsert する。Compatibility グラフ下に
 * 「100% がどの version / 0% (no-traffic) がどの version」を出すための入力。
 *
 * body (created_on は任意。`wrangler versions list` の metadata.created_on 由来):
 *   {
 *     "repo": "ippoan/auth-worker",
 *     "versions": [
 *       { "version_id": "530b908c-...", "percentage": 100, "created_on": "2026-05-28T..." },
 *       { "version_id": "1a2b3c4d-...", "percentage": 0,   "created_on": "2026-05-29T..." }
 *     ]
 *   }
 */
const trafficReportSchema = z.object({
  repo: z.string().min(1),
  // monorepo unit worker 名 (CF script 名)。省略時は単一 worker / legacy = repo-key。
  worker_name: z.string().min(1).nullish(),
  versions: z
    .array(
      z.object({
        version_id: z.string().min(1),
        percentage: z.number().min(0).max(100),
        // null / undefined / 省略すべて許容 (送信側が null を載せても弾かない)。
        created_on: z.string().min(1).nullish(),
        tag: z.string().min(1).nullish(),
      }),
    )
    .min(1),
});

export async function handleTrafficReportWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const v = await validateAndAuth(request, env, trafficReportSchema);
  if (!v.ok) return v.response;
  if (!env.COMPAT_KV) {
    return jsonResponse(500, {
      code: "KV_NOT_CONFIGURED",
      error: "COMPAT_KV is not bound",
    });
  }
  const record = await recordTraffic(env.COMPAT_KV, {
    repo: v.data.repo,
    worker_name: v.data.worker_name ?? null,
    versions: v.data.versions.map((x) => ({
      version_id: x.version_id,
      percentage: x.percentage,
      created_on: x.created_on ?? null,
      tag: x.tag ?? null,
    })),
    now: new Date().toISOString(),
  });
  // Traffic (version split) / Current (live) が変わった → live 更新。
  await broadcastChange(env);
  return jsonResponse(200, { ok: true, record });
}

// ----------------------------------------------------------------------------
// /webhooks/release-wave/backend-traffic-report  (Cloud Run 実 traffic、Refs #256)
// ----------------------------------------------------------------------------

/**
 * release-wave-handler の cloudrun flip / rollback 後に、release-wave-gcp の
 * `/cloudrun/stage-check` (GetService) で取得した Cloud Run の **実 traffic split**
 * (`status.traffic[]`) を service 単位で報告する。ci-dashboard 側で
 * `backend-traffic::<repo>` に upsert し、/release-wave の backend 表示を GCP の
 * 実態 (Flip 前の `旧 100% + 新 pending 0%` 含む) に追従させる。
 *
 * frontend の `/traffic-report` (Cloudflare Workers の version split) と対称だが、
 * backend は 1 repo = N service なので service 配列で受ける。
 *
 * body:
 *   {
 *     "repo": "ippoan/rust-alc-api",
 *     "services": [
 *       {
 *         "service": "rust-alc-api",
 *         "revisions": [
 *           { "revision": "rust-alc-api-00042-abc", "percent": 100, "tag": "v1.4.2" },
 *           { "revision": "rust-alc-api-00043-xyz", "percent": 0,   "tag": "pending-v1-4-3" }
 *         ]
 *       }
 *     ]
 *   }
 */
const backendTrafficReportSchema = z.object({
  repo: z.string().min(1),
  services: z
    .array(
      z.object({
        service: z.string().min(1),
        // traffic 未設定 (revision 0 件) の service も許容する。
        revisions: z.array(
          z.object({
            revision: z.string().min(1),
            percent: z.number().min(0).max(100),
            // null / undefined / 省略すべて許容 (tag の無い revision がある)。
            tag: z.string().min(1).nullish(),
          }),
        ),
      }),
    )
    .min(1),
});

export async function handleBackendTrafficReportWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const v = await validateAndAuth(request, env, backendTrafficReportSchema);
  if (!v.ok) return v.response;
  if (!env.COMPAT_KV) {
    return jsonResponse(500, {
      code: "KV_NOT_CONFIGURED",
      error: "COMPAT_KV is not bound",
    });
  }
  const services: BackendServiceTraffic[] = v.data.services.map((s) => ({
    service: s.service,
    revisions: s.revisions.map((r) => ({
      revision: r.revision,
      percent: r.percent,
      tag: r.tag ?? null,
    })),
  }));
  const record = await recordBackendTraffic(env.COMPAT_KV, {
    repo: v.data.repo,
    services,
    now: new Date().toISOString(),
  });
  // Backend traffic / rollback (Cloud Run revision) が変わった → live 更新。
  await broadcastChange(env);
  return jsonResponse(200, { ok: true, record });
}
