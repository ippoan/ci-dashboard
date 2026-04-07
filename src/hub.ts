import { DurableObject } from "cloudflare:workers";
import type { CIStatus, JobStatus } from "./webhook";
import type { Env } from "./index";

export class CIDashboardHub extends DurableObject<Env> {
  // In-memory cache: run_id → CIStatus
  private cache = new Map<number, CIStatus>();
  private cacheLoaded = false;

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

  private broadcastFromCache(): void {
    const statuses = this.computeStatuses();
    this.broadcast(JSON.stringify(statuses));
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
