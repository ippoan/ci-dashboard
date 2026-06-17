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
//
// #409 以降、blob の SoT は CIDashboardHub DO の `this.ctx.storage` (強整合)。
// 本 module は **`BlobStore` interface 経由でしか blob に触らず**、KV 直叩きの
// 経路は持たない。caller (= Hub DO) が `DoStorageBlobStore` を渡してくる。

import type { OrgIssue } from "./mcp/tools/issues";
import type { IssueRow, RepoView } from "./releases-page";
import type { IssueWebhookPayload } from "./issue-cache";
import { issueKey } from "./issue-cache";
import { computeWarnings } from "./release-helpers";
import type { ReleasesIndexBlob } from "./releases-index-cache";

/** blob の read / write を抽象化する store interface。
 *  - Hub DO 内: `DoStorageBlobStore` (= this.ctx.storage、強整合)
 *  - 単体テスト: `InMemoryBlobStore` 等 */
export interface BlobStore {
  read<T = unknown>(): Promise<ReleasesIndexBlob<T> | null>;
  write(blob: ReleasesIndexBlob): Promise<void>;
}

/** issues event (close / reopen / edit) を blob 内の該当行に反映する。
 *  行の特定は html_url 完全一致 (cross-repo 行も含めて全 card を走査)。
 *  @returns true = 1 行以上 patch して blob を書いた (= WS reload して良い)。
 *  false = 該当行なし or blob 不在 (= index 内容に影響なし、何もしない)。 */
export async function applyIssueEventToReleasesIndex(
  store: BlobStore,
  payload: IssueWebhookPayload,
): Promise<boolean> {
  const blob = await store.read<RepoView[]>();
  if (!blob) {
    console.log(JSON.stringify({
      msg: "releases-index-apply-issue",
      url: payload.issue.html_url,
      action: payload.action,
      state: payload.issue.state,
      blob: "missing",
      matched: 0,
      written: false,
    }));
    return false;
  }

  const issue = payload.issue;
  const labels = issue.labels.map((l) => l.name);
  let matched = 0;
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
        matched++;
      }
    }
  }
  const written = matched > 0;
  console.log(JSON.stringify({
    msg: "releases-index-apply-issue",
    url: issue.html_url,
    action: payload.action,
    state: issue.state,
    matched,
    written,
  }));
  if (!written) return false;
  await store.write(blob);
  return true;
}

/** ダッシュボード起点の close (`handleReleaseClose`) が、確定した closed issue を
 *  index blob に同期反映する (Refs #343)。issues webhook 直接 patch (#339) は
 *  per-repo 購読 + GitHub 配信 + fail-open hub fetch の単一非同期チェーンに依存し、
 *  webhook 未購読 repo では blob が patch されず closed issue が reload で復活する。
 *  close handler は自分の結果 (closed[]) を握っているので、それを使って同期的に
 *  blob を直す (webhook patch とは last-write-wins で冪等)。
 *
 *  行の特定は `applyIssueEventToReleasesIndex` と同じく url 完全一致。close の
 *  対象 url は `https://github.com/<owner>/<name>/issues/<n>` で、同一 repo 行
 *  (url がそれ自身) も cross-repo 行 (Refs #292、`row.repo` が close 対象 repo の
 *  時その url を持つ) も同じ突合で拾える。
 *
 *  state 以外 (title / labels / assignees / updated_at) は GitHub を引き直さず
 *  行の既存値を保持する — close は state しか変えないため。
 *  @returns true = 1 行以上 patch して blob を書いた (WS reload して良い)。 */
export async function applyCloseToReleasesIndex(
  store: BlobStore,
  closedUrls: string[],
): Promise<boolean> {
  if (closedUrls.length === 0) return false;
  const blob = await store.read<RepoView[]>();
  if (!blob) {
    console.log(JSON.stringify({
      msg: "releases-index-apply-close",
      total: closedUrls.length,
      matched: 0,
      alreadyClosed: 0,
      blob: "missing",
      written: false,
    }));
    return false;
  }

  const targets = new Set(closedUrls);
  // Track which target URLs were found in blob (matched) vs. already closed
  // (no-op) vs. not in blob at all (missing). Operator-side diagnostic for
  // "close した issue が復活する" 系の症状切り分け — どの URL が blob に
  // 見つからなかったか後追いできる。
  const matchedUrls = new Set<string>();
  let alreadyClosed = 0;
  let written = false;
  for (const view of blob.views) {
    for (const block of view.tagBlocks) {
      for (const row of block.issues) {
        if (!targets.has(row.url)) continue;
        matchedUrls.add(row.url);
        if (row.state === "closed") { alreadyClosed++; continue; }
        row.state = "closed";
        row.warnings = computeWarnings({ state: "closed", labels: row.labels });
        written = true;
      }
    }
  }
  const missing = closedUrls.filter((u) => !matchedUrls.has(u));
  console.log(JSON.stringify({
    msg: "releases-index-apply-close",
    total: closedUrls.length,
    matched: matchedUrls.size,
    alreadyClosed,
    missing: missing.slice(0, 10),
    missingCount: missing.length,
    written,
  }));
  if (!written) return false;
  await store.write(blob);
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
  store: BlobStore,
  kv: KVNamespace,
  repo: string,
  refs: number[],
  headSha: string | null,
): Promise<RefsPatchOutcome> {
  const logOutcome = (outcome: RefsPatchOutcome, extra: Record<string, unknown> = {}): RefsPatchOutcome => {
    console.log(JSON.stringify({
      msg: "releases-index-apply-refs",
      repo, refs, headSha, outcome, ...extra,
    }));
    return outcome;
  };

  const blob = await store.read<RepoView[]>();
  if (!blob) return logOutcome("fallback", { reason: "blob-missing" });

  const view = blob.views.find((v) => v.repo === repo);
  // Roster に未登場の repo は全集計でしか発見できない。
  if (!view) return logOutcome("fallback", { reason: "view-missing" });
  // 非 tagless repo の merge は index 内容を変えない (tag が出るまで
  // close 候補にならない)。stale 化もしない。
  if (!view.tagless) return logOutcome("noop", { reason: "not-tagless" });

  const block = view.tagBlocks.find((b) => b.synthetic);
  if (!block) {
    // tagless なのに synthetic block が無い形は loadRepoView が作らない
    // はずだが、見つからなければ構造を推測せず全集計に任せる。
    return logOutcome(refs.length === 0 ? "noop" : "fallback", { reason: "synthetic-block-missing" });
  }

  let changed = false;

  for (const n of refs) {
    // 既に載っている (same-repo 行 = repo field 無し) なら skip。
    if (block.issues.some((r) => r.number === n && !r.repo)) continue;
    const cached = await kv.get(issueKey(repo, n), "json") as OrgIssue | null;
    if (!cached) {
      // /issues KV に無い (closed 済 / 未配信)。中途半端に挿入せず全集計へ。
      // ここまでの patch は書かずに捨てる (fallback の全集計が全部やり直す)。
      return logOutcome("fallback", { reason: "issue-cache-miss", missingRef: n });
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

  if (!changed) return logOutcome("noop", { reason: "no-change" });
  await store.write(blob);
  return logOutcome("patched", { added: block.issues.length });
}
