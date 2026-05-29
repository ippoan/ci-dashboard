/**
 * GitHub Actions step が叩く HTTP webhook 群。MCP 経路と機能等価だが、
 * OAuth 不要の shared secret 認証で Actions 側を curl 1 行で済むようにする。
 *
 * 全 endpoint 共通:
 *   POST 必須、`X-Release-Wave-Webhook-Secret` header の constant-time 比較、
 *   Secrets Store binding `RELEASE_WAVE_WEBHOOK_SECRET` から expected 値取得、
 *   body は JSON、エラーは JSON `{ code, error }` で返す。
 *
 * 提供する 3 endpoint:
 *   POST /webhooks/release-wave/stage-report       — release-wave-handler が
 *      stage deploy 完了後に呼ぶ (= release_wave_stage MCP tool 等価)
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
import { recordFrontendTest, recordBackendDeploy, getBackendCurrent } from "./compat";
import { recordPendingRelease } from "./pending-release";
import { recordTraffic } from "./traffic";

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
// /webhooks/release-wave/stage-report  (Phase 4 NEW)
// ----------------------------------------------------------------------------

/**
 * stage-report body:
 *   {
 *     "wave_id": "wave_...",
 *     "repo": "ippoan/rust-alc-api",
 *     "ok": true,
 *     "preview_url": "https://preview-rust-alc-api.ippoan.org",      // ok=true 時のみ意味あり
 *     "flip_from_revision": "rust-alc-api-00041-zzz",                // ok=true 時のみ (rollback 戻し先)
 *     "previewed_version_id": "1a2b3c4d-...",                        // CF Workers のみ (flip 対象 version)
 *     "error": "build failed"                                        // ok=false 時のみ
 *   }
 */
const stageReportSchema = z.object({
  wave_id: z.string().min(1),
  repo: z.string().min(1),
  ok: z.boolean(),
  preview_url: z.string().url().optional(),
  flip_from_revision: z.string().optional(),
  previewed_version_id: z.string().optional(),
  error: z.string().optional(),
});

export async function handleStageReportWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const v = await validateAndAuth(request, env, stageReportSchema);
  if (!v.ok) return v.response;
  const result = (await hubStub(env).stageReport({
    wave_id: v.data.wave_id,
    repo: v.data.repo,
    ok: v.data.ok,
    preview_url: v.data.preview_url ?? null,
    flip_from_revision: v.data.flip_from_revision ?? null,
    previewed_version_id: v.data.previewed_version_id ?? null,
    error: v.data.error ?? null,
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
 *     "error": "patch denied"   // ok=false 時のみ
 *   }
 */
const flipReportSchema = z.object({
  wave_id: z.string().min(1),
  repo: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
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
  // version_id は wrangler の version id (UUID)。flip 時に
  // `wrangler versions deploy <id>@100%` に渡るため UUID 形式を強制する。
  version_id: z
    .string()
    .regex(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
      "version_id must be a UUID",
    ),
  tag: z.string().min(1),
  preview_url: z.string().url().optional(),
});

export async function handlePendingReleaseWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const v = await validateAndAuth(request, env, pendingReleaseSchema);
  if (!v.ok) return v.response;
  const record = await recordPendingRelease(env.COMPAT_KV, {
    repo: v.data.repo,
    version_id: v.data.version_id,
    tag: v.data.tag,
    preview_url: v.data.preview_url ?? null,
    now: new Date().toISOString(),
  });
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
    versions: v.data.versions.map((x) => ({
      version_id: x.version_id,
      percentage: x.percentage,
      created_on: x.created_on ?? null,
      tag: x.tag ?? null,
    })),
    now: new Date().toISOString(),
  });
  return jsonResponse(200, { ok: true, record });
}
