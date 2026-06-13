import { describe, it, expect } from "vitest";
import { handleReleaseWaveDebugKvPage } from "../../src/release-wave/debug-kv";
import type { Env } from "../../src/index";

function memKv(seed: Record<string, unknown> = {}): KVNamespace {
  const store = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [
      k,
      typeof v === "string" ? v : JSON.stringify(v),
    ]),
  );
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

function envWith(kv: KVNamespace | undefined): Env {
  return { COMPAT_KV: kv } as unknown as Env;
}

const req = (qs = "") =>
  new Request(`https://ci-dashboard.ippoan.org/release-wave/debug-kv${qs}`);

describe("handleReleaseWaveDebugKvPage", () => {
  it("503 when COMPAT_KV is not bound (html)", async () => {
    const res = await handleReleaseWaveDebugKvPage(envWith(undefined), req());
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("COMPAT_KV");
  });

  it("503 when COMPAT_KV is not bound (json)", async () => {
    const res = await handleReleaseWaveDebugKvPage(
      envWith(undefined),
      req("?format=json"),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("COMPAT_KV");
  });

  it("renders all keys with pretty JSON values", async () => {
    const kv = memKv({
      "traffic::ippoan/alc-app": {
        repo: "ippoan/alc-app",
        versions: [{ version_id: "2538f19d", percentage: 0 }],
      },
      "pending-release::ippoan/foo": { repo: "ippoan/foo" },
    });
    const res = await handleReleaseWaveDebugKvPage(envWith(kv), req());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("traffic::ippoan/alc-app");
    expect(html).toContain("2538f19d");
    expect(html).toContain("pending-release::ippoan/foo");
    // strict CSP, no inline script
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
  });

  it("filters by prefix", async () => {
    const kv = memKv({
      "traffic::a": { x: 1 },
      "pending-release::b": { y: 2 },
    });
    const res = await handleReleaseWaveDebugKvPage(
      envWith(kv),
      req("?prefix=traffic::"),
    );
    const html = await res.text();
    expect(html).toContain("traffic::a");
    expect(html).not.toContain("pending-release::b");
  });

  it("single key view via ?key=", async () => {
    const kv = memKv({ "flip-group::latest": { items: [] }, "traffic::z": { a: 1 } });
    const res = await handleReleaseWaveDebugKvPage(
      envWith(kv),
      req("?key=flip-group::latest&format=json"),
    );
    const body = (await res.json()) as {
      count: number;
      entries: { name: string; value: unknown }[];
    };
    expect(body.count).toBe(1);
    expect(body.entries[0].name).toBe("flip-group::latest");
    expect(body.entries[0].value).toEqual({ items: [] });
  });

  it("marks non-JSON values as raw text", async () => {
    const kv = memKv({ "weird::key": "not json {" });
    const res = await handleReleaseWaveDebugKvPage(
      envWith(kv),
      req("?format=json"),
    );
    const body = (await res.json()) as {
      entries: { name: string; value: unknown; raw: boolean }[];
    };
    const e = body.entries.find((x) => x.name === "weird::key")!;
    expect(e.raw).toBe(true);
    expect(e.value).toBe("not json {");
  });

  it("shows empty message when no keys match", async () => {
    const res = await handleReleaseWaveDebugKvPage(
      envWith(memKv()),
      req("?prefix=nope::"),
    );
    const html = await res.text();
    expect(html).toContain("該当キーはありません");
  });
});
