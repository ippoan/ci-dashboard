import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubApi, parseRepo, tokenForOrg } from "../../github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { createScopedRegisterTool } from "../scoped-tool";

export function registerPullsTools(
  server: McpServer,
  env: AuthClientWorkerEnv,
  scopes: ReadonlySet<string>,
): void {
  const registerTool = createScopedRegisterTool(server, scopes);

  registerTool(
    "list_pull_requests",
    {
      description: "List pull requests for a repository.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        state: z.enum(["open", "closed", "all"]).default("open").describe("PR state filter"),
        per_page: z.number().min(1).max(100).default(10).describe("Results per page"),
      },
      annotations: { readOnlyHint: true },
      requiresScope: "mcp.read",
    },
    async ({ repo, state, per_page }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const prs = await githubApi<PullRequest[]>(
        token, "GET", `/repos/${owner}/${name}/pulls`, undefined,
        { state, per_page: String(per_page) },
      );

      const result = prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        author: pr.user.login,
        branch: pr.head.ref,
        base: pr.base.ref,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        url: pr.html_url,
        draft: pr.draft,
        mergeable_state: pr.mergeable_state,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    "get_pull_request",
    {
      description: "Get PR details including CI check status.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        pull_number: z.number().describe("PR number"),
      },
      annotations: { readOnlyHint: true },
      requiresScope: "mcp.read",
    },
    async ({ repo, pull_number }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const pr = await githubApi<PullRequest>(
        token, "GET", `/repos/${owner}/${name}/pulls/${pull_number}`,
      );

      const checks = await githubApi<{ check_runs: CheckRun[] }>(
        token, "GET", `/repos/${owner}/${name}/commits/${pr.head.sha}/check-runs`,
      );

      const result = {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        author: pr.user.login,
        branch: pr.head.ref,
        base: pr.base.ref,
        mergeable: pr.mergeable,
        mergeable_state: pr.mergeable_state,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        url: pr.html_url,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        checks: checks.check_runs.map((c) => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          url: c.html_url,
        })),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    "merge_pull_request",
    {
      description: "Merge a pull request using squash merge.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        pull_number: z.number().describe("PR number"),
        commit_title: z.string().optional().describe("Custom commit title"),
      },
      annotations: { destructiveHint: true },
      requiresScope: "mcp.write",
    },
    async ({ repo, pull_number, commit_title }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const body: Record<string, unknown> = { merge_method: "squash" };
      if (commit_title) body.commit_title = commit_title;

      await githubApi(
        token, "PUT", `/repos/${owner}/${name}/pulls/${pull_number}/merge`, body,
      );

      return { content: [{ type: "text" as const, text: `PR #${pull_number} merged (squash)` }] };
    },
  );
}

interface PullRequest {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}
