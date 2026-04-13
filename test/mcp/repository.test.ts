import { describe, it, expect, vi, afterEach } from "vitest";
import { githubApi, parseRepo, validateOrg } from "../../src/github-api";

describe("Repository tool logic", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("get_file_tree returns file listing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        sha: "abc123",
        tree: [
          { path: "src", type: "tree" },
          { path: "src/index.ts", type: "blob", size: 1024 },
          { path: "src/hub.ts", type: "blob", size: 2048 },
          { path: "README.md", type: "blob", size: 512 },
        ],
        truncated: false,
      }),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    validateOrg(owner);
    const data = await githubApi<{
      tree: Array<{ path: string; type: string; size?: number }>;
      truncated: boolean;
    }>(
      "token", "GET", `/repos/${owner}/${repo}/git/trees/main`,
      undefined, { recursive: "1" },
    );

    expect(data.tree).toHaveLength(4);
    expect(data.tree[1]!.path).toBe("src/index.ts");
    expect(data.truncated).toBe(false);
  });

  it("get_file_tree with path filter", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        sha: "abc123",
        tree: [
          { path: "src", type: "tree" },
          { path: "src/index.ts", type: "blob", size: 1024 },
          { path: "src/mcp/server.ts", type: "blob", size: 512 },
          { path: "test/foo.test.ts", type: "blob", size: 256 },
        ],
        truncated: false,
      }),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    const data = await githubApi<{
      tree: Array<{ path: string; type: string; size?: number }>;
    }>(
      "token", "GET", `/repos/${owner}/${repo}/git/trees/main`,
      undefined, { recursive: "1" },
    );

    // Simulate path filter
    const prefix = "src/";
    const filtered = data.tree.filter((t) => t.path.startsWith(prefix) || t.path === "src");
    expect(filtered).toHaveLength(3);
  });

  it("get_file_content returns decoded content with line numbers", async () => {
    const content = btoa("line 1\nline 2\nline 3\nline 4\nline 5\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        name: "test.ts",
        path: "src/test.ts",
        type: "file",
        size: 30,
        content,
        encoding: "base64",
      }),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    const data = await githubApi<{ content: string; name: string; size: number }>(
      "token", "GET", `/repos/${owner}/${repo}/contents/src/test.ts`,
    );

    const decoded = atob(data.content.replace(/\n/g, ""));
    const lines = decoded.split("\n");
    expect(lines[0]).toBe("line 1");
    expect(lines[4]).toBe("line 5");

    // Simulate range: lines 2-4
    const selected = lines.slice(1, 4);
    expect(selected).toEqual(["line 2", "line 3", "line 4"]);
  });

  it("get_file_content handles directory listing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        { name: "index.ts", path: "src/index.ts", type: "file", size: 1024 },
        { name: "hub.ts", path: "src/hub.ts", type: "file", size: 2048 },
        { name: "mcp", path: "src/mcp", type: "dir" },
      ]),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    const data = await githubApi<Array<{ name: string; type: string }>>(
      "token", "GET", `/repos/${owner}/${repo}/contents/src`,
    );

    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(3);
    expect(data[2]!.type).toBe("dir");
  });

  it("search_code sends text-match header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        total_count: 2,
        items: [
          {
            name: "webhook.ts",
            path: "src/webhook.ts",
            html_url: "https://github.com/ippoan/ci-dashboard/blob/main/src/webhook.ts",
            text_matches: [
              { fragment: "export async function handleWebhook(", matches: [{ text: "handleWebhook", indices: [29, 42] }] },
            ],
          },
        ],
      }),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    await githubApi<{ total_count: number; items: unknown[] }>(
      "token", "GET", "/search/code", undefined,
      { q: `handleWebhook repo:${owner}/${repo}`, per_page: "20" },
      { Accept: "application/vnd.github.text-match+json" },
    );

    // Verify text-match header was sent
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github.text-match+json");
  });

  it("search_symbols builds language-aware query", () => {
    // Test query building logic
    const symbolKeyword = (kind: string, language?: string): string => {
      const lang = language?.toLowerCase();
      const keywords: Record<string, Record<string, string>> = {
        function: { rust: "fn", python: "def", go: "func", _default: "function" },
        class: { _default: "class" },
        struct: { _default: "struct" },
        trait: { _default: "trait" },
      };
      const kindMap = keywords[kind];
      if (!kindMap) return kind;
      return (lang && kindMap[lang]) || kindMap._default || kind;
    };

    expect(symbolKeyword("function", "rust")).toBe("fn");
    expect(symbolKeyword("function", "python")).toBe("def");
    expect(symbolKeyword("function", "go")).toBe("func");
    expect(symbolKeyword("function", "typescript")).toBe("function");
    expect(symbolKeyword("struct")).toBe("struct");
    expect(symbolKeyword("trait")).toBe("trait");
  });
});
