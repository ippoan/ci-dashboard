import type { Env } from "./index";
import { parseTaglessRepos } from "./tagless-repos";
import {
  upsertIssue,
  webhookIssueToOrgIssue,
  applyIssueCommentEvent,
  type IssueWebhookPayload,
  type IssueCommentWebhookPayload,
} from "./issue-cache";
import {
  applyProjectsV2Event,
  applyProjectsV2ItemEvent,
  type ProjectsV2WebhookPayload,
  type ProjectsV2ItemWebhookPayload,
} from "./project-cache";
import {
  invalidateIssue as invalidateReleaseCacheIssue,
  invalidateRepoTags,
  invalidateRepoCommits,
} from "./release-cache";

interface ReleaseWebhookPayload {
  action: string;
  release: {
    tag_name: string;
    id: number;
  };
  repository: { full_name: string };
}

interface PushWebhookPayload {
  ref: string;
  repository: {
    full_name: string;
    default_branch: string;
  };
}

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

  const secret = await env.WEBHOOK_SECRET.get();
  const valid = await verifySignature(secret, body, signature);
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

  // /issues SSR page の KV cache (issue-cache.ts) 更新経路。Webhook で来た
  // 個別 issue を upsert する。watermark は意図的に touch しない (配信ミス
  // 時に list-since reconcile が必ず拾うための担保)。Refs #129。
  //
  // Phase 3 (Refs #133): /releases page も release-cache.cachedIssue (60s TTL)
  // で同 issue を別 cache に保持しているため、外部から close された時に
  // release-cache 側も invalidate して /releases の close-status を即時反映する。
  if (event === "issues") {
    const payload: IssueWebhookPayload = JSON.parse(body);
    const issue = webhookIssueToOrgIssue(payload);
    await upsertIssue(env.CI_STATUS, issue);
    const [owner, name] = payload.repository.full_name.split("/");
    if (owner && name) {
      await invalidateReleaseCacheIssue(env.CI_STATUS, owner, name, payload.issue.number);
    }
    return new Response("OK", { status: 200 });
  }

  // /issues SSR の comment 数表示用。`created` / `deleted` だけ反映、
  // `edited` は無視 (件数変わらない)。cache miss (該当 issue が KV に
  // 居ない) は no-op — 次の reconcile delta が full record で上書きする。
  if (event === "issue_comment") {
    const payload: IssueCommentWebhookPayload = JSON.parse(body);
    await applyIssueCommentEvent(env.CI_STATUS, payload);
    return new Response("OK", { status: 200 });
  }

  // /projects SSR の KV cache (project-cache.ts) invalidation 経路。
  // `projects_v2` event = board level (create/close/delete/edit) なので
  //   org list + items 両方 flush。Refs #131。
  if (event === "projects_v2") {
    const payload: ProjectsV2WebhookPayload = JSON.parse(body);
    await applyProjectsV2Event(env.CI_STATUS, payload);
    return new Response("OK", { status: 200 });
  }

  // `projects_v2_item` event = 個別 card の add/edit/delete/archive/reorder。
  //   list は不変、該当 org の items cache + issues-page project map を flush。
  if (event === "projects_v2_item") {
    const payload: ProjectsV2ItemWebhookPayload = JSON.parse(body);
    await applyProjectsV2ItemEvent(env.CI_STATUS, payload);
    return new Response("OK", { status: 200 });
  }

  // /releases SSR の release-cache.ts (TTL 300s tags) を webhook で flush。
  // 新規 release が publish/edit/delete された時に該当 repo の tag list cache
  // を delete → 次の /releases ロードで refetch。Refs #133。
  if (event === "release") {
    const payload: ReleaseWebhookPayload = JSON.parse(body);
    const [owner, name] = payload.repository.full_name.split("/");
    if (owner && name) {
      await invalidateRepoTags(env.CI_STATUS, owner, name);
    }
    return new Response("OK", { status: 200 });
  }

  // `push` event は tag push (refs/tags/*) なら tags cache、default branch
  // への push なら commits cache (synthetic-block の HEAD listing 用) を
  // flush する。それ以外の branch push は noop。malformed payload (test fixture
  // 等) も noop して 200 を返す。Refs #133。
  if (event === "push") {
    const payload = JSON.parse(body) as Partial<PushWebhookPayload>;
    const fullName = payload.repository?.full_name;
    const defaultBranch = payload.repository?.default_branch;
    const ref = payload.ref;
    if (fullName && ref) {
      const [owner, name] = fullName.split("/");
      if (owner && name) {
        if (ref.startsWith("refs/tags/")) {
          await invalidateRepoTags(env.CI_STATUS, owner, name);
        } else if (defaultBranch && ref === `refs/heads/${defaultBranch}`) {
          await invalidateRepoCommits(env.CI_STATUS, owner, name);
        }
      }
    }
    return new Response("OK", { status: 200 });
  }

  return new Response("Ignored event: " + event, { status: 200 });
}

export { verifySignature };
