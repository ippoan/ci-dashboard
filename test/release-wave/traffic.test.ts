import { describe, it, expect } from "vitest";
import {
  recordTraffic,
  getTraffic,
  getTrafficForRepos,
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
    expect(rec!.versions[0]).toEqual({ version_id: "full", percentage: 100 });
    expect(rec!.versions[1]).toEqual({ version_id: "zero", percentage: 0 });
    expect(rec!.reported_at).toBe("2026-05-29T00:00:00Z");
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
    expect(rec!.versions).toEqual([{ version_id: "b", percentage: 100 }]);
    expect(rec!.reported_at).toBe("t2");
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
