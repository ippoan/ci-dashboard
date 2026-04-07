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

function runKey(runId: number): string {
  return `run:${runId}`;
}

async function handleWorkflowRun(
  payload: WorkflowRunPayload,
  env: Env
): Promise<void> {
  const run = payload.workflow_run;
  const key = runKey(run.id);

  const existing = await env.CI_STATUS.get(key);

  if (existing) {
    // Update only run-level fields, preserve jobs from workflow_job events
    const prev = JSON.parse(existing) as CIStatus;
    prev.status = run.status;
    prev.conclusion = run.conclusion;
    prev.updated_at = run.updated_at;
    // When run completes, fix stale in_progress/queued jobs whose
    // workflow_job completed event was missed
    if (run.status === "completed" && prev.jobs) {
      for (const job of prev.jobs) {
        if (job.status === "in_progress" || job.status === "queued") {
          job.status = "completed";
          job.conclusion = job.conclusion ?? "skipped";
        }
      }
    }
    await env.CI_STATUS.put(key, JSON.stringify(prev), {
      expirationTtl: 86400,
    });
  } else {
    // First event for this run — create new entry
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
    };
    await env.CI_STATUS.put(key, JSON.stringify(status), {
      expirationTtl: 86400,
    });
  }
}

async function handleWorkflowJob(
  payload: WorkflowJobPayload,
  env: Env
): Promise<void> {
  const job = payload.workflow_job;
  const key = runKey(job.run_id);

  const existing = await env.CI_STATUS.get(key);
  if (!existing) return;

  const status = JSON.parse(existing) as CIStatus;

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

async function broadcastUpdate(env: Env, hub: DurableObjectStub): Promise<void> {
  const { getAllStatuses } = await import("./status");
  const statuses = await getAllStatuses(env);
  await hub.fetch(new Request("http://hub/broadcast", {
    method: "POST",
    body: JSON.stringify(statuses),
  }));
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
    await handleWorkflowRun(payload, env);
    await broadcastUpdate(env, hub);
    return new Response("OK", { status: 200 });
  }

  if (event === "workflow_job") {
    const payload: WorkflowJobPayload = JSON.parse(body);
    await handleWorkflowJob(payload, env);
    await broadcastUpdate(env, hub);
    return new Response("OK", { status: 200 });
  }

  return new Response("Ignored event: " + event, { status: 200 });
}

export { verifySignature };
