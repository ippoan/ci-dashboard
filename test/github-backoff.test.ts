import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { GitHubApiError } from "../src/github-api";
import {
  isRateLimitError,
  setRateLimitBackoff,
  getRateLimitBackoff,
  __testing,
} from "../src/github-backoff";

describe("github-backoff", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete(__testing.BACKOFF_KEY);
  });

  it("isRateLimitError: GitHubApiError 403/429 と 'rate limit' 文言を拾う", () => {
    expect(isRateLimitError(new GitHubApiError(403, "GitHub API 403: forbidden"))).toBe(true);
    expect(isRateLimitError(new GitHubApiError(429, "GitHub API 429: slow down"))).toBe(true);
    expect(isRateLimitError(new GitHubApiError(500, "GitHub API 500: boom"))).toBe(false);
    expect(isRateLimitError(new Error("API rate limit already exceeded for user ID 1"))).toBe(true);
    expect(isRateLimitError(new Error("network down"))).toBe(false);
    expect(isRateLimitError("string error mentioning rate limit")).toBe(true);
  });

  it("set → get roundtrip: until ≈ now + TTL、message は 200 字 trim", async () => {
    const before = Date.now();
    await setRateLimitBackoff(env.CI_STATUS, new GitHubApiError(403, "x".repeat(500)));
    const entry = await getRateLimitBackoff(env.CI_STATUS);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe(403);
    expect(entry!.message).toHaveLength(200);
    expect(entry!.until).toBeGreaterThanOrEqual(before + __testing.BACKOFF_TTL_SECONDS * 1000);
    expect(entry!.until).toBeLessThanOrEqual(Date.now() + __testing.BACKOFF_TTL_SECONDS * 1000);
  });

  it("marker 無しは null", async () => {
    expect(await getRateLimitBackoff(env.CI_STATUS)).toBeNull();
  });

  it("非 GitHubApiError は status 0 で記録される", async () => {
    await setRateLimitBackoff(env.CI_STATUS, new Error("secondary rate limit hit"));
    const entry = await getRateLimitBackoff(env.CI_STATUS);
    expect(entry!.status).toBe(0);
    expect(entry!.message).toContain("secondary rate limit");
  });
});
