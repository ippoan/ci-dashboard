import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseRepo,
  validateOrg,
  githubApi,
  githubApiRaw,
  GitHubApiError,
} from "../src/github-api";

describe("parseRepo", () => {
  it("adds default org for bare repo name", () => {
    expect(parseRepo("rust-alc-api")).toEqual({ owner: "ippoan", repo: "rust-alc-api" });
  });

  it("splits owner/repo format", () => {
    expect(parseRepo("ohishi-exp/my-repo")).toEqual({ owner: "ohishi-exp", repo: "my-repo" });
  });
});

describe("validateOrg", () => {
  it("allows ippoan", () => {
    expect(() => validateOrg("ippoan")).not.toThrow();
  });

  it("allows ohishi-exp", () => {
    expect(() => validateOrg("ohishi-exp")).not.toThrow();
  });

  it("rejects unknown org", () => {
    expect(() => validateOrg("evil-org")).toThrow(GitHubApiError);
    try {
      validateOrg("evil-org");
    } catch (e) {
      expect((e as GitHubApiError).status).toBe(403);
    }
  });
});

describe("githubApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes GET request with correct headers", async () => {
    const mockData = { id: 1 };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(mockData),
    );

    const result = await githubApi<{ id: number }>(
      "test-token", "GET", "/repos/ippoan/test/actions/runs",
    );

    expect(result).toEqual(mockData);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/repos/ippoan/test/actions/runs",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          Accept: "application/vnd.github+json",
        }),
      }),
    );
  });

  it("appends query params", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ items: [] }),
    );

    await githubApi("token", "GET", "/repos/x/y/pulls", undefined, {
      state: "open",
      per_page: "10",
    });

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("state=open");
    expect(url).toContain("per_page=10");
  });

  it("sends POST body as JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    await githubApi("token", "POST", "/repos/x/y/actions/runs/1/rerun", { ref: "main" });

    const call = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(call[1]?.body).toBe('{"ref":"main"}');
  });

  it("returns undefined for 204 responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    const result = await githubApi("token", "POST", "/repos/x/y/cancel");
    expect(result).toBeUndefined();
  });

  it("throws GitHubApiError on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );

    await expect(
      githubApi("token", "GET", "/repos/x/y/nonexistent"),
    ).rejects.toThrow(GitHubApiError);

    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Forbidden", { status: 403 }),
      );
      await githubApi("token", "GET", "/repos/x/y/forbidden");
    } catch (e) {
      expect((e as GitHubApiError).status).toBe(403);
      expect((e as GitHubApiError).message).toContain("403");
    }
  });

  it("skips empty param values", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({}),
    );

    await githubApi("token", "GET", "/test", undefined, {
      filled: "yes",
      empty: "",
    });

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("filled=yes");
    expect(url).not.toContain("empty");
  });
});

describe("githubApiRaw", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns raw text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("line1\nline2\nline3"),
    );

    const text = await githubApiRaw("token", "GET", "/repos/x/y/actions/jobs/1/logs");
    expect(text).toBe("line1\nline2\nline3");
  });

  it("throws on error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Gone", { status: 410 }),
    );

    await expect(
      githubApiRaw("token", "GET", "/repos/x/y/actions/jobs/1/logs"),
    ).rejects.toThrow(GitHubApiError);
  });
});
