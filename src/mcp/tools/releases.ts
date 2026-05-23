import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubApi, parseRepo, tokenForOrg } from "../../github-api";
import type { GitHubAppEnv } from "../../github-app-auth";

export function registerReleasesTools(server: McpServer, env: GitHubAppEnv): void {
  server.registerTool(
    "list_tags",
    {
      description: "List tags for a repository.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
        per_page: z.number().min(1).max(100).default(10).describe("Results per page"),
      },
      annotations: { readOnlyHint: true },
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

  server.registerTool(
    "get_latest_release",
    {
      description: "Get the latest release for a repository.",
      inputSchema: {
        repo: z.string().describe("Repository (e.g. 'rust-alc-api')"),
      },
      annotations: { readOnlyHint: true },
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

  server.registerTool(
    "create_tag_release",
    {
      description: "Dispatch tag-release.yml workflow to create a patch release.",
      inputSchema: {
        repo: z.string().describe("Repository as 'org/name' (e.g. 'ippoan/rust-alc-api')"),
      },
    },
    async ({ repo }) => {
      const { owner, repo: name } = parseRepo(repo);
      const token = await tokenForOrg(env, owner);

      await githubApi(
        token, "POST",
        `/repos/${owner}/${name}/actions/workflows/tag-release.yml/dispatches`,
        { ref: "main" },
      );

      return { content: [{ type: "text" as const, text: `tag-release dispatched for ${owner}/${name}` }] };
    },
  );
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
