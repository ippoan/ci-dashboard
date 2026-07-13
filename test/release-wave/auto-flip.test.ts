import { describe, it, expect, vi, afterEach } from "vitest";

import {
  armAutoFlip,
  getAutoFlipArm,
  clearAutoFlipArm,
  computeArmProgress,
  maybeAutoFlip,
  handleReleaseWaveAutoFlipArm,
  handleReleaseWaveAutoFlipDisarm,
  type AutoFlipArmRecord,
} from "../../src/release-wave/auto-flip";
import { renderAutoFlipControls } from "../../src/release-wave/repo-status-section";
import type { Env } from "../../src/index";

// ----------------------------------------------------------------------------
// harness: in-memory COMPAT_KV + fake env (github token は KV cache hit で回避)
// ----------------------------------------------------------------------------

function memKv(seed: Record<string, unknown> = {}): KVNamespace {
  const store = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  return {
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

const FRESH_TOKEN = {
  token: "ghs_auto_flip_token",
  expires_at_ms: Date.now() + 3600_000,
};

function envWith(compatKv?: KVNamespace): Env {
  return {
    COMPAT_KV: compatKv,
    // getGitHubToken の KV cache hit 用 (introspect fetch を回避)。
    CI_STATUS: memKv({ "auth-client-worker:gh-token": FRESH_TOKEN }),
    INTERNAL_SHARED_SECRET: { get: async () => "secret" },
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({}) },
  } as unknown as Env;
}

/** pending-release:: record (tag 付き = release 完了) を作る。 */
function pending(repo: string, tag: string): Record<string, unknown> {
  return {
    schema_version: 1,
    repo,
    version_id: `${repo}-vid`,
    tag,
    preview_url: null,
    uploaded_at: "2026-07-13T00:00:00.000Z",
  };
}

/** armed record を作る。 */
function arm(
  repos: string[],
  overrides: Partial<AutoFlipArmRecord> = {},
): AutoFlipArmRecord {
  return {
    schema_version: 1,
    repos,
    armed_at: "2026-07-13T00:00:00.000Z",
    expires_at: "2026-07-13T00:30:00.000Z",
    actor: "me@example.com",
    status: "armed",
    blocked_reason: null,
    ...overrides,
  };
}

/** 非互換 (checked && !verified) を作る backend/frontend record 群。 */
function redCompat(): Record<string, unknown> {
  return {
    "backend::ippoan/rust-alc-api": {
      schema_version: 1,
      repo: "ippoan/rust-alc-api",
      current_image: "cur-img",
      deployed_at: "2026-07-13T00:00:00Z",
      deployed_by: "x",
      wave_id: null,
    },
    "frontend::ippoan/alc-app": {
      schema_version: 1,
      repo: "ippoan/alc-app",
      prod_version: "v1.0.0",
      prod_deployed_at: "2026-07-13T00:00:00Z",
      tested_against: [
        {
          backend_repo: "ippoan/rust-alc-api",
          backend_image: "stale-img",
          tested_at: "2026-07-13T00:00:00Z",
        },
      ],
    },
  };
}

// ----------------------------------------------------------------------------
// armAutoFlip / getAutoFlipArm / clearAutoFlipArm
// ----------------------------------------------------------------------------

describe("armAutoFlip / get / clear", () => {
  it("repos を dedup + sort して expires_at を armed_at + ttl で持つ", async () => {
    const kv = memKv();
    const env = envWith(kv);
    const rec = await armAutoFlip(env, {
      repos: ["ippoan/b", "ippoan/a", "ippoan/b"],
      actor: "me@example.com",
      now: "2026-07-13T00:00:00.000Z",
      ttlSeconds: 1800,
    });
    expect(rec?.repos).toEqual(["ippoan/a", "ippoan/b"]);
    expect(rec?.expires_at).toBe("2026-07-13T00:30:00.000Z");
    expect(rec?.status).toBe("armed");

    const loaded = await getAutoFlipArm(env);
    expect(loaded?.repos).toEqual(["ippoan/a", "ippoan/b"]);

    await clearAutoFlipArm(env);
    expect(await getAutoFlipArm(env)).toBeNull();
  });

  it("COMPAT_KV 未 bind なら null / no-op", async () => {
    const env = envWith(undefined);
    expect(
      await armAutoFlip(env, { repos: ["a"], actor: "x", now: "2026-07-13T00:00:00.000Z" }),
    ).toBeNull();
    expect(await getAutoFlipArm(env)).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// computeArmProgress
// ----------------------------------------------------------------------------

describe("computeArmProgress", () => {
  it("pending に載った repo だけ released、全部揃えば ready", async () => {
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
      "pending-release::ippoan/b": pending("ippoan/b", "v2.0.0"),
    });
    const env = envWith(kv);
    const p = await computeArmProgress(env, arm(["ippoan/a", "ippoan/b"]));
    expect(p.total).toBe(2);
    expect(p.released).toBe(2);
    expect(p.ready).toBe(true);
    expect(p.pendingRepos).toEqual([]);
  });

  it("一部だけ pending なら ready=false で残りを返す", async () => {
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(kv);
    const p = await computeArmProgress(env, arm(["ippoan/a", "ippoan/b"]));
    expect(p.released).toBe(1);
    expect(p.ready).toBe(false);
    expect(p.pendingRepos).toEqual(["ippoan/b"]);
  });
});

// ----------------------------------------------------------------------------
// maybeAutoFlip
// ----------------------------------------------------------------------------

describe("maybeAutoFlip", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("armed 無しなら none (dispatch しない)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const env = envWith(memKv());
    expect(await maybeAutoFlip(env, "2026-07-13T00:10:00.000Z")).toEqual({
      action: "none",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("期限超過なら armed を clear して expired", async () => {
    const kv = memKv({
      "auto-flip-arm::latest": arm(["ippoan/a"], {
        expires_at: "2026-07-13T00:00:00.000Z",
      }),
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(kv);
    // now が expires_at より後。
    const out = await maybeAutoFlip(env, "2026-07-13T01:00:00.000Z");
    expect(out).toEqual({ action: "expired" });
    expect(await getAutoFlipArm(env)).toBeNull();
  });

  it("全 repo 揃っていなければ none", async () => {
    const kv = memKv({
      "auto-flip-arm::latest": arm(["ippoan/a", "ippoan/b"]),
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(kv);
    const out = await maybeAutoFlip(env, "2026-07-13T00:10:00.000Z");
    expect(out).toEqual({ action: "none" });
    // armed は残る。
    expect((await getAutoFlipArm(env))?.status).toBe("armed");
  });

  it("全 repo 揃い compat gate OK (backend 無し) なら flip all を発火して clear", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv({
      "auto-flip-arm::latest": arm(["ippoan/a", "ippoan/b"]),
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
      "pending-release::ippoan/b": pending("ippoan/b", "v2.0.0"),
    });
    const env = envWith(kv);
    const out = await maybeAutoFlip(env, "2026-07-13T00:10:00.000Z");
    expect(out).toEqual({ action: "flipped", flipped: 2 });
    // dispatch が 2 repo に飛ぶ。
    const dispatched = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(dispatched.some((u) => u.includes("/repos/ippoan/a/dispatches"))).toBe(true);
    expect(dispatched.some((u) => u.includes("/repos/ippoan/b/dispatches"))).toBe(true);
    // armed は clear される。
    expect(await getAutoFlipArm(env)).toBeNull();
  });

  it("compat 非互換 (checked && !verified) なら flip せず blocked に落とす", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv({
      "auto-flip-arm::latest": arm(["ippoan/a"]),
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
      ...redCompat(),
    });
    const env = envWith(kv);
    const out = await maybeAutoFlip(env, "2026-07-13T00:10:00.000Z");
    expect(out.action).toBe("blocked");
    // dispatch は飛ばない。
    expect(fetchSpy).not.toHaveBeenCalled();
    // armed は blocked に更新され残る。
    const after = await getAutoFlipArm(env);
    expect(after?.status).toBe("blocked");
    expect(after?.blocked_reason).toContain("compatibility");
  });

  it("既に blocked なら再判定せず none", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv({
      "auto-flip-arm::latest": arm(["ippoan/a"], {
        status: "blocked",
        blocked_reason: "compatibility 未検証: x",
      }),
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(kv);
    expect(await maybeAutoFlip(env, "2026-07-13T00:10:00.000Z")).toEqual({
      action: "none",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// renderAutoFlipControls
// ----------------------------------------------------------------------------

describe("renderAutoFlipControls", () => {
  it("armed 無し + releasable 2 件以上で arm ボタンを出す", () => {
    const html = renderAutoFlipControls(["ippoan/a", "ippoan/b"], null);
    expect(html).toContain("/api/release-wave/auto-flip/arm");
    expect(html).toContain("Tag Release all + Auto Flip (2)");
    expect(html).toContain('value="ippoan/a,ippoan/b"');
  });

  it("releasable 1 件でも arm ボタンを出す (flip 高速化)", () => {
    const html = renderAutoFlipControls(["ippoan/a"], null);
    expect(html).toContain("/api/release-wave/auto-flip/arm");
    expect(html).toContain("Tag Release all + Auto Flip (1)");
    expect(html).toContain('value="ippoan/a"');
  });

  it("releasable 0 件では arm ボタンを出さない", () => {
    expect(renderAutoFlipControls([], null)).toBe("");
  });

  it("armed 中は進捗 + Disarm を出す", () => {
    const html = renderAutoFlipControls([], {
      arm: arm(["ippoan/a", "ippoan/b"]),
      progress: {
        total: 2,
        released: 1,
        releasedRepos: ["ippoan/a"],
        pendingRepos: ["ippoan/b"],
        ready: false,
      },
    });
    expect(html).toContain("Auto-flip armed");
    expect(html).toContain("1/2 released");
    expect(html).toContain("/api/release-wave/auto-flip/disarm");
    expect(html).toContain("ippoan/b"); // 残り repo
  });

  it("blocked は理由と手動対応の案内を出す", () => {
    const html = renderAutoFlipControls([], {
      arm: arm(["ippoan/a"], {
        status: "blocked",
        blocked_reason: "compatibility 未検証: alc-app→rust-alc-api",
      }),
      progress: {
        total: 1,
        released: 1,
        releasedRepos: ["ippoan/a"],
        pendingRepos: [],
        ready: true,
      },
    });
    expect(html).toContain("Auto-flip blocked");
    expect(html).toContain("alc-app→rust-alc-api");
    expect(html).toContain("/api/release-wave/auto-flip/disarm");
  });
});

// ----------------------------------------------------------------------------
// handleReleaseWaveAutoFlipArm / Disarm
// ----------------------------------------------------------------------------

function formPost(path: string, body: string): Request {
  return new Request(`https://ci-dashboard.ippoan.org${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("handleReleaseWaveAutoFlipArm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("repos の tag-release を dispatch し armed を登録して 303", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv();
    const env = envWith(kv);
    const resp = await handleReleaseWaveAutoFlipArm(
      formPost("/api/release-wave/auto-flip/arm", "repos=ippoan/a,ippoan/b"),
      env,
    );
    expect(resp.status).toBe(303);
    // 各 repo の tag-release.yml を dispatch。
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("ippoan/a/actions/workflows/tag-release.yml/dispatches"))).toBe(true);
    expect(urls.some((u) => u.includes("ippoan/b/actions/workflows/tag-release.yml/dispatches"))).toBe(true);
    // armed 登録済み。
    const rec = await getAutoFlipArm(env);
    expect(rec?.repos).toEqual(["ippoan/a", "ippoan/b"]);
  });

  it("repos 空なら 400 で armed しない", async () => {
    const env = envWith(memKv());
    const resp = await handleReleaseWaveAutoFlipArm(
      formPost("/api/release-wave/auto-flip/arm", "repos="),
      env,
    );
    expect(resp.status).toBe(400);
    expect(await getAutoFlipArm(env)).toBeNull();
  });

  it("dispatch が失敗したら 502 で armed しない (all-or-nothing)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    const env = envWith(memKv());
    const resp = await handleReleaseWaveAutoFlipArm(
      formPost("/api/release-wave/auto-flip/arm", "repos=ippoan/a"),
      env,
    );
    expect(resp.status).toBe(502);
    expect(await getAutoFlipArm(env)).toBeNull();
  });
});

describe("handleReleaseWaveAutoFlipDisarm", () => {
  it("armed を clear して 303", async () => {
    const kv = memKv({ "auto-flip-arm::latest": arm(["ippoan/a"]) });
    const env = envWith(kv);
    const resp = await handleReleaseWaveAutoFlipDisarm(
      formPost("/api/release-wave/auto-flip/disarm", ""),
      env,
    );
    expect(resp.status).toBe(303);
    expect(await getAutoFlipArm(env)).toBeNull();
  });
});
