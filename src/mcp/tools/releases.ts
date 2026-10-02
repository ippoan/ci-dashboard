import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubApi, GitHubApiError, parseRepo, tokenForOrg } from "../../github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { createScopedRegisterTool } from "../scoped-tool";

export function registerReleasesTools(
  server: McpServer,
  env: AuthClientWorkerEnv,
  scopes: ReadonlySet<string>,
): void {
  const registerTool = createScopedRegisterTool(server, scopes);

  registerTool(
    "list_tags",
    {
      description: "List tags for a repository.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        per_page: z.number().min(1).max(100).default(10).describe("Results per page"),
      },
      annotations: { readOnlyHint: true },
      requiresScope: "mcp.read",
    },
    async ({ repo, per_page }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const tags = await githubApi<Tag[]>(
        token, "GET", `/repos/${owner}/${name}/tags`, undefined,
        { per_page: String(per_page) },
      );

      const result = tags.map((t) => ({
        name: t.name,
        sha: t.commit.sha.slice(0, 7),
      }));

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    "get_latest_release",
    {
      description: "Get the latest release for a repository.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
      },
      annotations: { readOnlyHint: true },
      requiresScope: "mcp.read",
    },
    async ({ repo }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      const release = await githubApi<Release>(
        token, "GET", `/repos/${owner}/${name}/releases/latest`,
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            tag: release.tag_name,
            name: release.name,
            published_at: release.published_at,
            author: release.author.login,
            url: release.html_url,
            body: release.body?.slice(0, 500),
          }, null, 2),
        }],
      };
    },
  );

  registerTool(
    "create_tag_release",
    {
      description:
        "Dispatch tag-release.yml workflow to create a patch release. " +
        "A tag triggers a production deploy. " +
        "Optional `target` is passed as the workflow input of the same name and selects what gets tagged; " +
        "when omitted, no inputs are sent and the target repo's own workflow default applies. " +
        "e.g. ippoan/rust-alc-api: `backend` (default) = monolith `v*` tag, `worker-vein` = `worker-vein-v*` tag. " +
        "If the repo's tag-release.yml does not declare `target`, GitHub rejects the dispatch with 422 and nothing is started.",
      inputSchema: {
        repo: z.string().describe("Repository as 'org/name' (e.g. 'ippoan/rust-alc-api')"),
        target: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional()
          .describe("Value for the workflow's `target` input (e.g. 'backend', 'worker-vein'). Omit to use the workflow's default."),
      },
      requiresScope: "mcp.workflow",
    },
    async ({ repo, target }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      // 省略時は従来どおり `{ ref: "main" }` ちょうど (Refs #517)。
      const body = target === undefined
        ? { ref: "main" }
        : { ref: "main", inputs: { target }, return_run_details: true };

      let run: DispatchRunDetails | undefined;
      try {
        run = await githubApi<DispatchRunDetails | undefined>(
          token, "POST",
          `/repos/${owner}/${name}/actions/workflows/tag-release.yml/dispatches`,
          body,
        );
      } catch (err) {
        if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
        const lines = [
          `GitHub rejected the tag-release dispatch for ${owner}/${name} (422). The workflow was NOT started.`,
        ];
        if (target !== undefined) {
          lines.push(
            `inputs: target=${target} — the repo's tag-release.yml may not declare a \`target\` input, or the value is not one of its options.`,
          );
        }
        lines.push(err.message);
        return { isError: true, content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      const lines = [
        `tag-release dispatched for ${owner}/${name}`,
        target !== undefined
          ? `inputs: target=${target}`
          : "inputs: none (the workflow's own default applies; e.g. ippoan/rust-alc-api defaults to target=backend = monolith v* tag)",
      ];
      if (run?.html_url) lines.push(`run: ${run.html_url}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}

/** run の詳細を求めて dispatch したときの 200 応答 (求めなければ 204 で本文なし)。 */
interface DispatchRunDetails {
  workflow_run_id?: number;
  html_url?: string;
}

interface Tag {
  name: string;
  commit: { sha: string };
}

interface Release {
  tag_name: string;
  name: string;
  published_at: string;
  author: { login: string };
  html_url: string;
  body: string | null;
}
