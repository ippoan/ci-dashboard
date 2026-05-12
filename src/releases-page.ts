import { githubApi, parseRepo, validateOrg, GitHubApiError } from "./github-api";
import {
  extractRefIssues,
  extractPrNumber,
  extractBranchIssue,
  sortSemverDesc,
  previousTag,
  computeWarnings,
} from "./release-helpers";
import { renderTabs, TAB_STYLES } from "./nav-tabs";

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
  env: { GITHUB_TOKEN: string; CI_HUB: DurableObjectNamespace },
): Promise<Response> {
  const url = new URL(req.url);
  const repoParam = url.searchParams.get("repo");
  const tag = url.searchParams.get("tag");

  // Flash params populated by POST /api/release-close{,-batch} redirects.
  const closedFlash = numericList(url.searchParams.get("closed"));
  const failedFlash = numericList(url.searchParams.get("failed"));

  // Only the fully-specified pair opens the detail page; every other shape
  // (no params / partial / post-close redirect) falls through to the index so
  // the operator never lands on an empty form by accident (issue #45).
  if (repoParam && tag) {
    let result: ReleasePayload;
    try {
      result = await loadRelease(env.GITHUB_TOKEN, repoParam, tag);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        return html(renderError(`Not found: ${err.message}`), 404);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return html(renderError(msg), 502);
    }
    return html(renderHtml(result, closedFlash, failedFlash), 200);
  }

  // Index page; `repoParam` (when set without tag, e.g. from the batch-close
  // redirect) tags along so flash links can point at the right GitHub repo.
  return await handleIndexPage(env, closedFlash, failedFlash, repoParam);
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
}

// Top tags shown inline per repo (each fans out compare + per-issue fetches).
// Older tags collapse to a link strip pointing at the detail page.
const TOP_TAGS_INLINE = 5;

async function handleIndexPage(
  env: { GITHUB_TOKEN: string; CI_HUB: DurableObjectNamespace },
  closedFlash: number[],
  failedFlash: number[],
  flashRepo: string | null,
): Promise<Response> {
  // 1. Watched repos come from the Hub's status cache — every repo that has
  //    ever fired a CI run lives there, which is the same source the
  //    dashboard sidebar uses.
  let repos: string[] = [];
  try {
    const hubId = env.CI_HUB.idFromName("singleton");
    const hub = env.CI_HUB.get(hubId);
    const res = await hub.fetch(new Request("http://hub/statuses"));
    if (res.ok) {
      const statuses = await res.json<Array<{ repo: string }>>();
      repos = [...new Set(statuses.map((s) => s.repo))].sort();
    }
  } catch { /* empty list → page falls back to lookup form only */ }

  // 2. Per-repo data load in parallel; whole-repo failures get a null view
  //    we drop in the renderer.
  const views = await Promise.all(repos.map(async (repo) => {
    try {
      return await loadRepoView(env.GITHUB_TOKEN, repo);
    } catch {
      return null;
    }
  }));

  return html(
    renderIndex(
      views.filter((v): v is RepoView => v !== null),
      closedFlash,
      failedFlash,
      flashRepo,
    ),
    200,
  );
}

async function loadRepoView(token: string, repo: string): Promise<RepoView | null> {
  const { owner, repo: name } = parseRepo(repo);
  validateOrg(owner);

  // 1. Recent semver tags. 10 gives us 5 inline + room for the predecessor
  //    pairing on the oldest of those 5 + a small "older" strip.
  const allTags = await githubApi<TagListItem[]>(
    token, "GET", `/repos/${owner}/${name}/tags`, undefined,
    { per_page: "10" },
  );
  const sorted = sortSemverDesc(allTags.map((t) => t.name));
  const topTags = sorted.slice(0, TOP_TAGS_INLINE);
  if (topTags.length === 0) {
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
      const cmp = await githubApi<CompareResponse>(
        token, "GET", `/repos/${owner}/${name}/compare/${prevTag}...${tag}`,
      );
      const refs = new Set<number>();
      for (const c of cmp.commits) {
        for (const n of extractRefIssues(c.commit.message)) refs.add(n);
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
      const issue = await githubApi<RawIssue>(
        token, "GET", `/repos/${owner}/${name}/issues/${n}`,
      );
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

  return {
    repo: `${owner}/${name}`,
    tagBlocks,
    olderTags: sorted.slice(TOP_TAGS_INLINE),
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
  token: string,
  repoParam: string,
  tag: string,
): Promise<ReleasePayload> {
  const { owner, repo: name } = parseRepo(repoParam);
  validateOrg(owner);

  // 1. Pull recent tags so we can pick the immediate predecessor for the
  //    compare endpoint. 30 is plenty given typical release cadence; for
  //    older tags the operator can pass the URL anyway and we fall back to a
  //    bounded commit list below.
  const tags = await githubApi<TagListItem[]>(
    token, "GET", `/repos/${owner}/${name}/tags`, undefined,
    { per_page: "30" },
  );
  const tagNames = tags.map((t) => t.name);
  if (!tagNames.includes(tag)) {
    throw new GitHubApiError(
      404,
      `Tag "${tag}" not present in ${owner}/${name} (recent ${tagNames.length} tags scanned)`,
    );
  }
  const prev = previousTag(sortSemverDesc(tagNames), tag);

  // 2. Get the commits introduced by this tag. With a previous tag we use
  //    GitHub's compare endpoint (it stops at the merge base); without one
  //    (first release ever) we bound to 50 commits walking back from `tag`.
  const commits = prev
    ? (await githubApi<CompareResponse>(
        token, "GET", `/repos/${owner}/${name}/compare/${prev}...${tag}`,
      )).commits
    : await githubApi<RawCommit[]>(
        token, "GET", `/repos/${owner}/${name}/commits`, undefined,
        { sha: tag, per_page: "50" },
      );

  // 3. Harvest issue numbers from commit messages directly, and collect the
  //    PR numbers so we can do a second pass for branch-name + PR-body refs.
  const issueNumbers = new Set<number>();
  const prNumbers = new Set<number>();
  for (const c of commits) {
    const msg = c.commit.message;
    for (const n of extractRefIssues(msg)) issueNumbers.add(n);
    const pr = extractPrNumber(msg);
    if (pr !== null) prNumbers.add(pr);
  }

  // 4. Re-fetch each PR for its head.ref (branch name) and body. We swallow
  //    per-PR failures so a missing/deleted PR doesn't sink the whole page.
  await Promise.all([...prNumbers].map(async (n) => {
    try {
      const pr = await githubApi<PrResponse>(
        token, "GET", `/repos/${owner}/${name}/pulls/${n}`,
      );
      const fromBranch = extractBranchIssue(pr.head.ref);
      if (fromBranch !== null) issueNumbers.add(fromBranch);
      if (pr.body) {
        for (const ref of extractRefIssues(pr.body)) issueNumbers.add(ref);
      }
    } catch { /* ignore per-PR failure */ }
  }));

  // 5. Fetch each candidate issue. The /issues/:n endpoint also returns PRs,
  //    so we filter those out (PRs have a `pull_request` discriminator).
  const issueResults = await Promise.all([...issueNumbers].map(async (n) => {
    try {
      return await githubApi<RawIssue>(
        token, "GET", `/repos/${owner}/${name}/issues/${n}`,
      );
    } catch {
      return null;
    }
  }));

  const rows: IssueRow[] = issueResults
    .filter((i): i is RawIssue => i !== null && !i.pull_request)
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
    commits: commits.length,
    rows,
  };
}

interface TagListItem { name: string; commit: { sha: string } }
interface RawCommit { sha: string; commit: { message: string } }
interface CompareResponse { commits: RawCommit[] }
interface PrResponse { head: { ref: string }; body: string | null }
interface RawIssue {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  html_url: string;
  updated_at: string;
  pull_request?: unknown;
}

function numericList(s: string | null): number[] {
  if (!s) return [];
  return s.split(",").map((p) => Number(p.trim())).filter(Number.isInteger);
}

// --------------------------------------------------------------------------
// HTML
// --------------------------------------------------------------------------

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderHtml(
  data: ReleasePayload,
  closedFlash: number[],
  failedFlash: number[],
): string {
  const candidateRows = data.rows
    .filter((r) => !closedFlash.includes(r.number))
    .map((r) => renderRow(r))
    .join("\n");

  const flash = renderFlash(closedFlash, failedFlash, data.repo);

  const summary =
    `${escapeHtml(data.repo)} · <code>${escapeHtml(data.tag)}</code>` +
    (data.previousTag
      ? ` (since <code>${escapeHtml(data.previousTag)}</code>, ${data.commits} commits)`
      : ` (first release; last ${data.commits} commits scanned)`);

  const empty = data.rows.length === 0
    ? `<div class="empty">🎉 No referenced issues for this release.</div>`
    : "";

  const formInner = data.rows.length === 0 ? "" : `
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
  <title>Release ${escapeHtml(data.tag)} — ${escapeHtml(data.repo)}</title>
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
</body>
</html>`;
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
  const failedList = failed.length > 0
    ? `<div class="flash err">❌ Failed to close: ${failed.map(issueLink).join(" ")} (try again)</div>`
    : "";
  return closedList + failedList;
}

function renderIndex(
  views: RepoView[],
  closedFlash: number[],
  failedFlash: number[],
  flashRepo: string | null,
): string {
  // Show repos with at least one referenced issue in their displayed tag
  // window; repos that haven't had a Refs-bearing release yet would just
  // be a noise card.
  const populated = views.filter((v) =>
    v.tagBlocks.some((b) => b.issues.length > 0),
  );
  const body = populated.length === 0
    ? `<div class="empty">🤷 No releases with referenced issues in the recent window. Look one up below.</div>`
    : populated.map(renderIndexRepo).join("\n");

  // Banner sits above the cards so a successful batch close redirect always
  // lands the operator on the list with confirmation of what got closed.
  const flash = renderFlash(closedFlash, failedFlash, flashRepo);

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Releases — CI Dashboard</title><style>${STYLES}</style>
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
</body></html>`;
}

function renderIndexRepo(view: RepoView): string {
  const tagSections = view.tagBlocks
    .filter((b) => b.issues.length > 0)
    .map((b) => renderTagBlock(view.repo, b))
    .join("\n");

  const olderHtml = view.olderTags.length === 0
    ? ""
    : `<div class="older-tags">older: ${view.olderTags
        .map((t) =>
          `<a href="/releases?repo=${encodeURIComponent(view.repo)}&tag=${encodeURIComponent(t)}">${escapeHtml(t)}</a>`,
        )
        .join(" · ")}</div>`;

  // Whole repo card is one form so the operator can tick across tags and
  // close them in one shot; the POST handler groups by tag for comment
  // attribution.
  return `<section class="repo-card">
    <h2><a href="https://github.com/${escapeHtml(view.repo)}/releases" target="_blank" rel="noopener">${escapeHtml(view.repo)}</a></h2>
    <form method="POST" action="/api/release-close-batch" class="batch-close-form">
      <input type="hidden" name="repo" value="${escapeHtml(view.repo)}">
      ${tagSections}
      <div class="actions">
        <button type="submit">✅ Close selected as released</button>
        <span class="hint">⚠️ rows start unchecked.</span>
      </div>
    </form>
    ${olderHtml}
  </section>`;
}

function renderTagBlock(repo: string, block: TagBlock): string {
  const rows = block.issues.map((i) => renderIndexRow(block.tag, i)).join("\n");
  const since = block.prevTag
    ? `<span class="since">since <code>${escapeHtml(block.prevTag)}</code></span>`
    : "";
  return `<div class="tag-block">
    <div class="tag-block-header">
      <strong>${escapeHtml(block.tag)}</strong>
      ${since}
      <a class="detail-link"
         href="/releases?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(block.tag)}">
        → detail
      </a>
    </div>
    <table>
      <thead><tr>
        <th class="col-check"></th>
        <th>#</th>
        <th>Title</th>
        <th>State</th>
        <th>Labels</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
