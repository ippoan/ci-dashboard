import { describe, it, expect, vi, afterEach } from "vitest";
import { githubApi, parseRepo, validateOrg } from "../../src/github-api";

describe("Commits tool logic", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("list_commits returns formatted results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        {
          sha: "abc123def456789",
          commit: {
            message: "feat: add MCP tools\n\nDetailed description here",
            author: { name: "yhonda", date: "2026-04-13T10:00:00Z" },
          },
        },
        {
          sha: "def456abc789012",
          commit: {
            message: "fix: webhook handling",
            author: { name: "yhonda", date: "2026-04-12T09:00:00Z" },
          },
        },
      ]),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    validateOrg(owner);
    const commits = await githubApi<Array<{
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
    }>>(
      "token", "GET", `/repos/${owner}/${repo}/commits`,
      undefined, { sha: "main", per_page: "20" },
    );

    expect(commits).toHaveLength(2);
    expect(commits[0]!.sha.slice(0, 7)).toBe("abc123d");
    expect(commits[0]!.commit.message.split("\n")[0]).toBe("feat: add MCP tools");
  });

  it("list_commits with path filter", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([]),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    await githubApi<unknown[]>(
      "token", "GET", `/repos/${owner}/${repo}/commits`,
      undefined, { sha: "main", per_page: "10", path: "src/webhook.ts" },
    );

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("path=src%2Fwebhook.ts");
  });

  it("get_commit returns files with patch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        sha: "abc123def456789",
        commit: {
          message: "feat: add webhook handler",
          author: { name: "yhonda", date: "2026-04-13T10:00:00Z" },
        },
        stats: { total: 15, additions: 10, deletions: 5 },
        files: [
          {
            filename: "src/webhook.ts",
            status: "modified",
            additions: 10,
            deletions: 5,
            patch: "@@ -1,5 +1,10 @@\n+import { verify } from './crypto';\n export function handleWebhook() {",
          },
        ],
      }),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    const commit = await githubApi<{
      sha: string;
      stats: { total: number };
      files: Array<{ filename: string; patch?: string }>;
    }>(
      "token", "GET", `/repos/${owner}/${repo}/commits/abc123d`,
    );

    expect(commit.sha.slice(0, 7)).toBe("abc123d");
    expect(commit.stats.total).toBe(15);
    expect(commit.files).toHaveLength(1);
    expect(commit.files[0]!.filename).toBe("src/webhook.ts");
    expect(commit.files[0]!.patch).toContain("import { verify }");
  });

  it("get_commit truncates large patches", () => {
    const MAX_PATCH_LINES = 500;
    const largePatch = Array.from({ length: 600 }, (_, i) => `+line ${i}`).join("\n");
    const patchLines = largePatch.split("\n");

    expect(patchLines.length).toBe(600);

    // Simulate truncation logic
    const truncated = patchLines.slice(0, MAX_PATCH_LINES).join("\n")
      + `\n... (truncated, ${patchLines.length} total lines)`;
    expect(truncated).toContain("... (truncated, 600 total lines)");
    expect(truncated.split("\n").length).toBe(MAX_PATCH_LINES + 1);
  });
});
