import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubApi, parseRepo, validateOrg } from "../../github-api";

export function registerIssuesTools(server: McpServer, token: string): void {
  server.registerTool(
    "list_issues",
    {
      description: "List issues for a repository. Supports state and label filtering.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        state: z.enum(["open", "closed", "all"]).default("open").describe("Issue state filter (default: open)"),
        labels: z.string().optional().describe("Comma-separated label names (e.g. 'bug,enhancement')"),
        per_page: z.number().min(1).max(100).default(20).describe("Results per page (default 20)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, state, labels, per_page }) => {
      const { owner, repo: name } = parseRepo(repo);
      validateOrg(owner);

      const params: Record<string, string> = {
        state,
        per_page: String(per_page),
      };
      if (labels) params.labels = labels;

      const issues = await githubApi<Issue[]>(
        token, "GET", `/repos/${owner}/${name}/issues`, undefined, params,
      );

      // Filter out pull requests (GitHub Issues API returns PRs too)
      const filtered = issues.filter((i) => !i.pull_request);

      const result = filtered.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.user.login,
        labels: i.labels.map((l) => l.name),
        created_at: i.created_at,
        updated_at: i.updated_at,
        comments: i.comments,
        url: i.html_url,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "get_issue",
    {
      description: "Get issue details including body and comments.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        issue_number: z.number().describe("Issue number"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, issue_number }) => {
      const { owner, repo: name } = parseRepo(repo);
      validateOrg(owner);

      const [issue, comments] = await Promise.all([
        githubApi<Issue>(token, "GET", `/repos/${owner}/${name}/issues/${issue_number}`),
        githubApi<IssueComment[]>(token, "GET", `/repos/${owner}/${name}/issues/${issue_number}/comments`),
      ]);

      const result = {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.user.login,
        labels: issue.labels.map((l) => l.name),
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        body: issue.body,
        url: issue.html_url,
        comments: comments.map((c) => ({
          author: c.user.login,
          created_at: c.created_at,
          body: c.body,
        })),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

interface Issue {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
  body: string | null;
  comments: number;
  pull_request?: unknown;
}

interface IssueComment {
  user: { login: string };
  created_at: string;
  body: string;
}
