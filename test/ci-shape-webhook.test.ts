/**
 * `/webhooks/ci-shape` receiver。Refs ippoan/ci-dashboard#378.
 *
 * - 405 on non-POST
 * - 500 on SECRET_NOT_CONFIGURED
 * - 401 on invalid secret
 * - 400 on bad JSON / schema mismatch
 * - 200 on success + KV put + listCiShapes 経由で取得できる
 */
import { describe, it, expect } from "vitest";
import {
  handleCiShapeWebhook,
  listCiShapes,
  ciShapeKey,
  type CiShapePayload,
} from "../src/ci-shape-webhook";
import type { Env } from "../src/index";

const SECRET = "test-shape-secret";

function memKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: cursor ?? "" };
    },
  } as unknown as KVNamespace;
}

function testEnv(secret?: string): Env {
  return {
    CI_STATUS: memKv(),
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => secret ?? "" },
  } as unknown as Env;
}

function validBody(over: Partial<CiShapePayload> = {}): unknown {
  return {
    schema_version: 1,
    owner: "ippoan",
    repo: "auth-worker",
    scanned_at: "2026-06-17T08:00:00Z",
    workflows: [
      {
        file: ".github/workflows/test.yml",
        name: "CI",
        triggers: ["pull_request"],
        permissions: { contents: "write" },
        reusable_calls: [
          {
            job_id: "ci",
            target_owner: "ippoan",
            target_repo: "ci-workflows",
            target_file: ".github/workflows/frontend-ci.yml",
            reusable_name: "frontend-ci.yml",
            ref: "main",
            pinned_sha: false,
            secrets_inherit: true,
          },
        ],
        self_jobs: [],
        deviations: ["unpinned-ref-main"],
      },
    ],
    ...over,
  };
}

function req(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("https://ci-dashboard.ippoan.org/webhooks/ci-shape", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

describe("handleCiShapeWebhook", () => {
  it("non-POST → 405", async () => {
    const res = await handleCiShapeWebhook(req(null, {}, "GET"), testEnv(SECRET));
    expect(res.status).toBe(405);
  });

  it("secret 未設定 → 500 SECRET_NOT_CONFIGURED", async () => {
    const res = await handleCiShapeWebhook(req(validBody()), testEnv(""));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SECRET_NOT_CONFIGURED");
  });

  it("ヘッダなし / 不一致 → 401 UNAUTHORIZED", async () => {
    const env = testEnv(SECRET);
    const res1 = await handleCiShapeWebhook(req(validBody()), env);
    expect(res1.status).toBe(401);
    const res2 = await handleCiShapeWebhook(
      req(validBody(), { "X-CI-Shape-Secret": "wrong" }),
      env,
    );
    expect(res2.status).toBe(401);
  });

  it("BAD_JSON で 400", async () => {
    const env = testEnv(SECRET);
    const r = new Request("https://example.com/webhooks/ci-shape", {
      method: "POST",
      headers: { "X-CI-Shape-Secret": SECRET, "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await handleCiShapeWebhook(r, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("BAD_JSON");
  });

  it("schema 違反 (owner 不正) → 400 BAD_REQUEST", async () => {
    const env = testEnv(SECRET);
    const res = await handleCiShapeWebhook(
      req(validBody({ owner: "bad/slash" } as Partial<CiShapePayload>), {
        "X-CI-Shape-Secret": SECRET,
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.error).toContain("owner");
  });

  it("OK → 200 + KV 保存 + listCiShapes で取れる", async () => {
    const env = testEnv(SECRET);
    const fixedNow = () => "2026-06-17T08:01:00Z";
    const res = await handleCiShapeWebhook(
      req(validBody(), { "X-CI-Shape-Secret": SECRET }),
      env,
      fixedNow,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; key: string };
    expect(body.ok).toBe(true);
    expect(body.key).toBe("ci-shape:ippoan/auth-worker");

    const stored = await env.CI_STATUS.get(ciShapeKey("ippoan", "auth-worker"));
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.owner).toBe("ippoan");
    expect(parsed.received_at).toBe("2026-06-17T08:01:00Z");

    const all = await listCiShapes(env);
    expect(all).toHaveLength(1);
    expect(all[0]!.repo).toBe("auth-worker");
  });

  it("constant-time compare: 長さ違いでも 401 (timing leak しない)", async () => {
    const env = testEnv(SECRET);
    const res = await handleCiShapeWebhook(
      req(validBody(), { "X-CI-Shape-Secret": "x" }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("listCiShapes", () => {
  it("複数 repo を返す + 壊れた JSON は skip", async () => {
    const env = testEnv(SECRET);
    await env.CI_STATUS.put(
      "ci-shape:ippoan/a",
      JSON.stringify({
        schema_version: 1,
        owner: "ippoan",
        repo: "a",
        scanned_at: "2026-06-17T00:00:00Z",
        workflows: [],
      }),
    );
    await env.CI_STATUS.put("ci-shape:ippoan/b", "garbage{not-json");
    // 別 prefix はスキャン対象外。
    await env.CI_STATUS.put("run:something", "ignored");

    const all = await listCiShapes(env);
    expect(all).toHaveLength(1);
    expect(all[0]!.repo).toBe("a");
  });
});
