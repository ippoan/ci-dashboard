import { describe, it, expect, vi } from "vitest";
import {
  handleReleaseWaveApprove,
  handleReleaseWaveRollback,
  handleReleaseWaveAbort,
} from "../../src/release-wave/api";
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
    });
  });

  it("falls back to 'operator' when CF Access header missing", async () => {
    const { env, spies } = fakeEnv();
    const req = postRequest("/api/release-wave/w1/approve", {});
    await handleReleaseWaveApprove(req, env, "w1");
    expect(spies.approve).toHaveBeenCalledWith({
      wave_id: "w1",
      approved_by: "operator",
    });
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
