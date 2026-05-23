import type { Env } from "./index";
import { tokenForOrg } from "./github-api";

export async function handleTagRelease(
  request: Request,
  env: Env,
): Promise<Response> {
  const { repo } = await request.json<{ repo: string }>();

  if (!repo) {
    return Response.json({ error: "Missing repo" }, { status: 400 });
  }
  const [owner] = repo.split("/", 1);
  if (!owner) {
    return Response.json({ error: "Bad repo" }, { status: 400 });
  }
  let token: string;
  try {
    token = await tokenForOrg(env, owner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 403 });
  }

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/tag-release.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
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
