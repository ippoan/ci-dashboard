// /releases index blob の webhook 直接 patch (Refs #339)。
//
// #325〜#338 の SWR + queue 再集計では、webhook は「全集計 (12〜35s の GitHub
// fan-out) の引き金」でしかなかった。merge / close のたびに重い再集計が走り、
// deploy kill・rate limit・auth 断の影響を受け続ける。/issues (upsertIssue) や
// PR チップ (applyPullRequestEvent) と同じく、webhook payload の情報で blob を
// その場で書き換え、全集計は tag push と 1h の安全網だけに格下げする。
//
// 設計上の不変条件:
// - patch は storedAt / staleRepos を**変えない** (storedAt = 最後の full
//   snapshot 時刻という意味を保つ。patch 成功時は内容が現になるので
//   更新中バッジも出ない)
// - 行データは GitHub API を呼ばず /issues KV cache (`issue:repo#N`) から組む
// - patch できない時は caller が従来の stale 化 + 全集計に fallback する

import type { OrgIssue } from "./mcp/tools/issues";
import type { IssueRow, RepoView, TagBlock } from "./releases-page";
import type { IssueWebhookPayload } from "./issue-cache";
import { issueKey } from "./issue-cache";
import { computeWarnings } from "./release-helpers";
import {
  readReleasesIndexBlob,
  writePatchedReleasesIndexBlob,
} from "./releases-index-cache";

/** issues event (close / reopen / edit) を blob 内の該当行に反映する。
 *  行の特定は html_url 完全一致 (cross-repo 行も含めて全 card を走査)。
 *  @returns true = 1 行以上 patch して blob を書いた (= WS reload して良い)。
 *  false = 該当行なし or blob 不在 (= index 内容に影響なし、何もしない)。 */
export async function applyIssueEventToReleasesIndex(
  kv: KVNamespace,
  payload: IssueWebhookPayload,
): Promise<boolean> {
  const blob = await readReleasesIndexBlob<RepoView[]>(kv);
  if (!blob) return false;

  const issue = payload.issue;
  const labels = issue.labels.map((l) => l.name);
  let patched = false;
  for (const view of blob.views) {
    for (const block of view.tagBlocks) {
      for (const row of block.issues) {
        if (row.url !== issue.html_url) continue;
        row.state = issue.state;
        row.title = issue.title;
        row.labels = labels;
        row.assignees = issue.assignees.map((a) => a.login);
        row.updated_at = issue.updated_at;
        row.warnings = computeWarnings({ state: issue.state, labels });
        patched = true;
      }
    }
  }
  if (!patched) return false;
  await writePatchedReleasesIndexBlob(kv, blob);
  return true;
}

export type RefsPatchOutcome = "patched" | "noop" | "fallback";

/** merge / default-branch push で参照された issue (`Refs #N`) を tagless repo
 *  の synthetic / Unreleased block に挿入し、block の `<branch>@<sha7>` を
 *  進める。行データは /issues KV cache から構成 (GitHub API 0 call)。
 *
 *  @returns "patched"  = blob を書いた (WS reload して良い)
 *           "noop"     = index 内容に影響なし (非 tagless repo / 変更なし)
 *           "fallback" = patch 不能 (blob/card 無し、KV に issue 無し等) —
 *                        caller が stale 化 + 全集計に fallback する */
export async function applyRefsPatchToReleasesIndex(
  kv: KVNamespace,
  repo: string,
  refs: number[],
  headSha: string | null,
): Promise<RefsPatchOutcome> {
  const blob = await readReleasesIndexBlob<RepoView[]>(kv);
  if (!blob) return "fallback";

  const view = blob.views.find((v) => v.repo === repo);
  // Roster に未登場の repo は全集計でしか発見できない。
  if (!view) return "fallback";
  // 非 tagless repo の merge は index 内容を変えない (tag が出るまで
  // close 候補にならない)。stale 化もしない。
  if (!view.tagless) return "noop";

  const block = view.tagBlocks.find((b) => b.synthetic);
  if (!block) {
    // tagless なのに synthetic block が無い形は loadRepoView が作らない
    // はずだが、見つからなければ構造を推測せず全集計に任せる。
    return refs.length === 0 ? "noop" : "fallback";
  }

  let changed = false;

  for (const n of refs) {
    // 既に載っている (same-repo 行 = repo field 無し) なら skip。
    if (block.issues.some((r) => r.number === n && !r.repo)) continue;
    const cached = await kv.get(issueKey(repo, n), "json") as OrgIssue | null;
    if (!cached) {
      // /issues KV に無い (closed 済 / 未配信)。中途半端に挿入せず全集計へ。
      // ここまでの patch は書かずに捨てる (fallback の全集計が全部やり直す)。
      return "fallback";
    }
    const row: IssueRow = {
      number: cached.number,
      title: cached.title,
      state: cached.state,
      labels: cached.labels,
      assignees: cached.assignees,
      url: cached.url,
      updated_at: cached.updated_at,
      warnings: computeWarnings({ state: cached.state, labels: cached.labels }),
    };
    block.issues.push(row);
    changed = true;
  }
  block.issues.sort((a, b) => a.number - b.number);

  // Synthetic block の identity (`<branch>@<sha7>` 等、形式は build 経路で
  // 揺れる) は sha 部分だけを正規表現で差し替える — 形式を推測しない。
  if (headSha) {
    const sha7 = headSha.slice(0, 7);
    const next = block.tag.replace(/\b[0-9a-f]{7,40}\b/, sha7);
    if (next !== block.tag) {
      block.tag = next;
      changed = true;
    }
  }

  if (!changed) return "noop";
  await writePatchedReleasesIndexBlob(kv, blob);
  return "patched";
}
