import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  recordFrontendTest,
  recordBackendDeploy,
  getBackendCurrent,
  computeCompatibility,
  TESTED_AGAINST_MAX,
  WINDOW_DAYS,
  SCHEMA_VERSION,
  type FrontendCompatRecord,
} from "../../src/release-wave/compat";

const kv = () => env.COMPAT_KV;

/** 各テスト前に compat key (frontend:: / backend::) を一掃する。 */
async function clearCompatKeys(): Promise<void> {
  for (const prefix of ["frontend::", "backend::"]) {
    const { keys } = await kv().list({ prefix });
    await Promise.all(keys.map((k) => kv().delete(k.name)));
  }
}

beforeEach(clearCompatKeys);

const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("recordFrontendTest", () => {
  it("creates a new record with one tested_against entry", async () => {
    const rec = await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v0.5.32",
      tested: {
        backend_repo: "ippoan/rust-alc-api",
        backend_image: "img-a",
        ci_run_url: "https://github.com/ippoan/auth-worker/actions/runs/1",
      },
      now: "2026-05-27T00:00:00.000Z",
    });
    expect(rec.schema_version).toBe(SCHEMA_VERSION);
    expect(rec.repo).toBe("ippoan/auth-worker");
    expect(rec.prod_version).toBe("v0.5.32");
    expect(rec.tested_against).toHaveLength(1);
    expect(rec.tested_against[0]).toMatchObject({
      backend_repo: "ippoan/rust-alc-api",
      backend_image: "img-a",
      ci_run_url: "https://github.com/ippoan/auth-worker/actions/runs/1",
    });

    const stored = await kv().get<FrontendCompatRecord>(
      "frontend::ippoan/auth-worker",
      "json",
    );
    expect(stored?.tested_against).toHaveLength(1);
  });

  it("omits ci_run_url when not provided", async () => {
    const rec = await recordFrontendTest(kv(), {
      repo: "ippoan/alc-app",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "img-a" },
      now: daysAgo(0),
    });
    expect(rec.tested_against[0]!.ci_run_url).toBeUndefined();
  });

  it("prepends new entries (most-recent first)", async () => {
    await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "old" },
      now: daysAgo(2),
    });
    const rec = await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v2",
      tested: { backend_repo: "ippoan/cc-relay", backend_image: "new" },
      now: daysAgo(1),
    });
    expect(rec.tested_against.map((e) => e.backend_image)).toEqual([
      "new",
      "old",
    ]);
    expect(rec.prod_version).toBe("v2");
  });

  it("dedupes same (backend_repo, backend_image), keeping the latest", async () => {
    const latest = daysAgo(1);
    await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "img-a" },
      now: daysAgo(3),
    });
    const rec = await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "img-a" },
      now: latest,
    });
    expect(rec.tested_against).toHaveLength(1);
    expect(rec.tested_against[0]!.tested_at).toBe(latest);
  });

  it("keeps distinct backend_repo entries side by side", async () => {
    await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "a" },
      now: daysAgo(2),
    });
    const rec = await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/cc-relay", backend_image: "b" },
      now: daysAgo(1),
    });
    expect(rec.tested_against).toHaveLength(2);
  });

  it("drops entries older than the window", async () => {
    // 既存 record に古い entry を仕込む
    await kv().put(
      "frontend::ippoan/auth-worker",
      JSON.stringify({
        schema_version: SCHEMA_VERSION,
        repo: "ippoan/auth-worker",
        prod_version: "v0",
        prod_deployed_at: daysAgo(WINDOW_DAYS + 10),
        tested_against: [
          {
            backend_repo: "ippoan/rust-alc-api",
            backend_image: "ancient",
            tested_at: daysAgo(WINDOW_DAYS + 10),
          },
        ],
      } satisfies FrontendCompatRecord),
    );
    const rec = await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/cc-relay", backend_image: "fresh" },
      now: daysAgo(0),
    });
    expect(rec.tested_against.map((e) => e.backend_image)).toEqual(["fresh"]);
  });

  it("caps entries to TESTED_AGAINST_MAX", async () => {
    for (let i = 0; i < TESTED_AGAINST_MAX + 5; i++) {
      await recordFrontendTest(kv(), {
        repo: "ippoan/auth-worker",
        prod_version: "v1",
        tested: { backend_repo: "ippoan/rust-alc-api", backend_image: `img-${i}` },
        now: new Date(Date.parse("2026-05-27T00:00:00.000Z") + i * 1000).toISOString(),
      });
    }
    const stored = await kv().get<FrontendCompatRecord>(
      "frontend::ippoan/auth-worker",
      "json",
    );
    expect(stored!.tested_against).toHaveLength(TESTED_AGAINST_MAX);
    // 直近 (最大 index) が先頭
    expect(stored!.tested_against[0]!.backend_image).toBe(
      `img-${TESTED_AGAINST_MAX + 4}`,
    );
  });

  it("resets tested_against when stored schema_version mismatches", async () => {
    await kv().put(
      "frontend::ippoan/auth-worker",
      JSON.stringify({
        schema_version: 99,
        repo: "ippoan/auth-worker",
        prod_version: "old",
        prod_deployed_at: daysAgo(1),
        tested_against: [
          { backend_repo: "x", backend_image: "stale", tested_at: daysAgo(1) },
        ],
      }),
    );
    const rec = await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "new" },
      now: daysAgo(0),
    });
    expect(rec.tested_against.map((e) => e.backend_image)).toEqual(["new"]);
  });
});

describe("recordBackendDeploy / getBackendCurrent", () => {
  it("upserts and reads back", async () => {
    await recordBackendDeploy(kv(), {
      repo: "ippoan/rust-alc-api",
      current_image: "img-1",
      deployed_by: "release-wave-gcp",
      wave_id: "wave_1",
      now: "2026-05-27T01:00:00.000Z",
    });
    const got = await getBackendCurrent(kv(), "ippoan/rust-alc-api");
    expect(got).toMatchObject({
      repo: "ippoan/rust-alc-api",
      current_image: "img-1",
      deployed_by: "release-wave-gcp",
      wave_id: "wave_1",
    });
  });

  it("defaults wave_id to null when omitted", async () => {
    const rec = await recordBackendDeploy(kv(), {
      repo: "ippoan/rust-alc-api",
      current_image: "img-1",
      deployed_by: "hotfix-deploy",
      now: daysAgo(0),
    });
    expect(rec.wave_id).toBeNull();
  });

  it("overwrites on subsequent deploy (latest only)", async () => {
    await recordBackendDeploy(kv(), {
      repo: "ippoan/rust-alc-api",
      current_image: "old",
      deployed_by: "x",
      now: daysAgo(1),
    });
    await recordBackendDeploy(kv(), {
      repo: "ippoan/rust-alc-api",
      current_image: "new",
      deployed_by: "y",
      now: daysAgo(0),
    });
    const got = await getBackendCurrent(kv(), "ippoan/rust-alc-api");
    expect(got!.current_image).toBe("new");
  });

  it("returns null when missing", async () => {
    expect(await getBackendCurrent(kv(), "ippoan/nope")).toBeNull();
  });

  it("returns null on schema mismatch", async () => {
    await kv().put(
      "backend::ippoan/rust-alc-api",
      JSON.stringify({ schema_version: 99, repo: "ippoan/rust-alc-api" }),
    );
    expect(await getBackendCurrent(kv(), "ippoan/rust-alc-api")).toBeNull();
  });
});

describe("computeCompatibility", () => {
  it("returns empty matrix and verified=false when no frontend tested the backend", async () => {
    const res = await computeCompatibility(kv(), "ippoan/rust-alc-api", "target");
    expect(res.matrix).toHaveLength(0);
    expect(res.verified).toBe(false);
  });

  it("marks a frontend green when it tested the exact target image", async () => {
    const at = daysAgo(1);
    await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v0.5.32",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "target" },
      now: at,
    });
    const res = await computeCompatibility(kv(), "ippoan/rust-alc-api", "target");
    expect(res.verified).toBe(true);
    expect(res.matrix).toHaveLength(1);
    expect(res.matrix[0]).toMatchObject({
      frontend: "ippoan/auth-worker",
      prod_version: "v0.5.32",
      tested_against_target: true,
      tested_against_at: at,
      last_tested_image: null,
    });
  });

  it("marks a frontend red when it only tested a different image", async () => {
    await recordFrontendTest(kv(), {
      repo: "ippoan/alc-app",
      prod_version: "v1.2.10",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "old-sha" },
      now: daysAgo(2),
    });
    const res = await computeCompatibility(kv(), "ippoan/rust-alc-api", "target");
    expect(res.verified).toBe(false);
    expect(res.matrix[0]).toMatchObject({
      frontend: "ippoan/alc-app",
      tested_against_target: false,
      tested_against_at: null,
      last_tested_image: "old-sha",
    });
  });

  it("excludes frontends that never tested this backend_repo", async () => {
    await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/cc-relay", backend_image: "x" },
      now: daysAgo(1),
    });
    const res = await computeCompatibility(kv(), "ippoan/rust-alc-api", "target");
    expect(res.matrix).toHaveLength(0);
  });

  it("combines green + red and sorts by frontend name; verified=false if any red", async () => {
    await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "target" },
      now: daysAgo(1),
    });
    await recordFrontendTest(kv(), {
      repo: "ippoan/alc-app",
      prod_version: "v2",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "stale" },
      now: daysAgo(1),
    });
    const res = await computeCompatibility(kv(), "ippoan/rust-alc-api", "target");
    expect(res.matrix.map((m) => m.frontend)).toEqual([
      "ippoan/alc-app",
      "ippoan/auth-worker",
    ]);
    expect(res.verified).toBe(false);
  });

  it("verified=true when every consuming frontend is green", async () => {
    await recordFrontendTest(kv(), {
      repo: "ippoan/auth-worker",
      prod_version: "v1",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "target" },
      now: daysAgo(1),
    });
    await recordFrontendTest(kv(), {
      repo: "ippoan/alc-app",
      prod_version: "v2",
      tested: { backend_repo: "ippoan/rust-alc-api", backend_image: "target" },
      now: daysAgo(1),
    });
    const res = await computeCompatibility(kv(), "ippoan/rust-alc-api", "target");
    expect(res.verified).toBe(true);
    expect(res.matrix).toHaveLength(2);
  });
});
