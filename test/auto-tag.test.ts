import { describe, it, expect } from "vitest";
import {
  normalizeAutoTagRepos,
  readAutoTagRepos,
  writeAutoTagRepos,
  isAutoTagRepo,
} from "../src/auto-tag";

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
