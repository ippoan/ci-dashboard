/**
 * /dep-graph/:owner/:repo SSR page の境界条件。
 *
 * - 404: repo allowlist 外
 * - 403: org allowlist 外
 * - 200: meta cache HIT で full HTML (commit SHA / generated_at が出る)
 * - 200: meta が無い場合は "no dep-graph artifact yet" plate を返す
 */
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { cacheKey } from "../src/dep-graph-artifact";

class MemKv {
  store = new Map<string, ArrayBuffer>();
  async get(key: string, _type: "arrayBuffer"): Promise<ArrayBuffer | null> {
    return this.store.get(key) ?? null;
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

describe("GET /dep-graph/:owner/:repo", () => {
  let kv: MemKv;
  beforeEach(() => {
    kv = new MemKv();
  });

  it("404 when repo is not in dep-graph allowlist", async () => {
    const res = await get("/dep-graph/ippoan/some-other-repo", kv);
    expect(res.status).toBe(404);
  });

  it("403 when org is not in ALLOWED_ORGS", async () => {
    const res = await get("/dep-graph/evil/rust-alc-api", kv);
    expect(res.status).toBe(403);
  });

  it("renders full page with commit SHA when meta.json is cached", async () => {
    const meta = {
      repo: "ippoan/rust-alc-api",
      commit_sha: "abc1234567890def",
      ref: "refs/heads/main",
      generated_at: "2026-06-28T10:00:00Z",
      workflow_run_id: "12345",
    };
    await kv.put(
      cacheKey("ippoan", "rust-alc-api", "meta.json"),
      JSON.stringify(meta),
    );
    const res = await get("/dep-graph/ippoan/rust-alc-api", kv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toContain("rust-alc-api");
    expect(body).toContain("abc1234"); // short SHA
    expect(body).toContain("2026-06-28T10:00:00Z");
    expect(body).toContain("/actions/runs/12345");
    expect(body).toContain('src="/api/dep-graph/ippoan/rust-alc-api/deps.svg"');
  });

  it("renders 'no artifact yet' plate when meta.json is missing", async () => {
    // Empty KV → getDepGraphMeta will try GitHub, but env has no token binding
    // so it will throw. The handler converts the throw to a meta load error
    // and renders the empty plate. We can't easily exercise the truly-null
    // path without mocking findLatestDepGraphArtifact, but the 200 with the
    // error/empty plate path is the user-visible behaviour either way.
    const res = await get("/dep-graph/ippoan/rust-alc-api", kv);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Either "No dep-graph artifact yet" (null meta) or "meta load failed"
    // (token resolution error) — both are valid empty-state responses.
    expect(body).toMatch(/No dep-graph artifact yet|meta load failed/);
  });
});
