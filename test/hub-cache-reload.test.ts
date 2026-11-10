import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { CIDashboardHub, loadRunCache, RUN_CACHE_BULK_GET_SIZE } from "../src/hub";
import type { CIStatus } from "../src/webhook";

// Hub DO は hibernatable WebSocket のため、アイドルでメモリから追い出され、
// 次の要求で ensureCache() が KV の run:* を読み直す。その読み直しで 0 件に
// なり Dashboard が空になった (Refs #523)。

const PREFIX_REPO = "c9-reload";

function mkRun(run_id: number, repo: string, updated_at: string): CIStatus {
  return {
    repo,
    workflow: "CI",
    branch: "main",
    status: "completed",
    conclusion: "success",
    run_id,
    run_url: `https://github.com/${repo}/actions/runs/${run_id}`,
    actor: "yhonda-ohishi",
    updated_at,
    started_at: updated_at,
  };
}

function hubNs(): DurableObjectNamespace<CIDashboardHub> {
  return (env as unknown as { CI_HUB: DurableObjectNamespace<CIDashboardHub> }).CI_HUB;
}

describe("Hub DO の run cache を KV から読み直す (Refs #523)", () => {
  it("bulk get の 1 回分 (100) を超える run を、追い出しのあとも全件読み直す", async () => {
    const REPOS = 7;
    const N = RUN_CACHE_BULK_GET_SIZE * 2 + 37; // 3 chunk にまたがる
    for (let i = 0; i < N; i++) {
      const repo = `ippoan/${PREFIX_REPO}-${i % REPOS}`;
      const ts = new Date(Date.UTC(2026, 10, 10, 0, 0, i)).toISOString();
      await env.CI_STATUS.put(`run:${900000 + i}`, JSON.stringify(mkRun(900000 + i, repo, ts)));
    }

    const ns = hubNs();
    const stub = ns.get(ns.idFromName("c9-cache-reload"));

    const repos = async () => {
      const res = await stub.fetch(new Request("http://hub/statuses"));
      const body = (await res.json()) as CIStatus[];
      return body.filter((s) => s.repo.includes(PREFIX_REPO));
    };

    // 1 回目 (DO の生成直後)
    const first = await repos();
    expect(first).toHaveLength(REPOS);

    // hibernation による追い出しを模す: in-memory の cache を捨てる
    await runInDurableObject(stub, async (instance) => {
      const h = instance as unknown as { cache: Map<number, CIStatus>; cacheLoaded: boolean };
      expect(h.cache.size).toBeGreaterThanOrEqual(N);
      h.cache = new Map();
      h.cacheLoaded = false;
    });

    // 2 回目: KV から全件読み直し、各 repo の最新 run が返る
    const second = await repos();
    expect(second).toHaveLength(REPOS);
    for (const s of second) {
      const idx = s.run_id - 900000;
      // 各 repo で最大の index (= 最新) が選ばれている
      expect(idx + REPOS).toBeGreaterThanOrEqual(N);
    }
    await runInDurableObject(stub, async (instance) => {
      const h = instance as unknown as { cache: Map<number, CIStatus> };
      expect(h.cache.size).toBeGreaterThanOrEqual(N);
    });
  });

  it("起き抜けに同時に来た要求は 1 回の読み込みに束ねる", async () => {
    await env.CI_STATUS.put("run:910001", JSON.stringify(mkRun(910001, "ippoan/c9-conc", "2026-11-10T01:00:00Z")));
    const ns = hubNs();
    const stub = ns.get(ns.idFromName("c9-cache-concurrent"));
    const [a, b] = await Promise.all([
      stub.fetch(new Request("http://hub/statuses")),
      stub.fetch(new Request("http://hub/snapshot")),
    ]);
    const sa = (await a.json()) as CIStatus[];
    const sb = (await b.json()) as { statuses: CIStatus[] };
    expect(sa.some((s) => s.run_id === 910001)).toBe(true);
    expect(sb.statuses.some((s) => s.run_id === 910001)).toBe(true);
  });
});

describe("Hub DO: 読み込みに失敗した chunk があれば読み切ったことにしない", () => {
  it("1 回目の bulk get が落ちても、次の要求で読み直して全件そろう", async () => {
    const values: Record<string, string> = {};
    for (let i = 0; i < 150; i++) {
      values[`run:${2000 + i}`] = JSON.stringify(mkRun(2000 + i, `ippoan/c9-fail-${i % 3}`, "2026-11-10T00:00:00Z"));
    }
    const failing = fakeKv({ values, pageSize: 1000, failChunkAt: 0 });
    const ns = hubNs();
    const stub = ns.get(ns.idFromName("c9-cache-fail"));
    await runInDurableObject(stub, async (instance) => {
      const h = instance as unknown as { env: Record<string, unknown> };
      h.env = { ...h.env, CI_STATUS: failing.kv };
    });
    await stub.fetch(new Request("http://hub/statuses"));
    await runInDurableObject(stub, async (instance) => {
      const h = instance as unknown as { cache: Map<number, CIStatus>; cacheLoaded: boolean };
      expect(h.cacheLoaded).toBe(false);
      expect(h.cache.size).toBe(50);
    });
    // 次の要求: fakeKv は 1 回目 (index 0) だけ落ちる
    const res = await stub.fetch(new Request("http://hub/statuses"));
    const body = (await res.json()) as CIStatus[];
    expect(body).toHaveLength(3);
    await runInDurableObject(stub, async (instance) => {
      const h = instance as unknown as { cache: Map<number, CIStatus>; cacheLoaded: boolean };
      expect(h.cacheLoaded).toBe(true);
      expect(h.cache.size).toBe(150);
    });
  });
});

/** list / bulk get の挙動を差し込める最小の KV */
function fakeKv(opts: {
  values: Record<string, string>;
  pageSize: number;
  failChunkAt?: number;
}): { kv: KVNamespace; bulkCalls: number[] } {
  const names = Object.keys(opts.values).sort();
  const bulkCalls: number[] = [];
  const kv = {
    async list({ cursor }: { prefix?: string; cursor?: string }) {
      const start = cursor ? Number(cursor) : 0;
      const keys = names.slice(start, start + opts.pageSize).map((name) => ({ name }));
      const next = start + opts.pageSize;
      return next >= names.length
        ? { keys, list_complete: true, cacheStatus: null }
        : { keys, list_complete: false, cursor: String(next), cacheStatus: null };
    },
    async get(keys: string[] | string) {
      if (!Array.isArray(keys)) throw new Error("single get must not be used");
      bulkCalls.push(keys.length);
      if (opts.failChunkAt !== undefined && bulkCalls.length - 1 === opts.failChunkAt) {
        throw new Error("simulated KV failure");
      }
      return new Map(keys.map((k) => [k, opts.values[k] ?? null]));
    },
  };
  return { kv: kv as unknown as KVNamespace, bulkCalls };
}

describe("loadRunCache", () => {
  const values: Record<string, string> = {};
  for (let i = 0; i < 250; i++) {
    values[`run:${1000 + i}`] = JSON.stringify(mkRun(1000 + i, "ippoan/x", "2026-11-10T00:00:00Z"));
  }

  it("list の cursor を最後まで辿り、get は 100 key ずつの bulk get にする", async () => {
    const { kv, bulkCalls } = fakeKv({ values, pageSize: 60 });
    const r = await loadRunCache(kv);
    expect(r.pages).toBe(5);
    expect(r.listed).toBe(250);
    expect(r.loaded).toBe(250);
    expect(r.failed).toBe(0);
    expect(bulkCalls).toEqual([100, 100, 50]);
  });

  it("壊れた値と消えた値は数えて飛ばす", async () => {
    const v = { ...values, "run:9999": "{not json" };
    const { kv } = fakeKv({ values: v, pageSize: 1000 });
    // list に居るが get で null になる key を作る
    const origGet = kv.get.bind(kv);
    (kv as unknown as { get: unknown }).get = async (keys: string[]) => {
      const m = (await (origGet as (k: string[]) => Promise<Map<string, string | null>>)(keys));
      if (m.has("run:1000")) m.set("run:1000", null);
      return m;
    };
    const r = await loadRunCache(kv);
    expect(r.listed).toBe(251);
    expect(r.loaded).toBe(249);
    expect(r.missing).toBe(1);
    expect(r.corrupt).toBe(1);
  });

  it("bulk get が throw した chunk は failed に数え、残りは読む", async () => {
    const { kv } = fakeKv({ values, pageSize: 1000, failChunkAt: 1 });
    const r = await loadRunCache(kv);
    expect(r.failed).toBe(100);
    expect(r.loaded).toBe(150);
  });
});
