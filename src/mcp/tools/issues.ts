import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubApi, parseRepo, tokenForOrg, validateOrg } from "../../github-api";
import { getGitHubToken, type AuthClientWorkerEnv } from "@ippoan/auth-client-worker";

/** Build the PATCH body for `update_issue` from optional fields. Strips
 *  fields the caller did not provide (= `undefined`); preserves empty
 *  arrays and `null` (those are intentional clear-the-field signals).
 *  Throws if no fields would be sent (= empty PATCH is rejected). */
export function buildUpdateIssuePayload(input: {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.title !== undefined) payload.title = input.title;
  if (input.body !== undefined) payload.body = input.body;
  if (input.labels !== undefined) payload.labels = input.labels;
  if (input.assignees !== undefined) payload.assignees = input.assignees;
  if (input.milestone !== undefined) payload.milestone = input.milestone;

  if (Object.keys(payload).length === 0) {
    throw new Error(
      "update_issue: at least one of title/body/labels/assignees/milestone must be provided",
    );
  }
  return payload;
}

export function registerIssuesTools(server: McpServer, env: AuthClientWorkerEnv): void {
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
      const token = await tokenForOrg(env, owner);

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
      const token = await tokenForOrg(env, owner);

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

  server.registerTool(
    "create_issue",
    {
      description: "Create a new issue in a repository.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        title: z.string().describe("Issue title"),
        body: z.string().optional().describe("Issue body (markdown)"),
        labels: z.array(z.string()).optional().describe("Label names to attach"),
        assignees: z.array(z.string()).optional().describe("GitHub usernames to assign"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, title, body, labels, assignees }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const payload: Record<string, unknown> = { title };
      if (body) payload.body = body;
      if (labels) payload.labels = labels;
      if (assignees) payload.assignees = assignees;

      const created = await githubApi<Issue>(
        token, "POST", `/repos/${owner}/${name}/issues`, payload,
      );

      const result = {
        number: created.number,
        title: created.title,
        state: created.state,
        url: created.html_url,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Update an existing issue's title / body / labels / assignees / milestone. " +
        "State changes are intentionally not supported here — use close_issue / reopen_issue.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        issue_number: z.number().describe("Issue number"),
        title: z.string().optional().describe("New title"),
        body: z.string().optional().describe("New body (markdown). Pass '' to clear."),
        labels: z.array(z.string()).optional()
          .describe("Replace labels with this list (pass [] to remove all)"),
        assignees: z.array(z.string()).optional()
          .describe("Replace assignees with this list (pass [] to clear)"),
        milestone: z.number().nullable().optional()
          .describe("Milestone number, or null to detach"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, issue_number, title, body, labels, assignees, milestone }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const payload = buildUpdateIssuePayload({ title, body, labels, assignees, milestone });

      const updated = await githubApi<Issue>(
        token, "PATCH", `/repos/${owner}/${name}/issues/${issue_number}`, payload,
      );

      const result = {
        number: updated.number,
        title: updated.title,
        state: updated.state,
        labels: updated.labels.map((l) => l.name),
        url: updated.html_url,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "add_issue_comment",
    {
      description: "Add a comment to an existing issue or pull request.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        issue_number: z.number().describe("Issue or PR number"),
        body: z.string().describe("Comment body (markdown)"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, issue_number, body }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const created = await githubApi<{ id: number; html_url: string; created_at: string }>(
        token, "POST", `/repos/${owner}/${name}/issues/${issue_number}/comments`, { body },
      );

      const result = {
        id: created.id,
        url: created.html_url,
        created_at: created.created_at,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "add_labels",
    {
      description: "Add labels to an issue or pull request. Returns the current label list.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        issue_number: z.number().describe("Issue or PR number"),
        labels: z.array(z.string()).min(1).describe("Label names to add"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, issue_number, labels }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const updated = await githubApi<Array<{ name: string }>>(
        token, "POST", `/repos/${owner}/${name}/issues/${issue_number}/labels`, { labels },
      );

      const result = updated.map((l) => l.name);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "remove_label",
    {
      description: "Remove a single label from an issue or pull request. Returns the remaining label list.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        issue_number: z.number().describe("Issue or PR number"),
        label: z.string().describe("Label name to remove"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, issue_number, label }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const remaining = await githubApi<Array<{ name: string }>>(
        token, "DELETE",
        `/repos/${owner}/${name}/issues/${issue_number}/labels/${encodeURIComponent(label)}`,
      );

      const result = remaining.map((l) => l.name);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "close_issue",
    {
      description: "Close an issue. Optionally set state_reason to 'completed' or 'not_planned'.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        issue_number: z.number().describe("Issue number"),
        state_reason: z.enum(["completed", "not_planned"]).optional()
          .describe("Reason for closing (default: completed)"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, issue_number, state_reason }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const payload: Record<string, unknown> = { state: "closed" };
      payload.state_reason = state_reason ?? "completed";

      const updated = await githubApi<Issue & { state_reason?: string | null }>(
        token, "PATCH", `/repos/${owner}/${name}/issues/${issue_number}`, payload,
      );

      const result = {
        number: updated.number,
        state: updated.state,
        state_reason: updated.state_reason ?? null,
        url: updated.html_url,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "reopen_issue",
    {
      description: "Reopen a closed issue.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        issue_number: z.number().describe("Issue number"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, issue_number }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const updated = await githubApi<Issue>(
        token, "PATCH", `/repos/${owner}/${name}/issues/${issue_number}`,
        { state: "open" },
      );

      const result = {
        number: updated.number,
        state: updated.state,
        url: updated.html_url,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "list_org_issues",
    {
      description:
        "List issues across multiple orgs in one call (uses GitHub search). " +
        "Filters by state/labels/assignee. PRs are excluded. " +
        "If `query` contains `repo:owner/name`, the `orgs` allowlist is still " +
        "validated but `org:` is omitted from the search (GitHub silently " +
        "drops `repo:` when combined with `org:`).",
      inputSchema: {
        orgs: z.array(z.string()).min(1)
          .describe("Organization names (e.g. ['ippoan', 'ohishi-exp'])"),
        state: z.enum(["open", "closed", "all"]).default("open"),
        labels: z.array(z.string()).optional()
          .describe("AND filter by label names"),
        assignee: z.string().optional()
          .describe("GitHub username, or '@me' for the current token's user"),
        query: z.string().optional()
          .describe("Raw GitHub search syntax appended to q (advanced)"),
        per_page: z.number().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ orgs, state, labels, assignee, query, per_page }) => {
      const result = await fetchOrgIssues(env, {
        orgs, state, labels, assignee, query, per_page,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

// --------------------------------------------------------------------------
// Shared: org-wide issue search (used by `list_org_issues` MCP tool and by
// the SSR `/issues` page in src/issues-page.ts)
// --------------------------------------------------------------------------

export interface OrgIssue {
  repo: string;
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  assignees: string[];
  comments: number;
  created_at: string;
  updated_at: string;
  url: string;
}

export interface FetchOrgIssuesParams {
  orgs: string[];
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  query?: string;
  per_page?: number;
}

export interface FetchOrgIssuesResult {
  total_count: number;
  incomplete: boolean;
  items: OrgIssue[];
}

/** Cross-org issue search.
 *
 * auth-worker delegation (#116) issues a single user-scope token that spans
 * every org the operator is a member of. So we hit `/search/issues` once
 * with `org:ippoan org:ohishi-exp ...` and get all rows back in one call —
 * no per-org fan-out (which the GitHub App installation-token era required).
 *
 * GitHub Search silently drops `repo:` when combined with `org:`. When the
 * caller-supplied `query` pins specific repos via `repo:`, we omit the
 * `org:` qualifier (the `repo:` already implies the owner). `validateOrg`
 * runs above regardless, so the allowlist check is preserved. */
export async function fetchOrgIssues(
  env: AuthClientWorkerEnv,
  params: FetchOrgIssuesParams,
): Promise<FetchOrgIssuesResult> {
  const { orgs, state = "open", labels, assignee, query, per_page = 30 } = params;
  for (const o of orgs) validateOrg(o);

  const queryHasRepoFilter = !!query && /\brepo:/.test(query);
  // Default-exclude archived repos so old projects like cf-secrets-mcp don't
  // leak open issues into the dashboard. Caller can still opt back in (or
  // request archived-only) by passing `archived:true` / `archived:false` in
  // `query`.
  const queryHasArchivedFilter = !!query && /\barchived:/.test(query);

  const parts: string[] = ["is:issue"];
  if (state !== "all") parts.push(`state:${state}`);
  if (!queryHasRepoFilter) {
    for (const o of orgs) parts.push(`org:${o}`);
  }
  if (!queryHasArchivedFilter) parts.push("archived:false");
  if (labels) for (const l of labels) parts.push(`label:"${l}"`);
  if (assignee) parts.push(`assignee:${assignee}`);
  if (query) parts.push(query);
  const q = parts.join(" ");

  const token = await getGitHubToken(env);
  const data = await githubApi<SearchIssuesResponse>(
    token, "GET", "/search/issues", undefined,
    { q, per_page: String(per_page) },
  );

  const items = data.items
    .filter((i) => !i.pull_request)
    .map((i) => ({
      repo: i.repository_url.split("/").slice(-2).join("/"),
      number: i.number,
      title: i.title,
      state: i.state,
      author: i.user?.login ?? "",
      labels: i.labels.map((l) => l.name),
      assignees: (i.assignees ?? []).map((a) => a.login),
      comments: i.comments,
      created_at: i.created_at,
      updated_at: i.updated_at,
      url: i.html_url,
    }));

  return {
    total_count: data.total_count,
    incomplete: data.incomplete_results,
    items,
  };
}

interface SearchIssuesResponse {
  total_count: number;
  incomplete_results: boolean;
  items: SearchIssueItem[];
}

interface SearchIssueItem {
  number: number;
  title: string;
  state: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  repository_url: string;
  pull_request?: unknown;
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
