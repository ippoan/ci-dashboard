import { fetchOrgIssues, type OrgIssue } from "./mcp/tools/issues";
import { fetchProjectIssueMap, type ProjectRef } from "./mcp/tools/projects";
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
  kv: KVNamespace,
  token: string,
  orgs: string[],
): Promise<ProjectMapResult> {
  const cached = await kv.get(PROJECT_MAP_CACHE_KEY, "json") as ProjectMapCacheEntry | null;
  const now = Date.now();
  if (cached && now - cached.storedAt < PROJECT_MAP_FRESH_SECONDS * 1000) {
    return { map: new Map(Object.entries(cached.data)), stale: false, error: null };
  }
  try {
    const fresh = await fetchProjectIssueMap(token, { orgs });
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

export async function handleIssuesPage(
  env: { GITHUB_TOKEN: string; CI_STATUS: KVNamespace },
): Promise<Response> {
  // Search REST gives us the issues themselves; this is the only fetch that
  // can fail the page outright. Project map is loaded separately below so a
  // GraphQL rate-limit doesn't blank the page (Refs #94 follow-up).
  let merged;
  try {
    const [main, yhonda] = await Promise.all([
      fetchOrgIssues(env.GITHUB_TOKEN, {
        orgs: ORGS,
        state: "open",
        per_page: 100,
      }),
      fetchOrgIssues(env.GITHUB_TOKEN, {
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
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(renderError(msg), {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const project = await loadProjectMap(env.CI_STATUS, env.GITHUB_TOKEN, PROJECT_ORGS);
  const projectMap = project.map;

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
    renderHtml(merged.total_count, merged.incomplete, projectTagged, repos, project),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function renderHtml(
  total: number,
  incomplete: boolean,
  projectTagged: ReadonlyArray<{ issue: OrgIssue; projects: ProjectRef[] }>,
  repos: ReadonlyArray<readonly [string, OrgIssue[]]>,
  project: ProjectMapResult,
): string {
  const repoSections = repos
    .map(([repo, items]) => renderRepoSection(repo, items))
    .join("\n");

  const projectSection = projectTagged.length > 0
    ? renderProjectSection(projectTagged)
    : "";

  const incompleteBanner = incomplete
    ? `<div class="banner">⚠️ Result was truncated by GitHub search. Showing ${total} issues but more may exist.</div>`
    : "";
  const projectBanner = project.stale
    ? `<div class="banner banner-info">📋 Project tags shown are from the last successful sync — fresh fetch failed (${escapeHtml(project.error ?? "")})</div>`
    : project.error
    ? `<div class="banner">⚠️ Project tags unavailable: ${escapeHtml(project.error)}</div>`
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
): string {
  const rows = items.map(({ issue, projects }) => renderProjectRow(issue, projects)).join("\n");
  return `<section class="projects">
  <h2>📋 Project 付き<span class="count">(${items.length})</span></h2>
  <table>
    <thead><tr><th>#</th><th>Repo</th><th>Title</th><th>Author</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderProjectRow(i: OrgIssue, projects: ReadonlyArray<ProjectRef>): string {
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
    <td class="title"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a><div class="labels">${chips}</div>${labelChips}</td>
    <td class="author">@${escapeHtml(i.author)}</td>
    <td class="updated">${escapeHtml(i.updated_at.slice(0, 10))}</td>
  </tr>`;
}

function renderRepoSection(repo: string, items: OrgIssue[]): string {
  const rows = items.map((i) => renderRow(i)).join("\n");
  const repoUrl = `https://github.com/${repo}/issues`;
  return `<section class="repo">
  <h2><a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener">${escapeHtml(repo)}</a><span class="count">(${items.length})</span></h2>
  <table>
    <thead><tr><th>#</th><th>Title</th><th>Author</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderRow(i: OrgIssue): string {
  const labelChips = i.labels.length > 0
    ? `<div class="labels">${i.labels.map((l) =>
        `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "";
  return `<tr>
    <td class="num"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">#${i.number}</a></td>
    <td class="title"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a>${labelChips}</td>
    <td class="author">@${escapeHtml(i.author)}</td>
    <td class="updated">${escapeHtml(i.updated_at.slice(0, 10))}</td>
  </tr>`;
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
