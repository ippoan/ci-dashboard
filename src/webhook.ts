import type { Env } from "./index";
import { parseTaglessRepos } from "./tagless-repos";

interface WorkflowRunPayload {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    head_branch: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    actor: { login: string };
    updated_at: string;
    run_started_at: string;
  };
  repository: {
    full_name: string;
  };
}

interface WorkflowJobPayload {
  action: string;
  workflow_job: {
    id: number;
    run_id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    started_at: string | null;
    completed_at: string | null;
  };
  repository: {
    full_name: string;
  };
}

interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    merged: boolean;
    merge_commit_sha: string | null;
    base: { ref: string };
  };
  repository: {
    full_name: string;
    default_branch: string;
  };
}

export interface CIStatus {
  repo: string;
  workflow: string;
  branch: string;
  status: string;
  conclusion: string | null;
  run_id: number;
  run_url: string;
  actor: string;
  updated_at: string;
  started_at: string;
  jobs?: JobStatus[];
}

export interface JobStatus {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  started_at: string | null;
  completed_at: string | null;
}

async function verifySignature(
  secret: string,
  body: string,
  signature: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const digest = "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return signature === digest;
}

export async function handleWebhook(
  request: Request,
  env: Env,
  hub: DurableObjectStub
): Promise<Response> {
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!signature) {
    return new Response("Missing signature", { status: 401 });
  }

  const body = await request.text();

  const valid = await verifySignature(env.WEBHOOK_SECRET, body, signature);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = request.headers.get("X-GitHub-Event");

  if (event === "workflow_run") {
    const payload: WorkflowRunPayload = JSON.parse(body);
    // Route through Hub DO for serialized KV access
    await hub.fetch(new Request("http://hub/update-run", {
      method: "POST",
      body: JSON.stringify({
        run: payload.workflow_run,
        repo: payload.repository.full_name,
      }),
    }));

    // Side channel: detect "deploy completed for a new tag" so the dashboard
    // banner can flag any open `Refs #N` issues that the operator forgot to
    // close. We listen for the **CI** workflow finishing on a tag head_branch
    // (e.g. v0.0.43), not the `Tag Release` workflow itself — Tag Release
    // only pushes the tag, the CI run for that tag is what does
    // `wrangler deploy`. Detecting on Tag Release would deliver the
    // /release-alert-detect ping to the **previous** version's Hub before the
    // new code with the alert routes is live (see issue #51).
    if (
      payload.action === "completed" &&
      payload.workflow_run.name === "CI" &&
      /^v\d/.test(payload.workflow_run.head_branch) &&
      payload.workflow_run.conclusion === "success"
    ) {
      await hub.fetch(new Request("http://hub/release-alert-detect", {
        method: "POST",
        body: JSON.stringify({
          repo: payload.repository.full_name,
          tag: payload.workflow_run.head_branch,  // explicit tag from head_branch
        }),
      }));
    }

    return new Response("OK", { status: 200 });
  }

  if (event === "workflow_job") {
    const payload: WorkflowJobPayload = JSON.parse(body);
    await hub.fetch(new Request("http://hub/update-job", {
      method: "POST",
      body: JSON.stringify({ job: payload.workflow_job }),
    }));
    return new Response("OK", { status: 200 });
  }

  // Tagless-repo close-detection trigger. For repos that never cut a release
  // tag (listed in env.TAGLESS_REPOS), a PR merge into the default branch is
  // the closest analog to a release. We fire a `/release-alert-detect-pr` so
  // the Hub can compute open-Refs and surface them on the dashboard banner.
  // Skip silently for repos not on the list — the existing tag flow handles
  // those.
  if (event === "pull_request") {
    const payload: PullRequestPayload = JSON.parse(body);
    const repo = payload.repository.full_name;
    const isMergeToDefault =
      payload.action === "closed" &&
      payload.pull_request.merged === true &&
      payload.pull_request.base.ref === payload.repository.default_branch;
    if (isMergeToDefault && parseTaglessRepos(env.TAGLESS_REPOS).has(repo)) {
      await hub.fetch(new Request("http://hub/release-alert-detect-pr", {
        method: "POST",
        body: JSON.stringify({
          repo,
          prNumber: payload.pull_request.number,
          mergeSha: payload.pull_request.merge_commit_sha,
          defaultBranch: payload.repository.default_branch,
        }),
      }));
    }
    return new Response("OK", { status: 200 });
  }

  return new Response("Ignored event: " + event, { status: 200 });
}

export { verifySignature };
