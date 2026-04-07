import { DurableObject } from "cloudflare:workers";
import type { CIStatus, JobStatus } from "./webhook";
import type { Env } from "./index";

export class CIDashboardHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
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

    // Serialized KV mutations — all go through the singleton DO
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
      await this.updateRun(payload);
      await this.broadcastStatuses();
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
      await this.updateJob(payload);
      await this.broadcastStatuses();
      return new Response("OK");
    }

    if (url.pathname === "/delete-run") {
      const { run_id } = await request.json<{ run_id: number }>();
      await this.env.CI_STATUS.delete(`run:${run_id}`);
      await this.broadcastStatuses();
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
    const key = `run:${run.id}`;
    const existing = await this.env.CI_STATUS.get(key);

    if (existing) {
      const prev = JSON.parse(existing) as CIStatus;
      prev.status = run.status;
      prev.conclusion = run.conclusion;
      prev.updated_at = run.updated_at;
      // When run completes, fix stale in_progress/queued jobs
      if (run.status === "completed" && prev.jobs) {
        for (const job of prev.jobs) {
          if (job.status === "in_progress" || job.status === "queued") {
            job.status = "completed";
            job.conclusion = job.conclusion ?? "skipped";
          }
        }
      }
      await this.env.CI_STATUS.put(key, JSON.stringify(prev), {
        expirationTtl: 86400,
      });
    } else {
      const status: CIStatus = {
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
      await this.env.CI_STATUS.put(key, JSON.stringify(status), {
        expirationTtl: 86400,
      });
    }
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
    const key = `run:${job.run_id}`;
    const existing = await this.env.CI_STATUS.get(key);
    if (!existing) return;

    const status = JSON.parse(existing) as CIStatus;
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

    await this.env.CI_STATUS.put(key, JSON.stringify(status), {
      expirationTtl: 86400,
    });
  }

  private async broadcastStatuses(): Promise<void> {
    const { getAllStatuses } = await import("./status");
    const statuses = await getAllStatuses(this.env);
    this.broadcast(JSON.stringify(statuses));
  }

  broadcast(data: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Client disconnected, will be cleaned up by webSocketClose
      }
    }
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Clients don't send meaningful messages, ignore
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }
}
