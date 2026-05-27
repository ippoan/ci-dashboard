/**
 * GitHub Actions step からの contract migration 適用通知を受ける webhook。
 *
 * MCP 経路 (`release_wave_contract_applied` tool) は OAuth (auth-worker
 * 経由) を必要とし、Actions 側で実装が重い。本 webhook は shared secret
 * 認証のシンプルな HTTP endpoint で、Actions step が curl で叩く想定。
 *
 * 認証:
 *   X-Release-Wave-Webhook-Secret header の constant-time 比較。
 *   Secrets Store binding `RELEASE_WAVE_WEBHOOK_SECRET` から値取得。
 *
 * Body:
 *   {
 *     "wave_id": "wave_2026_05_27_01",
 *     "repo": "ippoan/rust-alc-api",
 *     "migration_id": "20260601_001_drop_legacy_token"
 *   }
 *
 * 成功時 200 + wave 現状 JSON、失敗時 4xx + { code, error }。
 *
 * 設計の親 issue: ippoan/ci-dashboard#137 "release_wave_contract_applied MCP tool 仕様"
 */

import { z } from "zod";
import type { Env } from "../index";
import type { ReleaseWaveHub, RpcResult } from "./do";
import type { WaveState } from "./types";

const requestSchema = z.object({
  wave_id: z.string().min(1),
  repo: z.string().min(1),
  migration_id: z.string().min(1),
});

/** constant-time string compare (= timing attack 防止)。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Web Crypto に直接 ConstantTimeCompare は無いので XOR sum で代替。
  // 長さ check を分けたうえで 1 文字ずつ XOR 累算するので timing は均一。
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

/**
 * POST /webhooks/release-wave/contract-applied を処理する。
 * 全エラーは JSON body で返す (Actions step が parse できるよう)。
 */
export async function handleContractAppliedWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }

  // 1) Secret check
  const provided = request.headers.get("X-Release-Wave-Webhook-Secret") ?? "";
  const expected = await env.RELEASE_WAVE_WEBHOOK_SECRET.get();
  if (!expected) {
    return jsonResponse(500, {
      code: "SECRET_NOT_CONFIGURED",
      error: "RELEASE_WAVE_WEBHOOK_SECRET is not bound",
    });
  }
  if (!constantTimeEqual(provided, expected)) {
    return jsonResponse(401, { code: "UNAUTHORIZED", error: "invalid webhook secret" });
  }

  // 2) Body parse + validate
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse(400, { code: "BAD_JSON", error: "request body is not valid JSON" });
  }
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    // zod 4 の `error.issues` を読みつつ、フォーマット差異で fail しないよう
    // `error.message` も含めて返す (= テスト assertion でも path 名でも文言
    // でも match できる)。
    const issuesText = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: issuesText || parsed.error.message || "validation failed",
    });
  }

  // 3) Call DO。Workers RPC は戻り値を Disposable で intersect するため、
  //    TS の discriminated-union narrowing が崩れる。as cast で復元する。
  const id = env.RELEASE_WAVE_HUB.idFromName("singleton");
  const stub = env.RELEASE_WAVE_HUB.get(id) as DurableObjectStub<ReleaseWaveHub>;
  const result = (await stub.contractApplied({
    wave_id: parsed.data.wave_id,
    repo: parsed.data.repo,
    migration_id: parsed.data.migration_id,
  })) as RpcResult<WaveState>;

  if (result.ok) {
    return jsonResponse(200, { ok: true, state: result.data });
  }
  // DO の RpcError code を HTTP status に map
  const httpStatus =
    result.code === "NOT_FOUND" ? 404
      : result.code === "REPO_NOT_IN_WAVE" ? 404
      : 409; // INVALID_TRANSITION / TERMINAL_STATE / etc.
  return jsonResponse(httpStatus, {
    ok: false,
    code: result.code,
    error: result.error,
  });
}
