import { getGitHubToken, type AuthClientWorkerEnv } from "@ippoan/auth-client-worker";

const GITHUB_API = "https://api.github.com";
const ALLOWED_ORGS = ["ippoan", "ohishi-exp", "yhonda-ohishi"];
const DEFAULT_ORG = "ippoan";

export function parseRepo(repo: string): { owner: string; repo: string } {
  if (repo.includes("/")) {
    const [owner, name] = repo.split("/", 2);
    return { owner: owner!, repo: name! };
  }
  return { owner: DEFAULT_ORG, repo };
}

export function validateOrg(owner: string): void {
  if (!ALLOWED_ORGS.includes(owner)) {
    throw new GitHubApiError(403, `Org not allowed: ${owner}`);
  }
}

/** Resolve a GitHub access token. Since auth-worker issues a single user-scope
 *  token that spans all orgs the operator is a member of, the `owner` arg is
 *  only used to enforce the allowlist (defense-in-depth) — the resolved token
 *  is org-agnostic. Kept for source-compat with the previous App-installation
 *  code path. */
export async function tokenForOrg(env: AuthClientWorkerEnv, owner: string): Promise<string> {
  validateOrg(owner);
  return getGitHubToken(env);
}

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ci-dashboard-mcp",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function githubApi<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${GITHUB_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: { ...headers(token), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new GitHubApiError(res.status, `GitHub API ${res.status}: ${text}`);
  }

  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

/**
 * GitHub GraphQL API caller. Used by Projects v2 tools (REST has no Projects v2
 * surface). On `errors[]` in the response, throws `GitHubApiError(400, ...)`
 * with the concatenated error messages so callers don't have to peek inside.
 */
export async function githubGraphQL<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: {
      ...headers(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new GitHubApiError(res.status, `GitHub GraphQL ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new GitHubApiError(400, `GitHub GraphQL error: ${msg}`);
  }
  if (json.data === undefined) {
    throw new GitHubApiError(500, "GitHub GraphQL: empty data");
  }
  return json.data;
}

export async function githubApiRaw(
  token: string,
  method: string,
  path: string,
): Promise<string> {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(token),
    redirect: "follow",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new GitHubApiError(res.status, `GitHub API ${res.status}: ${text}`);
  }

  return res.text();
}
