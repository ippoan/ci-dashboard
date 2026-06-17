// `/webhooks/ci-shape` receiver。Refs ippoan/ci-dashboard#378.
//
// 各 repo の CI から `ippoan/ci-workflows/.github/workflows/ci-shape-report.yml`
// reusable 経由で叩かれる webhook。caller が自分の `.github/workflows/*.yml`
// を parse した shape JSON を POST してくる。
//
// 認証:
// - `X-CI-Shape-Secret` header の constant-time 比較
// - 値は ippoan org の `RELEASE_WAVE_WEBHOOK_SECRET` を re-use (新規 secret
//   を作らない方針)。binding は既存 `env.RELEASE_WAVE_WEBHOOK_SECRET`
//   (wrangler.jsonc) をそのまま使う
//
// 保存:
// - CI_STATUS KV namespace を `ci-shape:{owner}/{repo}` prefix で再利用
//   (COMPAT_KV が同 namespace を別 prefix で使っているのと同パターン)
// - 値は受信した workflow 配列 + meta を JSON のまま 90 日 TTL で put

import { z } from "zod";
import type { Env } from "./index";

const REUSABLE_CALL_SCHEMA = z.object({
  job_id: z.string(),
  target_owner: z.string(),
  target_repo: z.string(),
  target_file: z.string(),
  reusable_name: z.string(),
  ref: z.string(),
  pinned_sha: z.boolean(),
  secrets_inherit: z.boolean(),
});

const WORKFLOW_SCHEMA = z.object({
  file: z.string(),
  name: z.string().nullable().optional(),
  triggers: z.array(z.string()).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  job_permissions_union: z.array(z.string()).optional(),
  reusable_calls: z.array(REUSABLE_CALL_SCHEMA).optional(),
  self_jobs: z.array(z.string()).optional(),
  deviations: z.array(z.string()).optional(),
  parse_error: z.string().optional(),
  fetch_error: z.boolean().optional(),
});

export const CI_SHAPE_BODY_SCHEMA = z.object({
  schema_version: z.literal(1),
  owner: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  repo: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),
  head_sha: z.string().min(7).max(64).optional(),
  scanned_at: z.string().min(1),
  workflows: z.array(WORKFLOW_SCHEMA),
});

export type CiShapePayload = z.infer<typeof CI_SHAPE_BODY_SCHEMA>;

const KV_PREFIX = "ci-shape:";
// 90 days — caller が止まった repo の古い shape は自然に消える。
const TTL_SECONDS = 90 * 24 * 3600;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function ciShapeKey(owner: string, repo: string): string {
  return `${KV_PREFIX}${owner}/${repo}`;
}

/** webhook handler 本体。pure 寄り (KV / secret は env から、time は引数注入)。 */
export async function handleCiShapeWebhook(
  request: Request,
  env: Env,
  now: () => string = () => new Date().toISOString(),
): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }
  const provided = request.headers.get("X-CI-Shape-Secret") ?? "";
  const expected = await env.RELEASE_WAVE_WEBHOOK_SECRET.get();
  if (!expected) {
    return json(500, {
      code: "SECRET_NOT_CONFIGURED",
      error: "RELEASE_WAVE_WEBHOOK_SECRET is not bound",
    });
  }
  if (!constantTimeEqual(provided, expected)) {
    return json(401, { code: "UNAUTHORIZED", error: "invalid webhook secret" });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(400, { code: "BAD_JSON", error: "request body is not valid JSON" });
  }
  const parsed = CI_SHAPE_BODY_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return json(400, { code: "BAD_REQUEST", error: issues });
  }
  const body = parsed.data;

  const stored = {
    ...body,
    received_at: now(),
  };
  await env.CI_STATUS.put(ciShapeKey(body.owner, body.repo), JSON.stringify(stored), {
    expirationTtl: TTL_SECONDS,
  });
  return json(200, { ok: true, key: ciShapeKey(body.owner, body.repo) });
}

/** UI 側からの読み出し: 全 ci-shape:* key を list して JSON parse して返す。 */
export async function listCiShapes(env: Env): Promise<CiShapePayload[]> {
  const out: CiShapePayload[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CI_STATUS.list({ prefix: KV_PREFIX, cursor });
    for (const k of page.keys) {
      const raw = await env.CI_STATUS.get(k.name);
      if (!raw) continue;
      try {
        const parsed = CI_SHAPE_BODY_SCHEMA.safeParse(JSON.parse(raw));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // ignore corrupt entry
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
