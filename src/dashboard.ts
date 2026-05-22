import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";

export function handleDashboard(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CI Dashboard</title>${PWA_HEAD_TAGS}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    ${TAB_STYLES}
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      background: #0d1117;
      color: #c9d1d9;
      padding: 24px;
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 { font-size: 20px; margin-bottom: 16px; color: #58a6ff; }
    .status-bar {
      font-size: 12px;
      color: #8b949e;
      margin-bottom: 16px;
    }
    .status-bar .connected { color: #3fb950; }
    .status-bar .disconnected { color: #f85149; }
    .layout {
      display: flex;
      gap: 16px;
    }
    .sidebar {
      width: 220px;
      min-width: 220px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px;
      align-self: flex-start;
      position: sticky;
      top: 24px;
      max-height: calc(100vh - 100px);
      overflow-y: auto;
    }
    .sidebar-header {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      color: #8b949e;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    .repo-item {
      padding: 8px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 2px;
      font-size: 13px;
      transition: background 0.15s;
    }
    .repo-item:hover { background: #21262d; }
    .repo-item.active {
      background: #1f6feb22;
      border-left: 2px solid #58a6ff;
      padding-left: 6px;
    }
    .repo-item .repo-name {
      font-weight: 600;
      color: #c9d1d9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .repo-item .repo-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 2px;
    }
    .repo-item .repo-branch {
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .repo-item .repo-branch.is-tag { color: #3fb950; }
    .repo-item .repo-branch.is-branch { color: #d29922; }
    .repo-item .sidebar-deploy {
      background: #238636;
      color: #fff;
      border: 1px solid #2ea043;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      margin-left: 4px;
    }
    .repo-item .sidebar-deploy:hover { background: #2ea043; }
    .repo-item .sidebar-deploy:disabled { opacity: 0.5; cursor: not-allowed; }
    .repo-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    .repo-dot.success { background: #3fb950; }
    .repo-dot.failure { background: #f85149; }
    .repo-dot.in_progress { background: #d29922; animation: pulse 2s infinite; }
    .repo-dot.queued { background: #58a6ff; }
    .repo-dot.cancelled { background: #484f58; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
      gap: 12px;
      flex: 1;
      min-width: 0;
    }
    .card {
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 16px;
      background: #161b22;
      transition: border-color 0.3s;
    }
    .card.in_progress { border-left: 3px solid #d29922; }
    .card.success { border-left: 3px solid #3fb950; }
    .card.failure { border-left: 3px solid #f85149; }
    .card.cancelled { border-left: 3px solid #8b949e; }
    .card.queued { border-left: 3px solid #58a6ff; }
    .card .repo {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 4px;
    }
    .card .repo a { color: #58a6ff; text-decoration: none; }
    .card .repo a:hover { text-decoration: underline; }
    .card .meta {
      font-size: 12px;
      color: #8b949e;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge.in_progress { background: #d29922; color: #000; }
    .badge.success { background: #3fb950; color: #000; }
    .badge.failure { background: #f85149; color: #fff; }
    .badge.cancelled { background: #484f58; color: #c9d1d9; }
    .badge.queued { background: #58a6ff; color: #000; }
    .badge.skipped { background: #30363d; color: #8b949e; }
    .empty {
      text-align: center;
      padding: 48px;
      color: #8b949e;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .card.in_progress .badge.in_progress { animation: pulse 2s infinite; }
    .jobs {
      margin-top: 10px;
      border-top: 1px solid #21262d;
      padding-top: 8px;
    }
    .job-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 0;
      font-size: 12px;
    }
    .job-row a {
      color: #c9d1d9;
      text-decoration: none;
    }
    .job-row a:hover { text-decoration: underline; }
    .job-icon { width: 16px; text-align: center; }
    .job-icon.success { color: #3fb950; }
    .job-icon.failure { color: #f85149; }
    .job-icon.in_progress { color: #d29922; }
    .job-icon.queued { color: #58a6ff; }
    .job-icon.skipped { color: #484f58; }
    .job-icon.cancelled { color: #484f58; }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; }
    .deploy-btn {
      background: #238636;
      color: #fff;
      border: 1px solid #2ea043;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .deploy-btn:hover { background: #2ea043; }
    .deploy-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .deploy-btn.loading { animation: pulse 1.5s infinite; }
    .dismiss-btn {
      background: transparent;
      color: #8b949e;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    .dismiss-btn:hover { color: #f85149; border-color: #f85149; }
    .recheck-btn {
      background: transparent;
      color: #8b949e;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    .recheck-btn:hover { color: #58a6ff; border-color: #58a6ff; }
    .recheck-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .recheck-btn.loading { animation: pulse 1.5s infinite; }
    .btn-group { display: flex; gap: 6px; }

    /* Release alert banners — appear after a Tag Release workflow completes
       when the release range references at least one still-open issue. They
       sit between the page title and the status bar so the operator sees
       them as soon as they open the dashboard. */
    .release-banners { margin-bottom: 16px; }
    .release-banner {
      background: #3b2c0e;
      border: 1px solid #d29922;
      border-left: 4px solid #d29922;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 8px;
      font-size: 13px;
      color: #e6cf80;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .release-banner .repo-tag {
      font-weight: 600;
      color: #f5deb3;
    }
    .release-banner .repo-tag code {
      background: #0d1117;
      padding: 1px 6px;
      border-radius: 4px;
      color: #d2a8ff;
      font-family: monospace;
    }
    .release-banner .review-link {
      color: #58a6ff;
      text-decoration: none;
      font-weight: 600;
      margin-left: auto;
    }
    .release-banner .review-link:hover { text-decoration: underline; }
    .release-banner .issue-chip {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 1px 8px;
      font-size: 11px;
      color: #c9d1d9;
      text-decoration: none;
    }
    .release-banner .issue-chip:hover { color: #58a6ff; border-color: #58a6ff; }
  </style>
</head>
<body>
  ${renderTabs("dashboard")}
  <h1>CI Dashboard</h1>
  <div id="release-banner-list" class="release-banners"></div>
  <div class="status-bar">
    WS: <span id="sse-status" class="disconnected">connecting...</span>
    &middot; Last update: <span id="last-update">-</span>
    &middot; <button id="reconnect-btn" type="button" style="background:transparent;color:#8b949e;border:1px solid #30363d;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer">&#x21bb; Reconnect</button>
  </div>
  <div class="layout">
    <aside id="sidebar" class="sidebar">
      <div class="sidebar-header">Repositories</div>
      <div id="repo-list"></div>
    </aside>
    <div id="grid" class="grid">
      <div class="empty">Waiting for data...</div>
    </div>
  </div>

  <script>
    const grid = document.getElementById("grid");
    const repoList = document.getElementById("repo-list");
    const sseStatus = document.getElementById("sse-status");
    const lastUpdate = document.getElementById("last-update");
    const bannerList = document.getElementById("release-banner-list");

    let lastStatuses = [];
    let activeFilter = null;

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function renderBanners(alerts) {
      if (!Array.isArray(alerts) || alerts.length === 0) {
        bannerList.innerHTML = "";
        return;
      }
      // Sort newest detectedAt first so the latest release floats to the top.
      const sorted = [...alerts].sort((a, b) =>
        (b.detectedAt || "").localeCompare(a.detectedAt || "")
      );
      bannerList.innerHTML = sorted.map(a => {
        const reviewUrl = "/releases?repo=" + encodeURIComponent(a.repo)
          + "&tag=" + encodeURIComponent(a.tag);
        const chips = (a.openIssues || []).slice(0, 8).map(i =>
          '<a class="issue-chip" href="' + escapeHtml(i.url)
            + '" target="_blank" rel="noopener" title="' + escapeHtml(i.title) + '">'
            + '#' + i.number + '</a>'
        ).join("");
        const more = (a.openIssues || []).length > 8
          ? ' <span class="issue-chip">+' + ((a.openIssues.length) - 8) + '</span>'
          : "";
        const n = (a.openIssues || []).length;
        return '<div class="release-banner">'
          + '<span class="repo-tag">\\uD83C\\uDFF7\\uFE0F '
          + escapeHtml(a.repo) + ' <code>' + escapeHtml(a.tag) + '</code> released</span>'
          + chips + more
          + '<a class="review-link" href="' + reviewUrl + '">'
          + n + ' open related issue' + (n === 1 ? '' : 's') + ' \\u2192 review</a>'
          + '</div>';
      }).join("");
    }

    function badgeClass(status, conclusion) {
      if (status === "completed") return conclusion || "success";
      if (status === "in_progress") return "in_progress";
      return "queued";
    }

    function jobIcon(status, conclusion) {
      const cls = badgeClass(status, conclusion);
      const icons = {
        success: "\\u2713",
        failure: "\\u2717",
        in_progress: "\\u25CF",
        queued: "\\u25CB",
        skipped: "\\u2013",
        cancelled: "\\u2013",
      };
      return '<span class="job-icon ' + cls + '">' + (icons[cls] || "?") + '</span>';
    }

    function timeAgo(dateStr) {
      const diff = Date.now() - new Date(dateStr).getTime();
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return sec + "s ago";
      const min = Math.floor(sec / 60);
      if (min < 60) return min + "m ago";
      const hr = Math.floor(min / 60);
      return hr + "h ago";
    }

    function elapsed(startStr, updateStr, status) {
      const start = new Date(startStr).getTime();
      const end = status === "completed" ? new Date(updateStr).getTime() : Date.now();
      const sec = Math.floor((end - start) / 1000);
      const min = Math.floor(sec / 60);
      const s = sec % 60;
      return min + "m" + String(s).padStart(2, "0") + "s";
    }

    function renderJobs(jobs) {
      if (!jobs || !jobs.length) return "";
      return '<div class="jobs">' + jobs.map(j => {
        const cls = badgeClass(j.status, j.conclusion);
        return '<div class="job-row">'
          + jobIcon(j.status, j.conclusion)
          + '<a href="' + j.url + '" target="_blank" rel="noopener">' + j.name + '</a>'
          + '</div>';
      }).join("") + '</div>';
    }

    function renderSidebar(statuses) {
      const seen = new Map();
      for (const s of statuses) {
        if (!seen.has(s.repo)) {
          seen.set(s.repo, s);
        }
      }
      const repos = [...seen.values()];
      repoList.innerHTML = repos.map(s => {
        const cls = badgeClass(s.status, s.conclusion);
        const shortName = s.repo.includes("/") ? s.repo.split("/").pop() : s.repo;
        const isActive = activeFilter === s.repo ? " active" : "";
        const canDeploy = s.repo.startsWith("ippoan/") || s.repo.startsWith("ohishi-exp/");
        const isTag = /^v\\d/.test(s.branch);
        const branchCls = isTag ? "is-tag" : "is-branch";
        const deployBtn = canDeploy && !isTag
          ? '<button class="sidebar-deploy" data-repo="' + s.repo + '" onclick="event.stopPropagation();deployTag(this)">Deploy</button>'
          : '';
        return '<div class="repo-item' + isActive + '" data-filter-repo="' + s.repo + '" onclick="toggleFilter(this)">'
          + '<div class="repo-name"><span class="repo-dot ' + cls + '"></span>' + shortName + '</div>'
          + '<div class="repo-meta"><span class="repo-branch ' + branchCls + '">' + s.branch + '</span>' + deployBtn + '</div>'
          + '</div>';
      }).join("");
    }

    function toggleFilter(el) {
      const repo = el.dataset.filterRepo;
      activeFilter = activeFilter === repo ? null : repo;
      renderAll(lastStatuses);
    }

    function render(statuses) {
      lastStatuses = statuses;
      renderAll(statuses);
    }

    function renderAll(statuses) {
      renderSidebar(statuses);
      const filtered = activeFilter
        ? statuses.filter(s => s.repo === activeFilter)
        : statuses;
      if (!filtered.length) {
        grid.innerHTML = '<div class="empty">'
          + (activeFilter
            ? 'No runs for this repo. <a href="#" onclick="activeFilter=null;render(lastStatuses);return false" style="color:#58a6ff">Clear filter</a>'
            : 'No CI runs yet. Configure webhooks to start.')
          + '</div>';
        return;
      }
      grid.innerHTML = filtered.map(s => {
        const cls = badgeClass(s.status, s.conclusion);
        const label = s.status === "completed" ? (s.conclusion || "unknown") : s.status;
        const deployBtn = (s.repo.startsWith("ippoan/") || s.repo.startsWith("ohishi-exp/"))
          ? '<button class="deploy-btn" data-repo="' + s.repo + '" onclick="deployTag(this)">Deploy</button>'
          : '';
        const recheckBtn = '<button class="recheck-btn" data-run-id="' + s.run_id + '" data-repo="' + s.repo + '" onclick="recheckRun(this)">&#x21bb;</button>';
        const dismissBtn = '<button class="dismiss-btn" data-run-id="' + s.run_id + '" onclick="dismissRun(this)">&times;</button>';
        return \`
          <div class="card \${cls}">
            <div class="card-header">
              <div class="repo">
                <a href="\${s.run_url}" target="_blank" rel="noopener">\${s.repo}</a>
              </div>
              <div class="btn-group">\${deployBtn}\${recheckBtn}\${dismissBtn}</div>
            </div>
            <div>
              <span class="badge \${cls}">\${label}</span>
              <span style="font-size:12px;color:#8b949e;margin-left:8px">\${s.workflow}</span>
            </div>
            <div class="meta">
              <span>\${s.branch}</span>
              <span>\${s.actor}</span>
              <span>\${elapsed(s.started_at, s.updated_at, s.status)}</span>
              <span>\${timeAgo(s.updated_at)}</span>
            </div>
            \${renderJobs(s.jobs)}
          </div>
        \`;
      }).join("");
    }

    // Pull the unified snapshot once. Used on initial WS connect and on
    // explicit Reconnect button. WS broadcasts then keep the page in sync
    // (= no periodic polling, no visibilitychange refresh). Refs #64.
    async function loadSnapshot() {
      if (document.hidden) return;
      try {
        const res = await fetch("/snapshot");
        const { statuses, alerts } = await res.json();
        render(statuses);
        renderBanners(alerts);
        lastUpdate.textContent = new Date().toLocaleTimeString();
      } catch {
        // Ignore — next WS event / manual reconnect will refresh
      }
    }

    // Module-scope ws so the Reconnect button can close it from outside
    // connect(). connect() reassigns this on each (re)connection attempt.
    let ws = null;

    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(proto + "//" + location.host + "/ws");
      let pingInterval = null;
      ws.onopen = () => {
        sseStatus.textContent = "connected";
        sseStatus.className = "connected";
        // Keep alive: send ping every 30s to prevent idle timeout.
        // The Worker side uses setWebSocketAutoResponse("ping", "pong")
        // so these pings do NOT count as Worker requests.
        pingInterval = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 30000);
        // Catch up via 1-shot snapshot. WS broadcasts handle subsequent
        // updates — no setInterval polling.
        loadSnapshot();
      };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        try {
          const msg = JSON.parse(e.data);
          // Typed envelope (current server format).
          if (msg && typeof msg === "object" && msg.type === "ci-statuses") {
            render(msg.data);
            lastUpdate.textContent = new Date().toLocaleTimeString();
            return;
          }
          if (msg && typeof msg === "object" && msg.type === "release-alerts") {
            renderBanners(msg.data);
            lastUpdate.textContent = new Date().toLocaleTimeString();
            return;
          }
          // Legacy fallback: bare CIStatus[] array (older Hub versions).
          if (Array.isArray(msg)) {
            render(msg);
            lastUpdate.textContent = new Date().toLocaleTimeString();
          }
        } catch { /* ignore malformed message */ }
      };
      ws.onclose = () => {
        if (pingInterval) clearInterval(pingInterval);
        sseStatus.textContent = "reconnecting...";
        sseStatus.className = "disconnected";
        setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        if (ws) ws.close();
      };
    }

    // Manual escape hatch: if the WS got into a weird half-dead state and
    // the user notices stale data, this drops the connection. ws.onclose
    // schedules an auto-reconnect after 3s, which then calls loadSnapshot().
    document.getElementById("reconnect-btn").addEventListener("click", () => {
      if (ws) ws.close();
    });

    async function deployTag(btn) {
      const repo = btn.dataset.repo;
      if (!confirm("Create patch release for " + repo + "?")) return;

      btn.disabled = true;
      btn.textContent = "Creating...";
      btn.classList.add("loading");

      try {
        const res = await fetch("/api/tag-release", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo }),
        });
        const data = await res.json();
        if (!res.ok) {
          btn.textContent = "Error";
          btn.classList.remove("loading");
          alert("Failed: " + (data.error || res.statusText));
          setTimeout(() => { btn.textContent = "Deploy"; btn.disabled = false; }, 3000);
          return;
        }
        btn.textContent = "Triggered!";
        btn.classList.remove("loading");
        setTimeout(() => { btn.textContent = "Deploy"; btn.disabled = false; }, 5000);
      } catch (e) {
        btn.textContent = "Error";
        btn.classList.remove("loading");
        setTimeout(() => { btn.textContent = "Deploy"; btn.disabled = false; }, 3000);
      }
    }

    async function recheckRun(btn) {
      const runId = btn.dataset.runId;
      const repo = btn.dataset.repo;
      btn.disabled = true;
      btn.classList.add("loading");
      try {
        const res = await fetch("/api/recheck", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ run_id: Number(runId), repo }),
        });
        if (!res.ok) {
          const data = await res.json();
          alert("Re-check failed: " + (data.error || res.statusText));
        }
      } catch (e) {
        alert("Re-check failed");
      } finally {
        btn.disabled = false;
        btn.classList.remove("loading");
      }
    }

    async function dismissRun(btn) {
      if (!confirm("Remove this card?")) return;
      const runId = btn.dataset.runId;
      btn.disabled = true;
      try {
        await fetch("/api/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ run_id: Number(runId) }),
        });
      } catch (e) {
        btn.disabled = false;
      }
    }

    connect();
  </script>
  ${PWA_REGISTER_SCRIPT}
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
