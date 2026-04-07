import type { Env } from "./index";

export async function handleTagRelease(
  request: Request,
  env: Env,
): Promise<Response> {
  const { repo } = await request.json<{ repo: string }>();

  if (!repo || !repo.startsWith("ippoan/")) {
    return Response.json(
      { error: "Only ippoan org repos allowed" },
      { status: 403 },
    );
  }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/tag-release.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ci-dashboard",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    return Response.json(
      { error: `GitHub API ${res.status}: ${text}` },
      { status: 502 },
    );
  }

  return Response.json({ ok: true, repo });
}
