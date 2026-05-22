import { DurableObject } from "cloudflare:workers";
import type { CIStatus, JobStatus } from "./webhook";
import type { Env } from "./index";
import {
  type ReleaseAlert,
  recomputeAlert,
  computeReleaseAlert,
  computeReleaseAlertForPr,
} from "./release-alert";
import { parseRepo } from "./github-api";
import { invalidateIssue } from "./release-cache";

// WebSocket message envelope. All broadcasts now share `{ type, data }` so
// the dashboard JS can dispatch by type. Two channels currently:
//   - "ci-statuses"     → CIStatus[] (workflow run grid)
//   - "release-alerts"  → ReleaseAlert[] (post-tag-release banner)
type WsEnvelope =
  | { type: "ci-statuses"; data: CIStatus[] }
  | { type: "release-alerts"; data: ReleaseAlert[] };

const ALERT_KEY_PREFIX = "release-alert:";
const ALERT_TTL_SECONDS = 7 * 86400;

function tagAlertKey(repo: string): string {
  return `${ALERT_KEY_PREFIX}${repo}`;
}

function prAlertKey(repo: string, prNumber: number): string {
  return `${ALERT_KEY_PREFIX}${repo}:pr-${prNumber}`;
}

export class CIDashboardHub extends DurableObject<Env> {
  // In-memory cache: run_id → CIStatus
  private cache = new Map<number, CIStatus>();
  private cacheLoaded = false;

  // In-memory cache: KV key → ReleaseAlert. Keys take one of two shapes:
  //   release-alert:<owner>/<name>            — traditional tag-driven alert
  //   release-alert:<owner>/<name>:pr-<n>     — PR-merge alert for tagless repos
  // Keying the map by the full KV key (instead of "owner/name") lets us hold
  // multiple PR-based alerts per repo concurrently while still overwriting
  // the tag alert in place when a fresh tag release fires.
  private alerts = new Map<string, ReleaseAlert>();
  private alertsLoaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  private async ensureCache(): Promise<void> {
    if (this.cacheLoaded) return;
    const list = await this.env.CI_STATUS.list({ prefix: "run:" });
    const values = await Promise.all(
      list.keys.map((key) => this.env.CI_STATUS.get(key.name))
    );
    for (const v of values) {
      if (v) {
        const s = JSON.parse(v) as CIStatus;
        this.cache.set(s.run_id, s);
      }
    }
    this.cacheLoaded = true;
  }

  private async ensureAlerts(): Promise<void> {
    if (this.alertsLoaded) return;
    const list = await this.env.CI_STATUS.list({ prefix: ALERT_KEY_PREFIX });
    const values = await Promise.all(
      list.keys.map((key) => this.env.CI_STATUS.get(key.name))
    );
    for (let i = 0; i < list.keys.length; i++) {
      const v = values[i];
      if (!v) continue;
      try {
        const a = JSON.parse(v) as ReleaseAlert;
        // Use the KV key directly so tag and PR alerts co-exist in the map
        // without colliding on `repo`.
        this.alerts.set(list.keys[i]!.name, a);
      } catch { /* skip corrupt entry */ }
    }
    this.alertsLoaded = true;
  }

  private computeStatuses(): CIStatus[] {
    const all = [...this.cache.values()];

    const latestInProgress = new Map<string, CIStatus>();
    const latestCompleted = new Map<string, CIStatus>();

    for (const s of all) {
      const map = s.status === "completed" ? latestCompleted : latestInProgress;
      const existing = map.get(s.repo);
      if (!existing || s.updated_at > existing.updated_at) {
        map.set(s.repo, s);
      }
    }

    for (const [repo, ip] of latestInProgress) {
      const completed = latestCompleted.get(repo);
      if (completed && completed.updated_at > ip.updated_at) {
        latestInProgress.delete(repo);
      }
    }

    const result = [...latestInProgress.values(), ...latestCompleted.values()];
    result.sort((a, b) => {
      if (a.status !== "completed" && b.status === "completed") return -1;
      if (a.status === "completed" && b.status !== "completed") return 1;
      return b.updated_at.localeCompare(a.updated_at);
    });

    return result;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast") {
      const data = await request.text();
      this.broadcast(data);
      return new Response("OK");
    }

    // All statuses from in-memory cache (for /status endpoint)
    if (url.pathname === "/statuses") {
      await this.ensureCache();
      const statuses = this.computeStatuses();
      return Response.json(statuses);
    }

    // All release alerts from in-memory cache (for /release-alerts endpoint).
    // Lazy-refresh path: drop openIssues that GitHub now reports as closed
    // before returning. The KV alert entry has a 7d TTL and is only mutated
    // on /release-alert-detect{,-pr} / /release-alert-recompute, so an issue
    // closed outside the dashboard's UI (manually on GitHub, or via a `Closes
    // #N` from another repo's PR) would otherwise haunt the banner for days.
    // See #90 follow-up.
    if (url.pathname === "/release-alerts") {
      await this.ensureAlerts();
      await this.refreshStaleAlerts();
      return Response.json([...this.alerts.values()]);
    }

    // Unified snapshot: { statuses, alerts } in one DO call. Dashboard UI
    // uses this on WS connect / reconnect instead of polling /status +
    // /release-alerts every 30s. Refs #64 (90% Worker request reduction).
    // Same lazy-refresh as /release-alerts above — this is the actual read
    // path the dashboard JS hits on every page load.
    if (url.pathname === "/snapshot") {
      await this.ensureCache();
      await this.ensureAlerts();
      await this.refreshStaleAlerts();
      return Response.json({
        statuses: this.computeStatuses(),
        alerts: [...this.alerts.values()],
      });
    }

    // Compute alert for a tag release that just shipped, store + broadcast.
    // Called from webhook.ts after a `Tag Release` workflow_run completes.
    if (url.pathname === "/release-alert-detect") {
      const { repo, tag } = await request.json<{ repo: string; tag?: string }>();
      await this.ensureAlerts();
      try {
        const alert = await computeReleaseAlert(
          this.env.GITHUB_TOKEN, repo, tag, this.env.CI_STATUS,
        );
        this.persistAlertAtKey(tagAlertKey(repo), alert);
        this.broadcastAlerts();
      } catch {
        // Best-effort: a failed compute (e.g. token rate-limit) leaves any
        // existing alert in place rather than wiping it.
      }
      return new Response("OK");
    }

    // Tagless-repo variant: a PR was just merged into the default branch on a
    // repo that doesn't cut release tags. Treat the PR as a mini-release —
    // walk it for Refs and persist a PR-scoped alert. Each PR gets its own KV
    // entry so multiple in-flight close-required PRs co-exist.
    if (url.pathname === "/release-alert-detect-pr") {
      const { repo, prNumber, mergeSha, defaultBranch } = await request.json<{
        repo: string;
        prNumber: number;
        mergeSha: string | null;
        defaultBranch: string;
      }>();
      await this.ensureAlerts();
      try {
        const alert = await computeReleaseAlertForPr(
          this.env.GITHUB_TOKEN, repo, prNumber, mergeSha, defaultBranch, this.env.CI_STATUS,
        );
        this.persistAlertAtKey(prAlertKey(repo, prNumber), alert);
        this.broadcastAlerts();
      } catch {
        // Same best-effort pattern as the tag path — failed compute keeps any
        // existing PR alert in place.
      }
      return new Response("OK");
    }

    // Recompute alert(s) for a repo whose state changed elsewhere (e.g. an
    // operator just closed issues via /api/release-close{,-batch}). For repos
    // with multiple PR-scoped alerts we recompute each one and drop those that
    // have no open issues left.
    if (url.pathname === "/release-alert-recompute") {
      const { repo } = await request.json<{ repo: string }>();
      await this.ensureAlerts();

      // Collect every (key, alert) pair for this repo before mutating so we
      // can iterate without disturbing the live Map.
      const matching = [...this.alerts.entries()].filter(([_, a]) => a.repo === repo);
      if (matching.length === 0) return new Response("OK");

      let changed = false;
      for (const [kvKey, existing] of matching) {
        try {
          const fresh = existing.prNumber !== undefined
            ? await computeReleaseAlertForPr(
                this.env.GITHUB_TOKEN, repo, existing.prNumber,
                /* mergeSha */ null,
                /* defaultBranch */ existing.tag.split("@")[0] ?? "main",
                this.env.CI_STATUS,
              )
            : await recomputeAlert(
                this.env.GITHUB_TOKEN, repo, existing.tag, this.env.CI_STATUS,
              );
          this.persistAlertAtKey(kvKey, fresh);
          changed = true;
        } catch {
          // Leave this particular alert in place; siblings still get a try.
        }
      }
      if (changed) this.broadcastAlerts();
      return new Response("OK");
    }

    if (url.pathname === "/update-run") {
      const payload = await request.json<{
        run: {
          id: number;
          name: string;
          head_branch: string;
          status: string;
          conclusion: string | null;
          html_url: string;
          actor: { login: string };
          updated_at: string;
          run_started_at: string;
        };
        repo: string;
      }>();
      await this.ensureCache();
      await this.updateRun(payload);
      this.broadcastFromCache();
      return new Response("OK");
    }

    if (url.pathname === "/update-job") {
      const payload = await request.json<{
        job: {
          run_id: number;
          name: string;
          status: string;
          conclusion: string | null;
          html_url: string;
          started_at: string | null;
          completed_at: string | null;
        };
      }>();
      await this.ensureCache();
      await this.updateJob(payload);
      this.broadcastFromCache();
      return new Response("OK");
    }

    if (url.pathname === "/delete-run") {
      const { run_id } = await request.json<{ run_id: number }>();
      await this.ensureCache();
      this.cache.delete(run_id);
      await this.env.CI_STATUS.delete(`run:${run_id}`);
      this.broadcastFromCache();
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }

  private async updateRun(payload: {
    run: {
      id: number;
      name: string;
      head_branch: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      actor: { login: string };
      updated_at: string;
      run_started_at: string;
    };
    repo: string;
  }): Promise<void> {
    const { run, repo } = payload;
    const existing = this.cache.get(run.id);

    let status: CIStatus;
    if (existing) {
      existing.status = run.status;
      existing.conclusion = run.conclusion;
      existing.updated_at = run.updated_at;
      if (run.status === "completed" && existing.jobs) {
        for (const job of existing.jobs) {
          if (job.status === "in_progress" || job.status === "queued") {
            job.status = "completed";
            job.conclusion = job.conclusion ?? "skipped";
          }
        }
      }
      status = existing;
    } else {
      status = {
        repo,
        workflow: run.name,
        branch: run.head_branch,
        status: run.status,
        conclusion: run.conclusion,
        run_id: run.id,
        run_url: run.html_url,
        actor: run.actor.login,
        updated_at: run.updated_at,
        started_at: run.run_started_at,
      };
    }

    this.cache.set(run.id, status);
    // KV write is fire-and-forget for speed; cache is source of truth
    this.ctx.waitUntil(
      this.env.CI_STATUS.put(`run:${run.id}`, JSON.stringify(status), {
        expirationTtl: 86400,
      })
    );
  }

  private async updateJob(payload: {
    job: {
      run_id: number;
      name: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      started_at: string | null;
      completed_at: string | null;
    };
  }): Promise<void> {
    const { job } = payload;
    const status = this.cache.get(job.run_id);
    if (!status) return;

    const jobStatus: JobStatus = {
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      url: job.html_url,
      started_at: job.started_at,
      completed_at: job.completed_at,
    };

    const jobs = status.jobs ?? [];
    const idx = jobs.findIndex((j) => j.name === job.name);
    if (idx >= 0) {
      jobs[idx] = jobStatus;
    } else {
      jobs.push(jobStatus);
    }
    status.jobs = jobs;

    this.ctx.waitUntil(
      this.env.CI_STATUS.put(`run:${job.run_id}`, JSON.stringify(status), {
        expirationTtl: 86400,
      })
    );
  }

  // Persist (or delete, when fresh is null) the alert at a specific KV key.
  // Map + KV stay in lockstep — the in-memory `alerts` Map is keyed by the same
  // KV key so a future `ensureAlerts()` read sees consistent state. Same KV-
  // fire-and-forget pattern as the run cache. Caller broadcasts afterward.
  private persistAlertAtKey(kvKey: string, fresh: ReleaseAlert | null): void {
    if (fresh === null) {
      this.alerts.delete(kvKey);
      this.ctx.waitUntil(this.env.CI_STATUS.delete(kvKey));
    } else {
      this.alerts.set(kvKey, fresh);
      this.ctx.waitUntil(
        this.env.CI_STATUS.put(kvKey, JSON.stringify(fresh), {
          expirationTtl: ALERT_TTL_SECONDS,
        }),
      );
    }
  }

  // For each in-memory alert, re-verify its openIssues against current GitHub
  // state. Drop issues now reported closed; if the alert ends up with no
  // openIssues, delete the alert entirely so the banner disappears.
  //
  // We deliberately bypass `cachedIssue` (60 s KV TTL) AND Cloudflare's
  // outbound fetch cache (`cache: "no-store"`). The reason: an issue
  // referenced by an alert is, by definition, one we already think is open.
  // The whole point of refreshing here is to detect the open→closed flip.
  // Reading any cached state runs the risk of returning the stale "open"
  // value that originally triggered the alert — defeating the refresh.
  //
  // Side effect: invalidate the cachedIssue KV entry after a state change so
  // /releases (which uses cachedIssue) reflects the fresh state on its next
  // load instead of waiting out the 60 s TTL.
  //
  // Cost: N raw GitHub `/issues/N` fetches per /snapshot call where N is the
  // total openIssues count across all alerts. Typical N is 1-5. /snapshot is
  // called on dashboard load + visibilitychange (Refs #92) — no periodic
  // polling. No GitHub fetches when `alerts.size === 0`.
  //
  // Best-effort: any per-issue fetch error keeps that issue in place
  // (transient GitHub 5xx shouldn't silently hide an alert that may still be
  // legitimate).
  //
  // Refs #94 (the previous cachedIssue-based version saw stale "open" data
  // and never dropped a known-closed issue).
  private async refreshStaleAlerts(): Promise<void> {
    if (this.alerts.size === 0) return;
    const entries = [...this.alerts.entries()];
    let anyChanged = false;
    const invalidations: Array<Promise<void>> = [];
    await Promise.all(entries.map(async ([kvKey, alert]) => {
      let owner: string;
      let name: string;
      try {
        ({ owner, repo: name } = parseRepo(alert.repo));
      } catch {
        return;
      }
      const statuses = await Promise.all(alert.openIssues.map(async (i) => {
        try {
          const state = await this.fetchLiveIssueState(owner, name, i.number);
          return { issue: i, state };
        } catch {
          // Keep the issue on transient failure (treat as "still open" so the
          // banner doesn't quietly disappear because of GitHub rate limits).
          return { issue: i, state: "open" };
        }
      }));
      const stillOpen = statuses
        .filter((s) => s.state !== "closed")
        .map((s) => s.issue);
      if (stillOpen.length === alert.openIssues.length) return;
      anyChanged = true;
      // Wipe the cachedIssue entry for each now-closed issue so /releases
      // also picks up the fresh "closed" on its next render rather than
      // serving the same stale "open" we just routed around.
      for (const s of statuses) {
        if (s.state === "closed") {
          invalidations.push(invalidateIssue(this.env.CI_STATUS, owner, name, s.issue.number));
        }
      }
      if (stillOpen.length === 0) {
        this.persistAlertAtKey(kvKey, null);
      } else {
        this.persistAlertAtKey(kvKey, { ...alert, openIssues: stillOpen });
      }
    }));
    if (invalidations.length > 0) this.ctx.waitUntil(Promise.all(invalidations).then(() => undefined));
    if (anyChanged) this.broadcastAlerts();
  }

  // Direct GitHub fetch that bypasses every cache layer:
  //   - KV `cachedIssue` (60 s TTL): we don't call it
  //   - Cloudflare Worker outbound fetch cache, defense in depth:
  //       1. `cache: "no-store"` (officially-supported escape hatch —
  //          https://developers.cloudflare.com/workers/runtime-apis/fetch/).
  //          The Worker types lib doesn't expose `cache` on RequestInit, so we
  //          widen via a cast — the runtime does honor it.
  //       2. Per-call cache-buster query (`?_=${Date.now()}`) so the cache
  //          key (full URL) misses on every request even if (1) is ignored.
  //          GitHub ignores unknown query params on /issues/N.
  //       3. `Cache-Control: no-cache, no-store, must-revalidate` + `Pragma:
  //          no-cache` request headers to ask the intermediate layer not to
  //          serve a cached response.
  //
  // Only used by refreshStaleAlerts; for any page-render path stick with
  // `cachedIssue` which is fine.
  //
  // Refs #94: without (1), the Worker's implicit fetch cache held a stale
  // `state: "open"` response for #64 across hours of /snapshot calls. After
  // shipping (1) alone the bug recurred — the cache only cleared when an
  // operator manually purged it. (2)+(3) defend against that recurrence.
  private async fetchLiveIssueState(owner: string, name: string, n: number): Promise<string> {
    const init: RequestInit & { cache?: string } = {
      method: "GET",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ci-dashboard-mcp",
        "X-GitHub-Api-Version": "2022-11-28",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    };
    const url = `https://api.github.com/repos/${owner}/${name}/issues/${n}?_=${Date.now()}`;
    const res = await fetch(url, init as RequestInit);
    if (!res.ok) {
      throw new Error(`GitHub /issues/${n} returned ${res.status}`);
    }
    const body = await res.json() as { state?: string };
    return body.state ?? "open";
  }

  private broadcastFromCache(): void {
    const statuses = this.computeStatuses();
    this.broadcastEnvelope({ type: "ci-statuses", data: statuses });
  }

  private broadcastAlerts(): void {
    this.broadcastEnvelope({
      type: "release-alerts",
      data: [...this.alerts.values()],
    });
  }

  private broadcastEnvelope(envelope: WsEnvelope): void {
    this.broadcast(JSON.stringify(envelope));
  }

  broadcast(data: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Client disconnected
      }
    }
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }
}
