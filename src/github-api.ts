const GITHUB_API = "https://api.github.com";
const ALLOWED_ORGS = ["ippoan", "ohishi-exp"];
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
