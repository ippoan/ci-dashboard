import { describe, it, expect, beforeEach } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
  handleFrontendTestReportWebhook,
  handleBackendDeployReportWebhook,
  handleBackendCurrentImageWebhook,
} from "../../src/release-wave/webhook";
import {
  handleCompatibility,
  handleBackendCurrentImage,
} from "../../src/release-wave/compat-api";
import { getBackendCurrent } from "../../src/release-wave/compat";
import type { Env } from "../../src/index";

const SECRET = "expected-secret";

function compatEnv(secret: string | null = SECRET): Env {
  return {
    COMPAT_KV: testEnv.COMPAT_KV,
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => secret },
  } as unknown as Env;
}

function postReq(url: string, body: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Release-Wave-Webhook-Secret"] = secret;
  return new Request(url, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function clearCompatKeys(): Promise<void> {
  for (const prefix of ["frontend::", "backend::"]) {
    const { keys } = await testEnv.COMPAT_KV.list({ prefix });
    await Promise.all(keys.map((k) => testEnv.COMPAT_KV.delete(k.name)));
  }
}
beforeEach(clearCompatKeys);

const FT_URL =
  "https://ci-dashboard.ippoan.org/webhooks/release-wave/frontend-test-report";
const BD_URL =
  "https://ci-dashboard.ippoan.org/webhooks/release-wave/backend-deploy-report";

describe("handleFrontendTestReportWebhook", () => {
  it("rejects non-POST with 405", async () => {
    const req = new Request(FT_URL, {
      method: "GET",
      headers: { "X-Release-Wave-Webhook-Secret": SECRET },
    });
    const resp = await handleFrontendTestReportWebhook(req, compatEnv());
    expect(resp.status).toBe(405);
  });

  it("rejects wrong secret with 401", async () => {
    const resp = await handleFrontendTestReportWebhook(
      postReq(FT_URL, { repo: "x", prod_version: "v1", tested: { backend_repo: "b", backend_image: "i" } }, "wrong"),
      compatEnv(),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects missing fields with 400", async () => {
    const resp = await handleFrontendTestReportWebhook(
      postReq(FT_URL, { repo: "x" }),
      compatEnv(),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("prod_version");
  });

  it("rejects non-URL ci_run_url with 400", async () => {
    const resp = await handleFrontendTestReportWebhook(
      postReq(FT_URL, {
        repo: "ippoan/auth-worker",
        prod_version: "v1",
        tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "i", ci_run_url: "not-a-url" },
      }),
      compatEnv(),
    );
    expect(resp.status).toBe(400);
  });

  it("writes the frontend record and returns it (200)", async () => {
    const resp = await handleFrontendTestReportWebhook(
      postReq(FT_URL, {
        repo: "ippoan/auth-worker",
        prod_version: "v0.5.32",
        tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "img-a" },
      }),
      compatEnv(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; record: { tested_against: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.record.tested_against).toHaveLength(1);
  });
});

describe("handleBackendDeployReportWebhook", () => {
  it("rejects wrong secret with 401", async () => {
    const resp = await handleBackendDeployReportWebhook(
      postReq(BD_URL, { repo: "b", current_image: "i", deployed_by: "x" }, "wrong"),
      compatEnv(),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects missing fields with 400", async () => {
    const resp = await handleBackendDeployReportWebhook(
      postReq(BD_URL, { repo: "b" }),
      compatEnv(),
    );
    expect(resp.status).toBe(400);
  });

  it("accepts null wave_id", async () => {
    const resp = await handleBackendDeployReportWebhook(
      postReq(BD_URL, {
        repo: "ippoan/rust-alc-api",
        current_image: "img-1",
        deployed_by: "hotfix",
        wave_id: null,
      }),
      compatEnv(),
    );
    expect(resp.status).toBe(200);
    const got = await getBackendCurrent(testEnv.COMPAT_KV, "ippoan/rust-alc-api");
    expect(got!.wave_id).toBeNull();
  });

  it("writes the backend record (200)", async () => {
    const resp = await handleBackendDeployReportWebhook(
      postReq(BD_URL, {
        repo: "ippoan/rust-alc-api",
        current_image: "img-1",
        deployed_by: "release-wave-gcp",
        wave_id: "wave_1",
      }),
      compatEnv(),
    );
    expect(resp.status).toBe(200);
    const got = await getBackendCurrent(testEnv.COMPAT_KV, "ippoan/rust-alc-api");
    expect(got!.current_image).toBe("img-1");
  });
});

describe("handleCompatibility (GET /compatibility)", () => {
  it("400 when query params missing", async () => {
    const resp = await handleCompatibility(
      new Request("https://ci-dashboard.ippoan.org/compatibility"),
      compatEnv(),
    );
    expect(resp.status).toBe(400);
  });

  it("returns matrix for a tested backend image", async () => {
    await handleFrontendTestReportWebhook(
      postReq(FT_URL, {
        repo: "ippoan/auth-worker",
        prod_version: "v0.5.32",
        tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "target" },
      }),
      compatEnv(),
    );
    const resp = await handleCompatibility(
      new Request(
        "https://ci-dashboard.ippoan.org/compatibility?backend_repo=ippoan/rust-alc-api&backend_target_image=target",
      ),
      compatEnv(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { verified: boolean; matrix: unknown[] };
    expect(body.verified).toBe(true);
    expect(body.matrix).toHaveLength(1);
  });
});

describe("handleBackendCurrentImage (GET /backend-current-image)", () => {
  it("400 when repo missing", async () => {
    const resp = await handleBackendCurrentImage(
      new Request("https://ci-dashboard.ippoan.org/backend-current-image"),
      compatEnv(),
    );
    expect(resp.status).toBe(400);
  });

  it("404 when no record", async () => {
    const resp = await handleBackendCurrentImage(
      new Request(
        "https://ci-dashboard.ippoan.org/backend-current-image?repo=ippoan/nope",
      ),
      compatEnv(),
    );
    expect(resp.status).toBe(404);
  });

  it("returns current image when present", async () => {
    await handleBackendDeployReportWebhook(
      postReq(BD_URL, {
        repo: "ippoan/rust-alc-api",
        current_image: "img-9",
        deployed_by: "x",
      }),
      compatEnv(),
    );
    const resp = await handleBackendCurrentImage(
      new Request(
        "https://ci-dashboard.ippoan.org/backend-current-image?repo=ippoan/rust-alc-api",
      ),
      compatEnv(),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { current_image: string };
    expect(body.current_image).toBe("img-9");
  });
});

describe("handleBackendCurrentImageWebhook (authed GET under /webhooks)", () => {
  const BCI_URL =
    "https://ci-dashboard.ippoan.org/webhooks/release-wave/backend-current-image?repo=ippoan/rust-alc-api";

  function getReq(url: string, secret: string | null = SECRET): Request {
    const headers: Record<string, string> = {};
    if (secret !== null) headers["X-Release-Wave-Webhook-Secret"] = secret;
    return new Request(url, { method: "GET", headers });
  }

  it("rejects non-GET with 405", async () => {
    const resp = await handleBackendCurrentImageWebhook(
      new Request(BCI_URL, {
        method: "POST",
        headers: { "X-Release-Wave-Webhook-Secret": SECRET },
      }),
      compatEnv(),
    );
    expect(resp.status).toBe(405);
  });

  it("500 when secret not configured", async () => {
    const resp = await handleBackendCurrentImageWebhook(
      getReq(BCI_URL),
      compatEnv(null),
    );
    expect(resp.status).toBe(500);
  });

  it("rejects wrong secret with 401", async () => {
    const resp = await handleBackendCurrentImageWebhook(
      getReq(BCI_URL, "wrong"),
      compatEnv(),
    );
    expect(resp.status).toBe(401);
  });

  it("400 when repo missing", async () => {
    const resp = await handleBackendCurrentImageWebhook(
      getReq("https://ci-dashboard.ippoan.org/webhooks/release-wave/backend-current-image"),
      compatEnv(),
    );
    expect(resp.status).toBe(400);
  });

  it("404 when no record", async () => {
    const resp = await handleBackendCurrentImageWebhook(
      getReq("https://ci-dashboard.ippoan.org/webhooks/release-wave/backend-current-image?repo=ippoan/nope"),
      compatEnv(),
    );
    expect(resp.status).toBe(404);
  });

  it("returns current image when present", async () => {
    await handleBackendDeployReportWebhook(
      postReq(BD_URL, {
        repo: "ippoan/rust-alc-api",
        current_image: "img-authed",
        deployed_by: "x",
      }),
      compatEnv(),
    );
    const resp = await handleBackendCurrentImageWebhook(getReq(BCI_URL), compatEnv());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { current_image: string };
    expect(body.current_image).toBe("img-authed");
  });
});
