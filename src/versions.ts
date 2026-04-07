import type { Env } from "./index";
import type { CIStatus } from "./webhook";

export interface RepoVersion {
  repo: string;
  version: string | null;
  url: string | null;
}

export async function handleVersions(env: Env): Promise<Response> {
  const versions = await getAllVersions(env);
  return new Response(JSON.stringify(versions), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function getAllVersions(env: Env): Promise<RepoVersion[]> {
  // Collect unique repos from KV
  const list = await env.CI_STATUS.list({ prefix: "run:" });
  const repos = new Set<string>();
  for (const key of list.keys) {
    const value = await env.CI_STATUS.get(key.name);
    if (value) {
      const s = JSON.parse(value) as CIStatus;
      if (s.repo.startsWith("ippoan/")) {
        repos.add(s.repo);
      }
    }
  }

  // Fetch latest tag for each repo in parallel
  const results = await Promise.all(
    [...repos].map(async (repo): Promise<RepoVersion> => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/tags?per_page=1`,
          {
            headers: {
              Authorization: `Bearer ${env.GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "ci-dashboard",
            },
          },
        );
        if (!res.ok) return { repo, version: null, url: null };
        const tags = await res.json<Array<{ name: string }>>();
        const first = tags[0];
        if (!first) return { repo, version: null, url: null };
        return {
          repo,
          version: first.name,
          url: `https://github.com/${repo}/releases/tag/${first.name}`,
        };
      } catch {
        return { repo, version: null, url: null };
      }
    }),
  );

  results.sort((a, b) => a.repo.localeCompare(b.repo));
  return results;
}
