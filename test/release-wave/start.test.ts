import { describe, it, expect, vi, afterEach } from "vitest";
import {
  renderStartWaveSection,
  injectStartWaveSection,
  defaultWaveId,
  handleReleaseWaveStart,
} from "../../src/release-wave/start";
import type { Env } from "../../src/index";
import type { ReleaseWaveHub } from "../../src/release-wave/do";
import type { RepoReleaseStatus } from "../../src/release-wave/repo-release-status";

/** 簡易 in-memory KV (token cache / repo-meta cache 用)。 */
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
  token: "ghs_start_token",
  expires_at_ms: Date.now() + 3600_000,
};

function status(
  repo: string,
  over: Partial<RepoReleaseStatus> = {},
): RepoReleaseStatus {
  return {
    repo,
    latestTag: "v1.0.0",
    hasTag: true,
    behind: 0,
    tagless: false,
    ...over,
  };
}

/** start spy を持つ fake env。CI_STATUS に token + repo-meta cache を仕込む。 */
function fakeEnv(opts: {
  startReturn?: unknown;
  ciStatusSeed?: Record<string, unknown>;
} = {}): { env: Env; start: ReturnType<typeof vi.fn> } {
  const start =
    (opts.startReturn !== undefined
      ? vi.fn().mockResolvedValue(opts.startReturn)
      : vi.fn().mockResolvedValue({ ok: true, data: { wave_id: "w1" } }));
  const hub = { start } as unknown as ReleaseWaveHub;
  const env = {
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => hub },
    CI_STATUS: memKv({
      "auth-client-worker:gh-token": FRESH_TOKEN,
      ...(opts.ciStatusSeed ?? {}),
    }),
  } as unknown as Env;
  return { env, start };
}

/**
 * GitHub REST を URL で振り分ける fetch mock:
 *   - `GET /repos/{o}/{n}`               → repo-meta { default_branch: "main" }
 *   - `GET /repos/{o}/{n}/commits/{ref}` → { sha } (repo 名で sha を変える)
 * `shaFor` で repo 名 → sha を制御。`commitsStatus` で commits 応答 status を上書き。
 */
function ghFetch(opts: {
  shaFor?: (url: string) => string;
  commitsStatus?: number;
} = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.includes("/commits/")) {
      const status = opts.commitsStatus ?? 200;
      if (status !== 200) return new Response("err", { status });
      const sha = opts.shaFor ? opts.shaFor(url) : "sha_head";
      return new Response(JSON.stringify({ sha }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // repo-meta
    return new Response(JSON.stringify({ default_branch: "main" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function postRequest(formBody?: Record<string, string | string[]>): Request {
  const params = new URLSearchParams();
  if (formBody) {
    for (const [k, v] of Object.entries(formBody)) {
      if (Array.isArray(v)) for (const item of v) params.append(k, item);
      else params.set(k, v);
    }
  }
  return new Request("https://ci-dashboard.ippoan.org/api/release-wave/start", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

// ============================================================================
// SSR helpers
// ============================================================================

describe("defaultWaveId", () => {
  it("formats wave_YYYY_MM_DD_HHMM in UTC", () => {
    const id = defaultWaveId(new Date("2026-06-03T04:05:00Z"));
    expect(id).toBe("wave_2026_06_03_0405");
  });
});

describe("renderStartWaveSection", () => {
  it("renders a form with a row per non-tagless repo", () => {
    const html = renderStartWaveSection([
      status("ippoan/rust-alc-api"),
      status("ippoan/alc-app", { hasTag: false, latestTag: null }),
    ]);
    expect(html).toContain('action="/api/release-wave/start"');
    expect(html).toContain("ippoan/rust-alc-api");
    expect(html).toContain("ippoan/alc-app");
    // checkbox + target_tag input per repo
    expect(html).toContain('name="include" value="ippoan/rust-alc-api"');
    expect(html).toContain('name="target_tag__ippoan/rust-alc-api"');
    // manual-approval is the default selected option
    expect(html).toContain('value="manual-approval" selected');
  });

  it("excludes tagless repos and fetch-failed repos", () => {
    const html = renderStartWaveSection([
      status("ippoan/tagless-one", { tagless: true }),
      status("ippoan/broken", { behind: -1 }),
    ]);
    // both candidates filtered out → empty section
    expect(html).toBe("");
  });

  it("escapes repo names", () => {
    const html = renderStartWaveSection([status('ippoan/x"y')]);
    expect(html).not.toContain('value="ippoan/x"y"');
    expect(html).toContain("&quot;");
  });

  it("prefills target_tag value with latest stable tag patch-bumped", () => {
    const html = renderStartWaveSection([
      status("ippoan/rust-alc-api", { latestTag: "v0.0.76" }),
      status("ippoan/alc-app", { latestTag: "v0.2.51" }),
    ]);
    // value (not just placeholder) is the latest tag with patch +1
    expect(html).toContain(
      'name="target_tag__ippoan/rust-alc-api"\n              value="v0.0.77"',
    );
    expect(html).toContain(
      'name="target_tag__ippoan/alc-app"\n              value="v0.2.52"',
    );
    // placeholder still shows the current latest tag
    expect(html).toContain('placeholder="v0.0.76"');
    expect(html).toContain('placeholder="v0.2.51"');
  });

  it("leaves prefill value empty when latest tag is a prerelease", () => {
    // A polluted prerelease (`-wave-test-NN` / `-dev` / `-rc`) must NOT bump
    // into a new stable tag — value stays empty, operator types manually.
    const html = renderStartWaveSection([
      status("ippoan/poll-1", { latestTag: "v0.5.99-wave-test-08" }),
      status("ippoan/poll-2", { latestTag: "v1.2.3-dev" }),
      status("ippoan/poll-3", { latestTag: "v1.2.3-rc.1" }),
    ]);
    expect(html).toContain(
      'name="target_tag__ippoan/poll-1"\n              value=""',
    );
    expect(html).toContain(
      'name="target_tag__ippoan/poll-2"\n              value=""',
    );
    expect(html).toContain(
      'name="target_tag__ippoan/poll-3"\n              value=""',
    );
    // but the placeholder still surfaces the (prerelease) latest for context
    expect(html).toContain('placeholder="v0.5.99-wave-test-08"');
  });

  it("leaves prefill value empty for repos with no tag", () => {
    const html = renderStartWaveSection([
      status("ippoan/fresh", { hasTag: false, latestTag: null }),
    ]);
    expect(html).toContain(
      'name="target_tag__ippoan/fresh"\n              value=""',
    );
    //未tag repo keeps the v0.1.0 example placeholder
    expect(html).toContain('placeholder="v0.1.0"');
  });
});

describe("injectStartWaveSection", () => {
  it("inserts after the h1 marker", () => {
    const html = "<body><h1>Release Waves</h1><p>x</p></body>";
    const out = injectStartWaveSection(html, "<div>START</div>");
    expect(out.indexOf("START")).toBeGreaterThan(out.indexOf("Release Waves"));
    expect(out.indexOf("START")).toBeLessThan(out.indexOf("<p>x</p>"));
  });

  it("falls back to before </body> when h1 missing", () => {
    const out = injectStartWaveSection("<body>hi</body>", "<div>S</div>");
    expect(out).toContain("<div>S</div>\n</body>");
  });

  it("is a no-op for empty section", () => {
    const html = "<h1>Release Waves</h1>";
    expect(injectStartWaveSection(html, "")).toBe(html);
  });
});

// ============================================================================
// POST /api/release-wave/start
// ============================================================================

describe("handleReleaseWaveStart", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 405 on GET", async () => {
    const { env } = fakeEnv();
    const req = new Request(
      "https://ci-dashboard.ippoan.org/api/release-wave/start",
      { method: "GET" },
    );
    const resp = await handleReleaseWaveStart(req, env);
    expect(resp.status).toBe(405);
  });

  it("400 when wave_id missing", async () => {
    const { env, start } = fakeEnv();
    const resp = await handleReleaseWaveStart(postRequest({}), env);
    expect(resp.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("400 when no repo selected", async () => {
    const { env, start } = fakeEnv();
    const resp = await handleReleaseWaveStart(
      postRequest({ wave_id: "w1" }),
      env,
    );
    expect(resp.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("400 when a selected repo has no target_tag", async () => {
    const { env, start } = fakeEnv();
    const resp = await handleReleaseWaveStart(
      postRequest({ wave_id: "w1", include: "ippoan/rust-alc-api" }),
      env,
    );
    expect(resp.status).toBe(400);
    const body = await resp.json<{ code: string }>();
    expect(body.code).toBe("MISSING_TARGET_TAG");
    expect(start).not.toHaveBeenCalled();
  });

  it("502 when HEAD sha fetch fails", async () => {
    const { env, start } = fakeEnv();
    vi.stubGlobal("fetch", ghFetch({ commitsStatus: 500 }));
    const resp = await handleReleaseWaveStart(
      postRequest({
        wave_id: "w1",
        include: "ippoan/rust-alc-api",
        "target_tag__ippoan/rust-alc-api": "v1.2.0",
      }),
      env,
    );
    expect(resp.status).toBe(502);
    const body = await resp.json<{ code: string }>();
    expect(body.code).toBe("HEAD_SHA_FETCH_FAILED");
    expect(start).not.toHaveBeenCalled();
  });

  it("calls hub.start with resolved head_sha and 303-redirects", async () => {
    const { env, start } = fakeEnv();
    vi.stubGlobal(
      "fetch",
      ghFetch({
        shaFor: (url) =>
          url.includes("alc-app") ? "sha_frontend" : "sha_backend",
      }),
    );

    const resp = await handleReleaseWaveStart(
      postRequest({
        wave_id: "wave_x",
        flip_policy: "manual-approval",
        note: "theme",
        include: ["ippoan/rust-alc-api", "ippoan/alc-app"],
        "target_tag__ippoan/rust-alc-api": "v1.2.0",
        "target_tag__ippoan/alc-app": "v3.0.0",
        require_compatibility: "ippoan/rust-alc-api",
      }),
      env,
    );

    expect(resp.status).toBe(303);
    expect(resp.headers.get("Location")).toBe("/release-wave/wave_x");
    expect(start).toHaveBeenCalledTimes(1);
    const arg = start.mock.calls[0]![0];
    expect(arg.wave_id).toBe("wave_x");
    expect(arg.flip_policy).toBe("manual-approval");
    expect(arg.note).toBe("theme");
    expect(arg.repos).toEqual([
      {
        repo: "ippoan/rust-alc-api",
        target_tag: "v1.2.0",
        head_sha: "sha_backend",
        require_compatibility: true,
      },
      {
        repo: "ippoan/alc-app",
        target_tag: "v3.0.0",
        head_sha: "sha_frontend",
      },
    ]);
  });

  it("defaults invalid flip_policy to manual-approval", async () => {
    const { env, start } = fakeEnv();
    vi.stubGlobal("fetch", ghFetch());
    await handleReleaseWaveStart(
      postRequest({
        wave_id: "w1",
        flip_policy: "garbage",
        include: "ippoan/rust-alc-api",
        "target_tag__ippoan/rust-alc-api": "v1.0.0",
      }),
      env,
    );
    expect(start.mock.calls[0]![0].flip_policy).toBe("manual-approval");
  });

  it("maps ALREADY_EXISTS to 409", async () => {
    const { env } = fakeEnv({
      startReturn: {
        ok: false,
        code: "ALREADY_EXISTS",
        error: "exists",
      },
    });
    vi.stubGlobal("fetch", ghFetch());
    const resp = await handleReleaseWaveStart(
      postRequest({
        wave_id: "dup",
        include: "ippoan/rust-alc-api",
        "target_tag__ippoan/rust-alc-api": "v1.0.0",
      }),
      env,
    );
    expect(resp.status).toBe(409);
  });

  it("maps WAVE_IN_PROGRESS to 409", async () => {
    const { env } = fakeEnv({
      startReturn: {
        ok: false,
        code: "WAVE_IN_PROGRESS",
        error: "busy",
      },
    });
    vi.stubGlobal("fetch", ghFetch());
    const resp = await handleReleaseWaveStart(
      postRequest({
        wave_id: "w2",
        include: "ippoan/rust-alc-api",
        "target_tag__ippoan/rust-alc-api": "v1.0.0",
      }),
      env,
    );
    expect(resp.status).toBe(409);
  });
});
