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
 *     "flip_from_revision": "rust-alc-api-00041-zzz",                // ok=true 時のみ
 *     "error": "build failed"                                        // ok=false 時のみ
 *   }
 */
const stageReportSchema = z.object({
  wave_id: z.string().min(1),
  repo: z.string().min(1),
  ok: z.boolean(),
  preview_url: z.string().url().optional(),
  flip_from_revision: z.string().optional(),
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
