import { describe, it, expect, vi, afterEach } from "vitest";

import {
  armAutoFlip,
  getAutoFlipArm,
  clearAutoFlipArm,
  computeArmProgress,
  maybeAutoFlip,
  enqueueAutoFlipFlip,
  runAutoFlipFlip,
  scheduleAutoFlipRecheck,
  runAutoFlipRecheck,
  handleReleaseWaveAutoFlipArm,
  handleReleaseWaveAutoFlipDisarm,
  AUTO_FLIP_RECHECK_DELAY_SECONDS,
  type AutoFlipArmRecord,
} from "../../src/release-wave/auto-flip";
import type { PendingReleaseRecord } from "../../src/release-wave/pending-release";
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

/** ReleaseWaveHub の auto-flip arm RPC を in-memory で模す fake namespace
 *  (Refs #490: arm の SoT は KV でなく DO storage)。 */
function memHub(seedArm: AutoFlipArmRecord | null = null): unknown {
  const state = { arm: seedArm };
  const stub = {
    getAutoFlipArm: async () => state.arm,
    putAutoFlipArm: async (r: AutoFlipArmRecord) => {
      state.arm = r;
    },
    deleteAutoFlipArm: async () => {
      state.arm = null;
    },
  };
  return { idFromName: () => ({}), get: () => stub };
}

function envWith(
  compatKv?: KVNamespace,
  armSeed: AutoFlipArmRecord | null = null,
): Env {
  return {
    COMPAT_KV: compatKv,
    // getGitHubToken の KV cache hit 用 (introspect fetch を回避)。
    CI_STATUS: memKv({ "auth-client-worker:gh-token": FRESH_TOKEN }),
    INTERNAL_SHARED_SECRET: { get: async () => "secret" },
    RELEASE_WAVE_HUB: memHub(armSeed),
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
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(
      kv,
      arm(["ippoan/a"], { expires_at: "2026-07-13T00:00:00.000Z" }),
    );
    // now が expires_at より後。
    const out = await maybeAutoFlip(env, "2026-07-13T01:00:00.000Z");
    expect(out).toEqual({ action: "expired" });
    expect(await getAutoFlipArm(env)).toBeNull();
  });

  it("全 repo 揃っていなければ none", async () => {
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(kv, arm(["ippoan/a", "ippoan/b"]));
    const out = await maybeAutoFlip(env, "2026-07-13T00:10:00.000Z");
    expect(out).toEqual({ action: "none" });
    // armed は残る。
    expect((await getAutoFlipArm(env))?.status).toBe("armed");
  });

  it("全 repo 揃い compat gate OK (backend 無し) なら flip all を発火して clear", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
      "pending-release::ippoan/b": pending("ippoan/b", "v2.0.0"),
    });
    const env = envWith(kv, arm(["ippoan/a", "ippoan/b"]));
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
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
      ...redCompat(),
    });
    const env = envWith(kv, arm(["ippoan/a"]));
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
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(
      kv,
      arm(["ippoan/a"], {
        status: "blocked",
        blocked_reason: "compatibility 未検証: x",
      }),
    );
    expect(await maybeAutoFlip(env, "2026-07-13T00:10:00.000Z")).toEqual({
      action: "none",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("justReleasedRepo hint で kv.list 未反映の最後の repo を released 扱いにして flip する (Refs #481)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    // b の pending-release:: がまだ list に無い (= list ラグ再現) 状態。
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
      "pending-release::ippoan/b": pending("ippoan/b", "v2.0.0"),
    });
    const env = envWith(kv, arm(["ippoan/a", "ippoan/b"]));
    // hint 無しでも memKv は強整合なので flip するが、hint 経路の回帰を固定する:
    // b を list から見えなくするのは harness では難しいので、hint が readiness を
    // 満たす経路 (a のみ list + b は hint) を直接検証する。
    const kvLagging = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
      // b は未反映 (list に出ない)。
    });
    const envLag = envWith(kvLagging, arm(["ippoan/a", "ippoan/b"]));
    // hint 無し → b が未 release 扱いで none。
    expect(
      (await maybeAutoFlip(envLag, "2026-07-13T00:10:00.000Z")).action,
    ).toBe("none");
    // hint=b → b を released 扱いにして flip。
    const out = await maybeAutoFlip(
      envLag,
      "2026-07-13T00:10:00.000Z",
      "ippoan/b",
    );
    expect(out.action).toBe("flipped");
    expect(await getAutoFlipArm(envLag)).toBeNull();
    // 参考: 完全反映済み env でも flip する。
    expect((await maybeAutoFlip(env, "2026-07-13T00:10:00.000Z")).action).toBe(
      "flipped",
    );
  });

  it("armed set に無い repo を hint に渡しても readiness には効かない", async () => {
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(kv, arm(["ippoan/a", "ippoan/b"]));
    // hint が armed set 外 (ippoan/z) → b は依然未 release なので none。
    expect(
      (await maybeAutoFlip(env, "2026-07-13T00:10:00.000Z", "ippoan/z")).action,
    ).toBe("none");
  });
});

// ----------------------------------------------------------------------------
// 権威版 flip (Refs #485): KV の stale cache でなく webhook の報告版を flip する
// ----------------------------------------------------------------------------

/** webhook が報告する権威版 record を作る。 */
function authRecord(
  repo: string,
  versionId: string,
  tag: string,
): PendingReleaseRecord {
  return {
    schema_version: 1,
    repo,
    version_id: versionId,
    tag,
    preview_url: null,
    uploaded_at: "2026-07-13T00:05:00.000Z",
  };
}

describe("maybeAutoFlip 権威版 override (Refs #485)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("KV に stale な version が載っていても、渡された権威版を flip する", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    // KV には古い版 (edge cache 由来の stale を再現) が載っている。
    const kv = memKv({
      "pending-release::ippoan/a": {
        schema_version: 1,
        repo: "ippoan/a",
        version_id: "stale-vid",
        tag: "v1.0.0",
        preview_url: null,
        uploaded_at: "2026-07-13T00:00:00.000Z",
      },
    });
    const env = envWith(kv, arm(["ippoan/a"]));
    const out = await maybeAutoFlip(
      env,
      "2026-07-13T00:10:00.000Z",
      "ippoan/a",
      authRecord("ippoan/a", "fresh-vid", "v1.0.1"),
    );
    expect(out).toEqual({ action: "flipped", flipped: 1 });
    // dispatch された flip 対象は KV の stale-vid でなく権威版 fresh-vid。
    const flip = bodies.find((b) => b.event_type === "release-wave-flip");
    expect(flip).toBeTruthy();
    expect(
      (flip!.client_payload as Record<string, unknown>).previewed_version_id,
    ).toBe("fresh-vid");
    expect(
      (flip!.client_payload as Record<string, unknown>).target_tag,
    ).toBe("v1.0.1");
    // arm は clear。
    expect(await getAutoFlipArm(env)).toBeNull();
  });
});

describe("enqueueAutoFlipFlip (Refs #485)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("armed + queue あり → message を送り inline flip しない", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sent: Array<unknown> = [];
    const kv = memKv();
    const env = {
      ...envWith(kv, arm(["ippoan/a"])),
      WEBHOOK_QUEUE: { send: async (m: unknown) => void sent.push(m) },
    } as unknown as Env;
    const rec = authRecord("ippoan/a", "fresh-vid", "v1.0.1");
    const out = await enqueueAutoFlipFlip(env, rec);
    expect(out).toEqual({ action: "enqueued" });
    expect(sent).toEqual([{ kind: "auto-flip-flip", authoritative: rec }]);
    // inline flip (GitHub dispatch) は走らない。
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("arm 直後の webhook でも armed を観測して enqueue する (DO 強整合、Refs #490)", async () => {
    // KV 置きだった頃は put 直後の get が edge cache (~60s) で null を返し
    // {action:"none"} で素通りする窓があった。DO 読みでは read-after-write が
    // 保証されるので、arm → 即 webhook の順でも必ず enqueued になる。
    const sent: Array<unknown> = [];
    const env = {
      ...envWith(memKv()),
      WEBHOOK_QUEUE: { send: async (m: unknown) => void sent.push(m) },
    } as unknown as Env;
    await armAutoFlip(env, {
      repos: ["ippoan/a"],
      actor: "me@example.com",
      now: new Date().toISOString(),
    });
    const out = await enqueueAutoFlipFlip(
      env,
      authRecord("ippoan/a", "fresh-vid", "v1.0.1"),
    );
    expect(out).toEqual({ action: "enqueued" });
    expect(sent).toHaveLength(1);
  });

  it("armed + queue 無し → inline で権威版 flip する (fallback)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(
      kv,
      arm(["ippoan/a"], { expires_at: "2099-01-01T00:00:00.000Z" }),
    ); // WEBHOOK_QUEUE 無し
    const out = await enqueueAutoFlipFlip(
      env,
      authRecord("ippoan/a", "fresh-vid", "v1.0.1"),
    );
    expect(out).toEqual({ action: "flipped", flipped: 1 });
    const flip = bodies.find((b) => b.event_type === "release-wave-flip");
    expect(
      (flip!.client_payload as Record<string, unknown>).previewed_version_id,
    ).toBe("fresh-vid");
  });

  it("armed でなければ no-op (send も flip もしない)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sent: Array<unknown> = [];
    const kv = memKv({}); // arm 無し
    const env = {
      ...envWith(kv),
      WEBHOOK_QUEUE: { send: async (m: unknown) => void sent.push(m) },
    } as unknown as Env;
    const out = await enqueueAutoFlipFlip(
      env,
      authRecord("ippoan/a", "fresh-vid", "v1.0.1"),
    );
    expect(out).toEqual({ action: "none" });
    expect(sent).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runAutoFlipFlip (Refs #485)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("consumer 経路: 権威版で flip して arm を clear する", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
    });
    const env = envWith(
      kv,
      arm(["ippoan/a"], { expires_at: "2099-01-01T00:00:00.000Z" }),
    );
    const out = await runAutoFlipFlip(
      env,
      authRecord("ippoan/a", "fresh-vid", "v1.0.1"),
    );
    expect(out).toEqual({ action: "flipped", flipped: 1 });
    expect(await getAutoFlipArm(env)).toBeNull();
    const flip = bodies.find((b) => b.event_type === "release-wave-flip");
    expect(
      (flip!.client_payload as Record<string, unknown>).previewed_version_id,
    ).toBe("fresh-vid");
  });
});

// ----------------------------------------------------------------------------
// Queue 駆動 recheck (Refs #481)
// ----------------------------------------------------------------------------

/** send spy 付き WEBHOOK_QUEUE を足した env。 */
function envWithQueue(
  compatKv: KVNamespace,
  send: (...args: unknown[]) => unknown,
  armSeed: AutoFlipArmRecord | null = null,
): Env {
  return {
    ...(envWith(compatKv, armSeed) as unknown as Record<string, unknown>),
    WEBHOOK_QUEUE: { send },
  } as unknown as Env;
}

describe("scheduleAutoFlipRecheck (Refs #481)", () => {
  it("armed 中は delaySeconds 付きで auto-flip-recheck を enqueue し marker を立てる", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const kv = memKv();
    const env = envWithQueue(kv, send, arm(["ippoan/a"]));
    await scheduleAutoFlipRecheck(env);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toEqual({ kind: "auto-flip-recheck" });
    expect(send.mock.calls[0][1]).toEqual({
      delaySeconds: AUTO_FLIP_RECHECK_DELAY_SECONDS,
    });
    // marker が立つ。
    expect(await kv.get("auto-flip::recheck-scheduled")).toBe("1");
  });

  it("marker がある間は重複 enqueue しない (dedup)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const kv = memKv({
      "auto-flip::recheck-scheduled": "1",
    });
    const env = envWithQueue(kv, send, arm(["ippoan/a"]));
    await scheduleAutoFlipRecheck(env);
    expect(send).not.toHaveBeenCalled();
  });

  it("armed が無ければ enqueue しない", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = envWithQueue(memKv(), send);
    await scheduleAutoFlipRecheck(env);
    expect(send).not.toHaveBeenCalled();
  });

  it("blocked の arm には予約しない", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const kv = memKv();
    const env = envWithQueue(
      kv,
      send,
      arm(["ippoan/a"], { status: "blocked", blocked_reason: "x" }),
    );
    await scheduleAutoFlipRecheck(env);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("runAutoFlipRecheck (Refs #481)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // runAutoFlipRecheck は実時刻 (new Date) で expiry 判定するので、テストの arm は
  // 十分未来の expires_at を持たせて「期限内」を保つ。
  const NOT_EXPIRED = { expires_at: "2099-01-01T00:00:00.000Z" };

  it("未 ready のままなら marker を消して次の tick を再予約する (ループ継続)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
      // b 未 release → 未 ready。
      "auto-flip::recheck-scheduled": "1",
    });
    const env = envWithQueue(kv, send, arm(["ippoan/a", "ippoan/b"], NOT_EXPIRED));
    await runAutoFlipRecheck(env);
    // 次の tick を再予約 (marker を消してから enqueue するので送信される)。
    expect(send).toHaveBeenCalledOnce();
    expect(await kv.get("auto-flip::recheck-scheduled")).toBe("1");
  });

  it("全 repo 揃えば flip して armed を clear し、再予約しない (ループ終了)", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const send = vi.fn().mockResolvedValue(undefined);
    const kv = memKv({
      "pending-release::ippoan/a": pending("ippoan/a", "v1.0.0"),
      "pending-release::ippoan/b": pending("ippoan/b", "v2.0.0"),
      "auto-flip::recheck-scheduled": "1",
    });
    const env = envWithQueue(kv, send, arm(["ippoan/a", "ippoan/b"], NOT_EXPIRED));
    await runAutoFlipRecheck(env);
    // flip 済み → armed clear → 再予約しない。
    expect(await getAutoFlipArm(env)).toBeNull();
    expect(send).not.toHaveBeenCalled();
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
    const kv = memKv();
    const env = envWith(kv, arm(["ippoan/a"]));
    const resp = await handleReleaseWaveAutoFlipDisarm(
      formPost("/api/release-wave/auto-flip/disarm", ""),
      env,
    );
    expect(resp.status).toBe(303);
    expect(await getAutoFlipArm(env)).toBeNull();
  });
});
