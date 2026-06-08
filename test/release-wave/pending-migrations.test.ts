import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  computeRepoPendingMigrations,
  type RepoPendingMigrations,
} from "../../src/release-wave/pending-migrations";
import { clearReleaseCache } from "../../src/release-cache";

// computeRepoPendingMigrations は GitHub の 3 endpoint を順に叩く:
//   GET /repos/{o}/{n}            (default branch)
//   GET /repos/{o}/{n}/tags       (最新 stable v* tag)
//   GET /repos/{o}/{n}/compare/.. (base...head の files[])
// fetch を URL で振り分けて mock する (release-cache.test.ts と同じ流儀)。

type FetchRoutes = {
  meta?: unknown;
  tags?: Array<{ name: string }>;
  compareFiles?: Array<{ filename: string; status: string }>;
};

function mockGitHub(routes: FetchRoutes): { compareCalls: () => number } {
  let compareCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/compare/")) {
      compareCalls++;
      return Response.json({ files: routes.compareFiles ?? [] });
    }
    if (url.endsWith("/tags") || url.includes("/tags?")) {
      return Response.json(
        (routes.tags ?? []).map((t) => ({ name: t.name, commit: { sha: "x" } })),
      );
    }
    // repo meta
    return Response.json(routes.meta ?? { default_branch: "main" });
  });
  return { compareCalls: () => compareCalls };
}

describe("computeRepoPendingMigrations", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearReleaseCache(env.CI_STATUS);
  });

  it("status=pending: base_tag 以降に追加された migrations/*.sql を拾う", async () => {
    mockGitHub({
      tags: [{ name: "v0.0.74" }, { name: "v0.0.73" }, { name: "dev-12" }],
      compareFiles: [
        { filename: "migrations/112_alter_yyy.sql", status: "added" },
        { filename: "migrations/111_add_xxx.sql", status: "added" },
        { filename: "src/routes/foo.rs", status: "modified" },
        { filename: "migrations/010_old.sql", status: "modified" }, // 既存変更は除外
        { filename: "docs/migrations/notes.sql", status: "added" }, // migrations/ 直下のみ
      ],
    });

    const pm = await computeRepoPendingMigrations(
      "tok",
      env.CI_STATUS,
      "ippoan/repo-a",
    );

    const expected: RepoPendingMigrations = {
      repo: "ippoan/repo-a",
      base_tag: "v0.0.74",
      head: "main",
      // basename 昇順
      files: ["111_add_xxx.sql", "112_alter_yyy.sql"],
      count: 2,
      status: "pending",
    };
    expect(pm).toEqual(expected);
  });

  it("status=none: 追加マイグレーション無し → migrate は no-op", async () => {
    mockGitHub({
      tags: [{ name: "v1.2.3" }],
      compareFiles: [{ filename: "src/index.ts", status: "modified" }],
    });

    const pm = await computeRepoPendingMigrations(
      "tok",
      env.CI_STATUS,
      "ippoan/repo-b",
    );
    expect(pm.status).toBe("none");
    expect(pm.count).toBe(0);
    expect(pm.files).toEqual([]);
    expect(pm.base_tag).toBe("v1.2.3");
  });

  it("status=unknown: stable v* tag が無い (= baseline 無し、compare も叩かない)", async () => {
    const m = mockGitHub({
      tags: [{ name: "dev-3" }, { name: "v1.0.0-rc.1" }], // どちらも stable でない
      compareFiles: [{ filename: "migrations/001_x.sql", status: "added" }],
    });

    const pm = await computeRepoPendingMigrations(
      "tok",
      env.CI_STATUS,
      "ippoan/repo-c",
    );
    expect(pm.status).toBe("unknown");
    expect(pm.base_tag).toBeNull();
    expect(pm.count).toBe(0);
    expect(m.compareCalls()).toBe(0); // baseline 無し → compare をそもそも呼ばない
  });

  it("default branch を repo meta から拾う (main 以外でも head に反映)", async () => {
    mockGitHub({
      meta: { default_branch: "trunk" },
      tags: [{ name: "v2.0.0" }],
      compareFiles: [{ filename: "migrations/050_z.sql", status: "added" }],
    });

    const pm = await computeRepoPendingMigrations(
      "tok",
      env.CI_STATUS,
      "ippoan/repo-d",
    );
    expect(pm.head).toBe("trunk");
    expect(pm.status).toBe("pending");
    expect(pm.files).toEqual(["050_z.sql"]);
  });

  it("compare 結果は短命 cache される (2 回目は GitHub を叩かない)", async () => {
    const m = mockGitHub({
      tags: [{ name: "v0.1.0" }],
      compareFiles: [{ filename: "migrations/001_a.sql", status: "added" }],
    });

    await computeRepoPendingMigrations("tok", env.CI_STATUS, "ippoan/repo-e");
    await computeRepoPendingMigrations("tok", env.CI_STATUS, "ippoan/repo-e");
    expect(m.compareCalls()).toBe(1);
  });
});
