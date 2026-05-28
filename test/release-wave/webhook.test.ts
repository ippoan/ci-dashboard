import { describe, it, expect, vi } from "vitest";
import {
  handleContractAppliedWebhook,
  handleStageReportWebhook,
  handleFlipReportWebhook,
} from "../../src/release-wave/webhook";
import type { Env } from "../../src/index";
import type { ReleaseWaveHub } from "../../src/release-wave/do";

// ----------------------------------------------------------------------------
// Fake env / request builder (3 endpoint 共通)
// ----------------------------------------------------------------------------

type FakeSpies = {
  contractApplied: ReturnType<typeof vi.fn>;
  stageReport: ReturnType<typeof vi.fn>;
  flipReport: ReturnType<typeof vi.fn>;
};

function fakeEnv(opts: {
  secret?: string | null;
  contractAppliedReturn?:
    | { ok: true; data: unknown }
    | { ok: false; code: string; error: string };
  stageReportReturn?:
    | { ok: true; data: unknown }
    | { ok: false; code: string; error: string };
  flipReportReturn?:
    | { ok: true; data: unknown }
    | { ok: false; code: string; error: string };
} = {}): { env: Env; spies: FakeSpies } {
  const okState = { wave_id: "w1", state: "staging" };
  const spies: FakeSpies = {
    contractApplied: vi
      .fn()
      .mockResolvedValue(opts.contractAppliedReturn ?? { ok: true, data: okState }),
    stageReport: vi
      .fn()
      .mockResolvedValue(opts.stageReportReturn ?? { ok: true, data: okState }),
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
// /webhooks/release-wave/stage-report
// ============================================================================

const STAGE_URL =
  "https://ci-dashboard.ippoan.org/webhooks/release-wave/stage-report";

describe("handleStageReportWebhook", () => {
  it("returns 405 on GET", async () => {
    const { env } = fakeEnv();
    const resp = await handleStageReportWebhook(
      jsonRequest({ url: STAGE_URL, method: "GET", secret: "expected-secret" }),
      env,
    );
    expect(resp.status).toBe(405);
  });

  it("returns 401 on wrong secret", async () => {
    const { env } = fakeEnv();
    const resp = await handleStageReportWebhook(
      jsonRequest({
        url: STAGE_URL,
        secret: "wrong",
        body: { wave_id: "w1", repo: "ippoan/a", ok: true },
      }),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it("returns 400 on missing fields", async () => {
    const { env } = fakeEnv();
    const resp = await handleStageReportWebhook(
      jsonRequest({
        url: STAGE_URL,
        secret: "expected-secret",
        body: { wave_id: "w1" },
      }),
      env,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("repo");
    expect(body.error).toContain("ok");
  });

  it("returns 400 on invalid preview_url (non-URL)", async () => {
    const { env } = fakeEnv();
    const resp = await handleStageReportWebhook(
      jsonRequest({
        url: STAGE_URL,
        secret: "expected-secret",
        body: {
          wave_id: "w1",
          repo: "ippoan/a",
          ok: true,
          preview_url: "not a url",
        },
      }),
      env,
    );
    expect(resp.status).toBe(400);
  });

  it("succeeds with full payload (ok=true)", async () => {
    const { env, spies } = fakeEnv();
    const resp = await handleStageReportWebhook(
      jsonRequest({
        url: STAGE_URL,
        secret: "expected-secret",
        body: {
          wave_id: "w1",
          repo: "ippoan/a",
          ok: true,
          preview_url: "https://preview-a.ippoan.org/",
          flip_from_revision: "a-old-rev",
          previewed_version_id: "11111111-2222-3333-4444-555555555555",
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.stageReport).toHaveBeenCalledWith({
      wave_id: "w1",
      repo: "ippoan/a",
      ok: true,
      preview_url: "https://preview-a.ippoan.org/",
      flip_from_revision: "a-old-rev",
      previewed_version_id: "11111111-2222-3333-4444-555555555555",
      error: null,
    });
  });

  it("succeeds with failure payload (ok=false, error)", async () => {
    const { env, spies } = fakeEnv();
    const resp = await handleStageReportWebhook(
      jsonRequest({
        url: STAGE_URL,
        secret: "expected-secret",
        body: {
          wave_id: "w1",
          repo: "ippoan/a",
          ok: false,
          error: "build broke",
        },
      }),
      env,
    );
    expect(resp.status).toBe(200);
    expect(spies.stageReport).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "build broke",
        preview_url: null,
        flip_from_revision: null,
      }),
    );
  });

  it("nullifies omitted optional fields", async () => {
    const { env, spies } = fakeEnv();
    await handleStageReportWebhook(
      jsonRequest({
        url: STAGE_URL,
        secret: "expected-secret",
        body: { wave_id: "w1", repo: "ippoan/a", ok: true },
      }),
      env,
    );
    expect(spies.stageReport).toHaveBeenCalledWith(
      expect.objectContaining({
        preview_url: null,
        flip_from_revision: null,
        previewed_version_id: null,
        error: null,
      }),
    );
  });

  it("maps NOT_FOUND to 404", async () => {
    const { env } = fakeEnv({
      stageReportReturn: { ok: false, code: "NOT_FOUND", error: "no wave" },
    });
    const resp = await handleStageReportWebhook(
      jsonRequest({
        url: STAGE_URL,
        secret: "expected-secret",
        body: { wave_id: "ghost", repo: "ippoan/a", ok: true },
      }),
      env,
    );
    expect(resp.status).toBe(404);
  });

  it("maps INVALID_TRANSITION to 409", async () => {
    const { env } = fakeEnv({
      stageReportReturn: {
        ok: false,
        code: "INVALID_TRANSITION",
        error: "wave is flipping",
      },
    });
    const resp = await handleStageReportWebhook(
      jsonRequest({
        url: STAGE_URL,
        secret: "expected-secret",
        body: { wave_id: "w1", repo: "ippoan/a", ok: true },
      }),
      env,
    );
    expect(resp.status).toBe(409);
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
