import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleContractAppliedWebhook,
  handleFlipReportWebhook,
  handlePendingReleaseWebhook,
  handleTrafficReportWebhook,
  handleBackendTrafficReportWebhook,
  handleBackendDeployReportWebhook,
  handleFrontendTestReportWebhook,
} from "../../src/release-wave/webhook";
import { recordFrontendTest } from "../../src/release-wave/compat";
import { getPendingRelease } from "../../src/release-wave/pending-release";
import { getTraffic } from "../../src/release-wave/traffic";
import { getBackendTraffic } from "../../src/release-wave/backend-traffic";
import type { Env } from "../../src/index";
import type { ReleaseWaveHub } from "../../src/release-wave/do";

/** in-memory KVNamespace for COMPAT_KV-backed handlers. */
function memKv(seed: Record<string, unknown> = {}): KVNamespace {
  const store = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  return {
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

// ----------------------------------------------------------------------------
// Fake env / request builder (3 endpoint 共通)
// ----------------------------------------------------------------------------

type FakeSpies = {
  contractApplied: ReturnType<typeof vi.fn>;
  flipReport: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
};

function fakeEnv(opts: {
  secret?: string | null;
  contractAppliedReturn?:
    | { ok: true; data: unknown }
    | { ok: false; code: string; error: string };
  flipReportReturn?:
    | { ok: true; data: unknown }
    | { ok: false; code: string; error: string };
  compatKv?: KVNamespace;
} = {}): { env: Env; spies: FakeSpies } {
  const okState = { wave_id: "w1", state: "flipping" };
  const spies: FakeSpies = {
    contractApplied: vi
      .fn()
      .mockResolvedValue(opts.contractAppliedReturn ?? { ok: true, data: okState }),
    flipReport: vi
      .fn()
      .mockResolvedValue(opts.flipReportReturn ?? { ok: true, data: okState }),
    // KV 系 report handler が live 更新のため呼ぶ broadcast (Refs #479)。
    broadcast: vi.fn().mockResolvedValue(undefined),
  };
  const hub = spies as unknown as ReleaseWaveHub;
  const env = {
    RELEASE_WAVE_HUB: {
      idFromName: () => ({}),
      get: () => hub,
    },
    RELEASE_WAVE_WEBHOOK_SECRET: {
      get: async () =>
        opts.secret === undefined ? "expected-secret" : opts.secret,
    },
    COMPAT_KV: opts.compatKv,
  } as unknown as Env;
  return { env, spies };
}

function jsonRequest(opts: {
  url?: string;
  method?: string;
  body?: unknown;
  secret?: string | null;
}): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.secret !== null && opts.secret !== undefined) {
    headers["X-Release-Wave-Webhook-Secret"] = opts.secret;
  }
  const method = opts.method ?? "POST";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && opts.body !== undefined) {
    init.body =
      typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  return new Request(
    opts.url ?? "https://ci-dashboard.ippoan.org/webhooks/release-wave/contract-applied",
    init,
  );
}

// ============================================================================
// /webhooks/release-wave/contract-applied
// ============================================================================

describe("handleContractAppliedWebhook", () => {
  it("rejects non-POST with 405", async () => {
    const { env } = fakeEnv();
    const resp = await handleContractAppliedWebhook(
      jsonRequest({ method: "GET", secret: "expected-secret" }),
      env,
    );
    expect(resp.status).toBe(405);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 500 when secret binding is missing", async () => {
    const { env } = fakeEnv({ secret: null });
    const resp = await handleContractAppliedWebhook(
      jsonRequest({
        secret: "anything",
        body: { wave_id: "w1", repo: "ippoan/a", migration_id: "m" },
      }),
      env,
    );
    expect(resp.status).toBe(500);
    expect(((await resp.json()) as { code: string }).code).toBe("SECRET_NOT_CONFIGURED");
  });

  it("rejects with 401 on missing header", async () => {
    const { env } = fakeEnv();
    const resp = await handleContractAppliedWebhook(
      jsonRequest({
        secret: null,
        body: { wave_id: "w1", repo: "ippoan/a", migration_id: "m" },
      }),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it("rejects with 401 on wrong header value", async () => {
    const { env } = fakeEnv();
    const resp = await handleContractAppliedWebhook(
      jsonRequest({
        secret: "wrong-secret",
        body: { wave_id: "w1", repo: "ippoan/a", migration_id: "m" },
      }),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it("rejects with 401 on different-length header (constant-time path)", async () => {
    const { env } = fakeEnv();
    const resp = await handleContractAppliedWebhook(
      jsonRequest({
        secret: "short",
        body: { wave_id: "w1", repo: "ippoan/a", migration_id: "m" },
      }),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it("rejects with 400 on non-JSON body", async () => {
    const { env } = fakeEnv();
    const resp = await handleContractAppliedWebhook(
      jsonRequest({ secret: "expected-secret", body: "not json {" }),
      env,
    );
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { code: string }).code).toBe("BAD_JSON");
  });

  it("rejects with 400 on missing fields", async () => {
    const { env } = fakeEnv();
    const resp = await handleContractAppliedWebhook(
      jsonRequest({ secret: "expected-secret", body: { wave_id: "w1" } }),
      env,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { code: string; error: string };
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.error).toContain("repo");
    expect(body.error).toContain("migration_id");
  });

  it("succeeds (200) when secret OK and DO returns ok", async () => {
    const { env, spies } = fakeEnv();
    const resp = await handleContractAppliedWebhook(
      jsonRequest({
        secret: "expected-secret",
        body: {
          wave_id: "wave_2026_05_27_01",
          repo: "ippoan/rust-alc-api",
          migration_id: "20260601_001_drop",
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.contractApplied).toHaveBeenCalledWith({
      wave_id: "wave_2026_05_27_01",
      repo: "ippoan/rust-alc-api",
      migration_id: "20260601_001_drop",
    });
  });

  it("maps INVALID_TRANSITION to 409", async () => {
    const { env } = fakeEnv({
      contractAppliedReturn: {
        ok: false,
        code: "INVALID_TRANSITION",
        error: "wave is staging",
      },
    });
    const resp = await handleContractAppliedWebhook(
      jsonRequest({
        secret: "expected-secret",
        body: { wave_id: "w1", repo: "ippoan/a", migration_id: "m" },
      }),
      env,
    );
    expect(resp.status).toBe(409);
  });

  it("maps NOT_FOUND to 404", async () => {
    const { env } = fakeEnv({
      contractAppliedReturn: { ok: false, code: "NOT_FOUND", error: "no wave" },
    });
    const resp = await handleContractAppliedWebhook(
      jsonRequest({
        secret: "expected-secret",
        body: { wave_id: "ghost", repo: "ippoan/a", migration_id: "m" },
      }),
      env,
    );
    expect(resp.status).toBe(404);
  });

  it("maps REPO_NOT_IN_WAVE to 404", async () => {
    const { env } = fakeEnv({
      contractAppliedReturn: {
        ok: false,
        code: "REPO_NOT_IN_WAVE",
        error: "repo not in wave",
      },
    });
    const resp = await handleContractAppliedWebhook(
      jsonRequest({
        secret: "expected-secret",
        body: { wave_id: "w1", repo: "ippoan/unrelated", migration_id: "m" },
      }),
      env,
    );
    expect(resp.status).toBe(404);
  });
});

// ============================================================================
// /webhooks/release-wave/flip-report
// ============================================================================

const FLIP_URL =
  "https://ci-dashboard.ippoan.org/webhooks/release-wave/flip-report";

describe("handleFlipReportWebhook", () => {
  it("returns 405 on GET", async () => {
    const { env } = fakeEnv();
    const resp = await handleFlipReportWebhook(
      jsonRequest({ url: FLIP_URL, method: "GET", secret: "expected-secret" }),
      env,
    );
    expect(resp.status).toBe(405);
  });

  it("returns 401 on wrong secret", async () => {
    const { env } = fakeEnv();
    const resp = await handleFlipReportWebhook(
      jsonRequest({
        url: FLIP_URL,
        secret: "wrong",
        body: { wave_id: "w1", repo: "ippoan/a", ok: true },
      }),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it("returns 400 on missing fields", async () => {
    const { env } = fakeEnv();
    const resp = await handleFlipReportWebhook(
      jsonRequest({
        url: FLIP_URL,
        secret: "expected-secret",
        body: { wave_id: "w1" },
      }),
      env,
    );
    expect(resp.status).toBe(400);
  });

  it("succeeds with ok=true", async () => {
    const { env, spies } = fakeEnv();
    const resp = await handleFlipReportWebhook(
      jsonRequest({
        url: FLIP_URL,
        secret: "expected-secret",
        body: { wave_id: "w1", repo: "ippoan/a", ok: true },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.flipReport).toHaveBeenCalledWith({
      wave_id: "w1",
      repo: "ippoan/a",
      ok: true,
      error: null,
      version_id: null,
      worker_name: null,
    });
  });

  it("forwards version_id + worker_name when provided (Refs #427)", async () => {
    const { env, spies } = fakeEnv();
    const resp = await handleFlipReportWebhook(
      jsonRequest({
        url: FLIP_URL,
        secret: "expected-secret",
        body: {
          wave_id: "w1",
          repo: "ippoan/nuxt-notify",
          ok: true,
          version_id: "530b908c-5385-451c-b163-747caaedafd3",
          worker_name: "notify-email-receiver",
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.flipReport).toHaveBeenCalledWith({
      wave_id: "w1",
      repo: "ippoan/nuxt-notify",
      ok: true,
      error: null,
      version_id: "530b908c-5385-451c-b163-747caaedafd3",
      worker_name: "notify-email-receiver",
    });
  });

  it("succeeds with ok=false + error", async () => {
    const { env, spies } = fakeEnv();
    const resp = await handleFlipReportWebhook(
      jsonRequest({
        url: FLIP_URL,
        secret: "expected-secret",
        body: {
          wave_id: "w1",
          repo: "ippoan/a",
          ok: false,
          error: "traffic update denied",
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.flipReport).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "traffic update denied" }),
    );
  });

  it("maps NOT_FOUND to 404", async () => {
    const { env } = fakeEnv({
      flipReportReturn: { ok: false, code: "NOT_FOUND", error: "no wave" },
    });
    const resp = await handleFlipReportWebhook(
      jsonRequest({
        url: FLIP_URL,
        secret: "expected-secret",
        body: { wave_id: "ghost", repo: "ippoan/a", ok: true },
      }),
      env,
    );
    expect(resp.status).toBe(404);
  });

  it("maps INVALID_TRANSITION to 409", async () => {
    const { env } = fakeEnv({
      flipReportReturn: {
        ok: false,
        code: "INVALID_TRANSITION",
        error: "wave not in flipping",
      },
    });
    const resp = await handleFlipReportWebhook(
      jsonRequest({
        url: FLIP_URL,
        secret: "expected-secret",
        body: { wave_id: "w1", repo: "ippoan/a", ok: true },
      }),
      env,
    );
    expect(resp.status).toBe(409);
  });
});

// ============================================================================
// /webhooks/release-wave/pending-release  (Refs #181 / #174)
// ============================================================================

const PENDING_URL =
  "https://ci-dashboard.ippoan.org/webhooks/release-wave/pending-release";
const VALID_VID = "530b908c-5385-451c-b163-747caaedafd3";

describe("handlePendingReleaseWebhook", () => {
  it("stores a pending release record (ok=true)", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handlePendingReleaseWebhook(
      jsonRequest({
        url: PENDING_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/auth-worker",
          version_id: VALID_VID,
          tag: "v0.2.38",
          preview_url: "https://abc-auth-worker.example.workers.dev",
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const rec = await getPendingRelease(kv, "ippoan/auth-worker");
    expect(rec).not.toBeNull();
    expect(rec!.version_id).toBe(VALID_VID);
    expect(rec!.tag).toBe("v0.2.38");
    expect(rec!.preview_url).toBe("https://abc-auth-worker.example.workers.dev");
  });

  it("accepts missing preview_url (nullified)", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handlePendingReleaseWebhook(
      jsonRequest({
        url: PENDING_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/auth-worker", version_id: VALID_VID, tag: "v1.0.0" },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const rec = await getPendingRelease(kv, "ippoan/auth-worker");
    expect(rec!.preview_url).toBeNull();
  });

  it("accepts non-UUID version_id (cloudrun pending-<tag>) (Refs #237)", async () => {
    // cloudrun は revision tag (pending-v0-0-79) を version_id に入れる。
    // UUID 強制をやめたので 200 で受理し record を保存する。
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handlePendingReleaseWebhook(
      jsonRequest({
        url: PENDING_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/rust-alc-api",
          version_id: "pending-v0-0-79",
          tag: "v0.0.79",
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const rec = await getPendingRelease(kv, "ippoan/rust-alc-api");
    expect(rec!.version_id).toBe("pending-v0-0-79");
    expect(rec!.tag).toBe("v0.0.79");
  });

  it("rejects bad webhook secret with 401", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handlePendingReleaseWebhook(
      jsonRequest({
        url: PENDING_URL,
        secret: "wrong-secret",
        body: { repo: "ippoan/auth-worker", version_id: VALID_VID, tag: "v1.0.0" },
      }),
      env,
    );
    expect(resp.status).toBe(401);
  });
});

// ============================================================================
// pending-release webhook → Auto-tag ON repo の継続 auto-flip (Refs #494)
// ============================================================================

describe("handlePendingReleaseWebhook → runContinuousAutoFlip wiring", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** CI_HUB (Hub DO) の auto-tag repos set を in-memory で模す fake namespace。 */
  function memAutoTagHub(repos: string[] = []): unknown {
    const stub = {
      fetch: async (req: Request) => {
        const u = new URL(req.url);
        if (u.pathname === "/auto-tag-repos" && req.method === "GET") {
          return Response.json(repos);
        }
        return new Response("not found", { status: 404 });
      },
    };
    return { idFromName: () => ({}), get: () => stub };
  }

  const FRESH_TOKEN = {
    token: "ghs_continuous_auto_flip_token",
    expires_at_ms: Date.now() + 3600_000,
  };

  it("flips immediately when the repo is Auto-tag ON and the compat gate is clear", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    (env as unknown as { CI_HUB: unknown }).CI_HUB = memAutoTagHub(["ippoan/auth-worker"]);
    // pendingFlipAllCore の GitHub dispatch は getGitHubToken(env) 経由で
    // CI_STATUS の cache hit を要る (auto-flip.test.ts の envWith と同方式)。
    (env as unknown as { CI_STATUS: unknown }).CI_STATUS = memKv({
      "auth-client-worker:gh-token": FRESH_TOKEN,
    });
    const resp = await handlePendingReleaseWebhook(
      jsonRequest({
        url: PENDING_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/auth-worker", version_id: VALID_VID, tag: "v0.2.38" },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const dispatched = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(dispatched.some((u) => u.includes("/repos/ippoan/auth-worker/dispatches"))).toBe(true);
  });

  it("does not flip when the repo is NOT Auto-tag ON", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    (env as unknown as { CI_HUB: unknown }).CI_HUB = memAutoTagHub([]);
    const resp = await handlePendingReleaseWebhook(
      jsonRequest({
        url: PENDING_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/auth-worker", version_id: VALID_VID, tag: "v0.2.38" },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const dispatched = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(dispatched.some((u) => u.includes("/dispatches"))).toBe(false);
  });

  it("does not flip when Auto-tag ON but the compat gate is red", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv({
      "backend::ippoan/rust-alc-api": {
        schema_version: 1,
        repo: "ippoan/rust-alc-api",
        current_image: "cur-img",
        deployed_at: "2026-07-13T00:00:00Z",
        deployed_by: "x",
        wave_id: null,
      },
      "frontend::ippoan/alc-app": {
        schema_version: 1,
        repo: "ippoan/alc-app",
        prod_version: "v1.0.0",
        prod_deployed_at: "2026-07-13T00:00:00Z",
        tested_against: [
          {
            backend_repo: "ippoan/rust-alc-api",
            backend_image: "stale-img",
            tested_at: "2026-07-13T00:00:00Z",
          },
        ],
      },
    });
    const { env } = fakeEnv({ compatKv: kv });
    (env as unknown as { CI_HUB: unknown }).CI_HUB = memAutoTagHub(["ippoan/rust-alc-api"]);
    const resp = await handlePendingReleaseWebhook(
      jsonRequest({
        url: PENDING_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/rust-alc-api", version_id: "pending-v1-0-0", tag: "v1.0.0" },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const dispatched = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(dispatched.some((u) => u.includes("/dispatches"))).toBe(false);
  });

  // COMPAT_KV 未 bind 時の fail-closed skip は runContinuousAutoFlip の単体テスト
  // (auto-flip.test.ts) でカバーする。handlePendingReleaseWebhook は COMPAT_KV が
  // 無いと pending release の記録自体が失敗するため、この webhook 経路では
  // 「CI_HUB はあるが COMPAT_KV は無い」状態を単独では再現できない。
});

// ============================================================================
// traffic-report webhook
// ============================================================================

const TRAFFIC_URL =
  "https://ci-dashboard.ippoan.org/webhooks/release-wave/traffic-report";

describe("handleTrafficReportWebhook", () => {
  it("records traffic split sorted by percentage desc (ok=true), carrying created_on", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleTrafficReportWebhook(
      jsonRequest({
        url: TRAFFIC_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/auth-worker",
          versions: [
            { version_id: "zero-id", percentage: 0, created_on: "2026-05-29T07:00:00Z" },
            { version_id: "full-id", percentage: 100, created_on: "2026-05-28T11:00:00Z" },
          ],
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const rec = await getTraffic(kv, "ippoan/auth-worker");
    expect(rec).not.toBeNull();
    expect(rec!.versions[0]).toEqual({
      version_id: "full-id",
      percentage: 100,
      created_on: "2026-05-28T11:00:00Z",
      tag: null,
    });
    expect(rec!.versions[1]).toEqual({
      version_id: "zero-id",
      percentage: 0,
      created_on: "2026-05-29T07:00:00Z",
      tag: null,
    });
  });

  it("defaults created_on to null when omitted", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleTrafficReportWebhook(
      jsonRequest({
        url: TRAFFIC_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/x",
          versions: [{ version_id: "v", percentage: 100 }],
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const rec = await getTraffic(kv, "ippoan/x");
    expect(rec!.versions[0]).toEqual({
      version_id: "v",
      percentage: 100,
      created_on: null,
      tag: null,
    });
  });

  it("stores the per-version tag and merges it across reports", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleTrafficReportWebhook(
      jsonRequest({
        url: TRAFFIC_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/x",
          versions: [{ version_id: "v1", percentage: 0, tag: "v0.2.43" }],
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const rec = await getTraffic(kv, "ippoan/x");
    expect(rec!.versions[0].tag).toBe("v0.2.43");
  });

  it("accepts explicit null created_on / tag (does not 400)", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleTrafficReportWebhook(
      jsonRequest({
        url: TRAFFIC_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/x",
          versions: [
            { version_id: "a", percentage: 100, created_on: null, tag: null },
            { version_id: "b", percentage: 0, created_on: "2026-05-29T00:00:00Z", tag: "v9.9.9" },
          ],
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const rec = await getTraffic(kv, "ippoan/x");
    const byId = Object.fromEntries(rec!.versions.map((v) => [v.version_id, v.tag]));
    expect(byId["a"]).toBeNull();
    expect(byId["b"]).toBe("v9.9.9");
  });

  it("rejects an empty versions array with 400", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleTrafficReportWebhook(
      jsonRequest({
        url: TRAFFIC_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/x", versions: [] },
      }),
      env,
    );
    expect(resp.status).toBe(400);
  });

  it("rejects a percentage out of range with 400", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleTrafficReportWebhook(
      jsonRequest({
        url: TRAFFIC_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/x", versions: [{ version_id: "a", percentage: 150 }] },
      }),
      env,
    );
    expect(resp.status).toBe(400);
  });

  it("rejects bad webhook secret with 401", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleTrafficReportWebhook(
      jsonRequest({
        url: TRAFFIC_URL,
        secret: "wrong-secret",
        body: {
          repo: "ippoan/auth-worker",
          versions: [{ version_id: "a", percentage: 100 }],
        },
      }),
      env,
    );
    expect(resp.status).toBe(401);
  });
});

// ============================================================================
// /webhooks/release-wave/backend-traffic-report
// ============================================================================

const BACKEND_TRAFFIC_URL =
  "https://ci-dashboard.ippoan.org/webhooks/release-wave/backend-traffic-report";

describe("handleBackendTrafficReportWebhook", () => {
  it("records service traffic sorted by percent desc (ok=true)", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleBackendTrafficReportWebhook(
      jsonRequest({
        url: BACKEND_TRAFFIC_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/rust-alc-api",
          services: [
            {
              service: "rust-alc-api",
              revisions: [
                { revision: "rust-alc-api-00043-xyz", percent: 0, tag: "pending-v1-4-3" },
                { revision: "rust-alc-api-00042-abc", percent: 100, tag: "v1.4.2" },
              ],
            },
          ],
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const rec = await getBackendTraffic(kv, "ippoan/rust-alc-api");
    expect(rec).not.toBeNull();
    expect(rec!.services[0]!.revisions[0]!.percent).toBe(100);
    expect(rec!.services[0]!.revisions[0]!.revision).toBe("rust-alc-api-00042-abc");
    expect(rec!.services[0]!.revisions[1]!.percent).toBe(0);
    expect(rec!.services[0]!.revisions[1]!.tag).toBe("pending-v1-4-3");
  });

  it("defaults a missing revision tag to null", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleBackendTrafficReportWebhook(
      jsonRequest({
        url: BACKEND_TRAFFIC_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/x",
          services: [{ service: "x", revisions: [{ revision: "x-1", percent: 100 }] }],
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const rec = await getBackendTraffic(kv, "ippoan/x");
    expect(rec!.services[0]!.revisions[0]!.tag).toBeNull();
  });

  it("accepts a service with an empty revisions array (traffic 未設定)", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleBackendTrafficReportWebhook(
      jsonRequest({
        url: BACKEND_TRAFFIC_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/x", services: [{ service: "x", revisions: [] }] },
      }),
      env,
    );
    expect(resp.status).toBe(200);
  });

  it("rejects an empty services array with 400", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleBackendTrafficReportWebhook(
      jsonRequest({
        url: BACKEND_TRAFFIC_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/x", services: [] },
      }),
      env,
    );
    expect(resp.status).toBe(400);
  });

  it("rejects a percent out of range with 400", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleBackendTrafficReportWebhook(
      jsonRequest({
        url: BACKEND_TRAFFIC_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/x",
          services: [{ service: "x", revisions: [{ revision: "r", percent: 150 }] }],
        },
      }),
      env,
    );
    expect(resp.status).toBe(400);
  });

  it("returns 500 when COMPAT_KV is unbound", async () => {
    const { env } = fakeEnv({ compatKv: undefined });
    const resp = await handleBackendTrafficReportWebhook(
      jsonRequest({
        url: BACKEND_TRAFFIC_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/x",
          services: [{ service: "x", revisions: [{ revision: "r", percent: 100 }] }],
        },
      }),
      env,
    );
    expect(resp.status).toBe(500);
  });

  it("rejects a bad webhook secret with 401", async () => {
    const kv = memKv();
    const { env } = fakeEnv({ compatKv: kv });
    const resp = await handleBackendTrafficReportWebhook(
      jsonRequest({
        url: BACKEND_TRAFFIC_URL,
        secret: "wrong-secret",
        body: {
          repo: "ippoan/x",
          services: [{ service: "x", revisions: [{ revision: "r", percent: 100 }] }],
        },
      }),
      env,
    );
    expect(resp.status).toBe(401);
  });
});

// ============================================================================
// /webhooks/release-wave/backend-deploy-report — auto-retest fan-out
//   (backend deploy 完了 → 新 image 未 test の consumer に retest 自動 dispatch)
// ============================================================================

// dispatchAll は GitHub repository_dispatch を打つ IO。workers test pool では
// 相対モジュールの vi.mock が SUT の import を差し替えられないため、api.test.ts と
// 同じく global fetch を stub し、CI_STATUS に fresh な gh-token を seed して
// tokenForOrg を auth-worker 往復なしで通す。`/dispatches` 宛 fetch の有無で
// fan-out を検証する。
const FRESH_TOKEN = {
  token: "ghs_retest_token",
  expires_at_ms: Date.now() + 3600_000,
};

/** auto-retest 用 env: webhook secret + COMPAT_KV + token cache を備える。 */
function deployEnv(compatKv: KVNamespace): Env {
  return {
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({}) },
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => "expected-secret" },
    COMPAT_KV: compatKv,
    CI_STATUS: memKv({ "auth-client-worker:gh-token": FRESH_TOKEN }),
    INTERNAL_SHARED_SECRET: { get: async () => "secret" },
  } as unknown as Env;
}

const BD_URL =
  "https://ci-dashboard.ippoan.org/webhooks/release-wave/backend-deploy-report";

function deployReq(body: unknown): Request {
  return jsonRequest({ url: BD_URL, body, secret: "expected-secret" });
}

/** consumer (frontend) を 1 件 seed した COMPAT_KV を作る。 */
async function compatKvWithConsumer(testedImage: string): Promise<KVNamespace> {
  const kv = memKv();
  await recordFrontendTest(kv, {
    repo: "ippoan/auth-worker",
    prod_version: "v0.5.32",
    tested: { backend_repo: "ippoan/rust-alc-api", backend_image: testedImage },
    now: "2026-06-10T00:00:00Z",
  });
  return kv;
}

describe("handleBackendDeployReportWebhook auto-retest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not dispatch when the backend has no consumers", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const resp = await handleBackendDeployReportWebhook(
      deployReq({
        repo: "ippoan/rust-alc-api",
        current_image: "img-new",
        deployed_by: "release-wave-gcp",
      }),
      deployEnv(memKv()),
    );
    expect(resp.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fans out wave-independent retest to consumers not on the new image", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    // consumer は rust-alc-api @ img-old を test 済み → 新 img-new は未 test (赤)。
    const kv = await compatKvWithConsumer("img-old");

    const resp = await handleBackendDeployReportWebhook(
      deployReq({
        repo: "ippoan/rust-alc-api",
        current_image: "img-new",
        deployed_by: "release-wave-gcp",
      }),
      deployEnv(kv),
    );
    expect(resp.status).toBe(200);

    const dispatchCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/repos/ippoan/auth-worker/dispatches"),
    );
    expect(dispatchCall).toBeDefined();
    const body = JSON.parse(dispatchCall![1].body) as {
      event_type: string;
      client_payload: Record<string, unknown>;
    };
    expect(body.event_type).toBe("release-wave-retest");
    expect(body.client_payload).toMatchObject({
      backend_repo: "ippoan/rust-alc-api",
      backend_image: "img-new",
      prod_version: "v0.5.32",
    });
    // wave 非依存 = wave_id を載せない。
    expect(body.client_payload).not.toHaveProperty("wave_id");
  });

  it("skips consumers that already tested the new image (idempotent re-report)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    // consumer は既に img-new を test 済み → 緑なので dispatch されない。
    const kv = await compatKvWithConsumer("img-new");

    const resp = await handleBackendDeployReportWebhook(
      deployReq({
        repo: "ippoan/rust-alc-api",
        current_image: "img-new",
        deployed_by: "release-wave-gcp",
      }),
      deployEnv(kv),
    );
    expect(resp.status).toBe(200);
    const dispatchCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/dispatches"),
    );
    expect(dispatchCall).toBeUndefined();
  });
});

// ============================================================================
// /webhooks/release-wave/pending-release — staged_image pre-flip retest fan-out
//   (no-traffic upload 時に staged image を未 test の consumer へ retest、Refs #427)
// ============================================================================

describe("handlePendingReleaseWebhook staged_image pre-flip retest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pendingReq(body: unknown): Request {
    return jsonRequest({ url: PENDING_URL, body, secret: "expected-secret" });
  }

  it("fans out pre-flip retest to consumers not on the staged image", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    // consumer は rust-alc-api @ img-old を test 済み → staged img-staged は未 test。
    const kv = await compatKvWithConsumer("img-old");

    const resp = await handlePendingReleaseWebhook(
      pendingReq({
        repo: "ippoan/rust-alc-api",
        version_id: "v0.0.93",
        tag: "v0.0.93",
        staged_image: "img-staged",
      }),
      deployEnv(kv),
    );
    expect(resp.status).toBe(200);
    // staged_image が record に persist される。
    const rec = await getPendingRelease(kv, "ippoan/rust-alc-api");
    expect(rec!.staged_image).toBe("img-staged");
    // 未 test consumer に staged image 相手の retest が飛ぶ。
    const dispatchCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/repos/ippoan/auth-worker/dispatches"),
    );
    expect(dispatchCall).toBeDefined();
    const body = JSON.parse(dispatchCall![1].body) as {
      event_type: string;
      client_payload: Record<string, unknown>;
    };
    expect(body.event_type).toBe("release-wave-retest");
    expect(body.client_payload).toMatchObject({
      backend_repo: "ippoan/rust-alc-api",
      backend_image: "img-staged",
    });
  });

  it("skips consumers that already tested the staged image (idempotent)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = await compatKvWithConsumer("img-staged");
    const resp = await handlePendingReleaseWebhook(
      pendingReq({
        repo: "ippoan/rust-alc-api",
        version_id: "v0.0.93",
        tag: "v0.0.93",
        staged_image: "img-staged",
      }),
      deployEnv(kv),
    );
    expect(resp.status).toBe(200);
    const dispatchCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/dispatches"),
    );
    expect(dispatchCall).toBeUndefined();
  });

  it("does not dispatch when staged_image is omitted (backward-compat)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = await compatKvWithConsumer("img-old");
    const resp = await handlePendingReleaseWebhook(
      pendingReq({
        repo: "ippoan/rust-alc-api",
        version_id: "v0.0.93",
        tag: "v0.0.93",
      }),
      deployEnv(kv),
    );
    expect(resp.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const rec = await getPendingRelease(kv, "ippoan/rust-alc-api");
    expect(rec!.staged_image ?? null).toBeNull();
  });
});

// ============================================================================
// live 更新 broadcast (Refs #479)
// ============================================================================
//
// KV だけを書く report 系 handler は DO の saveWave を通らないため、live 更新
// (`/release-wave` を開いているブラウザの部分更新) を発火させるには handler 自身
// が明示的に ReleaseWaveHub.broadcast() を呼ぶ必要がある。成功時に broadcast が
// 呼ばれること、および broadcast の失敗が report の 200 を止めないことを検証する。

describe("KV report webhooks broadcast for live update (Refs #479)", () => {
  const FT_URL =
    "https://ci-dashboard.ippoan.org/webhooks/release-wave/frontend-test-report";

  it("traffic-report broadcasts on success", async () => {
    const { env, spies } = fakeEnv({ compatKv: memKv() });
    const resp = await handleTrafficReportWebhook(
      jsonRequest({
        url: TRAFFIC_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/x", versions: [{ version_id: "v", percentage: 100 }] },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.broadcast).toHaveBeenCalledOnce();
  });

  it("pending-release broadcasts on success", async () => {
    const { env, spies } = fakeEnv({ compatKv: memKv() });
    const resp = await handlePendingReleaseWebhook(
      jsonRequest({
        url: PENDING_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/x", version_id: "id", tag: "v0.0.1" },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.broadcast).toHaveBeenCalledOnce();
  });

  it("backend-traffic-report broadcasts on success", async () => {
    const { env, spies } = fakeEnv({ compatKv: memKv() });
    const resp = await handleBackendTrafficReportWebhook(
      jsonRequest({
        url: BACKEND_TRAFFIC_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/x",
          services: [{ service: "x", revisions: [{ revision: "x-1", percent: 100 }] }],
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.broadcast).toHaveBeenCalledOnce();
  });

  it("backend-deploy-report broadcasts on success", async () => {
    const { env, spies } = fakeEnv({ compatKv: memKv() });
    const resp = await handleBackendDeployReportWebhook(
      jsonRequest({
        url: BD_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/x",
          current_image: "x-00001-abc",
          deployed_by: "test",
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.broadcast).toHaveBeenCalledOnce();
  });

  it("frontend-test-report broadcasts on success", async () => {
    const { env, spies } = fakeEnv({ compatKv: memKv() });
    const resp = await handleFrontendTestReportWebhook(
      jsonRequest({
        url: FT_URL,
        secret: "expected-secret",
        body: {
          repo: "ippoan/x",
          prod_version: "v0.0.1",
          tested: { backend_repo: "ippoan/y", backend_image: "y-00001-abc" },
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.broadcast).toHaveBeenCalledOnce();
  });

  it("still returns 200 when broadcast throws (best-effort)", async () => {
    const { env, spies } = fakeEnv({ compatKv: memKv() });
    spies.broadcast.mockRejectedValueOnce(new Error("DO unreachable"));
    const resp = await handleTrafficReportWebhook(
      jsonRequest({
        url: TRAFFIC_URL,
        secret: "expected-secret",
        body: { repo: "ippoan/x", versions: [{ version_id: "v", percentage: 100 }] },
      }),
      env,
    );
    expect(resp.status).toBe(200);
  });
});
