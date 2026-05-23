import { fetchOrgIssues, type OrgIssue } from "./mcp/tools/issues";
import { fetchProjectIssueMap, type ProjectRef } from "./mcp/tools/projects";
import { fetchAllOpenPrsByIssue, type IssuePrRef } from "./issue-prs";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";

// Orgs fetched in full. Same allowlist as github-api.ts (not imported because
// ALLOWED_ORGS isn't exported; keep the two in sync if either grows).
const ORGS = ["ippoan", "ohishi-exp"];

// yhonda-ohishi org has many old personal repos (2023-2024 lineworks_bot /
// nginx / authjs-nuxt-test etc.) that would create noise. Only surface the
// active claude-tooling repos by filtering on `repo:` qualifiers.
const YHONDA_REPOS = ["yhonda-ohishi/claude-skills", "yhonda-ohishi/claude-hooks"];

// Orgs scanned for Projects v2 (used by `fetchProjectIssueMap`). yhonda-ohishi
// is included so the user's claude-tooling repos can still be pinned to a
// board, even though only a subset of their repos surface as issues here.
const PROJECT_ORGS = ["ippoan", "ohishi-exp", "yhonda-ohishi"];

// Repos pre-attached when launching a Claude Code on Web session from an
// issue row's 🚀 button. Mirrors the GitHub MCP scope a typical web session
// runs with (cross-repo tasks routinely need consumers / shared hooks beyond
// the issue's own repo — see open-multirepo skill "Default repo set").
// Update in sync with the session install template if the scope changes.
export const CLAUDE_CODE_LAUNCH_REPOS = [
  "ippoan/auth-worker",
  "ippoan/mcp-relay-rs",
  "ippoan/ref-files-worker",
  "ippoan/cc-relay",
  "ippoan/ci-workflows",
  "ippoan/claude-md",
  "ippoan/ci-dashboard",
  "ippoan/secrets-inventory",
  "ippoan/secrets-inventory-gcp",
  "yhonda-ohishi/claude-skills",
  "yhonda-ohishi/claude-hooks",
];

// Build a claude.ai/code launch URL pre-attached with the standard repo set
// and a minimal `<owner>/<repo>#<N> を read して処理` prompt. Spec lives in
// the issue body — the prompt only carries the ref (open-multirepo "prompt
// body MUST stay minimal" rule).
export function buildClaudeCodeLaunchUrl(repo: string, issueNumber: number): string {
  const prompt = `${repo}#${issueNumber} を read して処理`;
  // encodeURIComponent leaves `!*'()` per RFC3986. They're harmless inside
  // an HTML href attribute, but encoding them keeps the URL safe if it's
  // ever copy-pasted into Markdown (where `)` would terminate a link).
  const encoded = encodeURIComponent(prompt)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  // claude.ai/code accepts raw `,` between repos — do NOT URL-encode commas.
  return `https://claude.ai/code?repositories=${CLAUDE_CODE_LAUNCH_REPOS.join(",")}&prompt=${encoded}`;
}

// KV cache for the cross-org Project v2 → issue map. GraphQL fan-out is
// expensive (one call per open project × per org) and its 5000 points/h budget
// is easy to exhaust when the dashboard's MCP tools share the same token. A
// short fresh window (5 min) is plenty for the issues page — Project boards
// don't churn second-by-second — and a long store window (24 h) keeps a stale
// copy around so a temporary rate-limit hit doesn't blank the page.
const PROJECT_MAP_CACHE_KEY = "issues-page:project-map";
const PROJECT_MAP_FRESH_SECONDS = 300;
const PROJECT_MAP_STORE_SECONDS = 86400;

interface ProjectMapCacheEntry {
  storedAt: number;
  data: Record<string, ProjectRef[]>;
}

interface ProjectMapResult {
  map: Map<string, ProjectRef[]>;
  stale: boolean;
  error: string | null;
}

async function loadProjectMap(
  env: AuthClientWorkerEnv,
  orgs: string[],
): Promise<ProjectMapResult> {
  const kv = env.CI_STATUS;
  const cached = await kv.get(PROJECT_MAP_CACHE_KEY, "json") as ProjectMapCacheEntry | null;
  const now = Date.now();
  if (cached && now - cached.storedAt < PROJECT_MAP_FRESH_SECONDS * 1000) {
    return { map: new Map(Object.entries(cached.data)), stale: false, error: null };
  }
  try {
    const fresh = await fetchProjectIssueMap(env, { orgs });
    const entry: ProjectMapCacheEntry = { storedAt: now, data: Object.fromEntries(fresh) };
    await kv.put(PROJECT_MAP_CACHE_KEY, JSON.stringify(entry), {
      expirationTtl: PROJECT_MAP_STORE_SECONDS,
    });
    return { map: fresh, stale: false, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached) {
      return { map: new Map(Object.entries(cached.data)), stale: true, error: message };
    }
    return { map: new Map(), stale: false, error: message };
  }
}

// PR map cache mirrors the project-map cache pattern. The freshness window is
// shorter (2 min) because PR state churns faster than Project board edits — a
// new PR opened minutes ago should appear without forcing a manual reload —
// but the 24 h store window keeps a stale copy as fallback when GitHub search
// rate-limits the worker.
// v2 suffix invalidates the open-only payload from before merged PRs were
// included (the shape changed — `IssuePrRef.state` is now required).
const PR_MAP_CACHE_KEY = "issues-page:pr-map:v2";
const PR_MAP_FRESH_SECONDS = 120;
const PR_MAP_STORE_SECONDS = 86400;

interface PrMapCacheEntry {
  storedAt: number;
  data: Record<string, IssuePrRef[]>;
}

interface PrMapResult {
  map: Map<string, IssuePrRef[]>;
  stale: boolean;
  error: string | null;
}

async function loadPrMap(
  env: AuthClientWorkerEnv,
  mainOrgs: string[],
  yhondaRepos: string[],
): Promise<PrMapResult> {
  const kv = env.CI_STATUS;
  const cached = await kv.get(PR_MAP_CACHE_KEY, "json") as PrMapCacheEntry | null;
  const now = Date.now();
  if (cached && now - cached.storedAt < PR_MAP_FRESH_SECONDS * 1000) {
    return { map: new Map(Object.entries(cached.data)), stale: false, error: null };
  }
  try {
    const fresh = await fetchAllOpenPrsByIssue(env, mainOrgs, yhondaRepos);
    const entry: PrMapCacheEntry = { storedAt: now, data: Object.fromEntries(fresh) };
    await kv.put(PR_MAP_CACHE_KEY, JSON.stringify(entry), {
      expirationTtl: PR_MAP_STORE_SECONDS,
    });
    return { map: fresh, stale: false, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached) {
      return { map: new Map(Object.entries(cached.data)), stale: true, error: message };
    }
    return { map: new Map(), stale: false, error: message };
  }
}

// `@ippoan/auth-client-worker` SDK が auth-worker delegation 中に投げる error
// は `Error.message` に常に診断文字列を入れる (introspect.ts / tokens.ts /
// dcr.ts 参照)。message に以下のどれかが含まれたら「再ログインで解決可能」と
// 判定して `/oauth/login` にリダイレクトする (= ユーザーは 502 ページではなく
// GitHub 同意画面に飛ぶ)。それ以外 (GitHub rate limit など) は従来通り 502 を
// 表示する。
function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /No (DCR client registered|OAuth tokens stored)/.test(msg) ||
    /auth-worker \/mcp\/(introspect|token).*failed \((401|403)/.test(msg) ||
    /JWT inactive/.test(msg)
  );
}

export async function handleIssuesPage(env: AuthClientWorkerEnv): Promise<Response> {
  // Search REST gives us the issues themselves; this is the only fetch that
  // can fail the page outright. Project map is loaded separately below so a
  // GraphQL rate-limit doesn't blank the page (Refs #94 follow-up).
  let merged;
  try {
    const [main, yhonda] = await Promise.all([
      fetchOrgIssues(env, {
        orgs: ORGS,
        state: "open",
        per_page: 100,
      }),
      fetchOrgIssues(env, {
        orgs: ["yhonda-ohishi"],
        state: "open",
        per_page: 100,
        query: YHONDA_REPOS.map((r) => `repo:${r}`).join(" "),
      }),
    ]);
    merged = {
      total_count: main.total_count + yhonda.total_count,
      incomplete: main.incomplete || yhonda.incomplete,
      items: [...main.items, ...yhonda.items],
    };
  } catch (err) {
    if (isAuthError(err)) {
      // 認証失効: GitHub 同意画面 → /oauth/callback → return_to で /issues に戻る
      return new Response(null, {
        status: 302,
        headers: { Location: "/oauth/login?return_to=/issues" },
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(renderError(msg), {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const [project, prs] = await Promise.all([
    loadProjectMap(env, PROJECT_ORGS),
    loadPrMap(env, ORGS, YHONDA_REPOS),
  ]);
  const projectMap = project.map;
  const prMap = prs.map;

  // Split issues into "Project-tagged" (top aggregate section) and
  // "ungrouped per-repo" (bottom sections). An issue belongs to the project
  // section iff `projectMap` has at least one ProjectRef for `repo#number`.
  const projectTagged: Array<{ issue: OrgIssue; projects: ProjectRef[] }> = [];
  const ungrouped: OrgIssue[] = [];
  for (const item of merged.items) {
    const key = `${item.repo}#${item.number}`;
    const refs = projectMap.get(key);
    if (refs && refs.length > 0) projectTagged.push({ issue: item, projects: refs });
    else ungrouped.push(item);
  }
  // Top section is one flat list ordered by recency across repos.
  projectTagged.sort((a, b) => b.issue.updated_at.localeCompare(a.issue.updated_at));

  // Per-repo grouping (existing behavior) for the ungrouped half.
  const grouped = new Map<string, OrgIssue[]>();
  for (const item of ungrouped) {
    if (!grouped.has(item.repo)) grouped.set(item.repo, []);
    grouped.get(item.repo)!.push(item);
  }
  const repos = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, items]) => [
      repo,
      [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    ] as const);

  return new Response(
    renderHtml(merged.total_count, merged.incomplete, projectTagged, repos, project, prs),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function renderHtml(
  total: number,
  incomplete: boolean,
  projectTagged: ReadonlyArray<{ issue: OrgIssue; projects: ProjectRef[] }>,
  repos: ReadonlyArray<readonly [string, OrgIssue[]]>,
  project: ProjectMapResult,
  prs: PrMapResult,
): string {
  const repoSections = repos
    .map(([repo, items]) => renderRepoSection(repo, items, prs.map))
    .join("\n");

  const projectSection = projectTagged.length > 0
    ? renderProjectSection(projectTagged, prs.map)
    : "";

  const incompleteBanner = incomplete
    ? `<div class="banner">⚠️ Result was truncated by GitHub search. Showing ${total} issues but more may exist.</div>`
    : "";
  const projectBanner = project.stale
    ? `<div class="banner banner-info">📋 Project tags shown are from the last successful sync — fresh fetch failed (${escapeHtml(project.error ?? "")})</div>`
    : project.error
    ? `<div class="banner">⚠️ Project tags unavailable: ${escapeHtml(project.error)}</div>`
    : "";
  const prBanner = prs.stale
    ? `<div class="banner banner-info">🔗 Related-PR links shown are from the last successful sync — fresh fetch failed (${escapeHtml(prs.error ?? "")})</div>`
    : prs.error
    ? `<div class="banner">⚠️ Related-PR links unavailable: ${escapeHtml(prs.error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Open Issues — CI Dashboard</title>${PWA_HEAD_TAGS}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      padding: 24px;
      max-width: 1200px;
      margin: 0 auto;
    }
    header { margin-bottom: 24px; }
    ${TAB_STYLES}
    h1 { font-size: 20px; color: #58a6ff; }
    .summary { font-size: 13px; color: #8b949e; margin-top: 4px; }
    .banner {
      background: #341a1f;
      border: 1px solid #f85149;
      color: #ffa198;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .banner-info {
      background: #1c2433;
      border-color: #1f6feb88;
      color: #a5d6ff;
    }
    section.repo, section.projects {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    section.repo h2, section.projects h2 {
      font-size: 14px;
      font-weight: 600;
      padding: 10px 14px;
      background: #1f2630;
      border-bottom: 1px solid #30363d;
    }
    section.projects h2 {
      /* Distinguish the aggregate section from per-repo blocks below */
      background: #1c2433;
      border-bottom-color: #1f6feb55;
    }
    section.repo h2 .count, section.projects h2 .count {
      color: #8b949e;
      font-weight: 400;
      margin-left: 6px;
    }
    section.repo h2 a { color: #c9d1d9; text-decoration: none; }
    section.repo h2 a:hover { color: #58a6ff; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    tbody tr { border-top: 1px solid #21262d; }
    tbody tr:hover { background: #1c2129; }
    th, td {
      padding: 8px 14px;
      text-align: left;
      vertical-align: top;
    }
    th {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #8b949e;
      background: #0d1117;
    }
    td.num { width: 60px; color: #8b949e; font-variant-numeric: tabular-nums; }
    td.num a { color: #58a6ff; text-decoration: none; }
    td.num a:hover { text-decoration: underline; }
    td.repo {
      width: 200px;
      color: #8b949e;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap;
    }
    td.repo a { color: #8b949e; text-decoration: none; }
    td.repo a:hover { color: #58a6ff; }
    td.title a { color: #c9d1d9; text-decoration: none; font-weight: 500; }
    td.title a:hover { color: #58a6ff; text-decoration: underline; }
    td.author { width: 130px; color: #8b949e; }
    td.updated {
      width: 110px;
      color: #8b949e;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    td.launch { width: 44px; text-align: center; }
    .cc-launch {
      display: inline-block;
      text-decoration: none;
      font-size: 15px;
      line-height: 1;
      padding: 4px 6px;
      border-radius: 6px;
      opacity: 0.55;
      transition: opacity 0.15s, background 0.15s;
    }
    .cc-launch:hover { opacity: 1; background: #1f6feb33; }
    .labels { margin-top: 4px; }
    .label {
      display: inline-block;
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 10px;
      background: #1f6feb22;
      color: #79c0ff;
      margin-right: 4px;
      margin-bottom: 2px;
    }
    /* Project chips: brighter than label chips so the board affiliation pops */
    .project-chip {
      display: inline-block;
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 10px;
      background: #1f6feb44;
      color: #a5d6ff;
      border: 1px solid #1f6feb88;
      margin-right: 4px;
      margin-bottom: 2px;
      text-decoration: none;
    }
    .project-chip:hover { background: #1f6feb66; }
    /* Related-PR chips: green palette so they read as "in-flight work" vs.
       the blue project-chip's "belongs to a board" affordance. Draft PRs
       desaturate to gray so the reader can tell at a glance whether the PR
       is review-ready. */
    .pr-chips { margin-top: 4px; }
    .pr-chip {
      display: inline-block;
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 10px;
      background: #2ea04322;
      color: #7ee787;
      border: 1px solid #2ea04388;
      margin-right: 4px;
      margin-bottom: 2px;
      text-decoration: none;
      font-variant-numeric: tabular-nums;
    }
    .pr-chip:hover { background: #2ea04344; }
    .pr-chip.draft {
      background: #6e768122;
      color: #8b949e;
      border-color: #6e768188;
    }
    .pr-chip.draft:hover { background: #6e768144; }
    /* Merged PRs: purple — "work done, release-close pending". Distinguishes
       from green open PRs (in-flight) at a glance. */
    .pr-chip.merged {
      background: #8957e522;
      color: #d2a8ff;
      border-color: #8957e588;
    }
    .pr-chip.merged:hover { background: #8957e544; }
    .empty {
      padding: 32px;
      text-align: center;
      color: #8b949e;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <header>
    ${renderTabs("issues")}
    <h1>📋 Open Issues</h1>
    <div class="summary">
      ${escapeHtml(String(total))} issue${total === 1 ? "" : "s"} across
      ${escapeHtml(String(repos.length + (projectTagged.length > 0 ? 1 : 0)))} section${repos.length === 0 && projectTagged.length <= 1 ? "" : "s"}
      (orgs: ${ORGS.map((o) => escapeHtml(o)).join(", ")}
      + ${YHONDA_REPOS.map((r) => escapeHtml(r)).join(", ")})
    </div>
  </header>
  ${incompleteBanner}
  ${projectBanner}
  ${prBanner}
  ${projectSection}
  ${repos.length === 0 && projectTagged.length === 0
    ? `<div class="empty">🎉 No open issues. Nice work.</div>`
    : repoSections}
  ${PWA_REGISTER_SCRIPT}
</body>
</html>`;
}

function renderProjectSection(
  items: ReadonlyArray<{ issue: OrgIssue; projects: ProjectRef[] }>,
  prMap: ReadonlyMap<string, IssuePrRef[]>,
): string {
  const rows = items.map(({ issue, projects }) =>
    renderProjectRow(issue, projects, prMap)).join("\n");
  return `<section class="projects">
  <h2>📋 Project 付き<span class="count">(${items.length})</span></h2>
  <table>
    <thead><tr><th>#</th><th>Repo</th><th>Title</th><th>Author</th><th>Updated</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderProjectRow(
  i: OrgIssue,
  projects: ReadonlyArray<ProjectRef>,
  prMap: ReadonlyMap<string, IssuePrRef[]>,
): string {
  const chips = projects.map((p) =>
    `<a class="project-chip" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>`,
  ).join("");
  const labelChips = i.labels.length > 0
    ? `<div class="labels">${i.labels.map((l) =>
        `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "";
  return `<tr>
    <td class="num"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">#${i.number}</a></td>
    <td class="repo"><a href="https://github.com/${escapeHtml(i.repo)}/issues" target="_blank" rel="noopener">${escapeHtml(i.repo)}</a></td>
    <td class="title"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a><div class="labels">${chips}</div>${labelChips}${renderPrChips(i, prMap)}</td>
    <td class="author">@${escapeHtml(i.author)}</td>
    <td class="updated">${escapeHtml(i.updated_at.slice(0, 10))}</td>
    ${renderLaunchCell(i)}
  </tr>`;
}

function renderRepoSection(
  repo: string,
  items: OrgIssue[],
  prMap: ReadonlyMap<string, IssuePrRef[]>,
): string {
  const rows = items.map((i) => renderRow(i, prMap)).join("\n");
  const repoUrl = `https://github.com/${repo}/issues`;
  return `<section class="repo">
  <h2><a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener">${escapeHtml(repo)}</a><span class="count">(${items.length})</span></h2>
  <table>
    <thead><tr><th>#</th><th>Title</th><th>Author</th><th>Updated</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderRow(
  i: OrgIssue,
  prMap: ReadonlyMap<string, IssuePrRef[]>,
): string {
  const labelChips = i.labels.length > 0
    ? `<div class="labels">${i.labels.map((l) =>
        `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "";
  return `<tr>
    <td class="num"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">#${i.number}</a></td>
    <td class="title"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a>${labelChips}${renderPrChips(i, prMap)}</td>
    <td class="author">@${escapeHtml(i.author)}</td>
    <td class="updated">${escapeHtml(i.updated_at.slice(0, 10))}</td>
    ${renderLaunchCell(i)}
  </tr>`;
}

function renderPrChips(
  i: OrgIssue,
  prMap: ReadonlyMap<string, IssuePrRef[]>,
): string {
  const refs = prMap.get(`${i.repo}#${i.number}`);
  if (!refs || refs.length === 0) return "";
  const chips = refs.map((p) => {
    // Merged PRs take precedence over draft styling — a merged PR can't
    // be draft anymore, but if GitHub ever flipped them simultaneously the
    // purple "done" signal is more useful than the gray "draft" one.
    const cls = p.state === "merged" ? " merged" : p.draft ? " draft" : "";
    const icon = p.state === "merged" ? "✅" : "🔗";
    const label = p.state === "merged"
      ? "Merged PR"
      : p.draft ? "Draft PR" : "PR";
    const title = `${label} #${p.number}: ${p.title}${p.repo === i.repo ? "" : ` (${p.repo})`}`;
    const suffix = p.state === "merged"
      ? " (merged)"
      : p.draft ? " (draft)" : "";
    return `<a class="pr-chip${cls}" href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="${escapeHtml(title)}">${icon} #${p.number}${suffix}</a>`;
  }).join("");
  return `<div class="pr-chips">${chips}</div>`;
}

function renderLaunchCell(i: OrgIssue): string {
  const url = buildClaudeCodeLaunchUrl(i.repo, i.number);
  return `<td class="launch"><a class="cc-launch" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Claude Code で起動 (${escapeHtml(i.repo)}#${i.number})">🚀</a></td>`;
}

function renderError(msg: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Open Issues — Error</title>
<style>body { font-family: sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
.err { background: #341a1f; border: 1px solid #f85149; color: #ffa198;
       padding: 12px 16px; border-radius: 6px; max-width: 720px; }</style>
</head><body>
<h1>📋 Open Issues</h1>
<div class="err">Failed to fetch issues: ${escapeHtml(msg)}</div>
<p style="margin-top: 12px;"><a href="/" style="color:#58a6ff">← CI Dashboard</a></p>
</body></html>`;
}

// Minimal HTML entity escape. Covers attribute and text contexts.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
