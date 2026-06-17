import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, {
  _resetAutoRecheckState,
  autoRecheckStale,
  STALE_IN_PROGRESS_MS,
  RECHECK_COOLDOWN_MS,
} from "../src/index";
import type { Env } from "../src/index";
import type { CIStatus } from "../src/webhook";
import {
  appTestEnv,
  seedTestTokens,
  clearTestTokens,
  TEST_GITHUB_TOKEN,
} from "./_helpers/app-env";

const WEBHOOK_SECRET = "test-secret";

// Hub mock that responds to /snapshot the same way Hub.computeStatuses() does:
// read everything in KV under `run:`, no eviction. /update-run and /update-job
// upsert KV directly so recheck's effect is observable from the test.
function mockHub(kv: KVNamespace): DurableObjectStub {
  const handler = async (req: Request) => {
    const url = new URL(req.url);

    if (url.pathname === "/snapshot") {
      const list = await kv.list({ prefix: "run:" });
      const values = await Promise.all(list.keys.map((k) => kv.get(k.name)));
      const statuses = values
        .filter((v): v is string => v !== null)
        .map((v) => JSON.parse(v) as CIStatus);
      return Response.json({ statuses, alerts: [] });
    }

    if (url.pathname === "/update-run") {
      const { run, repo } = (await req.json()) as {
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
      };
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
      await kv.put(`run:${run.id}`, JSON.stringify(status));
      return new Response("OK");
    }

    if (url.pathname === "/update-job") {
      return new Response("OK");
    }

    return new Response("OK");
  };
  return { fetch: handler } as unknown as DurableObjectStub;
}

function testEnv(): Env {
  const hub = mockHub(env.CI_STATUS);
  return {
    ...appTestEnv(),
    WEBHOOK_SECRET: {
      get: async () => WEBHOOK_SECRET,
    } as unknown as SecretsStoreSecret,
    CI_HUB: {
      idFromName: () => ({}),
      get: () => hub,
    } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("OK") }),
    } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: {
      get: async () => "test-webhook-secret",
    } as unknown as SecretsStoreSecret,
  } as Env;
}

const FAKE_NOW = new Date("2026-06-17T12:00:00Z").getTime();

// recheck の GitHub API 呼びを「completed/success」にすり替える stub fetch。
// /actions/runs/{id} と /jobs を識別し、それ以外の URL は throw して
// 想定外の通信を検知する。
function stubGitHubFetch(opts: {
  runId: number;
  status: string;
  conclusion: string | null;
  updatedAt: string;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (
      url ===
      `https://api.github.com/repos/ippoan/mcp-cf-workers/actions/runs/${opts.runId}`
    ) {
      return Response.json({
        id: opts.runId,
        name: "Deploy",
        head_branch: "main",
        status: opts.status,
        conclusion: opts.conclusion,
        html_url: `https://github.com/ippoan/mcp-cf-workers/actions/runs/${opts.runId}`,
        actor: { login: "yhonda-ohishi" },
        updated_at: opts.updatedAt,
        run_started_at: opts.updatedAt,
      });
    }
    if (
      url ===
      `https://api.github.com/repos/ippoan/mcp-cf-workers/actions/runs/${opts.runId}/jobs`
    ) {
      return Response.json({ jobs: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("autoRecheckStale", () => {
  beforeEach(async () => {
    _resetAutoRecheckState();
    await clearTestTokens();
    await seedTestTokens();
    // Wipe leftover run:* keys between tests so each starts from clean state.
    const list = await env.CI_STATUS.list({ prefix: "run:" });
    await Promise.all(list.keys.map((k) => env.CI_STATUS.delete(k.name)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1h 超の in_progress を recheck で completed に書き換える", async () => {
    // worker.fetch 経路は Date.now() を使うので updated_at も real-time anchored
    // にしておく (FAKE_NOW は autoRecheckStale を直接呼ぶ test 用)。
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const stale: CIStatus = {
      repo: "ippoan/mcp-cf-workers",
      workflow: "Deploy",
      branch: "main",
      status: "in_progress",
      conclusion: null,
      run_id: 5001,
      run_url: "https://github.com/ippoan/mcp-cf-workers/actions/runs/5001",
      actor: "yhonda-ohishi",
      updated_at: twoHoursAgo,
      started_at: twoHoursAgo,
    };
    await env.CI_STATUS.put(`run:${stale.run_id}`, JSON.stringify(stale));

    const fetchSpy = stubGitHubFetch({
      runId: 5001,
      status: "completed",
      conclusion: "success",
      updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const e = testEnv();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/snapshot"),
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    // GitHub run + jobs endpoints がそれぞれ 1 回ずつ叩かれた
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://api.github.com/repos/ippoan/mcp-cf-workers/actions/runs/5001",
    );
    const authHeader = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> })
      .headers.Authorization;
    expect(authHeader).toBe(`Bearer ${TEST_GITHUB_TOKEN}`);

    // KV (= hub cache 相当) に completed が反映されている
    const updated = JSON.parse(
      (await env.CI_STATUS.get("run:5001"))!,
    ) as CIStatus;
    expect(updated.status).toBe("completed");
    expect(updated.conclusion).toBe("success");
  });

  it("1h 未満の in_progress は recheck しない", async () => {
    const fresh: CIStatus = {
      repo: "ippoan/mcp-cf-workers",
      workflow: "Deploy",
      branch: "main",
      status: "in_progress",
      conclusion: null,
      run_id: 5002,
      run_url: "https://github.com/ippoan/mcp-cf-workers/actions/runs/5002",
      actor: "yhonda-ohishi",
      updated_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    };
    await env.CI_STATUS.put(`run:${fresh.run_id}`, JSON.stringify(fresh));

    const fetchSpy = vi.fn(async () => {
      throw new Error("fresh runs must not trigger recheck");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/snapshot"),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("completed の run は age に関係なく recheck しない", async () => {
    const old: CIStatus = {
      repo: "ippoan/mcp-cf-workers",
      workflow: "Deploy",
      branch: "main",
      status: "completed",
      conclusion: "success",
      run_id: 5003,
      run_url: "https://github.com/ippoan/mcp-cf-workers/actions/runs/5003",
      actor: "yhonda-ohishi",
      updated_at: new Date(FAKE_NOW - 5 * 24 * 60 * 60 * 1000).toISOString(),
      started_at: new Date(FAKE_NOW - 5 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await env.CI_STATUS.put(`run:${old.run_id}`, JSON.stringify(old));

    const fetchSpy = vi.fn(async () => {
      throw new Error("completed must not be rechecked");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/snapshot"),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("per-run cooldown で 10 分以内の連続 recheck を dedupe する", async () => {
    const hub = mockHub(env.CI_STATUS);
    const e = {
      ...appTestEnv(),
      CI_HUB: { idFromName: () => ({}), get: () => hub },
    } as unknown as Env;

    const body = JSON.stringify({
      statuses: [
        {
          run_id: 5004,
          repo: "ippoan/mcp-cf-workers",
          status: "in_progress",
          updated_at: new Date(FAKE_NOW - 3 * 60 * 60 * 1000).toISOString(),
        },
      ],
      alerts: [],
    });

    const fetchSpy = stubGitHubFetch({
      runId: 5004,
      status: "in_progress",
      conclusion: null,
      updatedAt: new Date(FAKE_NOW - 3 * 60 * 60 * 1000).toISOString(),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await autoRecheckStale(e, hub, body, FAKE_NOW);
    await autoRecheckStale(e, hub, body, FAKE_NOW + 5 * 60 * 1000); // 5min later, still cooled down
    // run + jobs の 2 call が 1 回分だけ
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // cooldown を抜けた後の呼び出しは通る
    await autoRecheckStale(e, hub, body, FAKE_NOW + RECHECK_COOLDOWN_MS + 1);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("壊れた snapshot body は silent に skip する", async () => {
    const hub = mockHub(env.CI_STATUS);
    const e = {
      ...appTestEnv(),
      CI_HUB: { idFromName: () => ({}), get: () => hub },
    } as unknown as Env;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      autoRecheckStale(e, hub, "not-json", FAKE_NOW),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("STALE_IN_PROGRESS_MS / RECHECK_COOLDOWN_MS は 1h / 10min", () => {
    expect(STALE_IN_PROGRESS_MS).toBe(60 * 60 * 1000);
    expect(RECHECK_COOLDOWN_MS).toBe(10 * 60 * 1000);
  });
});
