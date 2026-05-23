import { describe, it, expect, vi, afterEach } from "vitest";
import { extractIssueRefs, fetchOpenPrsByIssue, fetchAllOpenPrsByIssue } from "../src/issue-prs";

describe("extractIssueRefs()", () => {
  it("extracts bare `#N` refs qualified with the PR's own repo", () => {
    const refs = extractIssueRefs("ippoan/rust-alc-api", "Refs #123\nFixes #45");
    expect([...refs]).toEqual(
      expect.arrayContaining([
        "ippoan/rust-alc-api#123",
        "ippoan/rust-alc-api#45",
      ]),
    );
  });

  it("extracts cross-repo `owner/repo#N` refs", () => {
    const refs = extractIssueRefs(
      "ippoan/ci-dashboard",
      "Part of ippoan/auth-worker#7",
    );
    expect(refs.has("ippoan/auth-worker#7")).toBe(true);
  });

  it("extracts GitHub issue URLs", () => {
    const refs = extractIssueRefs(
      "ippoan/foo",
      "See https://github.com/ippoan/bar/issues/42 for context",
    );
    expect(refs.has("ippoan/bar#42")).toBe(true);
  });

  it("supports all the keywords from CLAUDE.md (Refs / Related to / Part of) and the closing keywords", () => {
    const refs = extractIssueRefs(
      "ippoan/x",
      "Closes #1\nFixes #2\nResolves #3\nRefs #4\nRelated to #5\nPart of #6",
    );
    expect(refs.size).toBe(6);
  });

  it("returns empty when no refs are present", () => {
    const refs = extractIssueRefs("ippoan/x", "This PR fixes a bug.");
    expect(refs.size).toBe(0);
  });

  it("is case-insensitive on keywords", () => {
    const refs = extractIssueRefs("ippoan/x", "REFS #99");
    expect(refs.has("ippoan/x#99")).toBe(true);
  });
});

describe("fetchOpenPrsByIssue()", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("queries /search/issues with `is:pr state:open` and parses refs from body", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            number: 10,
            title: "feat",
            state: "open",
            body: "Refs #5",
            html_url: "https://github.com/ippoan/foo/pull/10",
            repository_url: "https://api.github.com/repos/ippoan/foo",
            draft: false,
            updated_at: "2026-05-11T00:00:00Z",
            pull_request: {},
          },
          {
            number: 11,
            title: "chore: no refs",
            state: "open",
            body: "Just a cleanup",
            html_url: "https://github.com/ippoan/foo/pull/11",
            repository_url: "https://api.github.com/repos/ippoan/foo",
            draft: false,
            updated_at: "2026-05-11T00:00:00Z",
            pull_request: {},
          },
        ],
      }),
    );

    const map = await fetchOpenPrsByIssue("token", { orgs: ["ippoan"] });
    expect(spy).toHaveBeenCalledTimes(1);
    const url = String(spy.mock.calls[0]![0]);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("is:pr");
    expect(decoded).toContain("state:open");
    expect(decoded).toContain("org:ippoan");

    expect(map.size).toBe(1);
    const refs = map.get("ippoan/foo#5");
    expect(refs).toBeDefined();
    expect(refs!).toHaveLength(1);
    expect(refs![0]!.number).toBe(10);
    expect(refs![0]!.draft).toBe(false);
  });

  it("uses repo: qualifiers (and omits org:) when `repos` is set", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ total_count: 0, incomplete_results: false, items: [] }),
    );
    await fetchOpenPrsByIssue("token", {
      repos: ["yhonda-ohishi/claude-skills", "yhonda-ohishi/claude-hooks"],
    });
    const url = String(spy.mock.calls[0]![0]);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("repo:yhonda-ohishi/claude-skills");
    expect(decoded).toContain("repo:yhonda-ohishi/claude-hooks");
    expect(decoded).not.toContain("org:yhonda-ohishi");
  });

  it("rejects unknown orgs via validateOrg", async () => {
    await expect(fetchOpenPrsByIssue("token", { orgs: ["evil-org"] }))
      .rejects.toThrow(/Org not allowed/);
  });
});

describe("fetchAllOpenPrsByIssue()", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("merges main-org and yhonda-repos PR maps, appending refs that share a key", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      const decoded = decodeURIComponent(url);
      if (decoded.includes("repo:yhonda-ohishi/claude-skills")) {
        return Response.json({
          total_count: 1, incomplete_results: false,
          items: [{
            number: 99, title: "yhonda fix", state: "open",
            body: "Refs ippoan/foo#5",
            html_url: "https://github.com/yhonda-ohishi/claude-skills/pull/99",
            repository_url: "https://api.github.com/repos/yhonda-ohishi/claude-skills",
            draft: true,
            updated_at: "2026-05-12T00:00:00Z",
            pull_request: {},
          }],
        });
      }
      return Response.json({
        total_count: 1, incomplete_results: false,
        items: [{
          number: 10, title: "ippoan fix", state: "open",
          body: "Refs #5",
          html_url: "https://github.com/ippoan/foo/pull/10",
          repository_url: "https://api.github.com/repos/ippoan/foo",
          draft: false,
          updated_at: "2026-05-11T00:00:00Z",
          pull_request: {},
        }],
      });
    });

    const map = await fetchAllOpenPrsByIssue(
      "token", ["ippoan"], ["yhonda-ohishi/claude-skills"],
    );
    const refs = map.get("ippoan/foo#5");
    expect(refs).toBeDefined();
    expect(refs!).toHaveLength(2);
    // Sorted by updated_at desc, so the yhonda PR (later) comes first.
    expect(refs![0]!.number).toBe(99);
    expect(refs![0]!.draft).toBe(true);
    expect(refs![1]!.number).toBe(10);
  });
});
