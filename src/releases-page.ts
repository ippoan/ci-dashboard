import { parseRepo, tokenForOrg, GitHubApiError } from "./github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import {
  extractRefIssues,
  sortSemverDesc,
  isSemverTag,
  previousTag,
  computeWarnings,
} from "./release-helpers";
import {
  collectIssueNumbersForRange,
  fetchIssuesByNumbers,
} from "./release-alert";
import {
  cachedTags,
  cachedCompare,
  cachedCommits,
  cachedRepoMeta,
  cachedIssue,
  TTL_MOVING_COMPARE,
} from "./release-cache";
import { loadDirectPushAllowlist } from "./direct-push-allowlist";
import { parseTaglessRepos } from "./tagless-repos";
import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";

// `/releases` (no params) renders a list of "recent releases" — every watched
// repo (from Hub `/statuses`) with its latest semver-sorted tags, each linking
// to the detailed candidate view. The lookup form is appended below as a
// fallback for older / arbitrary tags.
//
// `/releases?repo=owner/name&tag=vX.Y.Z` renders the release confirmation
// view: every issue touched by commits in this tag's range, with a checkbox
// per row so the operator can close them in one POST after eyeballing the
// list. See issue #35 and CLAUDE.md (Refs convention, manual-close flow).
//
// We do NOT persist anything yet — the page recomputes from GitHub each load.
// Persistence + dashboard "unconfirmed release" badge are deferred to a later
// PR (issue #35 calls those out as recommended but not required for MVP).

export async function handleReleasesPage(
  req: Request,
  env: {
    INTERNAL_SHARED_SECRET: SecretsStoreSecret;
    CI_HUB: DurableObjectNamespace;
    CI_STATUS: KVNamespace;
    TAGLESS_REPOS?: string;
  },
): Promise<Response> {
  const url = new URL(req.url);
  const repoParam = url.searchParams.get("repo");
  const tag = url.searchParams.get("tag");

  // Flash params populated by POST /api/release-close{,-batch} redirects.
  const closedFlash = numericList(url.searchParams.get("closed"));
  const failedFlash = numericList(url.searchParams.get("failed"));
  // `failed_reasons=N:reason,N:reason` 形式。reason は URL-encoded。
  // Refs ippoan/ci-dashboard#152 (close 失敗時の原因表示)
  const failedReasons = parseFailedReasons(url.searchParams.get("failed_reasons"));

  // Only the fully-specified pair opens the detail page; every other shape
  // (no params / partial / post-close redirect) falls through to the index so
  // the operator never lands on an empty form by accident (issue #45).
  // Flash redirects must not be cached by the browser — they encode one-shot
  // banner state. Same logic for empty post-close redirects (no flash params
  // but the operator expects to see a fresh table).
  const hasFlash = closedFlash.length > 0 || failedFlash.length > 0;

  if (repoParam && tag) {
    let result: ReleasePayload;
    try {
      result = await loadRelease(env, repoParam, tag, env.CI_STATUS);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        return html(renderError(`Not found: ${err.message}`), 404);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return html(renderError(msg), 502);
    }
    return html(
      renderHtml(result, closedFlash, failedFlash, failedReasons),
      200,
      cacheControlFor(hasFlash, /* detail */ true),
    );
  }

  // Index page; `repoParam` (when set without tag, e.g. from the batch-close
  // redirect) tags along so flash links can point at the right GitHub repo.
  return await handleIndexPage(env, closedFlash, failedFlash, failedReasons, repoParam, hasFlash);
}

// Cache-Control policy:
//   - Flash redirects: `no-store` so the banner doesn't get pinned in the
//     browser's bfcache or revisited cache after a back-button click.
//   - Detail page (single repo+tag): max-age 30, swr 120. Already-cached KV
//     hits are usually <50ms but the HTML still costs CPU.
//   - Index page: max-age 15, swr 60. Multi-repo fan-out means even cached
//     paths are bigger; keep freshness tight so a new tag shows up quickly.
function cacheControlFor(hasFlash: boolean, detail: boolean): string {
  if (hasFlash) return "private, no-store";
  return detail
    ? "private, max-age=30, stale-while-revalidate=120"
    : "private, max-age=15, stale-while-revalidate=60";
}

// --------------------------------------------------------------------------
// "Recent releases" landing page (no params)
// --------------------------------------------------------------------------

interface RepoView {
  repo: string;
  tagBlocks: TagBlock[];
  olderTags: string[];   // tags beyond the displayed top N
}

interface TagBlock {
  tag: string;
  prevTag: string | null;
  issues: IssueRow[];    // already-fetched and warning-annotated
  // `synthetic` blocks are constructed from default-branch commits when a
  // direct-push-OK repo has no semver tags (#57). They drop the "→ detail"
  // link because there's no compare-range view to point at, and they hide
  // already-closed issues entirely instead of nesting them in <details>.
  synthetic?: boolean;
}

// Top tags shown inline per repo (each fans out compare + per-issue fetches).
// Older tags collapse to a link strip pointing at the detail page.
const TOP_TAGS_INLINE = 5;

async function handleIndexPage(
  env: {
    INTERNAL_SHARED_SECRET: SecretsStoreSecret;
    CI_HUB: DurableObjectNamespace;
    CI_STATUS: KVNamespace;
    TAGLESS_REPOS?: string;
  },
  closedFlash: number[],
  failedFlash: number[],
  failedReasons: Map<number, string>,
  flashRepo: string | null,
  hasFlash: boolean,
): Promise<Response> {
  // 1. Watched repos come from three sources:
  //   (a) Hub status cache — every repo that has ever fired a CI run.
  //   (b) Direct-push-OK allowlist — repos that never auto-merge a PR and
  //       therefore won't show up in (a) until they happen to push a tag.
  //       Fetched from `yhonda-ohishi/claude-skills` (same SoT as
  //       `/wt-direct-push`); see direct-push-allowlist.ts.
  //   (c) `TAGLESS_REPOS` wrangler var — opt-in list for repos that PR-merge
  //       through CI but don't cut release tags. These get the same synthetic-
  //       block treatment as (b), built from default-branch commits, so the
  //       operator can see open Refs without ever tagging.
  const watched = new Set<string>();
  try {
    const hubId = env.CI_HUB.idFromName("singleton");
    const hub = env.CI_HUB.get(hubId);
    const res = await hub.fetch(new Request("http://hub/statuses"));
    if (res.ok) {
      const statuses = await res.json<Array<{ repo: string }>>();
      for (const s of statuses) watched.add(s.repo);
    }
  } catch { /* empty list → falls through; allowlist may still add repos */ }

  let allowlist = new Set<string>();
  try {
    allowlist = await loadDirectPushAllowlist(env, env.CI_STATUS);
    for (const r of allowlist) watched.add(r);
  } catch { /* graceful: allowlist stays empty, existing tag-flow unaffected */ }

  const tagless = parseTaglessRepos(env.TAGLESS_REPOS);
  for (const r of tagless) watched.add(r);

  const repos = [...watched].sort();

  // 2. Per-repo data load in parallel; whole-repo failures get a null view
  //    we drop in the renderer. Allowlisted or TAGLESS_REPOS-listed repos
  //    take the synthetic path inside loadRepoView when they have no semver
  //    tags.
  const views = await Promise.all(repos.map(async (repo) => {
    try {
      const useSynthetic = allowlist.has(repo) || tagless.has(repo);
      return await loadRepoView(env, repo, useSynthetic, env.CI_STATUS);
    } catch {
      return null;
    }
  }));

  return html(
    renderIndex(
      views.filter((v): v is RepoView => v !== null),
      closedFlash,
      failedFlash,
      failedReasons,
      flashRepo,
    ),
    200,
    cacheControlFor(hasFlash, /* detail */ false),
  );
}

async function loadRepoView(
  env: AuthClientWorkerEnv,
  repo: string,
  useSynthetic: boolean,
  kv?: KVNamespace,
): Promise<RepoView | null> {
  const { owner, repo: name } = parseRepo(repo);
  const token = await tokenForOrg(env, owner);

  // 0. Drop archived repos early. GitHub API は archived repo の issue PATCH
  //    で 403 "Repository was archived so is read-only." を返すため、
  //    operator が release UI から close しようとして必ず失敗する。
  //    そもそも archived repo は将来の release tag も cut されない前提なので
  //    一覧から外す。Refs ippoan/ci-dashboard#155 (ippoan/github-mcp-server-rs
  //    が monorepo 化で archive されたが /releases に残っていた問題)。
  //
  //    meta fetch 自体が失敗 (private / 削除 / token 権限喪失 / network) した
  //    場合は best-effort で握り潰し、既存の tag fetch 失敗 → null 経路に
  //    判断を委ねる (= 「archived と確認できた時だけ」drop)。
  try {
    const meta = await cachedRepoMeta(token, kv, owner, name);
    if (meta.archived === true) return null;
  } catch {
    /* archived 判定不能 — 続行 */
  }

  // 1. Recent semver tags. 10 gives us 5 inline + room for the predecessor
  //    pairing on the oldest of those 5 + a small "older" strip.
  const allTags = await cachedTags(token, kv, owner, name, 10);
  // Non-semver tags (e.g. `installer-*` install stamps) are not release tags;
  // keep them out of topTags so a repo whose only tags are stamps still takes
  // the synthetic (direct-push) path below instead of the stale tag-compare
  // path — otherwise its open Refs never surface here. Refs #199.
  const sorted = sortSemverDesc(allTags.map((t) => t.name).filter(isSemverTag));
  const topTags = sorted.slice(0, TOP_TAGS_INLINE);
  if (topTags.length === 0) {
    // Tag-less repos opted into synthetic-block rendering (either via the
    // direct-push allowlist or the TAGLESS_REPOS wrangler var) still need a
    // way to surface their open Refs. Fall back to a synthetic block built
    // from the default branch's recent commits (#57). Other tag-less repos
    // return empty as before so we don't accidentally promote a regular
    // auto-merge repo into the synthetic path mid-release.
    if (useSynthetic) {
      const block = await loadSyntheticBlock(token, owner, name, kv);
      return {
        repo: `${owner}/${name}`,
        tagBlocks: block ? [block] : [],
        olderTags: [],
      };
    }
    return { repo: `${owner}/${name}`, tagBlocks: [], olderTags: [] };
  }

  // 2. For each inline tag, compare to its immediate predecessor (next in
  //    sorted-desc) and harvest issue refs from commit messages. We skip the
  //    PR-fetch heuristic the detail page uses, to keep the index sub-request
  //    budget bounded (fans out across N repos).
  const rawBlocks = await Promise.all(topTags.map(async (tag, i) => {
    const prevTag = sorted[i + 1] ?? null;
    if (!prevTag) {
      return { tag, prevTag: null, refs: [] as number[] };
    }
    try {
      const cmp = await cachedCompare(token, kv, owner, name, prevTag, tag);
      const refs = new Set<number>();
      for (const c of cmp.commits) {
        for (const n of extractRefIssues(c.commit.message, { owner, name })) refs.add(n);
      }
      return { tag, prevTag, refs: [...refs] };
    } catch {
      return { tag, prevTag, refs: [] };
    }
  }));

  // 3. Deduplicate issue numbers across blocks so the same issue referenced
  //    by two tags only triggers one GitHub fetch.
  const uniqueRefs = new Set<number>();
  for (const b of rawBlocks) for (const n of b.refs) uniqueRefs.add(n);

  const issueByNum = new Map<number, IssueRow | null>();
  await Promise.all([...uniqueRefs].map(async (n) => {
    try {
      const issue = await cachedIssue(token, kv, owner, name, n);
      if (issue.pull_request) { issueByNum.set(n, null); return; }
      const labels = issue.labels.map((l) => l.name);
      issueByNum.set(n, {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels,
        assignees: issue.assignees.map((a) => a.login),
        url: issue.html_url,
        updated_at: issue.updated_at,
        warnings: computeWarnings({ state: issue.state, labels }),
      });
    } catch {
      issueByNum.set(n, null);
    }
  }));

  const tagBlocks: TagBlock[] = rawBlocks.map((b) => ({
    tag: b.tag,
    prevTag: b.prevTag,
    issues: b.refs
      .map((n) => issueByNum.get(n) ?? null)
      .filter((i): i is IssueRow => i !== null)
      .sort((a, c) => a.number - c.number),
  }));

  // TAGLESS_REPOS に居る repo が tag を持つ場合、latest tag → HEAD で merge
  // されたが未 release な PR 由来の open issue を「Unreleased」block として
  // tag blocks の先頭に追加する。ci-dashboard / secrets-inventory のような
  // 「PR merge = staging deploy だが release tag も cut する」混合運用の repo
  // で、merge 済み未 release の issue を見落とさないようにするのが目的。
  // Refs ippoan/ci-dashboard#147 (cross-repo Refs 修正) + #145 (TAGLESS 追加)。
  if (useSynthetic) {
    const latestTag = sorted[0]!;
    const unreleased = await loadSyntheticBlock(token, owner, name, kv, latestTag);
    if (unreleased) tagBlocks.unshift(unreleased);
  }

  return {
    repo: `${owner}/${name}`,
    tagBlocks,
    olderTags: sorted.slice(TOP_TAGS_INLINE),
  };
}

// Build a synthetic block for tag-less direct-push-OK repos (#57).
//
// We scan the most recent SYNTHETIC_COMMIT_WINDOW commits on the default
// branch for `Refs #N` and hydrate the referenced issues. Both open and
// closed issues are kept (Refs #224): the operator wants tag-less / direct-
// push repos to keep showing their card even after every ref is closed.
// renderTagBlock collapses the closed rows into a <details>, mirroring the
// tag-compare path, so the card stays low-noise.
//
// The "tag" identity is `<branch>@<sha7>` so the post-close comment
// ("Closed by release main@e8e90a4") stays traceable even though the synthetic
// block has no compare range. The detail page (`?repo=X&tag=Y`) is *not*
// supported for these tags — `renderTagBlock` skips the link.
const SYNTHETIC_COMMIT_WINDOW = 100;

interface RepoMeta {
  default_branch: string;
  archived?: boolean;
}

async function loadSyntheticBlock(
  token: string,
  owner: string,
  name: string,
  kv?: KVNamespace,
  // `sinceTag` 指定時は latestTag..defaultBranch の compare で commits を取り、
  // `<branch>@<sha7> (since <sinceTag>)` という "Unreleased" 風の block にする。
  // 指定無しなら従来通り default branch の最近 SYNTHETIC_COMMIT_WINDOW commits。
  // Refs ippoan/ci-dashboard#147 (cross-repo Refs 修正) と #145 の延長:
  // TAGLESS_REPOS 指定の repo が tag を持つ場合に「latest tag → HEAD で merge
  // されたが未 release な PR」を表示するための「unreleased zone」用途。
  sinceTag?: string,
): Promise<TagBlock | null> {
  let defaultBranch: string;
  try {
    const meta = await cachedRepoMeta(token, kv, owner, name);
    defaultBranch = meta.default_branch;
  } catch {
    return null;
  }
  if (!defaultBranch) return null;

  let commits: RawCommit[] = [];
  try {
    if (sinceTag) {
      // `sinceTag...defaultBranch` is a moving range — HEAD advances on every
      // merge — so cap the compare cache at the short moving-head TTL. The
      // default 24h would hide just-merged Refs (e.g. open issues referenced by
      // a PR merged minutes ago), making the repo look "all closed". Refs #228.
      const cmp = await cachedCompare(
        token, kv, owner, name, sinceTag, defaultBranch, TTL_MOVING_COMPARE,
      );
      commits = cmp.commits;
    } else {
      commits = await cachedCommits(token, kv, owner, name, defaultBranch, SYNTHETIC_COMMIT_WINDOW);
    }
  } catch {
    return null;
  }
  if (commits.length === 0) return null;

  const refs = new Set<number>();
  for (const c of commits) {
    for (const n of extractRefIssues(c.commit.message, { owner, name })) refs.add(n);
  }
  if (refs.size === 0) {
    // No referenced issues in the recent window — nothing to confirm. Skipping
    // the block (vs. returning an empty one) keeps the repo off the landing
    // page entirely, matching the tag path's behavior.
    return null;
  }

  const issues = await fetchIssuesByNumbers(token, owner, name, refs, kv);
  // Keep both open and closed referenced issues (was open-only): a tag-less /
  // direct-push repo whose refs are all closed should still surface its card
  // with the closed history collapsed into a <details>. Refs #224.
  const rows: IssueRow[] = issues
    .filter((i) => !i.pull_request)
    .map((i) => {
      const labels = i.labels.map((l) => l.name);
      return {
        number: i.number,
        title: i.title,
        state: i.state,
        labels,
        assignees: i.assignees.map((a) => a.login),
        url: i.html_url,
        updated_at: i.updated_at,
        warnings: computeWarnings({ state: i.state, labels }),
      };
    })
    .sort((a, b) => a.number - b.number);

  if (rows.length === 0) return null;

  // commits の並び順:
  //   - 通常 (sinceTag 無し): cachedCommits は最新 first (GitHub /commits API 既定)
  //   - sinceTag 有り:        cachedCompare は古い first (GitHub /compare API)
  // どちらでも HEAD (= 最も新しい) sha を tag 名に含めたいので分岐させる。
  const headCommit = sinceTag ? commits[commits.length - 1]! : commits[0]!;
  const headSha7 = headCommit.sha.slice(0, 7);
  const tagLabel = sinceTag
    ? `Unreleased (${defaultBranch}@${headSha7})`
    : `${defaultBranch}@${headSha7}`;
  return {
    tag: tagLabel,
    prevTag: sinceTag ?? null,
    issues: rows,
    synthetic: true,
  };
}

// --------------------------------------------------------------------------
// Data loader
// --------------------------------------------------------------------------

interface ReleasePayload {
  repo: string;        // "owner/name"
  tag: string;
  previousTag: string | null;
  commits: number;     // count, for the summary line
  rows: IssueRow[];
}

interface IssueRow {
  number: number;
  title: string;
  state: string;
  labels: string[];
  assignees: string[];
  url: string;
  updated_at: string;
  warnings: string[];
}

async function loadRelease(
  env: AuthClientWorkerEnv,
  repoParam: string,
  tag: string,
  kv?: KVNamespace,
): Promise<ReleasePayload> {
  const { owner, repo: name } = parseRepo(repoParam);
  const token = await tokenForOrg(env, owner);

  // 1. Pull recent tags so we can pick the immediate predecessor for the
  //    compare endpoint. 30 is plenty given typical release cadence; for
  //    older tags the operator can pass the URL anyway and we fall back to a
  //    bounded commit list below.
  const tags = await cachedTags(token, kv, owner, name, 30);
  const tagNames = tags.map((t) => t.name);
  if (!tagNames.includes(tag)) {
    throw new GitHubApiError(
      404,
      `Tag "${tag}" not present in ${owner}/${name} (recent ${tagNames.length} tags scanned)`,
    );
  }
  const prev = previousTag(sortSemverDesc(tagNames), tag);

  // 2. Walk the tag's compare range to harvest every issue number we can
  //    attribute (Refs in commit message, PR body, branch prefix). Shared
  //    with the dashboard banner path so the two views stay in lockstep.
  const { issueNumbers, commitCount } = await collectIssueNumbersForRange(
    token, owner, name, tag, prev, kv,
  );

  // 3. Hydrate candidates. The /issues/:n endpoint also returns PRs, so we
  //    filter those out below (PRs carry a `pull_request` discriminator).
  const issues = await fetchIssuesByNumbers(token, owner, name, issueNumbers, kv);

  const rows: IssueRow[] = issues
    .filter((i) => !i.pull_request)
    .map((i) => {
      const labels = i.labels.map((l) => l.name);
      return {
        number: i.number,
        title: i.title,
        state: i.state,
        labels,
        assignees: i.assignees.map((a) => a.login),
        url: i.html_url,
        updated_at: i.updated_at,
        warnings: computeWarnings({ state: i.state, labels }),
      };
    })
    .sort((a, b) => a.number - b.number);

  return {
    repo: `${owner}/${name}`,
    tag,
    previousTag: prev,
    commits: commitCount,
    rows,
  };
}

interface RawCommit { sha: string; commit: { message: string } }

function numericList(s: string | null): number[] {
  if (!s) return [];
  return s.split(",").map((p) => Number(p.trim())).filter(Number.isInteger);
}

// `failed_reasons=N:urlencoded-reason,N:urlencoded-reason` を Map に parse する。
// release-close{,-batch}.ts が生成する flash param 経路と対 (= 同 file の
// `formatCloseFailureReason` でフォーマットされた 1 行短縮文字列)。
// 不正な entry は silently drop して残りを返す (= 旧 URL や手書き URL でも
// crash させない conservative parse)。Refs ippoan/ci-dashboard#152。
export function parseFailedReasons(s: string | null): Map<number, string> {
  const out = new Map<number, string>();
  if (!s) return out;
  for (const raw of s.split(",")) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const n = Number(raw.slice(0, idx).trim());
    if (!Number.isInteger(n) || n <= 0) continue;
    try {
      out.set(n, decodeURIComponent(raw.slice(idx + 1)));
    } catch {
      // malformed urlencoded → skip
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// HTML
// --------------------------------------------------------------------------

function html(body: string, status: number, cacheControl?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
  };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  return new Response(body, { status, headers });
}

function renderHtml(
  data: ReleasePayload,
  closedFlash: number[],
  failedFlash: number[],
  failedReasons: Map<number, string>,
): string {
  // Two filters drop rows from the form's candidate set:
  //   1. flash: just-closed rows from a close-then-redirect must not be offered
  //      again on the landing page (#61).
  //   2. state === "closed": issues that GitHub already reports as closed have
  //      nothing left to act on — the operator (or auto-close from `Closes #N`
  //      in some other PR) already handled them. Mirrors the index page's
  //      visible/hidden split in `renderTagBlock` so the detail and index views
  //      behave consistently. Pre-fix the row stayed in the form with the ⚠
  //      "already closed" warning and an un-ticked checkbox, which read as
  //      "still pending" to the operator (#90).
  const candidates = data.rows.filter(
    (r) => !closedFlash.includes(r.number) && r.state !== "closed",
  );
  const candidateRows = candidates.map((r) => renderRow(r)).join("\n");

  // Already-closed rows still live in the page as audit context (collapsed
  // <details>) so the operator can confirm which referenced issues this tag
  // actually resolved. flash-closed go in here too — the form has already
  // dropped them and the celebratory `empty` banner above shows the success;
  // the details strip just lists what got closed for reference.
  const closedRows = data.rows.filter(
    (r) => r.state === "closed" || closedFlash.includes(r.number),
  );
  const closedDetails = closedRows.length === 0 ? "" : `
    <details class="closed-details">
      <summary>${closedRows.length} closed issue${closedRows.length === 1 ? "" : "s"} (already resolved)</summary>
      <table>
        <thead><tr>
          <th>#</th>
          <th>Title</th>
          <th>State</th>
          <th>Labels</th>
          <th>Assignees</th>
        </tr></thead>
        <tbody>${closedRows.map((r) => renderClosedRow(r)).join("\n")}</tbody>
      </table>
    </details>`;

  const flash = renderFlash(closedFlash, failedFlash, failedReasons, data.repo);

  const summary =
    `${escapeHtml(data.repo)} · <code>${escapeHtml(data.tag)}</code>` +
    (data.previousTag
      ? ` (since <code>${escapeHtml(data.previousTag)}</code>, ${data.commits} commits)`
      : ` (first release; last ${data.commits} commits scanned)`);

  // Two distinct "nothing to do" states share the same hint slot:
  //   - data.rows.length === 0 → tag had no Refs at all
  //   - data.rows.length > 0 but candidates.length === 0 → everything is
  //     already closed (either before this page load, or just-closed via the
  //     redirect); show the celebratory variant.
  const empty = data.rows.length === 0
    ? `<div class="empty">🎉 No referenced issues for this release.</div>`
    : candidates.length === 0
      ? `<div class="empty">✅ All referenced issues for this release are closed.</div>`
      : "";

  const formInner = candidates.length === 0 ? "" : `
    <form method="POST" action="/api/release-close" class="close-form">
      <input type="hidden" name="repo" value="${escapeHtml(data.repo)}">
      <input type="hidden" name="tag" value="${escapeHtml(data.tag)}">
      <table>
        <thead><tr>
          <th class="col-check"></th>
          <th>#</th>
          <th>Title</th>
          <th>State</th>
          <th>Labels</th>
          <th>Assignees</th>
        </tr></thead>
        <tbody>${candidateRows}</tbody>
      </table>
      <div class="actions">
        <button type="submit">✅ Close selected as released</button>
        <span class="hint">Rows with ⚠️ are unchecked by default. Untick to skip.</span>
      </div>
    </form>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Release ${escapeHtml(data.tag)} — ${escapeHtml(data.repo)}</title>${PWA_HEAD_TAGS}
  <style>${STYLES}</style>
</head>
<body>
  <header>
    ${renderTabs("releases")}
    <h1>🏷️ Release confirmation</h1>
    <div class="summary">${summary}</div>
  </header>
  ${flash}
  ${empty}
  ${formInner}
  ${closedDetails}
  ${PWA_REGISTER_SCRIPT}
</body>
</html>`;
}

// Render an already-closed row for the audit <details> strip. No checkbox
// (nothing to act on), no warning icon (the "already closed" warn is implied
// by the section header). Same column layout as renderRow minus col-check.
function renderClosedRow(r: IssueRow): string {
  const labelChips = r.labels.length > 0
    ? `<div class="labels">${r.labels
        .map((l) => `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "";
  const assignees = r.assignees.length > 0
    ? r.assignees.map((a) => `@${escapeHtml(a)}`).join(", ")
    : "—";
  const stateChip =
    `<span class="state state-${escapeHtml(r.state)}">${escapeHtml(r.state)}</span>`;
  return `<tr>
    <td class="num"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">#${r.number}</a></td>
    <td class="title"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></td>
    <td>${stateChip}</td>
    <td>${labelChips || "—"}</td>
    <td class="assignees">${assignees}</td>
  </tr>`;
}

function renderRow(r: IssueRow): string {
  const hasWarn = r.warnings.length > 0;
  const checked = hasWarn ? "" : " checked";
  const warnIcon = hasWarn
    ? `<span class="warn" title="${escapeHtml(r.warnings.join(", "))}">⚠️</span>`
    : "";
  const labelChips = r.labels.length > 0
    ? `<div class="labels">${r.labels
        .map((l) => `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "";
  const assignees = r.assignees.length > 0
    ? r.assignees.map((a) => `@${escapeHtml(a)}`).join(", ")
    : "—";
  const stateChip =
    `<span class="state state-${escapeHtml(r.state)}">${escapeHtml(r.state)}</span>`;

  return `<tr>
    <td class="col-check"><input type="checkbox" name="issue" value="${r.number}"${checked}></td>
    <td class="num"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">#${r.number}</a></td>
    <td class="title">${warnIcon}<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></td>
    <td>${stateChip}</td>
    <td>${labelChips || "—"}</td>
    <td class="assignees">${assignees}</td>
  </tr>`;
}

function renderFlash(
  closed: number[],
  failed: number[],
  failedReasons: Map<number, string>,
  repo: string | null,
): string {
  if (closed.length === 0 && failed.length === 0) return "";
  // When the redirect carried a repo (single-tag detail close, batch close),
  // each issue number links to GitHub; otherwise we render bare `#N` text.
  const issueLink = (n: number): string => repo
    ? `<a href="https://github.com/${escapeHtml(repo)}/issues/${n}" target="_blank" rel="noopener">#${n}</a>`
    : `#${n}`;
  const closedList = closed.length > 0
    ? `<div class="flash ok">✅ Closed: ${closed.map(issueLink).join(" ")}</div>`
    : "";
  // failed_reasons が同伴している場合は per-issue で「#N: 理由」を 1 行ずつ
  // 表示する。理由不明 (= 古い URL や旧 deploy の handler 由来) は従来通り
  // 「try again」フォールバックを並べる。reason 文字列は formatCloseFailureReason
  // で短縮済だが、念のため escapeHtml を通す (XSS 防御)。
  // Refs ippoan/ci-dashboard#152。
  let failedList = "";
  if (failed.length > 0) {
    if (failedReasons.size > 0) {
      const items = failed.map((n) => {
        const reason = failedReasons.get(n);
        return reason
          ? `<li>${issueLink(n)}: ${escapeHtml(reason)}</li>`
          : `<li>${issueLink(n)}: (try again)</li>`;
      }).join("");
      failedList = `<div class="flash err">❌ Failed to close:<ul style="margin:0.25rem 0 0 1.25rem;padding:0">${items}</ul></div>`;
    } else {
      failedList = `<div class="flash err">❌ Failed to close: ${failed.map(issueLink).join(" ")} (try again)</div>`;
    }
  }
  return closedList + failedList;
}

function renderIndex(
  views: RepoView[],
  closedFlash: number[],
  failedFlash: number[],
  failedReasons: Map<number, string>,
  flashRepo: string | null,
): string {
  // Show every watched repo as a card — including ones with no referenced
  // issues yet or whose refs are all closed. The operator asked for the full
  // roster always-on (Refs #224); empty/closed repos render as a passive card
  // with a "no referenced issues" note (see renderIndexRepo) instead of being
  // dropped as noise. The bottom empty-state copy only kicks in when nothing
  // is watched at all (views is empty), so a fresh env still reads cleanly.
  const body = views.length === 0
    ? `<div class="empty">🤷 No releases with referenced issues in the recent window. Look one up below.</div>`
    : views.map(renderIndexRepo).join("\n");

  // Banner sits above the cards so a successful batch close redirect always
  // lands the operator on the list with confirmation of what got closed.
  const flash = renderFlash(closedFlash, failedFlash, failedReasons, flashRepo);

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Releases — CI Dashboard</title>${PWA_HEAD_TAGS}<style>${STYLES}</style>
</head><body>
<header>
  ${renderTabs("releases")}
  <h1>🏷️ Releases</h1>
  <div class="summary">Tick the issues that this release actually closed; one button per repo closes them all.</div>
</header>
${flash}
${body}
<h2 class="lookup-header">Look up another release</h2>
${renderLookupForm(null, null)}
${PWA_REGISTER_SCRIPT}
</body></html>`;
}

function renderIndexRepo(view: RepoView): string {
  // Only tag blocks with at least one OPEN (actionable) issue get the full
  // table+form treatment. Closed-only blocks are pure noise on the landing
  // page — the operator already released them. Refs #226.
  const openBlocks = view.tagBlocks.filter((b) =>
    b.issues.some((i) => i.state !== "closed"),
  );

  // When nothing in the repo is open, collapse the whole card to a single
  // compact line instead of a tall stack of expandable "N closed issues"
  // <details>. The repo stays on the roster (#224) but reads as one row:
  // either a deduped closed-issue count ("released") or a no-refs note.
  // No <form> / table / older-tags strip — the point is one line. Refs #226.
  if (openBlocks.length === 0) {
    const closed = new Set<number>();
    for (const b of view.tagBlocks) {
      for (const i of b.issues) if (i.state === "closed") closed.add(i.number);
    }
    const summary = closed.size > 0
      ? `<span class="closed-summary">✅ ${closed.size} closed issue${closed.size === 1 ? "" : "s"} (released)</span>`
      : `<span class="no-refs">No referenced issues in the recent release window.</span>`;
    return `<section class="repo-card repo-card-compact">
      <a class="repo-link" href="https://github.com/${escapeHtml(view.repo)}/releases" target="_blank" rel="noopener">${escapeHtml(view.repo)}</a>
      ${summary}
    </section>`;
  }

  const tagSections = openBlocks
    .map((b) => renderTagBlock(view.repo, b))
    .join("\n");

  const olderHtml = view.olderTags.length === 0
    ? ""
    : `<div class="older-tags">older: ${view.olderTags
        .map((t) =>
          `<a href="/releases?repo=${encodeURIComponent(view.repo)}&tag=${encodeURIComponent(t)}">${escapeHtml(t)}</a>`,
        )
        .join(" · ")}</div>`;

  // Every kept block has ≥1 open issue, so the close button always has
  // something to act on here.
  const actions = `<div class="actions">
        <button type="submit">✅ Close selected as released</button>
        <span class="hint">⚠️ rows start unchecked.</span>
      </div>`;

  // Whole repo card is one form so the operator can tick across tags and
  // close them in one shot; the POST handler groups by tag for comment
  // attribution.
  return `<section class="repo-card">
    <h2><a href="https://github.com/${escapeHtml(view.repo)}/releases" target="_blank" rel="noopener">${escapeHtml(view.repo)}</a></h2>
    <form method="POST" action="/api/release-close-batch" class="batch-close-form">
      <input type="hidden" name="repo" value="${escapeHtml(view.repo)}">
      ${tagSections}
      ${actions}
    </form>
    ${olderHtml}
  </section>`;
}

function renderTagBlock(repo: string, block: TagBlock): string {
  // Split by state: already-closed issues are noise in the at-a-glance view,
  // so they collapse into a native <details> below the active rows. The form
  // wrapping the whole repo card still picks up checkboxes inside <details>
  // when the operator expands it.
  //
  // Synthetic (direct-push) blocks have already filtered to open-only when
  // they were built (#57), so `hidden` ends up empty there and the <details>
  // collapses out naturally.
  const visible = block.issues.filter((i) => i.state !== "closed");
  const hidden = block.issues.filter((i) => i.state === "closed");

  const since = block.prevTag
    ? `<span class="since">since <code>${escapeHtml(block.prevTag)}</code></span>`
    : "";

  // Direct-push blocks have no compare range, so the detail page (`?tag=X`)
  // would 404. Show a passive "direct push" marker instead so the operator
  // knows why the link is missing.
  const detailOrMarker = block.synthetic
    ? `<span class="direct-marker" title="direct-push branch — no tag range">direct push</span>`
    : `<a class="detail-link"
         href="/releases?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(block.tag)}">
        → detail
      </a>`;

  const visibleTable = visible.length === 0 ? "" : `
    <table>
      <thead><tr>
        <th class="col-check"></th>
        <th>#</th>
        <th>Title</th>
        <th>State</th>
        <th>Labels</th>
      </tr></thead>
      <tbody>${visible.map((i) => renderIndexRow(block.tag, i)).join("\n")}</tbody>
    </table>`;

  const hiddenDetails = hidden.length === 0 ? "" : `
    <details class="closed-details">
      <summary>${hidden.length} closed issue${hidden.length === 1 ? "" : "s"}</summary>
      <table>
        <tbody>${hidden.map((i) => renderIndexRow(block.tag, i)).join("\n")}</tbody>
      </table>
    </details>`;

  return `<div class="tag-block">
    <div class="tag-block-header">
      <strong>${escapeHtml(block.tag)}</strong>
      ${since}
      ${detailOrMarker}
    </div>
    ${visibleTable}
    ${hiddenDetails}
  </div>`;
}

function renderIndexRow(tag: string, r: IssueRow): string {
  const hasWarn = r.warnings.length > 0;
  const checked = hasWarn ? "" : " checked";
  const pair = `${tag}:${r.number}`;
  const warnIcon = hasWarn
    ? `<span class="warn" title="${escapeHtml(r.warnings.join(", "))}">⚠️</span>`
    : "";
  const labelChips = r.labels.length > 0
    ? `<div class="labels">${r.labels
        .map((l) => `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "—";
  const stateChip =
    `<span class="state state-${escapeHtml(r.state)}">${escapeHtml(r.state)}</span>`;

  return `<tr>
    <td class="col-check"><input type="checkbox" name="pair" value="${escapeHtml(pair)}"${checked}></td>
    <td class="num"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">#${r.number}</a></td>
    <td class="title">${warnIcon}<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></td>
    <td>${stateChip}</td>
    <td>${labelChips}</td>
  </tr>`;
}

// Bare `<form>` extracted so both the index landing page and the
// one-param-given page share the same input layout.
function renderLookupForm(repo: string | null, tag: string | null): string {
  return `<form method="GET" action="/releases" class="lookup">
  <label>repo (<code>owner/name</code>)
    <input name="repo" required placeholder="ippoan/ci-dashboard"
      value="${escapeHtml(repo ?? "")}">
  </label>
  <label>tag
    <input name="tag" required placeholder="v1.2.3"
      value="${escapeHtml(tag ?? "")}">
  </label>
  <button type="submit">Look up</button>
</form>`;
}

function renderError(msg: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Release confirmation — Error</title>
<style>${STYLES}</style></head><body>
<header>${renderTabs("releases")}
<h1>🏷️ Release confirmation</h1></header>
<div class="flash err">${escapeHtml(msg)}</div>
</body></html>`;
}

// Style block kept inline so the page is self-contained, mirroring
// issues-page.ts. Mobile is the operations target (CLAUDE.md notes the
// Android-first context) so we keep widths fluid and avoid fixed pixel cols.
const STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117; color: #c9d1d9; padding: 24px;
    max-width: 1200px; margin: 0 auto;
  }
  header { margin-bottom: 16px; }
  ${TAB_STYLES}
  h1 { font-size: 20px; color: #58a6ff; }
  .summary { font-size: 13px; color: #8b949e; margin-top: 4px; }
  .summary code { background: #161b22; padding: 1px 6px; border-radius: 4px; color: #d2a8ff; }
  .lookup {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: end;
    background: #161b22; border: 1px solid #30363d;
    padding: 16px; border-radius: 8px; margin-top: 12px;
  }
  .lookup label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #8b949e; }
  .lookup input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d;
    border-radius: 6px; padding: 6px 10px; font-size: 14px; min-width: 220px; }
  button { background: #238636; color: white; border: 0; border-radius: 6px;
    padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
  button:hover { background: #2ea043; }
  .close-form { background: #161b22; border: 1px solid #30363d;
    border-radius: 8px; overflow: hidden; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  tbody tr { border-top: 1px solid #21262d; }
  tbody tr:hover { background: #1c2129; }
  th, td { padding: 8px 12px; text-align: left; vertical-align: top; }
  th { font-size: 11px; font-weight: 600; text-transform: uppercase;
       letter-spacing: 0.5px; color: #8b949e; background: #0d1117; }
  td.col-check, th.col-check { width: 36px; }
  td.num { width: 60px; color: #8b949e; font-variant-numeric: tabular-nums; }
  td.num a { color: #58a6ff; text-decoration: none; }
  td.title a { color: #c9d1d9; text-decoration: none; font-weight: 500; }
  td.title a:hover { color: #58a6ff; text-decoration: underline; }
  td.assignees { color: #8b949e; }
  .warn { margin-right: 4px; }
  .labels .label { display: inline-block; font-size: 11px; padding: 1px 6px;
    border-radius: 10px; background: #1f6feb22; color: #79c0ff;
    margin-right: 4px; margin-bottom: 2px; }
  .state { display: inline-block; font-size: 11px; padding: 1px 8px;
    border-radius: 10px; font-weight: 600; }
  .state-open { background: #238636; color: white; }
  .state-closed { background: #8957e5; color: white; }
  .actions { padding: 12px 14px; border-top: 1px solid #21262d;
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .actions .hint { color: #8b949e; font-size: 12px; }
  .empty { padding: 32px; text-align: center; color: #8b949e; font-size: 14px; }
  .flash { padding: 10px 14px; border-radius: 6px; font-size: 13px;
    margin-bottom: 12px; }
  .flash.ok  { background: #1f3d28; border: 1px solid #238636; color: #a3e3b0; }
  .flash.err { background: #341a1f; border: 1px solid #f85149; color: #ffa198; }
  .flash a { color: inherit; text-decoration: underline; }

  /* Recent releases landing page — repo card with stacked tag blocks */
  .repo-card {
    background: #161b22; border: 1px solid #30363d;
    border-radius: 8px; padding: 16px; margin-bottom: 16px;
  }
  .repo-card > h2 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
  .repo-card > h2 a { color: #c9d1d9; text-decoration: none; }
  .repo-card > h2 a:hover { color: #58a6ff; }
  .batch-close-form { display: block; }
  .no-refs {
    font-size: 12px; color: #8b949e;
    padding: 4px 0 2px 0;
  }
  /* Closed-only / no-ref repos collapse to a single compact row (#226). */
  .repo-card-compact {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
    padding: 10px 16px;
  }
  .repo-card-compact .repo-link {
    font-size: 14px; font-weight: 600; color: #c9d1d9; text-decoration: none;
  }
  .repo-card-compact .repo-link:hover { color: #58a6ff; }
  .repo-card-compact .closed-summary { font-size: 12px; color: #8b949e; }
  .tag-block { margin-bottom: 14px; }
  .tag-block-header {
    display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;
    font-size: 13px; margin-bottom: 4px; color: #c9d1d9;
  }
  .tag-block-header strong {
    color: #d2a8ff; font-variant-numeric: tabular-nums; font-weight: 600;
  }
  .tag-block-header .since { color: #8b949e; font-size: 12px; }
  .tag-block-header .since code { background: #0d1117; padding: 1px 4px;
    border-radius: 4px; color: #d2a8ff; }
  .tag-block-header .detail-link {
    margin-left: auto; color: #58a6ff; text-decoration: none; font-size: 12px;
  }
  .tag-block-header .detail-link:hover { text-decoration: underline; }
  .tag-block-header .direct-marker {
    margin-left: auto; font-size: 11px; color: #8b949e;
    background: #21262d; border: 1px solid #30363d;
    padding: 1px 8px; border-radius: 10px;
  }
  .tag-block table {
    background: #0d1117; border: 1px solid #30363d;
    border-radius: 6px; overflow: hidden;
  }
  .older-tags {
    margin-top: 8px; font-size: 12px; color: #8b949e;
    border-top: 1px dashed #30363d; padding-top: 8px;
  }
  .older-tags a {
    color: #58a6ff; text-decoration: none;
    padding: 1px 6px; border-radius: 4px;
    font-variant-numeric: tabular-nums;
  }
  .older-tags a:hover { background: #1f6feb22; }
  details.closed-details {
    margin-top: 8px;
    background: #0d1117;
    border: 1px dashed #30363d;
    border-radius: 6px;
  }
  details.closed-details > summary {
    padding: 6px 12px;
    font-size: 12px; color: #8b949e;
    cursor: pointer; user-select: none;
    list-style: none;
  }
  details.closed-details > summary::before {
    content: "▶";
    display: inline-block;
    margin-right: 6px;
    transition: transform 0.1s;
    font-size: 10px;
  }
  details.closed-details[open] > summary::before { transform: rotate(90deg); }
  details.closed-details > summary:hover { color: #c9d1d9; }
  details.closed-details[open] > summary {
    color: #c9d1d9; border-bottom: 1px solid #30363d;
  }
  details.closed-details table { background: transparent; border: 0; }
  .lookup-header {
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.5px; color: #8b949e;
    margin: 24px 0 8px 0;
  }
`;

// Minimal HTML escape, exported for tests.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
