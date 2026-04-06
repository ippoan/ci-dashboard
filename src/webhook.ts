import type { Env } from "./index";

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

async function handleWorkflowRun(
  payload: WorkflowRunPayload,
  env: Env
): Promise<void> {
  const run = payload.workflow_run;
  const key = `${payload.repository.full_name}/${run.head_branch}`;

  // Preserve existing jobs if any
  const existing = await env.CI_STATUS.get(key);
  let jobs: JobStatus[] | undefined;
  if (existing) {
    const prev = JSON.parse(existing) as CIStatus;
    // Keep jobs only if same run_id, otherwise reset
    if (prev.run_id === run.id) {
      jobs = prev.jobs;
    }
  }

  const status: CIStatus = {
    repo: payload.repository.full_name,
    workflow: run.name,
    branch: run.head_branch,
    status: run.status,
    conclusion: run.conclusion,
    run_id: run.id,
    run_url: run.html_url,
    actor: run.actor.login,
    updated_at: run.updated_at,
    started_at: run.run_started_at,
    jobs,
  };

  await env.CI_STATUS.put(key, JSON.stringify(status), {
    expirationTtl: 86400,
  });
}

async function findRunEntryByRunId(
  env: Env,
  repo: string,
  runId: number
): Promise<{ key: string; status: CIStatus } | null> {
  const list = await env.CI_STATUS.list({ prefix: `${repo}/` });
  for (const k of list.keys) {
    const val = await env.CI_STATUS.get(k.name);
    if (val) {
      const s = JSON.parse(val) as CIStatus;
      if (s.run_id === runId) {
        return { key: k.name, status: s };
      }
    }
  }
  return null;
}

async function handleWorkflowJob(
  payload: WorkflowJobPayload,
  env: Env
): Promise<void> {
  const job = payload.workflow_job;
  const repo = payload.repository.full_name;

  // Find the run entry by run_id (key includes branch)
  const entry = await findRunEntryByRunId(env, repo, job.run_id);
  if (!entry) return; // No run yet, ignore

  const { key, status } = entry;

  const jobStatus: JobStatus = {
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    url: job.html_url,
    started_at: job.started_at,
    completed_at: job.completed_at,
  };

  const jobs = status.jobs ?? [];
  const idx = jobs.findIndex((j) => j.name === job.name);
  if (idx >= 0) {
    jobs[idx] = jobStatus;
  } else {
    jobs.push(jobStatus);
  }
  status.jobs = jobs;

  await env.CI_STATUS.put(key, JSON.stringify(status), {
    expirationTtl: 86400,
  });
}

export async function handleWebhook(
  request: Request,
  env: Env
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
    await handleWorkflowRun(payload, env);
    return new Response("OK", { status: 200 });
  }

  if (event === "workflow_job") {
    const payload: WorkflowJobPayload = JSON.parse(body);
    await handleWorkflowJob(payload, env);
    return new Response("OK", { status: 200 });
  }

  return new Response("Ignored event: " + event, { status: 200 });
}

export { verifySignature };
