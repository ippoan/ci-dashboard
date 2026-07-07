import { appTestEnv } from "./_helpers/app-env";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extractIssueRefs,
  fetchOpenPrsByIssue,
  fetchAllOpenPrsByIssue,
  chunkRepos,
  TAGLESS_REPO_CHUNK,
} from "../src/issue-prs";

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

    const map = await fetchOpenPrsByIssue(appTestEnv(), { orgs: ["ippoan"] });
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
    expect(refs![0]!.state).toBe("open");
  });

  it("queries with `is:merged` and a recent updated:>= window when state='merged'", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        total_count: 1, incomplete_results: false,
        items: [{
          number: 20, title: "feat: done", state: "closed",
          body: "Refs #5",
          html_url: "https://github.com/ippoan/foo/pull/20",
          repository_url: "https://api.github.com/repos/ippoan/foo",
          draft: false, updated_at: "2026-05-10T00:00:00Z", pull_request: {},
        }],
      }),
    );
    const map = await fetchOpenPrsByIssue(appTestEnv(), {
      orgs: ["ippoan"], state: "merged",
    });
    const decoded = decodeURIComponent(String(spy.mock.calls[0]![0]));
    expect(decoded).toContain("is:pr");
    expect(decoded).toContain("is:merged");
    expect(decoded).not.toContain("state:open");
    expect(decoded).toMatch(/updated:>=\d{4}-\d{2}-\d{2}/);
    expect(map.get("ippoan/foo#5")![0]!.state).toBe("merged");
  });

  it("passes sort=updated & order=desc so recently-updated PRs win the per_page cap (Refs #464)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ total_count: 0, incomplete_results: false, items: [] }),
    );
    await fetchOpenPrsByIssue(appTestEnv(), { orgs: ["ippoan"], state: "merged" });
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(url.searchParams.get("sort")).toBe("updated");
    expect(url.searchParams.get("order")).toBe("desc");
    // open 側も一貫して付与される。
    await fetchOpenPrsByIssue(appTestEnv(), { orgs: ["ippoan"], state: "open" });
    const url2 = new URL(String(spy.mock.calls[1]![0]));
    expect(url2.searchParams.get("sort")).toBe("updated");
    expect(url2.searchParams.get("order")).toBe("desc");
  });

  it("uses repo: qualifiers (and omits org:) when `repos` is set", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ total_count: 0, incomplete_results: false, items: [] }),
    );
    await fetchOpenPrsByIssue(appTestEnv(), {
      repos: ["yhonda-ohishi/claude-skills", "yhonda-ohishi/claude-hooks"],
    });
    const url = String(spy.mock.calls[0]![0]);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("repo:yhonda-ohishi/claude-skills");
    expect(decoded).toContain("repo:yhonda-ohishi/claude-hooks");
    expect(decoded).not.toContain("org:yhonda-ohishi");
  });

  it("rejects unknown orgs via validateOrg", async () => {
    await expect(fetchOpenPrsByIssue(appTestEnv(), { orgs: ["evil-org"] }))
      .rejects.toThrow(/Org not allowed/);
  });
});

describe("fetchAllOpenPrsByIssue()", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("merges main-org and yhonda-repos PR maps (both open and merged), appending refs that share a key", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      const decoded = decodeURIComponent(url);
      const merged = decoded.includes("is:merged");
      if (decoded.includes("repo:yhonda-ohishi/claude-skills")) {
        if (merged) {
          return Response.json({ total_count: 0, incomplete_results: false, items: [] });
        }
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
      if (merged) {
        return Response.json({
          total_count: 1, incomplete_results: false,
          items: [{
            number: 7, title: "old done work", state: "closed",
            body: "Refs #5",
            html_url: "https://github.com/ippoan/foo/pull/7",
            repository_url: "https://api.github.com/repos/ippoan/foo",
            draft: false,
            updated_at: "2026-05-09T00:00:00Z",
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
      appTestEnv(), ["ippoan"], ["yhonda-ohishi/claude-skills"],
    );
    const refs = map.get("ippoan/foo#5");
    expect(refs).toBeDefined();
    expect(refs!).toHaveLength(3);
    // Open PRs come first (sorted by updated_at desc), then merged PRs.
    expect(refs![0]!.state).toBe("open");
    expect(refs![0]!.number).toBe(99);
    expect(refs![1]!.state).toBe("open");
    expect(refs![1]!.number).toBe(10);
    expect(refs![2]!.state).toBe("merged");
    expect(refs![2]!.number).toBe(7);
  });

  it("splits TAGLESS_REPOS merged search into chunks and never issues an open repo-scope call for them (Refs #466)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ total_count: 0, incomplete_results: false, items: [] }),
    );
    // prefix 重複しない 12 repo (12/5 = 3 チャンク)。
    const tagless = "abcdefghijkl".split("").map((c) => `ippoan/tagless-${c}`);
    await fetchAllOpenPrsByIssue(appTestEnv(), ["ippoan"], [], tagless);

    const urls = spy.mock.calls.map((c) => decodeURIComponent(String(c[0]!)));
    // org 広域 open+merged の 2 コール + tagless merged チャンク 3 コール = 5。
    expect(urls).toHaveLength(5);

    const taglessCalls = urls.filter((u) => u.includes("ippoan/tagless-"));
    expect(taglessCalls).toHaveLength(3);
    for (const u of taglessCalls) {
      // すべて merged / repo スコープ。open (state:open) は 1 件も出さない。
      expect(u).toContain("is:merged");
      expect(u).not.toContain("state:open");
      // 1 チャンクは TAGLESS_REPO_CHUNK 件以下。
      const count = (u.match(/repo:ippoan\/tagless-/g) ?? []).length;
      expect(count).toBeLessThanOrEqual(TAGLESS_REPO_CHUNK);
    }
    // 全 12 repo がいずれかのチャンクに含まれる (取りこぼし無し)。
    for (const r of tagless) {
      expect(taglessCalls.some((u) => u.includes(`repo:${r}`))).toBe(true);
    }
  });

  it("backfills a merged PR the org-wide search truncated but the TAGLESS repo-scope search finds (Refs #466)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      const decoded = decodeURIComponent(url);
      // org 広域 (org:) は truncation で該当 PR を返さない。repo スコープだけが返す。
      if (decoded.includes("is:merged") && decoded.includes("repo:ippoan/secrets-inventory")) {
        return Response.json({
          total_count: 1, incomplete_results: false,
          items: [{
            number: 87, title: "feat: done", state: "closed", body: "Refs #86",
            html_url: "https://github.com/ippoan/secrets-inventory/pull/87",
            repository_url: "https://api.github.com/repos/ippoan/secrets-inventory",
            draft: false, updated_at: "2026-07-04T00:00:00Z", pull_request: {},
          }],
        });
      }
      return Response.json({ total_count: 0, incomplete_results: false, items: [] });
    });

    const map = await fetchAllOpenPrsByIssue(
      appTestEnv(), ["ippoan"], [], ["ippoan/secrets-inventory"],
    );
    const refs = map.get("ippoan/secrets-inventory#86");
    expect(refs).toBeDefined();
    expect(refs!).toHaveLength(1);
    expect(refs![0]!.number).toBe(87);
    expect(refs![0]!.state).toBe("merged");
  });

  it("dedupes a merged PR returned by BOTH the org-wide and the TAGLESS repo-scope search (Refs #466)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      const decoded = decodeURIComponent(url);
      // 両方の merged 検索 (org 広域 + repo スコープ) が同一 PR を返す。
      if (decoded.includes("is:merged")) {
        return Response.json({
          total_count: 1, incomplete_results: false,
          items: [{
            number: 87, title: "feat: done", state: "closed", body: "Refs #86",
            html_url: "https://github.com/ippoan/secrets-inventory/pull/87",
            repository_url: "https://api.github.com/repos/ippoan/secrets-inventory",
            draft: false, updated_at: "2026-07-04T00:00:00Z", pull_request: {},
          }],
        });
      }
      return Response.json({ total_count: 0, incomplete_results: false, items: [] });
    });

    const map = await fetchAllOpenPrsByIssue(
      appTestEnv(), ["ippoan"], [], ["ippoan/secrets-inventory"],
    );
    const refs = map.get("ippoan/secrets-inventory#86");
    expect(refs).toBeDefined();
    // repo+number で dedup され、二重表示にならない。
    expect(refs!).toHaveLength(1);
    expect(refs![0]!.number).toBe(87);
    expect(refs![0]!.state).toBe("merged");
  });
});

describe("chunkRepos()", () => {
  it("splits into chunks of the given size (last chunk may be shorter)", () => {
    expect(chunkRepos([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkRepos([], 5)).toEqual([]);
  });

  it("keeps every chunk of the real 21-entry TAGLESS_REPOS under GitHub's 256-char query limit", () => {
    // wrangler.jsonc の env.staging.vars.TAGLESS_REPOS の実データ (21 件)。
    const tagless = [
      "ippoan/secrets-inventory", "ippoan/secrets-inventory-gcp", "ippoan/ci-dashboard",
      "ippoan/HealthConnectReaderWorker", "ippoan/claude-md", "ippoan/mcp-relay-rs",
      "ippoan/cc-relay", "ippoan/claude-skills", "ippoan/ci-workflows", "ippoan/ref-files-worker",
      "ippoan/claude-hooks", "ippoan/cdp-relay", "ippoan/release-wave-gcp", "ippoan/ui-preview",
      "ippoan/rust-flickr", "ippoan/cf-billing-monitor", "ippoan/security-notification-app",
      "ippoan/mcp-cf-workers", "ohishi-exp/rust-ichibanboshi", "ohishi-exp/daiun-salary",
      "ohishi-exp/nuxt-ichibanboshi-seikyu",
    ];
    const base = "is:pr archived:false is:merged updated:>=2026-05-08";
    for (const chunk of chunkRepos(tagless, TAGLESS_REPO_CHUNK)) {
      const q = [base, ...chunk.map((r) => `repo:${r}`)].join(" ");
      expect(q.length).toBeLessThanOrEqual(256);
    }
  });
});
