// POST /api/issue-flip — /issues 各行の close/reopen (flip) ボタンの backend
// (Refs #496)。`gh` CLI は token がすぐ失効するため使わず、既存の
// `github-api.ts` (`tokenForOrg` = auth-worker delegation) 経由の REST で
// close_issue / reopen_issue MCP tool (src/mcp/tools/issues.ts) と同じ
// payload を叩く。
//
// 「reopen は更新するまで可能」は本 handler では実装しない — /issues 側の
// 既存 webhook → live-reload (issues-page.ts LIVE_RELOAD_SCRIPT) が画面を
// 更新するまでボタンが flip し続けられる、という既存挙動にそのまま乗る。

import { GitHubApiError, githubApi, parseRepo, tokenForOrg } from "./github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { upsertIssue } from "./issue-cache";
import type { OrgIssue } from "./mcp/tools/issues";
import { formatCloseFailureReason } from "./release-close";

export interface IssueFlipRequestBody {
  repo?: unknown;
  number?: unknown;
  action?: unknown;
}

// GitHub REST issue object (PATCH レスポンス)。mcp/tools/issues.ts の
// `Issue` interface は assignees を持たないため、ここでだけ拡張する。
interface FlippedIssue {
  number: number;
  title: string;
  state: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  body: string | null;
}

export async function handleIssueFlip(
  req: Request,
  env: AuthClientWorkerEnv,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: IssueFlipRequestBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, reason: "invalid JSON body" }, { status: 400 });
  }

  const repoParam = typeof body.repo === "string" ? body.repo.trim() : "";
  const number = Number(body.number);
  const action = body.action;

  if (!repoParam || !Number.isInteger(number) || number <= 0) {
    return Response.json(
      { ok: false, reason: "missing/invalid repo or number" },
      { status: 400 },
    );
  }
  if (action !== "close" && action !== "reopen") {
    return Response.json(
      { ok: false, reason: "action must be 'close' or 'reopen'" },
      { status: 400 },
    );
  }

  let owner: string, name: string, token: string;
  try {
    ({ owner, repo: name } = parseRepo(repoParam));
    token = await tokenForOrg(env, owner);
  } catch (err) {
    const status = err instanceof GitHubApiError ? err.status : 400;
    return Response.json({ ok: false, reason: formatCloseFailureReason(err) }, { status });
  }

  const payload: Record<string, unknown> = action === "close"
    ? { state: "closed", state_reason: "completed" }
    : { state: "open" };

  let updated: FlippedIssue;
  try {
    updated = await githubApi<FlippedIssue>(
      token, "PATCH", `/repos/${owner}/${name}/issues/${number}`, payload,
    );
  } catch (err) {
    const status = err instanceof GitHubApiError ? err.status : 502;
    return Response.json({ ok: false, reason: formatCloseFailureReason(err) }, { status });
  }

  // GitHub webhook (issues event) の到達を待たずに open issues cache を
  // 同期反映する (release-close.ts の invalidateIssue と同方針)。open のみ
  // 保持する cache なので、close → evict / reopen → upsert は upsertIssue が
  // state を見て自動で振り分ける。
  const orgIssue: OrgIssue = {
    repo: `${owner}/${name}`,
    number: updated.number,
    title: updated.title,
    state: updated.state,
    author: updated.user?.login ?? "",
    labels: updated.labels.map((l) => l.name),
    assignees: (updated.assignees ?? []).map((a) => a.login),
    comments: updated.comments,
    created_at: updated.created_at,
    updated_at: updated.updated_at,
    url: updated.html_url,
    body: updated.body ?? null,
  };
  await upsertIssue(env.CI_STATUS, orgIssue);

  return Response.json({ ok: true, state: updated.state, number: updated.number });
}
