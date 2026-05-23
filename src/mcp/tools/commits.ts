import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubApi, parseRepo, tokenForOrg } from "../../github-api";
import type { AuthWorkerEnv } from "../../auth-worker-client";

export function registerCommitsTools(server: McpServer, env: AuthWorkerEnv): void {
  server.registerTool(
    "list_commits",
    {
      description: "List commits for a repository. Supports branch/tag and file path filtering.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        sha: z.string().default("main").describe("Branch, tag, or SHA (default: main)"),
        path: z.string().optional().describe("Filter commits touching this file path"),
        per_page: z.number().min(1).max(100).default(20).describe("Results per page (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, sha, path, per_page }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const params: Record<string, string> = {
        sha,
        per_page: String(per_page),
      };
      if (path) params.path = path;

      const commits = await githubApi<CommitListItem[]>(
        token, "GET", `/repos/${owner}/${name}/commits`, undefined, params,
      );

      const result = commits.map((c) => ({
        sha: c.sha.slice(0, 7),
        message: c.commit.message.split("\n")[0],
        author: c.commit.author.name,
        date: c.commit.author.date,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "get_commit",
    {
      description: "Get commit details including changed files and diff patches.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        sha: z.string().describe("Commit SHA (full or short)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, sha }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const commit = await githubApi<CommitDetail>(
        token, "GET", `/repos/${owner}/${name}/commits/${sha}`,
      );

      const MAX_PATCH_LINES = 500;
      const files = (commit.files ?? []).map((f) => {
        let patch = f.patch ?? "";
        const patchLines = patch.split("\n");
        if (patchLines.length > MAX_PATCH_LINES) {
          patch = patchLines.slice(0, MAX_PATCH_LINES).join("\n") + `\n... (truncated, ${patchLines.length} total lines)`;
        }
        return {
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch,
        };
      });

      const result = {
        sha: commit.sha.slice(0, 7),
        message: commit.commit.message,
        author: commit.commit.author.name,
        date: commit.commit.author.date,
        stats: commit.stats,
        files,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

interface CommitListItem {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
}

interface CommitDetail {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
  stats: { total: number; additions: number; deletions: number };
  files?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
}
