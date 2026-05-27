import { describe, it, expect, vi } from "vitest";
import { handleContractAppliedWebhook } from "../../src/release-wave/webhook";
import type { Env } from "../../src/index";
import type { ReleaseWaveHub } from "../../src/release-wave/do";

// 各 test で hub method の呼び出しと secret 値を切替えられる fake env を作る。
function fakeEnv(opts: {
  secret?: string | null;
  contractAppliedReturn?:
    | { ok: true; data: unknown }
    | { ok: false; code: string; error: string };
}): {
  env: Env;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue(
    opts.contractAppliedReturn ?? {
      ok: true,
      data: { wave_id: "w1", state: "flipped" },
    },
  );
  const hub = { contractApplied: spy } as unknown as ReleaseWaveHub;
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
  return { env, spy };
}

function jsonRequest(opts: {
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
  return new Request("https://ci-dashboard.ippoan.org/webhooks/release-wave/contract-applied", {
    method: opts.method ?? "POST",
    headers,
    body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
}

describe("handleContractAppliedWebhook", () => {
  it("rejects non-POST with 405", async () => {
    const { env } = fakeEnv({});
    const resp = await handleContractAppliedWebhook(
      jsonRequest({ method: "GET", secret: "expected-secret", body: {} }),
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
        body: {
          wave_id: "w1",
          repo: "ippoan/a",
          migration_id: "m",
        },
      }),
      env,
    );
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("SECRET_NOT_CONFIGURED");
  });

  it("rejects with 401 on missing header", async () => {
    const { env } = fakeEnv({});
    const resp = await handleContractAppliedWebhook(
      jsonRequest({
        secret: null, // do not set header
        body: { wave_id: "w1", repo: "ippoan/a", migration_id: "m" },
      }),
      env,
    );
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("rejects with 401 on wrong header value", async () => {
    const { env } = fakeEnv({});
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
    const { env } = fakeEnv({});
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
    const { env } = fakeEnv({});
    const resp = await handleContractAppliedWebhook(
      jsonRequest({ secret: "expected-secret", body: "not json {" }),
      env,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("BAD_JSON");
  });

  it("rejects with 400 on missing fields", async () => {
    const { env } = fakeEnv({});
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
    const { env, spy } = fakeEnv({});
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
    const body = (await resp.json()) as { ok: boolean; state: unknown };
    expect(body.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith({
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
        body: {
          wave_id: "w1",
          repo: "ippoan/a",
          migration_id: "m",
        },
      }),
      env,
    );
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { code: string };
    expect(body.code).toBe("INVALID_TRANSITION");
  });

  it("maps NOT_FOUND to 404", async () => {
    const { env } = fakeEnv({
      contractAppliedReturn: {
        ok: false,
        code: "NOT_FOUND",
        error: "no such wave",
      },
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
