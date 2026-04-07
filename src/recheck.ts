import type { Env } from "./index";

interface GitHubRun {
  id: number;
  name: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  actor: { login: string };
  updated_at: string;
  run_started_at: string;
}

interface GitHubJob {
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
}

export async function handleRecheck(
  request: Request,
  env: Env,
  hub: DurableObjectStub,
): Promise<Response> {
  const { run_id, repo } = await request.json<{
    run_id: number;
    repo: string;
  }>();

  const allowedOrgs = ["ippoan/", "ohishi-exp/"];
  if (!repo || !allowedOrgs.some((org) => repo.startsWith(org))) {
    return Response.json({ error: "Org not allowed" }, { status: 403 });
  }

  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ci-dashboard",
  };

  // Fetch run status
  const runRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/runs/${run_id}`,
    { headers },
  );
  if (!runRes.ok) {
    const text = await runRes.text();
    return Response.json(
      { error: `GitHub API ${runRes.status}: ${text}` },
      { status: 502 },
    );
  }

  const run = (await runRes.json()) as GitHubRun;
  await hub.fetch(
    new Request("http://hub/update-run", {
      method: "POST",
      body: JSON.stringify({
        run: {
          id: run.id,
          name: run.name,
          head_branch: run.head_branch,
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.html_url,
          actor: { login: run.actor.login },
          updated_at: run.updated_at,
          run_started_at: run.run_started_at,
        },
        repo,
      }),
    }),
  );

  // Fetch jobs (non-fatal if this fails)
  const jobsRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/runs/${run_id}/jobs`,
    { headers },
  );
  if (jobsRes.ok) {
    const { jobs } = (await jobsRes.json()) as { jobs: GitHubJob[] };
    for (const job of jobs) {
      await hub.fetch(
        new Request("http://hub/update-job", {
          method: "POST",
          body: JSON.stringify({
            job: {
              run_id: job.run_id,
              name: job.name,
              status: job.status,
              conclusion: job.conclusion,
              html_url: job.html_url,
              started_at: job.started_at,
              completed_at: job.completed_at,
            },
          }),
        }),
      );
    }
  }

  return Response.json({ ok: true, run_id });
}
