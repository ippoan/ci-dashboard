import { describe, it, expect } from "vitest";
import { formatCloseFailureReason } from "../src/release-close";
import { parseFailedReasons } from "../src/releases-page";
import { GitHubApiError } from "../src/github-api";

// Refs ippoan/ci-dashboard#152
// close 失敗時の reason 短縮整形 + URL flash param 経路の roundtrip 検証。

describe("formatCloseFailureReason", () => {
  it("maps archived 403 to short human-readable string", () => {
    const err = new GitHubApiError(
      403,
      'GitHub API 403: {"message":"Repository was archived so is read-only.","documentation_url":"..."}',
    );
    expect(formatCloseFailureReason(err)).toBe("archived (read-only)");
  });

  it("maps generic 403 to 'forbidden (403)'", () => {
    const err = new GitHubApiError(403, "GitHub API 403: Resource not accessible by integration");
    expect(formatCloseFailureReason(err)).toBe("forbidden (403)");
  });

  it("detects rate-limit 403", () => {
    const err = new GitHubApiError(
      403,
      'GitHub API 403: {"message":"API rate limit exceeded for user ID 87104778"}',
    );
    expect(formatCloseFailureReason(err)).toBe("rate limit");
  });

  it("detects SAML SSO 403", () => {
    const err = new GitHubApiError(
      403,
      'GitHub API 403: Resource protected by SAML SSO',
    );
    expect(formatCloseFailureReason(err)).toBe("SAML SSO required");
  });

  it("maps 404 / 410 / 422 to short labels", () => {
    expect(formatCloseFailureReason(new GitHubApiError(404, "not found"))).toBe("not found (404)");
    expect(formatCloseFailureReason(new GitHubApiError(410, "issues disabled"))).toBe("issues disabled (410)");
    expect(formatCloseFailureReason(new GitHubApiError(422, "validation"))).toBe("validation failed (422)");
  });

  it("falls back to status + truncated message for other GitHubApiError", () => {
    const err = new GitHubApiError(500, "GitHub API 500: boom");
    const r = formatCloseFailureReason(err);
    expect(r.startsWith("500 ")).toBe(true);
    expect(r.length).toBeLessThanOrEqual(80 + 4);
  });

  it("handles non-Error values gracefully", () => {
    expect(formatCloseFailureReason("network glitch")).toBe("network glitch");
    expect(formatCloseFailureReason(new Error("offline"))).toBe("offline");
  });

  it("truncates very long fallback messages to 100 chars", () => {
    const long = "x".repeat(500);
    expect(formatCloseFailureReason(long).length).toBe(100);
  });
});

describe("parseFailedReasons", () => {
  it("parses N:urlencoded-reason,N:urlencoded-reason form", () => {
    const m = parseFailedReasons("59:archived%20(read-only),60:rate%20limit");
    expect(m.get(59)).toBe("archived (read-only)");
    expect(m.get(60)).toBe("rate limit");
  });

  it("returns empty map for null / empty / malformed input", () => {
    expect(parseFailedReasons(null).size).toBe(0);
    expect(parseFailedReasons("").size).toBe(0);
    expect(parseFailedReasons("garbage").size).toBe(0);
    expect(parseFailedReasons(":no-number").size).toBe(0);
    expect(parseFailedReasons("abc:not-a-number").size).toBe(0);
  });

  it("silently drops individual malformed entries while keeping valid ones", () => {
    const m = parseFailedReasons("59:ok,garbage,60:also-ok");
    expect(m.get(59)).toBe("ok");
    expect(m.get(60)).toBe("also-ok");
    expect(m.size).toBe(2);
  });

  it("roundtrips with the encoder used by release-close.ts", () => {
    // release-close.ts は `${n}:${encodeURIComponent(reason)}` を join(",") で
    // 連結する。同じ形式を assemble → parse して同値性を確認。
    const enc = (n: number, r: string) => `${n}:${encodeURIComponent(r)}`;
    const param = [
      enc(1, "archived (read-only)"),
      enc(2, "forbidden (403)"),
      enc(3, "500 GitHub API 500: boom"),
    ].join(",");
    const m = parseFailedReasons(param);
    expect(m.get(1)).toBe("archived (read-only)");
    expect(m.get(2)).toBe("forbidden (403)");
    expect(m.get(3)).toBe("500 GitHub API 500: boom");
  });
});
