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
  if (event !== "workflow_run") {
    return new Response("Ignored event: " + event, { status: 200 });
  }

  const payload: WorkflowRunPayload = JSON.parse(body);
  const run = payload.workflow_run;

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

  const key = payload.repository.full_name;
  await env.CI_STATUS.put(key, JSON.stringify(status), {
    expirationTtl: 86400, // 24h
  });

  return new Response("OK", { status: 200 });
}

export { verifySignature };
