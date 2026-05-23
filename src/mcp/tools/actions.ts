import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubApi, parseRepo, tokenForOrg } from "../../github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";

export function registerActionsTools(server: McpServer, env: AuthClientWorkerEnv): void {
  server.registerTool(
    "list_workflow_runs",
    {
      description: "List recent workflow runs for a repository. Use ci-dashboard UI for real-time monitoring instead of polling.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api' or 'ippoan/rust-alc-api')"),
        status: z.enum(["queued", "in_progress", "completed"]).optional().describe("Filter by status"),
        per_page: z.number().min(1).max(100).default(10).describe("Results per page (default 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, status, per_page }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);
      const params: Record<string, string> = { per_page: String(per_page) };
      if (status) params.status = status;

      const data = await githubApi<{ workflow_runs: WorkflowRun[] }>(
        token, "GET", `/repos/${owner}/${name}/actions/runs`, undefined, params,
      );

      const runs = data.workflow_runs.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        actor: r.actor.login,
        created_at: r.created_at,
        updated_at: r.updated_at,
        url: r.html_url,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(runs, null, 2) }] };
    },
  );

  server.registerTool(
    "get_workflow_run",
    {
      description: "Get details of a specific workflow run.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        run_id: z.number().describe("Workflow run ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, run_id }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const run = await githubApi<WorkflowRun>(
        token, "GET", `/repos/${owner}/${name}/actions/runs/${run_id}`,
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            branch: run.head_branch,
            actor: run.actor.login,
            created_at: run.created_at,
            updated_at: run.updated_at,
            url: run.html_url,
            run_attempt: run.run_attempt,
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    "list_workflow_run_jobs",
    {
      description: "List jobs for a workflow run.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        run_id: z.number().describe("Workflow run ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, run_id }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const data = await githubApi<{ jobs: WorkflowJob[] }>(
        token, "GET", `/repos/${owner}/${name}/actions/runs/${run_id}/jobs`,
      );

      const jobs = data.jobs.map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        started_at: j.started_at,
        completed_at: j.completed_at,
        url: j.html_url,
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(jobs, null, 2) }] };
    },
  );

  server.registerTool(
    "rerun_workflow_run",
    {
      description: "Re-run all jobs in a workflow run.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        run_id: z.number().describe("Workflow run ID"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ repo, run_id }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);
      await githubApi(token, "POST", `/repos/${owner}/${name}/actions/runs/${run_id}/rerun`);
      return { content: [{ type: "text" as const, text: `Rerun triggered for run ${run_id}` }] };
    },
  );

  server.registerTool(
    "rerun_failed_jobs",
    {
      description: "Re-run only failed jobs in a workflow run.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        run_id: z.number().describe("Workflow run ID"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ repo, run_id }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);
      await githubApi(token, "POST", `/repos/${owner}/${name}/actions/runs/${run_id}/rerun-failed-jobs`);
      return { content: [{ type: "text" as const, text: `Rerun of failed jobs triggered for run ${run_id}` }] };
    },
  );

  server.registerTool(
    "cancel_workflow_run",
    {
      description: "Cancel an in-progress workflow run.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        run_id: z.number().describe("Workflow run ID"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, run_id }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);
      await githubApi(token, "POST", `/repos/${owner}/${name}/actions/runs/${run_id}/cancel`);
      return { content: [{ type: "text" as const, text: `Cancelled run ${run_id}` }] };
    },
  );
}

interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  actor: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  run_attempt: number;
}

interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
}
