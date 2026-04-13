import { describe, it, expect, vi, afterEach } from "vitest";
import { githubApi, parseRepo, validateOrg } from "../../src/github-api";

describe("Issues tool logic", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("list_issues returns formatted results, filtering out PRs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        {
          number: 10,
          title: "Bug: webhook fails",
          state: "open",
          user: { login: "yhonda" },
          labels: [{ name: "bug" }],
          created_at: "2026-04-10T00:00:00Z",
          updated_at: "2026-04-11T00:00:00Z",
          html_url: "https://github.com/ippoan/ci-dashboard/issues/10",
          body: "Details here",
          comments: 3,
        },
        {
          number: 11,
          title: "feat: add MCP tools",
          state: "open",
          user: { login: "yhonda" },
          labels: [],
          created_at: "2026-04-11T00:00:00Z",
          updated_at: "2026-04-11T00:00:00Z",
          html_url: "https://github.com/ippoan/ci-dashboard/pull/11",
          body: null,
          comments: 0,
          pull_request: { url: "https://api.github.com/..." },
        },
      ]),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    validateOrg(owner);
    const issues = await githubApi<Array<{
      number: number;
      title: string;
      pull_request?: unknown;
    }>>(
      "token", "GET", `/repos/${owner}/${repo}/issues`,
      undefined, { state: "open", per_page: "20" },
    );

    // Filter out PRs like the tool does
    const filtered = issues.filter((i) => !i.pull_request);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.number).toBe(10);
    expect(filtered[0]!.title).toBe("Bug: webhook fails");
  });

  it("list_issues with labels filter", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([]),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    await githubApi<unknown[]>(
      "token", "GET", `/repos/${owner}/${repo}/issues`,
      undefined, { state: "open", per_page: "20", labels: "bug,enhancement" },
    );

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("labels=bug%2Cenhancement");
  });

  it("get_issue fetches issue + comments in parallel", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      Response.json({
        number: 10,
        title: "Bug: webhook fails",
        state: "open",
        user: { login: "yhonda" },
        labels: [{ name: "bug" }],
        created_at: "2026-04-10T00:00:00Z",
        updated_at: "2026-04-11T00:00:00Z",
        html_url: "https://github.com/ippoan/ci-dashboard/issues/10",
        body: "The webhook handler crashes when...",
        comments: 2,
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      Response.json([
        {
          user: { login: "reviewer" },
          created_at: "2026-04-10T01:00:00Z",
          body: "Can you add more details?",
        },
        {
          user: { login: "yhonda" },
          created_at: "2026-04-10T02:00:00Z",
          body: "Added stack trace above.",
        },
      ]),
    );

    const { owner, repo } = parseRepo("ci-dashboard");

    // Simulate parallel fetch like the tool does
    const [issue, comments] = await Promise.all([
      githubApi<{ number: number; title: string; body: string | null }>(
        "token", "GET", `/repos/${owner}/${repo}/issues/10`,
      ),
      githubApi<Array<{ user: { login: string }; body: string }>>(
        "token", "GET", `/repos/${owner}/${repo}/issues/10/comments`,
      ),
    ]);

    expect(issue.number).toBe(10);
    expect(issue.body).toContain("webhook handler crashes");
    expect(comments).toHaveLength(2);
    expect(comments[0]!.user.login).toBe("reviewer");
    expect(comments[1]!.body).toBe("Added stack trace above.");
  });
});
