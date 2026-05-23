import {
  fetchOrgProjects,
  fetchProjectItems,
  type OrgProject,
  type ProjectItemSummary,
} from "./mcp/tools/projects";
import type { AuthWorkerEnv } from "./auth-worker-client";
import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";
import { escapeHtml } from "./issues-page";

// Same set of orgs as the `/issues` Projects-aggregate section. Three orgs ×
// ~10 open projects each is well under the GraphQL rate-limit budget for one
// page load; cross-page caching is a follow-up if items() queries grow.
const PROJECT_ORGS = ["ippoan", "ohishi-exp", "yhonda-ohishi"];

interface ProjectWithItems {
  project: OrgProject;
  items: ProjectItemSummary[] | null; // null on per-project fetch failure
  error: string | null;
}

interface OrgSection {
  org: string;
  projects: ProjectWithItems[];
}

export async function handleProjectsPage(env: AuthWorkerEnv): Promise<Response> {
  let perOrg;
  try {
    perOrg = await fetchOrgProjects(env, { orgs: PROJECT_ORGS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(renderError(msg), {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Fan-out: one items() GraphQL call per (org, project). `allSettled` so a
  // single project that errors out (e.g. permission, deleted between list and
  // fetch) doesn't blank the whole page — that project surfaces an inline
  // error in its <details> block instead.
  const flat = perOrg.flatMap(({ org, projects }) =>
    projects.map((p) => ({ org, project: p })),
  );
  const itemResults = await Promise.allSettled(
    flat.map(({ org, project }) =>
      fetchProjectItems(env, org, project.number),
    ),
  );

  // Re-fold into org → projects[] structure preserving the order from
  // `fetchOrgProjects` (which is NUMBER DESC per org → newest first).
  const itemsByKey = new Map<string, ProjectWithItems>();
  flat.forEach(({ org, project }, idx) => {
    const r = itemResults[idx]!;
    const key = `${org}/${project.number}`;
    if (r.status === "fulfilled") {
      itemsByKey.set(key, { project, items: r.value, error: null });
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      itemsByKey.set(key, { project, items: null, error: msg });
    }
  });

  const sections: OrgSection[] = perOrg.map(({ org, projects }) => ({
    org,
    projects: projects.map((p) => itemsByKey.get(`${org}/${p.number}`)!),
  }));

  const totalProjects = sections.reduce((sum, s) => sum + s.projects.length, 0);

  return new Response(renderHtml(sections, totalProjects), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderHtml(sections: OrgSection[], totalProjects: number): string {
  const orgBlocks = sections
    .map((s) => renderOrgSection(s))
    .join("\n");

  const empty = totalProjects === 0
    ? `<div class="empty">No open Projects v2 across ${PROJECT_ORGS.map((o) => escapeHtml(o)).join(", ")}.</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Projects — CI Dashboard</title>${PWA_HEAD_TAGS}
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
    section.org {
      margin-bottom: 24px;
    }
    section.org > h2 {
      font-size: 14px;
      font-weight: 600;
      color: #8b949e;
      padding: 4px 0;
      margin-bottom: 8px;
      letter-spacing: 0.3px;
    }
    section.org > h2 .count {
      color: #6b7280;
      font-weight: 400;
      margin-left: 6px;
    }
    details.project {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    details.project[open] {
      border-color: #1f6feb55;
    }
    details.project > summary {
      cursor: pointer;
      list-style: none;
      padding: 10px 14px;
      background: #1f2630;
      border-bottom: 1px solid transparent;
      display: flex;
      gap: 10px;
      align-items: baseline;
      font-size: 13px;
    }
    details.project > summary::-webkit-details-marker { display: none; }
    details.project > summary::before {
      content: "▸";
      color: #8b949e;
      font-size: 11px;
      width: 10px;
      display: inline-block;
    }
    details.project[open] > summary::before { content: "▾"; }
    details.project[open] > summary {
      border-bottom-color: #30363d;
      background: #1c2433;
    }
    summary .num {
      color: #8b949e;
      font-variant-numeric: tabular-nums;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    summary .title {
      color: #c9d1d9;
      font-weight: 500;
      flex-grow: 1;
    }
    summary .title a {
      color: inherit;
      text-decoration: none;
    }
    summary .title a:hover { color: #58a6ff; text-decoration: underline; }
    summary .desc {
      color: #8b949e;
      font-size: 12px;
      font-weight: 400;
    }
    summary .item-count {
      color: #8b949e;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    summary .closed-tag {
      display: inline-block;
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 10px;
      background: #8b949e22;
      color: #8b949e;
      margin-left: 6px;
    }
    .items {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .items tbody tr { border-top: 1px solid #21262d; }
    .items tbody tr:hover { background: #1c2129; }
    .items th, .items td {
      padding: 8px 14px;
      text-align: left;
      vertical-align: top;
    }
    .items th {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #8b949e;
      background: #0d1117;
    }
    .items td.type {
      width: 90px;
      color: #8b949e;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .items td.repo {
      width: 220px;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #8b949e;
      white-space: nowrap;
    }
    .items td.repo a { color: #58a6ff; text-decoration: none; }
    .items td.repo a:hover { text-decoration: underline; }
    .items td.title a { color: #c9d1d9; text-decoration: none; font-weight: 500; }
    .items td.title a:hover { color: #58a6ff; text-decoration: underline; }
    .items td.state {
      width: 80px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #8b949e;
    }
    .items .state-open { color: #3fb950; }
    .items .state-closed { color: #f85149; }
    .items .state-merged { color: #a371f7; }
    .fields { margin-top: 4px; }
    .field-chip {
      display: inline-block;
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 10px;
      background: #1f6feb22;
      color: #79c0ff;
      margin-right: 4px;
      margin-bottom: 2px;
    }
    .field-chip .field-name {
      color: #58a6ff99;
      margin-right: 4px;
    }
    .err {
      padding: 12px 14px;
      color: #ffa198;
      background: #341a1f;
      font-size: 12px;
    }
    .no-items {
      padding: 12px 14px;
      color: #8b949e;
      font-size: 13px;
      font-style: italic;
    }
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
    ${renderTabs("projects")}
    <h1>🗂️ Projects</h1>
    <div class="summary">
      ${escapeHtml(String(totalProjects))} open project${totalProjects === 1 ? "" : "s"} across
      ${PROJECT_ORGS.map((o) => escapeHtml(o)).join(", ")}
    </div>
  </header>
  ${orgBlocks}
  ${empty}
  ${PWA_REGISTER_SCRIPT}
</body>
</html>`;
}

function renderOrgSection(s: OrgSection): string {
  if (s.projects.length === 0) {
    // Skip empty orgs to avoid visual noise (closed/empty user accounts).
    return "";
  }
  const items = s.projects.map((pw) => renderProject(pw)).join("\n");
  return `<section class="org">
  <h2>${escapeHtml(s.org)}<span class="count">(${s.projects.length})</span></h2>
  ${items}
</section>`;
}

function renderProject(pw: ProjectWithItems): string {
  const { project, items, error } = pw;
  const itemCount = items?.length ?? 0;
  const closedTag = project.closed ? `<span class="closed-tag">closed</span>` : "";
  const desc = project.shortDescription
    ? `<span class="desc">— ${escapeHtml(project.shortDescription)}</span>`
    : "";
  const countLabel = error
    ? `<span class="item-count">error</span>`
    : `<span class="item-count">${itemCount} item${itemCount === 1 ? "" : "s"}</span>`;
  const body = error
    ? `<div class="err">Failed to load items: ${escapeHtml(error)}</div>`
    : !items || items.length === 0
    ? `<div class="no-items">No items.</div>`
    : renderItemsTable(items);

  return `<details class="project">
  <summary>
    <span class="num">#${project.number}</span>
    <span class="title"><a href="${escapeHtml(project.url)}" target="_blank" rel="noopener">${escapeHtml(project.title)}</a>${closedTag}</span>
    ${desc}
    ${countLabel}
  </summary>
  ${body}
</details>`;
}

function renderItemsTable(items: ReadonlyArray<ProjectItemSummary>): string {
  const rows = items.map((i) => renderItemRow(i)).join("\n");
  return `<table class="items">
  <thead><tr><th>Type</th><th>Repo</th><th>Title</th><th>State</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderItemRow(item: ProjectItemSummary): string {
  const fieldChips = renderFieldChips(item.fields);
  const c = item.content;
  if (c.type === "issue" || c.type === "pull_request") {
    const stateCls = stateClass(c.state);
    return `<tr>
    <td class="type">${c.type === "issue" ? "Issue" : "PR"}</td>
    <td class="repo"><a href="https://github.com/${escapeHtml(c.repo)}" target="_blank" rel="noopener">${escapeHtml(c.repo)}</a>#${c.number}</td>
    <td class="title"><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a>${fieldChips}</td>
    <td class="state ${stateCls}">${escapeHtml(c.state.toLowerCase())}</td>
  </tr>`;
  }
  if (c.type === "draft_issue") {
    return `<tr>
    <td class="type">Draft</td>
    <td class="repo">—</td>
    <td class="title">${escapeHtml(c.title)}${fieldChips}</td>
    <td class="state">draft</td>
  </tr>`;
  }
  return `<tr>
    <td class="type">?</td>
    <td class="repo">—</td>
    <td class="title">(redacted item)${fieldChips}</td>
    <td class="state">—</td>
  </tr>`;
}

function renderFieldChips(fields: Record<string, unknown>): string {
  const names = Object.keys(fields);
  if (names.length === 0) return "";
  const chips = names.map((name) => {
    const v = fields[name];
    const display = v === null || v === undefined ? "" : String(v);
    return `<span class="field-chip"><span class="field-name">${escapeHtml(name)}:</span>${escapeHtml(display)}</span>`;
  }).join("");
  return `<div class="fields">${chips}</div>`;
}

function stateClass(state: string): string {
  const lower = state.toLowerCase();
  if (lower === "open") return "state-open";
  if (lower === "closed") return "state-closed";
  if (lower === "merged") return "state-merged";
  return "";
}

function renderError(msg: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Projects — Error</title>
<style>body { font-family: sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
.err { background: #341a1f; border: 1px solid #f85149; color: #ffa198;
       padding: 12px 16px; border-radius: 6px; max-width: 720px; }</style>
</head><body>
<h1>🗂️ Projects</h1>
<div class="err">Failed to fetch projects: ${escapeHtml(msg)}</div>
<p style="margin-top: 12px;"><a href="/" style="color:#58a6ff">← CI Dashboard</a></p>
</body></html>`;
}
