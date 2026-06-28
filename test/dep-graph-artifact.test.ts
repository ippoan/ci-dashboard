/**
 * dep-graph artifact passthrough の最小 spec。
 *
 * - file 名 allowlist (path traversal 防止)
 * - org 名 allowlist (validateOrg)
 * - KV cache HIT 経路で GitHub に当たらないこと
 *
 * GitHub fetch 自体 (artifact list / zip download / fflate 展開) は
 * 統合の手間に対して回収が薄いため、ここでは route の境界条件だけテストする。
 * 実物の zip 展開検証は merge 後の手動疎通 (PR description の checklist) で行う。
 */
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { cacheKey, contentType, isDepGraphFile } from "../src/dep-graph-artifact";

class MemKv {
  store = new Map<string, ArrayBuffer>();
  hits = 0;
  async get(key: string, _type: "arrayBuffer"): Promise<ArrayBuffer | null> {
    const v = this.store.get(key);
    if (v) this.hits++;
    return v ?? null;
  }
  async put(key: string, value: ArrayBuffer | string): Promise<void> {
    if (typeof value === "string") {
      this.store.set(key, new TextEncoder().encode(value).buffer);
    } else {
      this.store.set(key, value);
    }
  }
}

function envWith(kv: MemKv): Env {
  return { CI_STATUS: kv } as unknown as Env;
}

async function get(path: string, kv: MemKv): Promise<Response> {
  return worker.fetch(
    new Request("https://ci-dashboard.ippoan.org" + path),
    envWith(kv),
    {} as ExecutionContext,
  );
}

describe("dep-graph-artifact pure helpers", () => {
  it("cacheKey is namespaced per (owner, repo, file)", () => {
    expect(cacheKey("ippoan", "rust-alc-api", "deps.svg")).toBe(
      "dep-graph:ippoan/rust-alc-api:deps.svg",
    );
  });

  it("contentType maps each allowlisted file to an explicit charset/MIME", () => {
    expect(contentType("deps.svg")).toMatch(/^image\/svg\+xml/);
    expect(contentType("deps.dot")).toMatch(/^text\/vnd\.graphviz/);
    expect(contentType("meta.json")).toMatch(/^application\/json/);
  });

  it("isDepGraphFile rejects path-traversal-ish names", () => {
    expect(isDepGraphFile("deps.svg")).toBe(true);
    expect(isDepGraphFile("../etc/passwd")).toBe(false);
    expect(isDepGraphFile("deps.svg/../")).toBe(false);
    expect(isDepGraphFile("")).toBe(false);
  });
});

describe("GET /api/dep-graph/:owner/:repo/:file", () => {
  let kv: MemKv;
  beforeEach(() => {
    kv = new MemKv();
  });

  it("400 when file is not allowlisted", async () => {
    const res = await get("/api/dep-graph/ippoan/rust-alc-api/passwd", kv);
    expect(res.status).toBe(400);
  });

  it("403 when org is not in ALLOWED_ORGS", async () => {
    const res = await get("/api/dep-graph/evil/x/deps.svg", kv);
    expect(res.status).toBe(403);
  });

  it("serves cached bytes with correct MIME and x-cache:HIT (no GitHub call)", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    await kv.put(cacheKey("ippoan", "rust-alc-api", "deps.svg"), svg);
    const res = await get("/api/dep-graph/ippoan/rust-alc-api/deps.svg", kv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(res.headers.get("x-cache")).toBe("HIT");
    expect(await res.text()).toBe(svg);
    expect(kv.hits).toBe(1);
  });
});
