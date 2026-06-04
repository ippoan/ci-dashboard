import { describe, it, expect } from "vitest";
import {
  recordBackendTraffic,
  getBackendTraffic,
  getBackendTrafficForRepos,
} from "../../src/release-wave/backend-traffic";

/** in-memory KV (backend-traffic:: の read/write 検証用)。 */
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

describe("recordBackendTraffic / getBackendTraffic", () => {
  it("stores service traffic and sorts revisions by percent desc", async () => {
    const kv = memKv();
    await recordBackendTraffic(kv, {
      repo: "ippoan/rust-alc-api",
      services: [
        {
          service: "rust-alc-api",
          revisions: [
            // わざと 0% を先に渡す → 100% が先頭に並ぶことを確認。
            { revision: "rust-alc-api-00043-xyz", percent: 0, tag: "pending-v1-4-3" },
            { revision: "rust-alc-api-00042-abc", percent: 100, tag: "v1.4.2" },
          ],
        },
      ],
      now: "2026-06-04T00:00:00Z",
    });
    const rec = await getBackendTraffic(kv, "ippoan/rust-alc-api");
    expect(rec).not.toBeNull();
    expect(rec!.repo).toBe("ippoan/rust-alc-api");
    expect(rec!.reported_at).toBe("2026-06-04T00:00:00Z");
    const revs = rec!.services[0]!.revisions;
    expect(revs[0]!.percent).toBe(100);
    expect(revs[0]!.revision).toBe("rust-alc-api-00042-abc");
    expect(revs[0]!.tag).toBe("v1.4.2");
    expect(revs[1]!.percent).toBe(0);
    expect(revs[1]!.tag).toBe("pending-v1-4-3");
  });

  it("sorts services by name asc", async () => {
    const kv = memKv();
    await recordBackendTraffic(kv, {
      repo: "ippoan/x",
      services: [
        { service: "z-gateway", revisions: [{ revision: "z-1", percent: 100, tag: null }] },
        { service: "a-api", revisions: [{ revision: "a-1", percent: 100, tag: null }] },
      ],
      now: "t",
    });
    const rec = await getBackendTraffic(kv, "ippoan/x");
    expect(rec!.services.map((s) => s.service)).toEqual(["a-api", "z-gateway"]);
  });

  it("upsert replaces the previous record (latest report wins)", async () => {
    const kv = memKv();
    await recordBackendTraffic(kv, {
      repo: "ippoan/x",
      services: [{ service: "x", revisions: [{ revision: "old", percent: 100, tag: null }] }],
      now: "t1",
    });
    await recordBackendTraffic(kv, {
      repo: "ippoan/x",
      services: [{ service: "x", revisions: [{ revision: "new", percent: 100, tag: null }] }],
      now: "t2",
    });
    const rec = await getBackendTraffic(kv, "ippoan/x");
    expect(rec!.services[0]!.revisions[0]!.revision).toBe("new");
    expect(rec!.reported_at).toBe("t2");
  });

  it("returns null for a missing repo", async () => {
    expect(await getBackendTraffic(memKv(), "ippoan/none")).toBeNull();
  });

  it("returns null for a schema mismatch", async () => {
    const kv = memKv({
      "backend-traffic::ippoan/x": {
        schema_version: 99,
        repo: "ippoan/x",
        services: [],
        reported_at: "t",
      },
    });
    expect(await getBackendTraffic(kv, "ippoan/x")).toBeNull();
  });
});

describe("getBackendTrafficForRepos", () => {
  it("returns only repos that have a record", async () => {
    const kv = memKv();
    await recordBackendTraffic(kv, {
      repo: "ippoan/a",
      services: [{ service: "a", revisions: [{ revision: "a-1", percent: 100, tag: null }] }],
      now: "t",
    });
    const map = await getBackendTrafficForRepos(kv, ["ippoan/a", "ippoan/b"]);
    expect(map.has("ippoan/a")).toBe(true);
    expect(map.has("ippoan/b")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("dedupes repeated repos", async () => {
    const kv = memKv();
    await recordBackendTraffic(kv, {
      repo: "ippoan/a",
      services: [{ service: "a", revisions: [{ revision: "a-1", percent: 100, tag: null }] }],
      now: "t",
    });
    const map = await getBackendTrafficForRepos(kv, ["ippoan/a", "ippoan/a"]);
    expect(map.size).toBe(1);
  });

  it("returns an empty map when no repo has a record", async () => {
    const map = await getBackendTrafficForRepos(memKv(), ["ippoan/a"]);
    expect(map.size).toBe(0);
  });
});
