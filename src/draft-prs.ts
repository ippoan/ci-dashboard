// draft PR stock (Refs #470)。cc-webreview (ippoan/cc-webreview-ext#4) の side panel
// が「レビュー待ち draft PR の一覧」を取得するための webhook-fed KV cache + 一覧 API。
//
// KV schema:
//   draft-prs:v1 -> { updatedAt, data: Record<"owner/repo#N", DraftPr> }
//
// pr-map cache と違い「cache 不在は no-op」規約は採らない — この cache は webhook
// だけで完結して積み上がる (full fetch の安全網が無い) ため、空から普通に育てる。
// 取りこぼしは当該 PR の次の activity (synchronize / edited / closed) で自己修復する。

export const DRAFT_PRS_KEY = "draft-prs:v1";

export interface DraftPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** PR 作者 login (実配信では常に載る。最小 payload では "unknown")。 */
  author: string;
  updated_at: string;
}

interface DraftPrsEntry {
  updatedAt: string;
  data: Record<string, DraftPr>;
}

/** pull_request webhook payload のうち draft 集合の更新に必要な最小形
 *  (webhook.ts の PullRequestPayload と構造互換)。 */
export interface DraftPrEventPayload {
  action: string;
  pull_request: {
    number: number;
    title?: string;
    draft?: boolean;
    html_url?: string;
    updated_at?: string;
    user?: { login?: string };
  };
  repository: { full_name: string };
}

/** pull_request event を draft 集合に反映する。
 *
 *  - `closed` / `ready_for_review` → 除去 (レビュー待ち stock から外れる)
 *  - `draft === true` (opened / reopened / converted_to_draft / edited /
 *    synchronize) → upsert
 *  - `draft === false` → 除去 (非 draft PR の activity。大半は no-op)
 *  - `draft` 不明 (最小 payload) → 何もしない (分類できない)
 *
 *  変化が無いときは KV write を省略する。
 */
export async function applyDraftPrEvent(
  kv: KVNamespace,
  payload: DraftPrEventPayload,
): Promise<void> {
  const pr = payload.pull_request;
  const repo = payload.repository.full_name;
  const key = `${repo}#${pr.number}`;

  const remove =
    payload.action === "closed" ||
    payload.action === "ready_for_review" ||
    pr.draft === false;
  const upsert = !remove && pr.draft === true;
  if (!remove && !upsert) return; // draft 不明 → 分類できない

  const cached =
    ((await kv.get(DRAFT_PRS_KEY, "json")) as DraftPrsEntry | null) ?? {
      updatedAt: "",
      data: {},
    };

  if (remove) {
    if (!(key in cached.data)) return; // 変化なし → write 省略
    delete cached.data[key];
  } else {
    cached.data[key] = {
      repo,
      number: pr.number,
      title: pr.title ?? `PR #${pr.number}`,
      url: pr.html_url ?? `https://github.com/${repo}/pull/${pr.number}`,
      author: pr.user?.login ?? "unknown",
      updated_at: pr.updated_at ?? new Date().toISOString(),
    };
  }
  cached.updatedAt = new Date().toISOString();
  await kv.put(DRAFT_PRS_KEY, JSON.stringify(cached));
}

/** 現在の draft PR 一覧 (updated_at 降順)。`GET /api/draft-prs` の中身。 */
export async function listDraftPrs(
  kv: KVNamespace,
): Promise<{ updatedAt: string; prs: DraftPr[] }> {
  const cached = (await kv.get(DRAFT_PRS_KEY, "json")) as DraftPrsEntry | null;
  if (!cached) return { updatedAt: "", prs: [] };
  const prs = Object.values(cached.data).sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
  return { updatedAt: cached.updatedAt, prs };
}
