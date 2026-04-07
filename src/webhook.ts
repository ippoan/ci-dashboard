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

  return new Response("Ignored event: " + event, { status: 200 });
}

export { verifySignature };
