import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubApiRaw, parseRepo, tokenForOrg } from "../../github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { createScopedRegisterTool } from "../scoped-tool";

export function registerLogsTools(
  server: McpServer,
  env: AuthClientWorkerEnv,
  scopes: ReadonlySet<string>,
): void {
  const registerTool = createScopedRegisterTool(server, scopes);

  registerTool(
    "get_job_logs",
    {
      description: "Get logs for a workflow job. Returns tail lines by default, or a specific line range with start_line/end_line.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        job_id: z.number().describe("Job ID (from list_workflow_run_jobs)"),
        tail_lines: z.number().min(1).max(1000).default(200).describe("Lines from end (default 200). Ignored if start_line set."),
        start_line: z.number().min(1).optional().describe("Start line (1-based) for range retrieval"),
        end_line: z.number().min(1).optional().describe("End line (inclusive) for range retrieval"),
      },
      annotations: { readOnlyHint: true },
      requiresScope: "mcp.read",
    },
    async ({ repo, job_id, tail_lines, start_line, end_line }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const raw = await githubApiRaw(
        token, "GET", `/repos/${owner}/${name}/actions/jobs/${job_id}/logs`,
      );

      const lines = raw.split("\n");
      const totalLines = lines.length;
      let selected: string[];
      let header: string;

      if (start_line !== undefined) {
        const start = Math.max(1, start_line);
        const end = end_line !== undefined ? Math.min(totalLines, end_line) : totalLines;
        selected = lines.slice(start - 1, end);
        header = `Lines ${start}-${Math.min(end, totalLines)} of ${totalLines}`;
      } else {
        if (totalLines > tail_lines) {
          selected = lines.slice(-tail_lines);
          header = `Last ${tail_lines} of ${totalLines} lines (use start_line/end_line for specific range)`;
        } else {
          selected = lines;
          header = `${totalLines} lines (complete)`;
        }
      }

      const startNum = start_line !== undefined
        ? Math.max(1, start_line)
        : totalLines - selected.length + 1;
      const numbered = selected.map((line, i) => `${startNum + i}: ${line}`);

      return {
        content: [{
          type: "text" as const,
          text: `${header}\n\n${numbered.join("\n")}`,
        }],
      };
    },
  );

  registerTool(
    "grep_job_logs",
    {
      description: "Search job logs with regex pattern. Returns matching lines with context. Use for finding errors: pattern='error|fail|panic'",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        job_id: z.number().describe("Job ID (from list_workflow_run_jobs)"),
        pattern: z.string().describe("Regex pattern (e.g. 'error|fail|panic')"),
        context_lines: z.number().min(0).max(20).default(3).describe("Context lines before/after each match (default 3)"),
      },
      annotations: { readOnlyHint: true },
      requiresScope: "mcp.read",
    },
    async ({ repo, job_id, pattern, context_lines }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const raw = await githubApiRaw(
        token, "GET", `/repos/${owner}/${name}/actions/jobs/${job_id}/logs`,
      );

      const lines = raw.split("\n");
      const regex = new RegExp(pattern, "i");
      const MAX_MATCHES = 50;

      const matchIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          matchIndices.push(i);
        }
      }

      if (matchIndices.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No matches for /${pattern}/i in ${lines.length} lines`,
          }],
        };
      }

      const truncated = matchIndices.length > MAX_MATCHES;
      const displayIndices = matchIndices.slice(0, MAX_MATCHES);

      // Merge overlapping context ranges
      const ranges: Array<{ start: number; end: number }> = [];
      for (const idx of displayIndices) {
        const start = Math.max(0, idx - context_lines);
        const end = Math.min(lines.length - 1, idx + context_lines);
        const last = ranges[ranges.length - 1];
        if (last && start <= last.end + 1) {
          last.end = end;
        } else {
          ranges.push({ start, end });
        }
      }

      const matchSet = new Set(displayIndices);
      const parts: string[] = [];
      for (const range of ranges) {
        const chunk: string[] = [];
        for (let i = range.start; i <= range.end; i++) {
          const marker = matchSet.has(i) ? ">" : " ";
          chunk.push(`${marker} ${i + 1}: ${lines[i]}`);
        }
        parts.push(chunk.join("\n"));
      }

      let header = `${matchIndices.length} matches for /${pattern}/i in ${lines.length} lines`;
      if (truncated) {
        header += ` (showing first ${MAX_MATCHES}, ${matchIndices.length - MAX_MATCHES} more truncated)`;
      }

      return {
        content: [{
          type: "text" as const,
          text: `${header}\n\n${parts.join("\n---\n")}`,
        }],
      };
    },
  );
}
