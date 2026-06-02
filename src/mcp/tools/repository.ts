import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubApi, parseRepo, tokenForOrg } from "../../github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";

export function registerRepositoryTools(server: McpServer, env: AuthClientWorkerEnv): void {
  server.registerTool(
    "get_file_tree",
    {
      description: "Get the file tree of a repository. Use path filter to scope to a subdirectory.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api' or 'ippoan/rust-alc-api')"),
        ref: z.string().default("main").describe("Branch, tag, or commit SHA (default: main)"),
        path: z.string().optional().describe("Filter to paths starting with this prefix (e.g. 'src/routes')"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, ref, path }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const data = await githubApi<GitTree>(
        token, "GET", `/repos/${owner}/${name}/git/trees/${ref}`, undefined,
        { recursive: "1" },
      );

      let items = data.tree.map((t) => ({
        type: t.type === "blob" ? "file" : "dir",
        path: t.path,
        size: t.size ?? null,
      }));

      if (path) {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        items = items.filter((i) => i.path.startsWith(prefix) || i.path === path);
      }

      let header = `${items.length} entries`;
      if (data.truncated) header += " (truncated — repo too large for full tree)";

      return {
        content: [{
          type: "text" as const,
          text: `${header}\n\n${items.map((i) => `${i.type === "dir" ? "d" : "f"} ${i.path}${i.size != null ? ` (${i.size}B)` : ""}`).join("\n")}`,
        }],
      };
    },
  );

  server.registerTool(
    "get_file_content",
    {
      description: "Get file content with optional line range. For directories, returns the entry listing.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        path: z.string().describe("File path (e.g. 'src/main.rs')"),
        ref: z.string().optional().describe("Branch, tag, or commit SHA"),
        start_line: z.number().min(1).optional().describe("Start line (1-based)"),
        end_line: z.number().min(1).optional().describe("End line (inclusive)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, path, ref, start_line, end_line }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const params: Record<string, string> = {};
      if (ref) params.ref = ref;

      const data = await githubApi<ContentResponse | ContentResponse[]>(
        token, "GET", `/repos/${owner}/${name}/contents/${path}`, undefined, params,
      );

      // Directory listing
      if (Array.isArray(data)) {
        const entries = data.map((e) => `${e.type === "dir" ? "d" : "f"} ${e.name}${e.size ? ` (${e.size}B)` : ""}`);
        return {
          content: [{
            type: "text" as const,
            text: `Directory: ${path}\n${entries.length} entries\n\n${entries.join("\n")}`,
          }],
        };
      }

      // File content
      if (data.type === "symlink" || data.type === "submodule") {
        return { content: [{ type: "text" as const, text: `${data.type}: ${data.target ?? data.submodule_git_url ?? data.name}` }] };
      }

      if (!data.content) {
        return { content: [{ type: "text" as const, text: `File too large (${data.size}B). Use git blob API for files > 1MB.` }] };
      }

      const decoded = atob(data.content.replace(/\n/g, ""));
      const lines = decoded.split("\n");
      const totalLines = lines.length;

      let selected: string[];
      let header: string;

      if (start_line !== undefined) {
        const start = Math.max(1, start_line);
        const end = end_line !== undefined ? Math.min(totalLines, end_line) : totalLines;
        selected = lines.slice(start - 1, end);
        header = `${data.name} — Lines ${start}-${Math.min(end, totalLines)} of ${totalLines}`;
      } else {
        selected = lines;
        header = `${data.name} — ${totalLines} lines (${data.size}B)`;
      }

      const startNum = start_line !== undefined ? Math.max(1, start_line) : 1;
      const numbered = selected.map((line, i) => `${startNum + i}: ${line}`);

      return { content: [{ type: "text" as const, text: `${header}\n\n${numbered.join("\n")}` }] };
    },
  );

  server.registerTool(
    "search_code",
    {
      description: "Search code in a repository (grep-like). Returns matching files with text fragments.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        query: z.string().describe("Search query (e.g. 'handleWebhook', 'TODO')"),
        path: z.string().optional().describe("Path filter (e.g. 'src/routes')"),
        extension: z.string().optional().describe("File extension filter (e.g. 'ts', 'rs')"),
        per_page: z.number().min(1).max(100).default(20).describe("Results per page (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, query, path, extension, per_page }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      let q = `${query} repo:${owner}/${name}`;
      if (path) q += ` path:${path}`;
      if (extension) q += ` extension:${extension}`;

      const data = await githubApi<SearchCodeResponse>(
        token, "GET", "/search/code", undefined,
        { q, per_page: String(per_page) },
        { Accept: "application/vnd.github.text-match+json" },
      );

      const results = data.items.map((item) => {
        const fragments = (item.text_matches ?? [])
          .map((m) => m.fragment)
          .join("\n---\n");
        return `## ${item.path}\n${fragments || "(no text preview)"}`;
      });

      const header = `${data.total_count} total matches, showing ${data.items.length}`;
      return { content: [{ type: "text" as const, text: `${header}\n\n${results.join("\n\n")}` }] };
    },
  );

  // search_symbols は MCP tool から外した。CCoW では repo が clone 済みなので
  // symbol 検索はローカル (smart-read skill / session 内 LSP) で行う方が速く、
  // MCP 往復が要らない。symbol index の D1 は残すが、用途は MCP query ではなく
  // (1) skills/map の鮮度比較 (repos.src_hash) と (2) 人間向け view 生成。
  // 投入は POST /webhooks/symbol-index (src/symbol-index.ts)。
  // 設計: ippoan/claude-skills の cross-repo-symbol-index skill。
}

interface GitTree {
  sha: string;
  tree: Array<{
    path: string;
    type: string;
    size?: number;
  }>;
  truncated: boolean;
}

interface ContentResponse {
  name: string;
  path: string;
  type: string;
  size: number;
  content?: string;
  encoding?: string;
  target?: string;
  submodule_git_url?: string;
}

interface SearchCodeResponse {
  total_count: number;
  items: Array<{
    name: string;
    path: string;
    html_url: string;
    text_matches?: Array<{
      fragment: string;
      matches: Array<{ text: string; indices: number[] }>;
    }>;
  }>;
}
