import { describe, it, expect } from "vitest";
import {
  recordTraffic,
  getTraffic,
  getTrafficForRepos,
  nextDeployHistory,
  DEPLOY_HISTORY_MAX,
  type TrafficRecord,
} from "../../src/release-wave/traffic";

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

describe("traffic record", () => {
  it("recordTraffic sorts versions by percentage desc and round-trips", async () => {
    const kv = memKv();
    await recordTraffic(kv, {
      repo: "ippoan/auth-worker",
      versions: [
        { version_id: "zero", percentage: 0 },
        { version_id: "full", percentage: 100 },
      ],
      now: "2026-05-29T00:00:00Z",
    });
    const rec = await getTraffic(kv, "ippoan/auth-worker");
    expect(rec).not.toBeNull();
    expect(rec!.versions[0].version_id).toBe("full");
    expect(rec!.versions[1].version_id).toBe("zero");
    expect(rec!.reported_at).toBe("2026-05-29T00:00:00Z");
    expect(rec!.schema_version).toBe(4);
  });

  it("recordTraffic breaks percentage ties by created_on desc (newest 0% first)", async () => {
    const kv = memKv();
    await recordTraffic(kv, {
      repo: "ippoan/auth-worker",
      versions: [
        { version_id: "full", percentage: 100, created_on: "2026-05-20T00:00:00Z" },
        { version_id: "zero-old", percentage: 0, created_on: "2026-05-28T00:00:00Z" },
        { version_id: "zero-new", percentage: 0, created_on: "2026-05-29T00:00:00Z" },
        { version_id: "zero-nodate", percentage: 0 },
      ],
      now: "t",
    });
    const rec = await getTraffic(kv, "ippoan/auth-worker");
    expect(rec!.versions.map((v) => v.version_id)).toEqual([
      "full", // 100% が先頭
      "zero-new", // 0% は created_on 降順
      "zero-old",
      "zero-nodate", // created_on 無しは末尾
    ]);
  });

  it("getTraffic returns null for a missing repo", async () => {
    expect(await getTraffic(memKv(), "ippoan/none")).toBeNull();
  });

  it("getTraffic rejects a record with a mismatched schema_version", async () => {
    const kv = memKv({
      "traffic::ippoan/x": { schema_version: 99, repo: "ippoan/x", versions: [], reported_at: "t" },
    });
    expect(await getTraffic(kv, "ippoan/x")).toBeNull();
  });

  it("recordTraffic upserts (latest report wins)", async () => {
    const kv = memKv();
    await recordTraffic(kv, {
      repo: "ippoan/x",
      versions: [{ version_id: "a", percentage: 100 }],
      now: "t1",
    });
    await recordTraffic(kv, {
      repo: "ippoan/x",
      versions: [{ version_id: "b", percentage: 100 }],
      now: "t2",
    });
    const rec = await getTraffic(kv, "ippoan/x");
    expect(rec!.versions).toEqual([
      { version_id: "b", percentage: 100, created_on: null, tag: null },
    ]);
    expect(rec!.reported_at).toBe("t2");
  });

  it("merges (accumulates) tags across reports per version_id", async () => {
    const kv = memKv();
    // 1 回目: full に tag v1.0.0 が付く。
    await recordTraffic(kv, {
      repo: "ippoan/x",
      versions: [
        { version_id: "full", percentage: 100, tag: "v1.0.0" },
        { version_id: "zero", percentage: 0 },
      ],
      now: "t1",
    });
    // 2 回目: zero に tag v1.0.1。full は tag を送らない (= 既存 v1.0.0 を保持)。
    await recordTraffic(kv, {
      repo: "ippoan/x",
      versions: [
        { version_id: "full", percentage: 100 },
        { version_id: "zero", percentage: 0, tag: "v1.0.1" },
      ],
      now: "t2",
    });
    const rec = await getTraffic(kv, "ippoan/x");
    const byId = Object.fromEntries(rec!.versions.map((v) => [v.version_id, v.tag]));
    expect(byId["full"]).toBe("v1.0.0"); // 過去 report の tag を保持
    expect(byId["zero"]).toBe("v1.0.1"); // 新 report の tag
  });

  it("records deploy_history when the active (100%) version changes", async () => {
    const kv = memKv();
    // 1 回目: v1 が 100%。
    await recordTraffic(kv, {
      repo: "ippoan/x",
      versions: [{ version_id: "v1", percentage: 100, tag: "v1.0.0" }],
      now: "2026-05-01T00:00:00Z",
    });
    let rec = await getTraffic(kv, "ippoan/x");
    expect(rec!.deploy_history).toEqual([
      { version_id: "v1", tag: "v1.0.0", became_active_at: "2026-05-01T00:00:00Z" },
    ]);

    // 2 回目: v2 が 100% に (v1 は 0% に落ちる) → 履歴先頭に v2。
    await recordTraffic(kv, {
      repo: "ippoan/x",
      versions: [
        { version_id: "v2", percentage: 100, tag: "v2.0.0", created_on: "2026-05-02T00:00:00Z" },
        { version_id: "v1", percentage: 0, tag: "v1.0.0" },
      ],
      now: "2026-05-02T09:00:00Z",
    });
    rec = await getTraffic(kv, "ippoan/x");
    expect(rec!.deploy_history!.map((e) => e.version_id)).toEqual(["v2", "v1"]);
    // became_active_at は created_on 優先。
    expect(rec!.deploy_history![0].became_active_at).toBe("2026-05-02T00:00:00Z");
  });

  it("does not duplicate deploy_history when active stays the same", async () => {
    const kv = memKv();
    await recordTraffic(kv, {
      repo: "ippoan/x",
      versions: [{ version_id: "v1", percentage: 100 }],
      now: "t1",
    });
    await recordTraffic(kv, {
      repo: "ippoan/x",
      versions: [{ version_id: "v1", percentage: 100 }],
      now: "t2",
    });
    const rec = await getTraffic(kv, "ippoan/x");
    expect(rec!.deploy_history!.map((e) => e.version_id)).toEqual(["v1"]);
  });

  it("nextDeployHistory: re-promoting an old version moves it back to the front", () => {
    const prior = [
      { version_id: "v2", tag: "v2", became_active_at: "t2" },
      { version_id: "v1", tag: "v1", became_active_at: "t1" },
    ];
    const next = nextDeployHistory(
      prior,
      [{ version_id: "v1", percentage: 100, tag: "v1" }],
      "t3",
    );
    expect(next.map((e) => e.version_id)).toEqual(["v1", "v2"]);
  });

  it("nextDeployHistory: no active (all 0%) keeps prior history", () => {
    const prior = [{ version_id: "v1", tag: null, became_active_at: "t1" }];
    const next = nextDeployHistory(prior, [{ version_id: "v1", percentage: 0 }], "t2");
    expect(next).toEqual(prior);
  });

  it("nextDeployHistory trims to DEPLOY_HISTORY_MAX", () => {
    let history: ReturnType<typeof nextDeployHistory> = [];
    for (let i = 0; i < DEPLOY_HISTORY_MAX + 5; i++) {
      history = nextDeployHistory(
        history,
        [{ version_id: `v${i}`, percentage: 100 }],
        `t${i}`,
      );
    }
    expect(history.length).toBe(DEPLOY_HISTORY_MAX);
    // 先頭は最新。
    expect(history[0].version_id).toBe(`v${DEPLOY_HISTORY_MAX + 4}`);
  });

  it("getTrafficForRepos returns only repos that have a record", async () => {
    const seedRec = (repo: string): TrafficRecord => ({
      schema_version: 1,
      repo,
      versions: [{ version_id: "v", percentage: 100 }],
      reported_at: "t",
    });
    const kv = memKv({
      "traffic::ippoan/a": seedRec("ippoan/a"),
      "traffic::ippoan/b": seedRec("ippoan/b"),
    });
    const map = await getTrafficForRepos(kv, ["ippoan/a", "ippoan/c"]);
    expect(map.has("ippoan/a")).toBe(true);
    expect(map.has("ippoan/c")).toBe(false);
    expect(map.size).toBe(1);
  });
});
