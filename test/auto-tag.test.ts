import { describe, it, expect } from "vitest";
import {
  normalizeAutoTagRepos,
  readAutoTagRepos,
  writeAutoTagRepos,
  isAutoTagRepo,
  handleAutoTagToggle,
} from "../src/auto-tag";
import type { Env } from "../src/index";

interface MockHub {
  stub: DurableObjectStub;
  get(): string[];
  setReject(reason: "throw" | "non-ok" | null): void;
}

function makeMockHub(initial: string[] = []): MockHub {
  let stored = [...initial];
  let reject: "throw" | "non-ok" | null = null;
  const stub = {
    fetch: async (req: Request) => {
      const u = new URL(req.url);
      if (reject === "throw") throw new Error("hub unreachable");
      if (reject === "non-ok") return new Response("", { status: 500 });
      if (u.pathname === "/auto-tag-repos" && req.method === "GET") {
        return Response.json(stored);
      }
      if (u.pathname === "/auto-tag-repos" && req.method === "PUT") {
        const body = await req.json<{ repos: string[] }>();
        stored = normalizeAutoTagRepos(body.repos ?? []);
        return Response.json(stored);
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as DurableObjectStub;
  return {
    stub,
    get: () => stored.slice(),
    setReject: (r) => { reject = r; },
  };
}

describe("normalizeAutoTagRepos", () => {
  it("trims whitespace from each entry", () => {
    expect(normalizeAutoTagRepos(["  a/b  ", "c/d\t"])).toEqual(["a/b", "c/d"]);
  });

  it("drops empty / whitespace-only lines", () => {
    expect(normalizeAutoTagRepos(["", "  ", "\t\n", "a/b"])).toEqual(["a/b"]);
  });

  it("deduplicates", () => {
    expect(normalizeAutoTagRepos(["a/b", "a/b", "c/d"])).toEqual(["a/b", "c/d"]);
  });

  it("sorts alphabetically for stable diffs", () => {
    expect(normalizeAutoTagRepos(["z/z", "a/a", "m/m"]))
      .toEqual(["a/a", "m/m", "z/z"]);
  });

  it("returns [] for empty input", () => {
    expect(normalizeAutoTagRepos([])).toEqual([]);
  });
});

describe("readAutoTagRepos / writeAutoTagRepos round-trip", () => {
  it("read returns [] when nothing stored", async () => {
    const h = makeMockHub();
    expect(await readAutoTagRepos(h.stub)).toEqual([]);
  });

  it("write then read returns same normalized set", async () => {
    const h = makeMockHub();
    const ok = await writeAutoTagRepos(h.stub, ["b/y", "a/x", "a/x"]);
    expect(ok).toBe(true);
    expect(await readAutoTagRepos(h.stub)).toEqual(["a/x", "b/y"]);
  });

  it("write with [] clears the set", async () => {
    const h = makeMockHub(["a/x"]);
    await writeAutoTagRepos(h.stub, []);
    expect(await readAutoTagRepos(h.stub)).toEqual([]);
  });

  it("fail-open: read returns [] when hub throws", async () => {
    const h = makeMockHub(["a/x"]);
    h.setReject("throw");
    expect(await readAutoTagRepos(h.stub)).toEqual([]);
  });

  it("fail-open: read returns [] when hub responds non-OK", async () => {
    const h = makeMockHub(["a/x"]);
    h.setReject("non-ok");
    expect(await readAutoTagRepos(h.stub)).toEqual([]);
  });

  it("fail-closed: write returns false when hub throws", async () => {
    const h = makeMockHub();
    h.setReject("throw");
    expect(await writeAutoTagRepos(h.stub, ["a/x"])).toBe(false);
  });

  it("fail-closed: write returns false when hub responds non-OK", async () => {
    const h = makeMockHub();
    h.setReject("non-ok");
    expect(await writeAutoTagRepos(h.stub, ["a/x"])).toBe(false);
  });
});

describe("isAutoTagRepo", () => {
  it("true when repo is in the set", async () => {
    const h = makeMockHub(["ippoan/foo", "ippoan/bar"]);
    expect(await isAutoTagRepo(h.stub, "ippoan/foo")).toBe(true);
  });

  it("false when repo is NOT in the set", async () => {
    const h = makeMockHub(["ippoan/foo"]);
    expect(await isAutoTagRepo(h.stub, "ippoan/bar")).toBe(false);
  });

  it("false when set is empty", async () => {
    const h = makeMockHub();
    expect(await isAutoTagRepo(h.stub, "ippoan/foo")).toBe(false);
  });

  it("false when hub is unreachable (fail-open)", async () => {
    const h = makeMockHub(["ippoan/foo"]);
    h.setReject("throw");
    expect(await isAutoTagRepo(h.stub, "ippoan/foo")).toBe(false);
  });
});

describe("handleAutoTagToggle (POST /api/release-wave/auto-tag/toggle, Refs #492)", () => {
  function makeEnv(h: MockHub): Env {
    return {
      CI_HUB: {
        idFromName: () => ({}),
        get: () => h.stub,
      },
    } as unknown as Env;
  }

  function toggleRequest(repo: string, enable: "1" | "0"): Request {
    return new Request("http://localhost/api/release-wave/auto-tag/toggle", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ repo, enable }).toString(),
    });
  }

  it("enable=1 adds only the target repo without touching others", async () => {
    const h = makeMockHub(["ippoan/existing"]);
    const res = await handleAutoTagToggle(toggleRequest("ippoan/new", "1"), makeEnv(h));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/release-wave");
    expect(h.get()).toEqual(["ippoan/existing", "ippoan/new"]);
  });

  it("enable=0 removes only the target repo, leaving others intact", async () => {
    const h = makeMockHub(["ippoan/a", "ippoan/b"]);
    const res = await handleAutoTagToggle(toggleRequest("ippoan/a", "0"), makeEnv(h));
    expect(res.status).toBe(303);
    expect(h.get()).toEqual(["ippoan/b"]);
  });

  it("is idempotent: enabling an already-enabled repo is a no-op", async () => {
    const h = makeMockHub(["ippoan/a"]);
    await handleAutoTagToggle(toggleRequest("ippoan/a", "1"), makeEnv(h));
    expect(h.get()).toEqual(["ippoan/a"]);
  });

  it("no-ops (redirect only, no write) when repo is missing/blank", async () => {
    const h = makeMockHub(["ippoan/a"]);
    const res = await handleAutoTagToggle(toggleRequest("  ", "1"), makeEnv(h));
    expect(res.status).toBe(303);
    expect(h.get()).toEqual(["ippoan/a"]);
  });

  it("returns 502 when the hub write fails (fail-closed, doesn't silently drop the intent)", async () => {
    const h = makeMockHub(["ippoan/a"]);
    h.setReject("non-ok");
    const res = await handleAutoTagToggle(toggleRequest("ippoan/b", "1"), makeEnv(h));
    expect(res.status).toBe(502);
  });
});
