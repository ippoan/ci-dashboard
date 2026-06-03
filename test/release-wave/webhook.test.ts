import { describe, it, expect, vi } from "vitest";
import {
  handleContractAppliedWebhook,
  handleFlipReportWebhook,
  handlePendingReleaseWebhook,
  handleTrafficReportWebhook,
} from "../../src/release-wave/webhook";
import { getPendingRelease } from "../../src/release-wave/pending-release";
import { getTraffic } from "../../src/release-wave/traffic";
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
