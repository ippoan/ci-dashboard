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
  invalidateRepoCompare,
} from "./release-cache";
import { applyPullRequestEvent } from "./pr-map-cache";
import { markReleasesIndexStale } from "./releases-index-cache";
import { noteGitHubAuthBroken } from "./github-backoff";
import { refreshReleasesIndex } from "./releases-page";

// Queue 経由で consumer に渡す raw event (Refs #318)。body は署名検証済みの
// raw JSON 文字列をそのまま積む (consumer 側で event 別に parse する)。
export interface WebhookQueueMessage {
  event: string | null;
  body: string;
  delivery: string;
}

/** 同じ queue に流す内部 job (Refs #325)。/releases index の再集計は GitHub
 *  fan-out で 35s かかり得るため、waitUntil (30s 上限) ではなく consumer
 *  (15 分上限) で実行する。 */
export interface ReleasesIndexRefreshMessage {
  kind: "releases-index-refresh";
}

export type QueueMessage = WebhookQueueMessage | ReleasesIndexRefreshMessage;

// Self-reschedule の重複防止 marker (Refs #337)。60s 遅延 job が既に予約済み
// なら積み増さない。KV expirationTtl の最小値 60s に合わせる。
const REKICK_MARKER = "releases:index:rekick-scheduled";

/** stale なのに集計できなかった時の自己再投函 (Refs #337)。queue binding が
 *  無い環境 (dev / test) は no-op — 次の event / page view の enqueue が拾う。 */
async function scheduleReleasesIndexRekick(env: Env): Promise<void> {
  if (!env.WEBHOOK_QUEUE) return;
  if (await env.CI_STATUS.get(REKICK_MARKER)) return;
  await env.CI_STATUS.put(REKICK_MARKER, "1", { expirationTtl: 60 });
  try {
    await env.WEBHOOK_QUEUE.send(
      { kind: "releases-index-refresh" },
      { delaySeconds: 60 },
    );
  } catch { /* 次の event / page view の enqueue に任せる */ }
}

/** /releases index の stale 化 + refresh job の即時投函 (Refs #327)。
 *  page view を待たずに consumer が再集計を始めるので、WS reload が届く頃には
 *  fresh blob が出来ている。queue binding 無し環境では stale 化のみ (次の
 *  page view の waitUntil fallback が拾う)。enqueue の重複は refresh 側の
 *  lock / fresh recheck が無駄撃ちに落とす。 */
async function staleAndKickReleasesIndex(env: Env, repo: string): Promise<void> {
  await markReleasesIndexStale(env.CI_STATUS, repo);
  if (env.WEBHOOK_QUEUE) {
    try {
      await env.WEBHOOK_QUEUE.send({ kind: "releases-index-refresh" });
    } catch { /* enqueue 失敗は次の page view の fallback に任せる */ }
  }
}

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
    // pr-map patch (Refs #304) 用。GitHub の実配信には常に載るが、optional
    // にして最小 payload (テスト fixture) でも落ちないようにする。title が
    // 無い場合 applyPullRequestEvent は除去のみ行う。
    title?: string;
    body?: string | null;
    draft?: boolean;
    html_url?: string;
    updated_at?: string;
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
  hub: DurableObjectStub,
  ctx?: ExecutionContext,
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

  // 受信 event の観測 log (Refs #316)。request log には X-GitHub-Event が
  // 乗らないため、「issues event がどの repo から届いているか」を observability
  // で集計できるようここで 1 行出す。webhook は per-repo 設定なので、Issues
  // event 未購読の repo (= /issues の反映が reconcile 頼みで遅い repo) の特定に
  // 使う。payload の parse 失敗時は repo/action 空のまま log だけ出して続行。
  let logRepo = "";
  let logAction = "";
  try {
    const p = JSON.parse(body) as {
      action?: string;
      repository?: { full_name?: string };
    };
    logRepo = p.repository?.full_name ?? "";
    logAction = p.action ?? "";
  } catch { /* 観測用なので落とさない */ }
  console.log(JSON.stringify({
    msg: "webhook-received",
    event,
    action: logAction,
    repo: logRepo,
    delivery: request.headers.get("X-GitHub-Delivery") ?? "",
  }));

  // Queue 経路 (Refs #318)。GitHub の webhook delivery timeout は 10s で、
  // timeout した delivery は自動再送されない。受信側は署名検証 + enqueue
  // だけ行って即 200 を返し、処理は queue consumer (本 worker の queue handler)
  // が行う。処理失敗は Queues の retry (max_retries) が面倒を見るため、
  // waitUntil 方式 (#319) の「応答後 30s + 喪失 silent」問題も解消する。
  const delivery = request.headers.get("X-GitHub-Delivery") ?? "";
  if (env.WEBHOOK_QUEUE) {
    try {
      await env.WEBHOOK_QUEUE.send({ event, body, delivery });
      return new Response("OK", { status: 200 });
    } catch (err) {
      // send 失敗 (メッセージ 128KB 超 / 一時障害) は下の inline 経路に
      // fallback して取りこぼしを防ぐ。
      console.log(JSON.stringify({
        msg: "webhook-enqueue-failed",
        event,
        repo: logRepo,
        delivery,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  // Fallback: queue binding が無い環境 (wrangler dev / test) と enqueue 失敗時。
  // ack-then-process (#319) — 即 200 を返し、処理本体は waitUntil に流す
  // (応答後 30s まで実行が保証される)。処理失敗は log のみ — GitHub への 500 は
  // 再送を引き起こさないため、応答コードで伝える意味がない。
  const work = processWebhookEvent(event, body, env, hub).catch((err) => {
    console.log(JSON.stringify({
      msg: "webhook-process-failed",
      event,
      repo: logRepo,
      error: err instanceof Error ? err.message : String(err),
    }));
  });
  if (ctx) {
    ctx.waitUntil(work);
  } else {
    // test / ctx 非提供の呼び出し元では従来どおり同期処理 (挙動互換)。
    await work;
  }
  return new Response("OK", { status: 200 });
}

// Queue consumer (Refs #318)。wrangler の queues.consumers 設定で本 worker の
// `queue()` handler に配送される。max_concurrency: 1 + batch 逐次処理で
// event の相対順序を概ね保つ (GitHub の配信自体に厳密順序は無い)。失敗 message
// は retry() で Queues の再配送に任せる (max_retries 超過で drop + log 済み)。
export async function consumeWebhookBatch(
  batch: MessageBatch<QueueMessage>,
  env: Env,
): Promise<void> {
  const hub = env.CI_HUB.get(env.CI_HUB.idFromName("singleton"));

  // Event-first (Refs #335): 重い index 再集計 (12〜35s の GitHub fan-out) が
  // 同 batch の webhook event (即時 KV write) を塞がないよう、event を先に
  // 全部処理してから refresh job を最後に 1 回だけ実行する。同 batch に
  // refresh message が複数あってもまとめて 1 回 (残りはまとめて ack)。
  const eventMessages: Message<QueueMessage>[] = [];
  const refreshMessages: Message<QueueMessage>[] = [];
  for (const message of batch.messages) {
    if ("kind" in message.body && message.body.kind === "releases-index-refresh") {
      refreshMessages.push(message);
    } else {
      eventMessages.push(message);
    }
  }

  for (const message of eventMessages) {
    const { event, body, delivery } = message.body as WebhookQueueMessage;
    try {
      await processWebhookEvent(event, body, env, hub);
      message.ack();
    } catch (err) {
      console.log(JSON.stringify({
        msg: "webhook-process-failed",
        event,
        delivery,
        attempts: message.attempts,
        error: err instanceof Error ? err.message : String(err),
      }));
      message.retry();
    }
  }

  if (refreshMessages.length === 0) return;
  try {
    const outcome = await refreshReleasesIndex(env);
    // 集計が実際に走った時だけ /releases の WS reload を発火する (Refs #327)。
    if (outcome === "done") {
      await hub.fetch(new Request("http://hub/releases-updated", {
        method: "POST",
        body: JSON.stringify({ repo: "*" }),
      }));
    } else if (outcome !== "fresh") {
      // blob はまだ stale なのに集計できなかった (backoff / lock / empty-skip)。
      // 60s 後の refresh job を自分で再投函して「stale な blob はいつか必ず
      // 集計される」invariant を保つ (Refs #337 — 旧実装はここで ack 捨てして
      // おり、deploy に殺された compute の残 lock に当たると停止していた)。
      await scheduleReleasesIndexRekick(env);
    }
    for (const m of refreshMessages) m.ack();
  } catch (err) {
    // 認証失効なら marker を立てて page banner で operator に知らせる (Refs #334)。
    await noteGitHubAuthBroken(env.CI_STATUS, err);
    console.log(JSON.stringify({
      msg: "releases-index-refresh-failed",
      attempts: refreshMessages[0]?.attempts,
      error: err instanceof Error ? err.message : String(err),
    }));
    for (const m of refreshMessages) m.retry();
  }
}

// Event 処理本体。handleWebhook から waitUntil 経由で呼ばれる (Refs #318)。
async function processWebhookEvent(
  event: string | null,
  body: string,
  env: Env,
  hub: DurableObjectStub,
): Promise<void> {
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

    return;
  }

  if (event === "workflow_job") {
    const payload: WorkflowJobPayload = JSON.parse(body);
    await hub.fetch(new Request("http://hub/update-job", {
      method: "POST",
      body: JSON.stringify({ job: payload.workflow_job }),
    }));
    return;
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

    // /issues の関連 PR chip (pr-map cache) を即時 patch する (Refs #304)。
    // merge 判定とは独立に全 action で呼ぶ — opened / edited / reopened /
    // draft flip も chip の表示内容を変えるため。対象外 action や cache
    // 不在は applyPullRequestEvent 側が no-op にする。
    await applyPullRequestEvent(env.CI_STATUS, payload);

    const isMergeToDefault =
      payload.action === "closed" &&
      payload.pull_request.merged === true &&
      payload.pull_request.base.ref === payload.repository.default_branch;
    if (isMergeToDefault) {
      // /releases の "Unreleased" ゾーンを即時更新。merge で main HEAD が動き、
      // `<tag>...<defaultBranch>` の compare 内容 (= 直近 merge が参照した
      // open issue) が変わるので、compare + commits cache を flush して 60s
      // TTL を待たずに次ロードで refetch させる。Refs #231。
      const [owner, name] = repo.split("/");
      if (owner && name) {
        await invalidateRepoCompare(env.CI_STATUS, owner, name);
        await invalidateRepoCommits(env.CI_STATUS, owner, name);
      }
      // merge は Unreleased zone / synthetic block の中身を変える → /releases
      // index の stale 化 + refresh job 投函 (Refs #325 / #327)。
      await staleAndKickReleasesIndex(env, repo);
      // /issues の merged 紫チップも変わる (pr-map は applyPullRequestEvent で
      // patch 済み) → live reload を発火 (Refs #327)。
      try {
        await hub.fetch(new Request("http://hub/issues-updated", {
          method: "POST",
          body: JSON.stringify({
            repo,
            number: payload.pull_request.number,
            state: "merged",
          }),
        }));
      } catch { /* fail-open */ }
      if (parseTaglessRepos(env.TAGLESS_REPOS).has(repo)) {
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
    }
    return;
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
    // /releases index は issue の open/close で close 候補の表示が変わる。
    // stale 化 + refresh job 投函 (Refs #325 / #327)。
    await staleAndKickReleasesIndex(env, payload.repository.full_name);
    // /issues page の live reload trigger (Refs #321)。KV upsert 完了後に
    // broadcast するので、reload 時の SSR read は必ず更新後の KV を見る。
    // 通知失敗は page 側の問題に留まる (次の手動 reload で追い付く) ため
    // fail-open。
    try {
      await hub.fetch(new Request("http://hub/issues-updated", {
        method: "POST",
        body: JSON.stringify({
          repo: payload.repository.full_name,
          number: payload.issue.number,
          state: payload.issue.state,
        }),
      }));
    } catch { /* fail-open */ }
    return;
  }

  // /issues SSR の comment 数表示用。`created` / `deleted` だけ反映、
  // `edited` は無視 (件数変わらない)。cache miss (該当 issue が KV に
  // 居ない) は no-op — 次の reconcile delta が full record で上書きする。
  if (event === "issue_comment") {
    const payload: IssueCommentWebhookPayload = JSON.parse(body);
    await applyIssueCommentEvent(env.CI_STATUS, payload);
    return;
  }

  // /projects SSR の KV cache (project-cache.ts) invalidation 経路。
  // `projects_v2` event = board level (create/close/delete/edit) なので
  //   org list + items 両方 flush。Refs #131。
  if (event === "projects_v2") {
    const payload: ProjectsV2WebhookPayload = JSON.parse(body);
    await applyProjectsV2Event(env.CI_STATUS, payload);
    return;
  }

  // `projects_v2_item` event = 個別 card の add/edit/delete/archive/reorder。
  //   list は不変、該当 org の items cache + issues-page project map を flush。
  if (event === "projects_v2_item") {
    const payload: ProjectsV2ItemWebhookPayload = JSON.parse(body);
    await applyProjectsV2ItemEvent(env.CI_STATUS, payload);
    return;
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
    return;
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
          // 新 tag は index の tag blocks を変える (Refs #325 / #327)。
          await staleAndKickReleasesIndex(env, fullName);
        } else if (defaultBranch && ref === `refs/heads/${defaultBranch}`) {
          await invalidateRepoCommits(env.CI_STATUS, owner, name);
          // "Unreleased" ゾーンの `<tag>...<defaultBranch>` compare も flush。
          // squash merge は default branch への push として届くので、これで
          // merge 単位の即時反映になる (60s TTL を待たない)。Refs #231。
          await invalidateRepoCompare(env.CI_STATUS, owner, name);
          await staleAndKickReleasesIndex(env, fullName);
        }
      }
    }
    return;
  }

  // 未知 event は noop (応答は handleWebhook が常に 200 を返す)。
}

export { verifySignature };
