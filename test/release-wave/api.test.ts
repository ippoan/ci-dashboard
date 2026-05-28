import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleReleaseWaveApprove,
  handleReleaseWaveRollback,
  handleReleaseWaveAbort,
  handleReleaseWaveRetest,
  handleReleaseWavePendingReleaseFlip,
} from "../../src/release-wave/api";
import { getPendingRelease } from "../../src/release-wave/pending-release";
import type { Env } from "../../src/index";
import type { ReleaseWaveHub } from "../../src/release-wave/do";

function fakeEnv(spyOverrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}): {
  env: Env;
  spies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const spies = {
    approve: spyOverrides.approve ?? vi.fn().mockResolvedValue({ ok: true, data: { wave_id: "w1" } }),
    rollback: spyOverrides.rollback ?? vi.fn().mockResolvedValue({ ok: true, data: { wave_id: "w1" } }),
    abort: spyOverrides.abort ?? vi.fn().mockResolvedValue({ ok: true, data: { wave_id: "w1" } }),
  };
  const hub = spies as unknown as ReleaseWaveHub;
  const env = {
    RELEASE_WAVE_HUB: {
      idFromName: () => ({}),
      get: () => hub,
    },
  } as unknown as Env;
  return { env, spies };
}

function postRequest(
  path: string,
  opts: {
    formBody?: Record<string, string>;
    actorEmail?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.actorEmail) {
    headers["Cf-Access-Authenticated-User-Email"] = opts.actorEmail;
  }
  let body: string | undefined;
  if (opts.formBody) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.formBody)) params.set(k, v);
    body = params.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  return new Request(`https://ci-dashboard.ippoan.org${path}`, {
    method: "POST",
    headers,
    body,
  });
}

// ============================================================================
// /api/release-wave/:wave_id/approve
// ============================================================================

describe("handleReleaseWaveApprove", () => {
  it("calls hub.approve with CF Access email", async () => {
    const { env, spies } = fakeEnv();
    const req = postRequest("/api/release-wave/w1/approve", {
      actorEmail: "ops@example.com",
    });
    const resp = await handleReleaseWaveApprove(req, env, "w1");
    expect(resp.status).toBe(303);
    expect(resp.headers.get("Location")).toBe("/release-wave/w1");
    expect(spies.approve).toHaveBeenCalledWith({
      wave_id: "w1",
      approved_by: "ops@example.com",
      force: false,
    });
  });

  it("falls back to 'operator' when CF Access header missing", async () => {
    const { env, spies } = fakeEnv();
    const req = postRequest("/api/release-wave/w1/approve", {});
    await handleReleaseWaveApprove(req, env, "w1");
    expect(spies.approve).toHaveBeenCalledWith({
      wave_id: "w1",
      approved_by: "operator",
      force: false,
    });
  });

  it("passes force=true when form sets it (compat gate override)", async () => {
    const { env, spies } = fakeEnv();
    const req = postRequest("/api/release-wave/w1/approve", {
      actorEmail: "ops@x",
      formBody: { force: "true" },
    });
    await handleReleaseWaveApprove(req, env, "w1");
    expect(spies.approve).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("returns 405 on non-POST", async () => {
    const { env } = fakeEnv();
    const req = new Request("https://ci-dashboard.ippoan.org/api/release-wave/w1/approve", {
      method: "GET",
    });
    const resp = await handleReleaseWaveApprove(req, env, "w1");
    expect(resp.status).toBe(405);
  });

  it("maps NOT_FOUND to 404", async () => {
    const { env } = fakeEnv({
      approve: vi.fn().mockResolvedValue({
        ok: false,
        code: "NOT_FOUND",
        error: "no wave",
      }),
    });
    const req = postRequest("/api/release-wave/ghost/approve", {
      actorEmail: "x@y",
    });
    const resp = await handleReleaseWaveApprove(req, env, "ghost");
    expect(resp.status).toBe(404);
  });

  it("maps INVALID_TRANSITION to 409", async () => {
    const { env } = fakeEnv({
      approve: vi.fn().mockResolvedValue({
        ok: false,
        code: "INVALID_TRANSITION",
        error: "state is staging",
      }),
    });
    const req = postRequest("/api/release-wave/w1/approve", {
      actorEmail: "x@y",
    });
    const resp = await handleReleaseWaveApprove(req, env, "w1");
    expect(resp.status).toBe(409);
  });
});

// ============================================================================
// /api/release-wave/:wave_id/rollback
// ============================================================================

describe("handleReleaseWaveRollback", () => {
  it("rolls back without force when form omits it", async () => {
    const { env, spies } = fakeEnv();
    const req = postRequest("/api/release-wave/w1/rollback", {
      actorEmail: "ops@x",
    });
    const resp = await handleReleaseWaveRollback(req, env, "w1");
    expect(resp.status).toBe(303);
    expect(spies.rollback).toHaveBeenCalledWith({
      wave_id: "w1",
      rolled_back_by: "ops@x",
      force: false,
    });
  });

  it("rolls back with force=true when form has it", async () => {
    const { env, spies } = fakeEnv();
    const req = postRequest("/api/release-wave/w1/rollback", {
      actorEmail: "ops@x",
      formBody: { force: "true" },
    });
    await handleReleaseWaveRollback(req, env, "w1");
    expect(spies.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("returns 405 on GET", async () => {
    const { env } = fakeEnv();
    const req = new Request("https://ci-dashboard.ippoan.org/api/release-wave/w1/rollback", {
      method: "GET",
    });
    const resp = await handleReleaseWaveRollback(req, env, "w1");
    expect(resp.status).toBe(405);
  });

  it("maps ROLLBACK_UNSAFE to 409", async () => {
    const { env } = fakeEnv({
      rollback: vi.fn().mockResolvedValue({
        ok: false,
        code: "ROLLBACK_UNSAFE",
        error: "contract applied",
      }),
    });
    const req = postRequest("/api/release-wave/w1/rollback", {
      actorEmail: "ops@x",
    });
    const resp = await handleReleaseWaveRollback(req, env, "w1");
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("ROLLBACK_UNSAFE");
  });

  it("treats empty body as no force (= safe path)", async () => {
    const { env, spies } = fakeEnv();
    const req = new Request("https://ci-dashboard.ippoan.org/api/release-wave/w1/rollback", {
      method: "POST",
      // no body, no Content-Type
    });
    await handleReleaseWaveRollback(req, env, "w1");
    expect(spies.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ force: false }),
    );
  });
});

// ============================================================================
// /api/release-wave/:wave_id/abort
// ============================================================================

describe("handleReleaseWaveAbort", () => {
  it("uses default reason when form omits it", async () => {
    const { env, spies } = fakeEnv();
    const req = postRequest("/api/release-wave/w1/abort", {
      actorEmail: "ops@x",
    });
    const resp = await handleReleaseWaveAbort(req, env, "w1");
    expect(resp.status).toBe(303);
    expect(spies.abort).toHaveBeenCalledWith({
      wave_id: "w1",
      aborted_by: "ops@x",
      reason: "aborted via admin UI",
    });
  });

  it("uses provided reason when form has it", async () => {
    const { env, spies } = fakeEnv();
    const req = postRequest("/api/release-wave/w1/abort", {
      actorEmail: "ops@x",
      formBody: { reason: "smoke broken" },
    });
    await handleReleaseWaveAbort(req, env, "w1");
    expect(spies.abort).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "smoke broken" }),
    );
  });

  it("returns 405 on GET", async () => {
    const { env } = fakeEnv();
    const req = new Request("https://ci-dashboard.ippoan.org/api/release-wave/w1/abort", {
      method: "GET",
    });
    const resp = await handleReleaseWaveAbort(req, env, "w1");
    expect(resp.status).toBe(405);
  });

  it("maps INVALID_TRANSITION to 409 (e.g. abort after flip)", async () => {
    const { env } = fakeEnv({
      abort: vi.fn().mockResolvedValue({
        ok: false,
        code: "INVALID_TRANSITION",
        error: "wave is flipped, use rollback",
      }),
    });
    const req = postRequest("/api/release-wave/w1/abort", {
      actorEmail: "ops@x",
    });
    const resp = await handleReleaseWaveAbort(req, env, "w1");
    expect(resp.status).toBe(409);
  });
});

// ============================================================================
// /api/release-wave/:wave_id/retest  (Refs #157 Phase B)
// ============================================================================

/** 簡易 in-memory KV (compat 突合用)。 */
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

const FRESH_TOKEN = {
  token: "ghs_retest_token",
  expires_at_ms: Date.now() + 3600_000,
};

function retestEnv(opts: {
  getReturn?: unknown;
  compatKv?: KVNamespace;
}): Env {
  const hub = {
    get: vi.fn().mockResolvedValue(
      opts.getReturn ?? {
        ok: true,
        data: { wave_id: "w1", repos: [{ repo: "ippoan/rust-alc-api" }] },
      },
    ),
  } as unknown as ReleaseWaveHub;
  return {
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => hub },
    COMPAT_KV: opts.compatKv,
    // getGitHubToken の KV cache hit 用 (introspect fetch を回避)。
    CI_STATUS: memKv({ "auth-client-worker:gh-token": FRESH_TOKEN }),
    INTERNAL_SHARED_SECRET: { get: async () => "secret" },
  } as unknown as Env;
}

/** backend cur-img + frontend red を仕込んだ COMPAT_KV。 */
function redCompatKv(): KVNamespace {
  return memKv({
    "backend::ippoan/rust-alc-api": {
      schema_version: 1,
      repo: "ippoan/rust-alc-api",
      current_image: "cur-img",
      deployed_at: "2026-05-27T00:00:00Z",
      deployed_by: "x",
      wave_id: null,
    },
    "frontend::ippoan/alc-app": {
      schema_version: 1,
      repo: "ippoan/alc-app",
      prod_version: "v1.2.10",
      prod_deployed_at: "2026-05-27T00:00:00Z",
      tested_against: [
        {
          backend_repo: "ippoan/rust-alc-api",
          backend_image: "stale-img",
          tested_at: "2026-05-27T00:00:00Z",
        },
      ],
    },
  });
}

describe("handleReleaseWaveRetest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 405 on GET", async () => {
    const env = retestEnv({});
    const req = new Request("https://ci-dashboard.ippoan.org/api/release-wave/w1/retest", {
      method: "GET",
    });
    const resp = await handleReleaseWaveRetest(req, env, "w1");
    expect(resp.status).toBe(405);
  });

  it("maps NOT_FOUND to 404", async () => {
    const env = retestEnv({
      getReturn: { ok: false, code: "NOT_FOUND", error: "no wave" },
    });
    const resp = await handleReleaseWaveRetest(
      postRequest("/api/release-wave/ghost/retest"),
      env,
      "ghost",
    );
    expect(resp.status).toBe(404);
  });

  it("redirects without dispatch when COMPAT_KV unbound", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const env = retestEnv({ compatKv: undefined });
    const resp = await handleReleaseWaveRetest(
      postRequest("/api/release-wave/w1/retest"),
      env,
      "w1",
    );
    expect(resp.status).toBe(303);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects without dispatch when there are no reds", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // backend record 無し → matrix 空 → 赤無し
    const env = retestEnv({ compatKv: memKv() });
    const resp = await handleReleaseWaveRetest(
      postRequest("/api/release-wave/w1/retest"),
      env,
      "w1",
    );
    expect(resp.status).toBe(303);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatches release-wave-retest to a red frontend and redirects", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const env = retestEnv({ compatKv: redCompatKv() });
    const resp = await handleReleaseWaveRetest(
      postRequest("/api/release-wave/w1/retest"),
      env,
      "w1",
    );
    expect(resp.status).toBe(303);
    const dispatchCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/repos/ippoan/alc-app/dispatches"),
    );
    expect(dispatchCall).toBeDefined();
    const body = JSON.parse(dispatchCall![1].body);
    expect(body.event_type).toBe("release-wave-retest");
    expect(body.client_payload).toMatchObject({
      wave_id: "w1",
      backend_repo: "ippoan/rust-alc-api",
      backend_image: "cur-img",
      prod_version: "v1.2.10",
    });
  });

  it("honors the `frontend` form field to target one repo", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const env = retestEnv({ compatKv: redCompatKv() });
    const resp = await handleReleaseWaveRetest(
      postRequest("/api/release-wave/w1/retest", {
        formBody: { frontend: "ippoan/does-not-match" },
      }),
      env,
      "w1",
    );
    expect(resp.status).toBe(303);
    // frontend が一致しないので dispatch されない。
    const dispatchCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/dispatches"),
    );
    expect(dispatchCall).toBeUndefined();
  });
});

// ============================================================================
// /api/release-wave/pending-release/flip  (Refs #181 / #174)
// ============================================================================

const PENDING_VID = "530b908c-5385-451c-b163-747caaedafd3";

function pendingFlipEnv(compatKv: KVNamespace): Env {
  return {
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({}) },
    COMPAT_KV: compatKv,
    CI_STATUS: memKv({ "auth-client-worker:gh-token": FRESH_TOKEN }),
    INTERNAL_SHARED_SECRET: { get: async () => "secret" },
  } as unknown as Env;
}

function pendingKv(): KVNamespace {
  return memKv({
    "pending-release::ippoan/auth-worker": {
      schema_version: 1,
      repo: "ippoan/auth-worker",
      version_id: PENDING_VID,
      tag: "v0.2.38",
      preview_url: "https://abc-auth-worker.example.workers.dev",
      uploaded_at: "2026-05-28T12:00:00Z",
    },
  });
}

describe("handleReleaseWavePendingReleaseFlip", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 405 on GET", async () => {
    const req = new Request(
      "https://ci-dashboard.ippoan.org/api/release-wave/pending-release/flip",
      { method: "GET" },
    );
    const resp = await handleReleaseWavePendingReleaseFlip(req, pendingFlipEnv(pendingKv()));
    expect(resp.status).toBe(405);
  });

  it("returns 400 when repo form field missing", async () => {
    const resp = await handleReleaseWavePendingReleaseFlip(
      postRequest("/api/release-wave/pending-release/flip"),
      pendingFlipEnv(pendingKv()),
    );
    expect(resp.status).toBe(400);
  });

  it("returns 404 when no pending release for repo", async () => {
    const resp = await handleReleaseWavePendingReleaseFlip(
      postRequest("/api/release-wave/pending-release/flip", {
        formBody: { repo: "ippoan/no-such" },
      }),
      pendingFlipEnv(pendingKv()),
    );
    expect(resp.status).toBe(404);
  });

  it("dispatches release-wave-flip with previewed_version_id + pending_release marker, then clears record", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = pendingKv();
    const resp = await handleReleaseWavePendingReleaseFlip(
      postRequest("/api/release-wave/pending-release/flip", {
        formBody: { repo: "ippoan/auth-worker" },
      }),
      pendingFlipEnv(kv),
    );
    expect(resp.status).toBe(303);
    const dispatchCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/repos/ippoan/auth-worker/dispatches"),
    );
    expect(dispatchCall).toBeDefined();
    const body = JSON.parse(dispatchCall![1].body);
    expect(body.event_type).toBe("release-wave-flip");
    expect(body.client_payload).toMatchObject({
      target_tag: "v0.2.38",
      previewed_version_id: PENDING_VID,
      pending_release: true,
    });
    // wave_id は synthetic で `/` を含まない (handler の形式検証を満たす)
    expect(body.client_payload.wave_id).toMatch(/^[a-zA-Z0-9._-]{1,128}$/);
    // dispatch 成功で record は消える
    expect(await getPendingRelease(kv, "ippoan/auth-worker")).toBeNull();
  });

  it("keeps the record when dispatch fails", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = pendingKv();
    const resp = await handleReleaseWavePendingReleaseFlip(
      postRequest("/api/release-wave/pending-release/flip", {
        formBody: { repo: "ippoan/auth-worker" },
      }),
      pendingFlipEnv(kv),
    );
    expect(resp.status).toBe(502);
    // 着火失敗時は record を残す (operator が再試行可能)
    expect(await getPendingRelease(kv, "ippoan/auth-worker")).not.toBeNull();
  });
});
