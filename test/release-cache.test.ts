import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cachedTags,
  cachedCommits,
  cachedIssue,
  cachedCompare,
  invalidateIssue,
  invalidateRepoTags,
  invalidateRepoCommits,
  invalidateRepoCompare,
  invalidateRepoMeta,
  clearReleaseCache,
  TTL_MOVING_COMPARE,
} from "../src/release-cache";

// The cache layer is meant to be transparent: first call hits GitHub, second
// call returns the same payload without touching the network. Issue closes
// then invalidate the slot so the third call re-fetches. We assert on fetch
// call counts because that's what determines the actual /releases speedup —
// hitting KV instead of api.github.com.
describe("release-cache", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearReleaseCache(env.CI_STATUS);
  });

  it("cachedIssue: first call fetches, second hits KV, invalidate forces re-fetch", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return Response.json({
        number: 1, title: "x", state: "open",
        labels: [], assignees: [],
        html_url: "u", updated_at: "t",
      });
    });

    const a = await cachedIssue("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 1);
    const b = await cachedIssue("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 1);
    expect(calls).toBe(1);
    expect(b).toEqual(a);

    await invalidateIssue(env.CI_STATUS, "ippoan", "ci-dashboard", 1);
    await cachedIssue("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 1);
    expect(calls).toBe(2);
  });

  it("cachedTags: per_page is part of the cache key", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return Response.json([{ name: "v1.0.0", commit: { sha: "a" } }]);
    });
    await cachedTags("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 10);
    await cachedTags("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 10);
    await cachedTags("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 30);
    expect(calls).toBe(2);
  });

  it("cachedCompare: prev..curr identity caches per range", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return Response.json({ commits: [] });
    });
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "x", "v1.0.0", "v1.1.0");
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "x", "v1.0.0", "v1.1.0");
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "x", "v1.1.0", "v1.2.0");
    expect(calls).toBe(2);
  });

  // #228: the "Unreleased" zone compares `tag...<defaultBranch>`, a moving
  // range, so it must NOT inherit the 24h immutable-range TTL — otherwise a
  // just-merged Ref stays hidden for up to a day. An explicit ttlSec override
  // (TTL_MOVING_COMPARE) caps the KV entry at 60s; the default stays 24h.
  it("cachedCompare: honors an explicit short ttl for moving-HEAD ranges", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ commits: [] }),
    );
    const putSpy = vi.spyOn(env.CI_STATUS, "put");

    // Immutable tag...tag — default 24h.
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "y", "v1.0.0", "v1.1.0");
    // Moving tag...main — short TTL via override.
    await cachedCompare(
      "tok", env.CI_STATUS, "ippoan", "y", "v1.0.0", "main", TTL_MOVING_COMPARE,
    );

    const ttlFor = (frag: string): number | undefined => {
      const call = putSpy.mock.calls.find(([k]) => String(k).includes(frag));
      return (call?.[2] as { expirationTtl?: number } | undefined)?.expirationTtl;
    };
    expect(ttlFor("v1.0.0..v1.1.0")).toBe(86400);
    expect(ttlFor("v1.0.0..main")).toBe(TTL_MOVING_COMPARE);
    expect(TTL_MOVING_COMPARE).toBe(60);
  });

  it("falls through to the loader when kv is undefined (no caching)", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return Response.json([]);
    });
    await cachedTags("tok", undefined, "ippoan", "ci-dashboard", 10);
    await cachedTags("tok", undefined, "ippoan", "ci-dashboard", 10);
    expect(calls).toBe(2);
  });

  it("invalidateIssue is a no-op when kv is undefined", async () => {
    await expect(
      invalidateIssue(undefined, "ippoan", "ci-dashboard", 1),
    ).resolves.toBeUndefined();
  });

  // Phase 3 (Refs #133): webhook 駆動 invalidation helpers。
  it("invalidateRepoTags: 該当 repo の tags cache を全 per_page 分 flush する", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return Response.json([{ name: "v1.0.0", commit: { sha: "a" } }]);
    });
    // 2 different per_page values populate 2 different KV keys
    await cachedTags("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 10);
    await cachedTags("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 30);
    // 別 repo は触らないことの確認用
    await cachedTags("tok", env.CI_STATUS, "ippoan", "other", 10);
    expect(calls).toBe(3);

    await invalidateRepoTags(env.CI_STATUS, "ippoan", "ci-dashboard");

    // 該当 repo は cache miss → 再 fetch (calls 増える)
    await cachedTags("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 10);
    await cachedTags("tok", env.CI_STATUS, "ippoan", "ci-dashboard", 30);
    expect(calls).toBe(5);
    // 別 repo は cache hit のまま
    await cachedTags("tok", env.CI_STATUS, "ippoan", "other", 10);
    expect(calls).toBe(5);
  });

  it("invalidateRepoCommits: 該当 repo の commits cache を flush する", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return Response.json([{ sha: "a", commit: { message: "m" } }]);
    });
    await cachedCommits("tok", env.CI_STATUS, "ippoan", "ci-dashboard", "main", 50);
    await cachedCommits("tok", env.CI_STATUS, "ippoan", "other", "main", 50);
    expect(calls).toBe(2);

    await invalidateRepoCommits(env.CI_STATUS, "ippoan", "ci-dashboard");

    await cachedCommits("tok", env.CI_STATUS, "ippoan", "ci-dashboard", "main", 50);
    expect(calls).toBe(3); // 該当 repo 再 fetch
    await cachedCommits("tok", env.CI_STATUS, "ippoan", "other", "main", 50);
    expect(calls).toBe(3); // 別 repo は hit
  });

  it("invalidateRepoCompare: 該当 repo の全 compare range を flush する (#231)", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return Response.json({ commits: [] });
    });
    // immutable tag...tag と moving tag...main の両方を populate
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "ci-dashboard", "v1.0.0", "v1.1.0");
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "ci-dashboard", "v1.1.0", "main", TTL_MOVING_COMPARE);
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "other", "v1.0.0", "main", TTL_MOVING_COMPARE);
    expect(calls).toBe(3);

    await invalidateRepoCompare(env.CI_STATUS, "ippoan", "ci-dashboard");

    // 該当 repo の compare は全部 (tag...tag も tag...main も) 再 fetch
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "ci-dashboard", "v1.0.0", "v1.1.0");
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "ci-dashboard", "v1.1.0", "main", TTL_MOVING_COMPARE);
    expect(calls).toBe(5);
    // 別 repo は hit のまま
    await cachedCompare("tok", env.CI_STATUS, "ippoan", "other", "v1.0.0", "main", TTL_MOVING_COMPARE);
    expect(calls).toBe(5);
  });

  it("invalidateRepoMeta: 該当 repo の repo-meta key だけ消す", async () => {
    await env.CI_STATUS.put("rcache:v1:repo:ippoan/ci-dashboard", '{"default_branch":"main"}');
    await env.CI_STATUS.put("rcache:v1:repo:ippoan/other", '{"default_branch":"main"}');
    await invalidateRepoMeta(env.CI_STATUS, "ippoan", "ci-dashboard");
    expect(await env.CI_STATUS.get("rcache:v1:repo:ippoan/ci-dashboard")).toBeNull();
    expect(await env.CI_STATUS.get("rcache:v1:repo:ippoan/other")).toBeTruthy();
  });

  it("invalidateRepoTags / invalidateRepoCommits / invalidateRepoMeta は kv=undefined で no-op", async () => {
    await expect(invalidateRepoTags(undefined, "x", "y")).resolves.toBeUndefined();
    await expect(invalidateRepoCommits(undefined, "x", "y")).resolves.toBeUndefined();
    await expect(invalidateRepoMeta(undefined, "x", "y")).resolves.toBeUndefined();
  });
});
