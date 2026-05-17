import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cachedTags,
  cachedIssue,
  cachedCompare,
  invalidateIssue,
  clearReleaseCache,
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
});
