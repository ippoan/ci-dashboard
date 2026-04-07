export function handleDashboard(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CI Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      background: #0d1117;
      color: #c9d1d9;
      padding: 24px;
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
    .repo-item .repo-branch {
      font-size: 11px;
      color: #8b949e;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }
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
    .btn-group { display: flex; gap: 6px; }
  </style>
</head>
<body>
  <h1>CI Dashboard</h1>
  <div class="status-bar">
    WS: <span id="sse-status" class="disconnected">connecting...</span>
    &middot; Last update: <span id="last-update">-</span>
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

    let lastStatuses = [];
    let activeFilter = null;

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
        return '<div class="repo-item' + isActive + '" data-filter-repo="' + s.repo + '" onclick="toggleFilter(this)">'
          + '<div class="repo-name"><span class="repo-dot ' + cls + '"></span>' + shortName + '</div>'
          + '<div class="repo-branch">' + s.branch + '</div>'
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
        const dismissBtn = '<button class="dismiss-btn" data-run-id="' + s.run_id + '" onclick="dismissRun(this)">&times;</button>';
        return \`
          <div class="card \${cls}">
            <div class="card-header">
              <div class="repo">
                <a href="\${s.run_url}" target="_blank" rel="noopener">\${s.repo}</a>
              </div>
              <div class="btn-group">\${deployBtn}\${dismissBtn}</div>
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

    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(proto + "//" + location.host + "/ws");
      ws.onopen = () => {
        sseStatus.textContent = "connected";
        sseStatus.className = "connected";
        // Request initial data
        fetch("/status").then(r => r.json()).then(data => {
          render(data);
          lastUpdate.textContent = new Date().toLocaleTimeString();
        });
      };
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        render(data);
        lastUpdate.textContent = new Date().toLocaleTimeString();
      };
      ws.onclose = () => {
        sseStatus.textContent = "reconnecting...";
        sseStatus.className = "disconnected";
        setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        ws.close();
      };
    }

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
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
