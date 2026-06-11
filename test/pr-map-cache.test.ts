import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { appTestEnv } from "./_helpers/app-env";
import {
  loadPrMap,
  refreshPrMap,
  applyPullRequestEvent,
  PR_MAP_CACHE_KEY,
  __testing,
  type PrMapWebhookPayload,
} from "../src/pr-map-cache";
import {
  setRateLimitBackoff,
  getRateLimitBackoff,
  __testing as backoffTesting,
} from "../src/github-backoff";
import { GitHubApiError } from "../src/github-api";
import type { IssuePrRef } from "../src/issue-prs";

const ORGS = ["ippoan", "ohishi-exp"];
const YHONDA = ["yhonda-ohishi/claude-skills"];

function testEnv(): AuthClientWorkerEnv {
  return appTestEnv() as unknown as AuthClientWorkerEnv;
}

/** /search/issues (is:pr) を空 result で stub。失敗させたい時は status を渡す。 */
function stubPrSearch(opts: { status?: number; bodyText?: string } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
    const url = typeof req === "string" ? req : (req as Request).url;
    if (!url.includes("/search/issues")) {
      return new Response("not stubbed: " + url, { status: 500 });
    }
    if (opts.status) {
      return new Response(opts.bodyText ?? "rate limited", { status: opts.status });
    }
    return Response.json({ total_count: 0, incomplete_results: false, items: [] });
  });
}

function prRef(over: Partial<IssuePrRef> = {}): IssuePrRef {
  return {
    repo: "ippoan/x",
    number: 42,
    title: "feat: y",
    url: "https://github.com/ippoan/x/pull/42",
    draft: false,
    updated_at: "2026-06-01T00:00:00Z",
    state: "open",
    ...over,
  };
}

interface StoredEntry {
  storedAt: number;
  patchedAt?: number;
  data: Record<string, IssuePrRef[]>;
}

async function seedMap(data: Record<string, IssuePrRef[]>, storedAt = Date.now()): Promise<void> {
  await env.CI_STATUS.put(PR_MAP_CACHE_KEY, JSON.stringify({ storedAt, data }));
}

async function readMap(): Promise<StoredEntry | null> {
  return await env.CI_STATUS.get(PR_MAP_CACHE_KEY, "json") as StoredEntry | null;
}

function prPayload(over: {
  action?: string;
  number?: number;
  merged?: boolean;
  title?: string;
  body?: string | null;
  draft?: boolean;
  repo?: string;
} = {}): PrMapWebhookPayload {
  const { action = "opened", number = 42, merged = false, title, body, draft, repo = "ippoan/x" } = over;
  return {
    action,
    pull_request: {
      number,
      merged,
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(draft !== undefined ? { draft } : {}),
      html_url: `https://github.com/${repo}/pull/${number}`,
      updated_at: "2026-06-10T00:00:00Z",
    },
    repository: { full_name: repo },
  };
}

beforeEach(async () => {
  await env.CI_STATUS.delete(PR_MAP_CACHE_KEY);
  await env.CI_STATUS.delete(__testing.REFRESH_LOCK_KEY);
  await env.CI_STATUS.delete(backoffTesting.BACKOFF_KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadPrMap (SWR)", () => {
  it("fresh cache: fetch せず即返し (refreshing=false)", async () => {
    const fetchSpy = stubPrSearch();
    await seedMap({ "ippoan/x#7": [prRef()] });
    const ctx = createExecutionContext();
    const res = await loadPrMap(testEnv(), ORGS, YHONDA, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.refreshing).toBe(false);
    expect(res.stale).toBe(false);
    expect(res.map.get("ippoan/x#7")).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stale cache: 旧データ即返し + refreshing=true、background で fetch + storedAt 更新", async () => {
    const fetchSpy = stubPrSearch();
    const oldStoredAt = Date.now() - (__testing.PR_MAP_FRESH_SECONDS + 10) * 1000;
    await seedMap({ "ippoan/x#7": [prRef()] }, oldStoredAt);
    const ctx = createExecutionContext();
    const res = await loadPrMap(testEnv(), ORGS, YHONDA, ctx);
    // 即返し: 旧データのまま
    expect(res.refreshing).toBe(true);
    expect(res.map.get("ippoan/x#7")).toHaveLength(1);
    // background refresh の完了後に storedAt が進み、4 call fetch 済み
    await waitOnExecutionContext(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const entry = await readMap();
    expect(entry!.storedAt).toBeGreaterThan(oldStoredAt);
  });

  it("stale + background 403: 即返しは成功、backoff marker が立つ (waitUntil reject しない)", async () => {
    stubPrSearch({ status: 403, bodyText: "API rate limit exceeded" });
    const oldStoredAt = Date.now() - (__testing.PR_MAP_FRESH_SECONDS + 10) * 1000;
    await seedMap({ "ippoan/x#7": [prRef()] }, oldStoredAt);
    const ctx = createExecutionContext();
    const res = await loadPrMap(testEnv(), ORGS, YHONDA, ctx);
    expect(res.map.size).toBe(1);
    // pre-catch されているので waitOnExecutionContext は throw しない
    await waitOnExecutionContext(ctx);
    expect(await getRateLimitBackoff(env.CI_STATUS)).not.toBeNull();
    // storedAt は失敗時に進まない
    const entry = await readMap();
    expect(entry!.storedAt).toBe(oldStoredAt);
  });

  it("cold start (cache 無し): 同期 fetch せず loading flag + 背景 refresh (Refs #323)", async () => {
    stubPrSearch({ status: 403, bodyText: "API rate limit exceeded" });
    const ctx = createExecutionContext();
    const res = await loadPrMap(testEnv(), ORGS, YHONDA, ctx);
    // SSR をブロックしない: 即 loading で返る
    expect(res.map.size).toBe(0);
    expect(res.loading).toBe(true);
    expect(res.error).toBeNull();
    // 背景 refresh の失敗 (403) は backoff を立てる (waitUntil reject しない)
    await waitOnExecutionContext(ctx);
    expect(await getRateLimitBackoff(env.CI_STATUS)).not.toBeNull();
  });

  it("cold start: 背景 refresh 成功後の 2 回目は cache から chips を返す (Refs #323)", async () => {
    stubPrSearch();
    const ctx1 = createExecutionContext();
    const cold = await loadPrMap(testEnv(), ORGS, YHONDA, ctx1);
    expect(cold.loading).toBe(true);
    await waitOnExecutionContext(ctx1);

    const ctx2 = createExecutionContext();
    const warm = await loadPrMap(testEnv(), ORGS, YHONDA, ctx2);
    await waitOnExecutionContext(ctx2);
    // 背景 refresh が cache を作っているので 2 回目は loading しない
    expect(warm.loading).toBe(false);
    expect(await readMap()).not.toBeNull();
  });
});

describe("refreshPrMap (short-circuits)", () => {
  it("backoff 中は fetch しない", async () => {
    const fetchSpy = stubPrSearch();
    await setRateLimitBackoff(env.CI_STATUS, new GitHubApiError(403, "rate limit"));
    await refreshPrMap(testEnv(), ORGS, YHONDA);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("soft lock 中は fetch しない", async () => {
    const fetchSpy = stubPrSearch();
    await env.CI_STATUS.put(__testing.REFRESH_LOCK_KEY, "1", { expirationTtl: 60 });
    await refreshPrMap(testEnv(), ORGS, YHONDA);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lock 取得後に fresh entry を見つけたら bail", async () => {
    const fetchSpy = stubPrSearch();
    await seedMap({}, Date.now()); // fresh
    await refreshPrMap(testEnv(), ORGS, YHONDA);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("applyPullRequestEvent (pull_request webhook patch)", () => {
  it("cache 不在は no-op (entry を作らない)", async () => {
    await applyPullRequestEvent(env.CI_STATUS, prPayload({ title: "t", body: "Refs #7" }));
    expect(await readMap()).toBeNull();
  });

  it("opened + Refs #7: 該当 issue key に追加、storedAt 不変 + patchedAt 付与", async () => {
    const storedAt = Date.now() - 1000;
    await seedMap({}, storedAt);
    await applyPullRequestEvent(
      env.CI_STATUS,
      prPayload({ action: "opened", title: "feat: y", body: "Refs #7" }),
    );
    const entry = await readMap();
    expect(entry!.storedAt).toBe(storedAt);
    expect(entry!.patchedAt).toBeGreaterThan(0);
    expect(entry!.data["ippoan/x#7"]).toHaveLength(1);
    expect(entry!.data["ippoan/x#7"]![0]!.state).toBe("open");
  });

  it("closed + merged: state が merged に変わる", async () => {
    await seedMap({ "ippoan/x#7": [prRef()] });
    await applyPullRequestEvent(
      env.CI_STATUS,
      prPayload({ action: "closed", merged: true, title: "feat: y", body: "Refs #7" }),
    );
    const entry = await readMap();
    expect(entry!.data["ippoan/x#7"]).toHaveLength(1);
    expect(entry!.data["ippoan/x#7"]![0]!.state).toBe("merged");
  });

  it("closed + unmerged: 全 key から除去 (空 key は削除)", async () => {
    await seedMap({ "ippoan/x#7": [prRef()] });
    await applyPullRequestEvent(
      env.CI_STATUS,
      prPayload({ action: "closed", merged: false, title: "feat: y", body: "Refs #7" }),
    );
    const entry = await readMap();
    expect(entry!.data["ippoan/x#7"]).toBeUndefined();
  });

  it("edited で ref を #7→#8 に移動: 旧 key から消えて新 key に現れる", async () => {
    await seedMap({ "ippoan/x#7": [prRef()] });
    await applyPullRequestEvent(
      env.CI_STATUS,
      prPayload({ action: "edited", title: "feat: y", body: "Refs #8" }),
    );
    const entry = await readMap();
    expect(entry!.data["ippoan/x#7"]).toBeUndefined();
    expect(entry!.data["ippoan/x#8"]).toHaveLength(1);
  });

  it("title 無し最小 payload は除去のみ (既存 fixture 互換)", async () => {
    await seedMap({ "ippoan/x#7": [prRef()] });
    await applyPullRequestEvent(env.CI_STATUS, prPayload({ action: "closed", merged: true }));
    const entry = await readMap();
    expect(entry!.data["ippoan/x#7"]).toBeUndefined();
  });

  it("対象外 action (synchronize) は no-op (patchedAt 付かない)", async () => {
    await seedMap({ "ippoan/x#7": [prRef()] });
    await applyPullRequestEvent(
      env.CI_STATUS,
      prPayload({ action: "synchronize", title: "feat: y", body: "Refs #99" }),
    );
    const entry = await readMap();
    expect(entry!.patchedAt).toBeUndefined();
    expect(entry!.data["ippoan/x#7"]).toHaveLength(1);
  });

  it("他 repo の同番号 PR は除去しない", async () => {
    await seedMap({
      "ippoan/x#7": [prRef(), prRef({ repo: "ippoan/other", url: "https://github.com/ippoan/other/pull/42" })],
    });
    await applyPullRequestEvent(
      env.CI_STATUS,
      prPayload({ action: "closed", merged: false, title: "t", body: "Refs #7" }),
    );
    const entry = await readMap();
    expect(entry!.data["ippoan/x#7"]).toHaveLength(1);
    expect(entry!.data["ippoan/x#7"]![0]!.repo).toBe("ippoan/other");
  });
});
