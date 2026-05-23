import { appTestEnv } from "./_helpers/app-env";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseAllowlist,
  loadDirectPushAllowlist,
  ALLOWLIST_REPO,
  ALLOWLIST_PATH,
} from "../src/direct-push-allowlist";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseAllowlist", () => {
  it("strips comments + blank lines and keeps owner/name lines", () => {
    const body =
      "# header\n" +
      "ippoan/ci-workflows\n" +
      "\n" +
      "# section\n" +
      "yhonda-ohishi/claude-hooks\n" +
      "yhonda-ohishi/claude-skills  # inline comment\n";
    expect(parseAllowlist(body)).toEqual([
      "ippoan/ci-workflows",
      "yhonda-ohishi/claude-hooks",
      "yhonda-ohishi/claude-skills",
    ]);
  });

  it("rejects lines that don't look like owner/name", () => {
    // Defensive: a typo or stray prose shouldn't poison the set with a bogus
    // entry that later compares true to some repo string.
    const body = "ippoan/good\nbroken line\nhttps://example.com\nfoo/bar/baz\n";
    expect(parseAllowlist(body)).toEqual(["ippoan/good"]);
  });

  it("returns [] on empty input", () => {
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist("# just comments\n")).toEqual([]);
  });
});

// Minimal in-memory stand-in for `KVNamespace.get<json>()` / `put()`. We only
// exercise the two methods the loader touches; the rest stay `undefined` so
// any accidental usage throws loudly.
function memoryKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string, type?: "text" | "json") => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

function stubContentsResponse(repos: string[]): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
    const url = typeof req === "string" ? req : (req as Request).url;
    if (url.includes(`/repos/${ALLOWLIST_REPO}/contents/${ALLOWLIST_PATH}`)) {
      const body = repos.join("\n") + "\n";
      const content = btoa(body);
      return Response.json({ content, encoding: "base64" });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
}

describe("loadDirectPushAllowlist", () => {
  it("returns the parsed Set on a fresh fetch and writes it to KV", async () => {
    stubContentsResponse([
      "ippoan/ci-workflows",
      "yhonda-ohishi/claude-hooks",
    ]);
    const kv = memoryKv();
    const set = await loadDirectPushAllowlist(appTestEnv(), kv);
    expect([...set].sort()).toEqual([
      "ippoan/ci-workflows",
      "yhonda-ohishi/claude-hooks",
    ]);
    // Cached for subsequent reads — the KV value carries the parsed list so
    // the SSR page can return it without re-decoding base64.
    const cached = await kv.get("direct-push-allowlist:v1", "json");
    expect(cached).toMatchObject({ repos: ["ippoan/ci-workflows", "yhonda-ohishi/claude-hooks"] });
  });

  it("returns the cached value without calling GitHub on a warm KV", async () => {
    const kv = memoryKv({
      "direct-push-allowlist:v1": JSON.stringify({
        fetchedAt: Date.now(),
        repos: ["cached/repo"],
      }),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("should not be called");
    });
    const set = await loadDirectPushAllowlist(appTestEnv(), kv);
    expect([...set]).toEqual(["cached/repo"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns an empty Set when the allowlist file is missing (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("Not Found", { status: 404 }),
    );
    const kv = memoryKv();
    const set = await loadDirectPushAllowlist(appTestEnv(), kv);
    expect(set.size).toBe(0);
    // Empty fetches must NOT poison the cache; the next load gets a real
    // chance against GitHub.
    const cached = await kv.get("direct-push-allowlist:v1");
    expect(cached).toBeNull();
  });

  it("works without a KV namespace (pure fetch fallback)", async () => {
    stubContentsResponse(["a/b"]);
    const set = await loadDirectPushAllowlist(appTestEnv());
    expect([...set]).toEqual(["a/b"]);
  });
});
