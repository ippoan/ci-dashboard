import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { clearReleaseCache } from "../src/release-cache";
import { PR_MAP_CACHE_KEY } from "../src/pr-map-cache";

// `watched` populates the Hub `/statuses` response so the no-params index
// page can enumerate repos. Defaults to empty so existing tests keep their
// pre-#41 behavior (form-only).
function testEnv(opts: { watched?: string[]; tagless?: string[] } = {}): Env {
  const watched = opts.watched ?? [];
  const tagless = opts.tagless;
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => "test-secret" } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "test-internal" } as unknown as SecretsStoreSecret,
    CI_HUB: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (req: Request) => {
          if (new URL(req.url).pathname === "/statuses") {
            return Response.json(watched.map((repo) => ({ repo })));
          }
          return new Response("OK");
        },
      }),
    } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => "test-webhook-secret" } as unknown as SecretsStoreSecret,
    ...(tagless ? { TAGLESS_REPOS: tagless.join(",") } : {}),
  };
}

// URL-aware stub: branches on the GitHub API path so each step of the data
// loader (tags → compare → pulls/:n → issues/:n) gets a tailored response.
//
// Test fixture covers:
//   - 2 commits between v1.1.0..v1.2.0
//     * commit A:  "feat(x): foo (#11)"   PR #11  branch `42-feat-foo`  body "Refs #99"
//     * commit B:  "fix(y): bar\n\nRefs #50"   no trailing PR
//   - resulting candidate issues: 42 (from branch), 50 (from Refs in B),
//                                 99 (from PR body)
//   - issue 42: open, no labels                    → no warnings, ON
//   - issue 50: closed                              → "already closed" warn, OFF
//   - issue 99: open, label "bug"                   → "bug label" warn, OFF
function stubGithubApi(opts: { tagExists?: boolean; failPr?: boolean } = {}) {
  const tagExists = opts.tagExists ?? true;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
    const url = typeof req === "string" ? req : (req as Request).url;

    if (url.includes("/tags?")) {
      return Response.json(tagExists ? [
        { name: "v1.2.0", commit: { sha: "aaaaaaa" } },
        { name: "v1.1.0", commit: { sha: "bbbbbbb" } },
        { name: "v1.0.0", commit: { sha: "ccccccc" } },
      ] : [
        { name: "v9.9.9", commit: { sha: "zzzzzzz" } },
      ]);
    }

    if (url.includes("/compare/v1.1.0...v1.2.0")) {
      return Response.json({
        commits: [
          { sha: "aaa", commit: { message: "feat(x): foo (#11)" } },
          { sha: "bbb", commit: { message: "fix(y): bar\n\nRefs #50" } },
        ],
      });
    }

    if (url.endsWith("/pulls/11")) {
      if (opts.failPr) return new Response("boom", { status: 500 });
      return Response.json({
        head: { ref: "42-feat-foo" },
        body: "summary\n\nRefs #99",
      });
    }

    if (url.endsWith("/issues/42")) {
      return Response.json({
        number: 42, title: "open clean", state: "open",
        labels: [], assignees: [],
        html_url: "https://github.com/ippoan/ci-dashboard/issues/42",
        updated_at: "2026-05-10T00:00:00Z",
      });
    }
    if (url.endsWith("/issues/50")) {
      return Response.json({
        number: 50, title: "already done", state: "closed",
        labels: [], assignees: [],
        html_url: "https://github.com/ippoan/ci-dashboard/issues/50",
        updated_at: "2026-05-09T00:00:00Z",
      });
    }
    if (url.endsWith("/issues/99")) {
      return Response.json({
        number: 99, title: "<script>alert(1)</script> & bug",
        state: "open",
        labels: [{ name: "bug" }], assignees: [{ login: "yhonda-ohishi" }],
        html_url: "https://github.com/ippoan/ci-dashboard/issues/99",
        updated_at: "2026-05-11T00:00:00Z",
      });
    }

    return new Response("not stubbed: " + url, { status: 500 });
  });
}

describe("GET /releases", () => {
  // KV-backed release cache and the direct-push allowlist cache both persist
  // across tests in the shared CI_STATUS namespace; wipe them so fixture-A
  // doesn't leak into fixture-B (e.g. the synthetic-block test caching the
  // claude-hooks allowlist entry).
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearReleaseCache(env.CI_STATUS);
    await env.CI_STATUS.delete("direct-push-allowlist:v1");
    // /releases index の SWR blob (Refs #325) もテスト間で leak しないよう flush。
    await env.CI_STATUS.delete("releases:index:v3");
    await env.CI_STATUS.delete("releases:index:refreshing");
    await env.CI_STATUS.delete(PR_MAP_CACHE_KEY);
  });

  it("renders the empty-state landing page when nothing is watched yet", async () => {
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // No watched repos → empty hint + lookup form at the bottom.
    expect(html).toContain("No releases with referenced issues");
    expect(html).toContain('<form method="GET" action="/releases"');
    expect(html).toContain('name="repo"');
    expect(html).toContain('name="tag"');
  });



  it("falls back to the index page when only `repo` is given (no tag, no flash)", async () => {
    // Pre-#45 this rendered a partial lookup form. Now any incomplete shape
    // lands on the index so the operator never sees an empty form on its own.
    const req = new Request("http://localhost/releases?repo=ippoan/ci-dashboard");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // Empty-state landing copy (no watched repos in default testEnv).
    expect(html).toContain("No releases with referenced issues");
    // The lookup form is now appended at the bottom of the index page.
    expect(html).toContain('<form method="GET" action="/releases"');
  });


  it("renders the flash banner on `?repo=X&closed=N` (post-batch-close redirect)", async () => {
    // This is the exact URL shape /api/release-close-batch redirects to.
    // The previous routing fell through to renderForm and hid the banner.
    const req = new Request(
      "http://localhost/releases?repo=ippoan/nuxt-pwa-carins&closed=23,24",
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // Flash banner present with both closed issue numbers.
    expect(html).toContain("✅ Closed");
    expect(html).toContain("#23");
    expect(html).toContain("#24");
    // Issue numbers link to the GitHub repo that came along on the redirect.
    expect(html).toContain("https://github.com/ippoan/nuxt-pwa-carins/issues/23");
    expect(html).toContain("https://github.com/ippoan/nuxt-pwa-carins/issues/24");
    // Flash param を address bar から除去する script が同伴する (Refs #314)。
    // リロードしても banner が再表示されない。
    expect(html).toContain("history.replaceState");
  });

  it("flash 無しの page には replaceState script を出さない (Refs #314)", async () => {
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("history.replaceState");
  });

  it("renders release candidates with merged ref sources", async () => {
    stubGithubApi();
    const req = new Request("http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // Summary line shows current + previous tag.
    expect(html).toContain("ippoan/ci-dashboard");
    expect(html).toContain("v1.2.0");
    expect(html).toContain("v1.1.0");
    expect(html).toContain("2 commits");

    // All three issues end up in the table (branch / commit Refs / PR body Refs).
    expect(html).toContain("#42");
    expect(html).toContain("#50");
    expect(html).toContain("#99");

    // Title-level XSS is escaped.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");

    // Form points at POST endpoint.
    expect(html).toContain('action="/api/release-close"');
  });

  it("already-closed rows move to the audit <details>; open rows stay in the form and are checked by default", async () => {
    stubGithubApi();
    const req = new Request("http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    const html = await res.text();

    // #42 (open, no warnings) → in form, checked.
    expect(html).toMatch(/name="issue" value="42" checked/);
    // #99 (open, "bug" label — no longer warned per #77) → in form, checked.
    expect(html).toMatch(/name="issue" value="99" checked/);
    // #50 is closed → NOT in the form at all (no checkbox / no `name="issue"`
    // value="50") so the operator can't accidentally re-close it.
    expect(html).not.toMatch(/name="issue" value="50"/);

    // #50 still appears in the audit strip so the operator can confirm what
    // got resolved by this tag.
    expect(html).toContain("closed-details");
    expect(html).toMatch(/1 closed issue \(already resolved\)/);
    expect(html).toContain("#50");
    expect(html).toContain("already done");
  });

  it("returns 404 when the tag is not in the recent list", async () => {
    stubGithubApi({ tagExists: false });
    const req = new Request("http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Not found");
    expect(html).toContain("v1.2.0");
  });

  it("survives a 500 on a single PR fetch (no whole-page crash)", async () => {
    stubGithubApi({ failPr: true });
    const req = new Request("http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // #50 still pulled from commit B's Refs trailer — branch / body refs (#42, #99) are lost.
    expect(html).toContain("#50");
    expect(html).not.toContain("#42");
    expect(html).not.toContain("#99");
  });

  it("hides rows already in the flash `closed` list and shows ok flash", async () => {
    stubGithubApi();
    const req = new Request(
      "http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0&closed=42,50",
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // Closed flash visible.
    expect(html).toContain("Closed:");
    // 42 and 50 should not appear as checkbox rows (still appear in flash links).
    expect(html).not.toMatch(/name="issue" value="42"/);
    expect(html).not.toMatch(/name="issue" value="50"/);
    // 99 still in the candidate table.
    expect(html).toMatch(/name="issue" value="99"/);
  });

  it("rejects an org outside the allow-list with 502", async () => {
    // No fetch stub: validateOrg throws before any fetch. The page catches it
    // as a generic upstream error and renders 502.
    const req = new Request("http://localhost/releases?repo=evil-org/whatever&tag=v1");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("evil-org");
  });

  // #61: detail-page sibling of the index fix. When the flash redirect lands
  // after closing every row, the form/button must disappear; only the closed
  // flash banner + the "all closed" hint should remain.
  it("hides the detail form when the flash filter removes every remaining candidate", async () => {
    stubGithubApi();
    // Pass every candidate (42, 50, 99) through `closed=` so the filter empties
    // the table. The data loader still sees them, but the renderer should
    // recognize there's nothing left to act on.
    const req = new Request(
      "http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0&closed=42,50,99",
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // Flash banner survives (operator sees what just got closed).
    expect(html).toContain("Closed:");
    // No button, no form-shaped checkboxes.
    expect(html).not.toContain("Close selected as released");
    expect(html).not.toMatch(/name="issue" value="\d+"/);
    // Reassuring hint takes the form's slot.
    expect(html).toContain("All referenced issues for this release are closed");
  });

  // PR-driven (synthetic-only) /releases: tag を持つ repo でも tagBlocks は
  // synthetic block 1 個だけ (= default branch の recent commits + PR body Refs)。
  // 旧設計の per-tag compare 経路は廃止 (#360〜)。「issue は PR と紐づく、
  // tag とは紐づかない」が原則。
  it("v* tag を持つ repo でも synthetic-only で render される (PR-driven)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      // 監視 repo: v* tag を持っているが、index は tag-compare 経路を取らない。
      if (url.includes("/repos/ippoan/sample/tags")) {
        return Response.json([
          { name: "v0.2.0", commit: { sha: "aaaaaaaaaaaa" } },
          { name: "v0.1.0", commit: { sha: "bbbbbbbbbbbb" } },
        ]);
      }
      if (url.match(/\/repos\/ippoan\/sample(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }
      if (url.includes("/repos/ippoan/sample/commits")) {
        return Response.json([
          { sha: "cafe0011deadbeef", commit: { message: "fix: thing\n\nRefs #7" } },
        ]);
      }
      if (url.endsWith("/repos/ippoan/sample/issues/7")) {
        return Response.json({
          number: 7, title: "synthetic-only behavior", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/sample/issues/7",
          updated_at: "2026-06-16T00:00:00Z",
        });
      }
      // 旧 tag-compare 経路が呼ばれていたら 500 で fail (= 触れていないことの担保)。
      if (url.includes("/compare/")) {
        throw new Error(`tag-compare path must not be called: ${url}`);
      }
      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv({ watched: ["ippoan/sample"] }), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // synthetic block identity (= <branch>@<sha7>) で表示される。
    expect(html).toContain("main@cafe001");
    expect(html).toContain("direct push");
    // v0.2.0 / v0.1.0 のような tag identity が card 内に出ない。
    expect(html).not.toContain("v0.2.0");
    expect(html).not.toContain("v0.1.0");
    // 「🏷️ 要 tag」badge は廃止 (全 repo tagless)。
    expect(html).not.toContain('<span class="mode-badge mode-needs-tag"');
    expect(html).toContain('<span class="mode-badge mode-tagless"');
    // 候補行 + form pair encoding は synthetic 経路と同じ。
    expect(html).toContain(`name="pair" value="main@cafe001:7"`);
    expect(html).toContain("synthetic-only behavior");
  });

  // #57: synthetic block for tag-less direct-push-OK repos. The allowlist
  // comes from `yhonda-ohishi/claude-skills`; only repos appearing in it get
  // the fallback path so auto-merge PR repos in a brief tag-less window stay
  // off the page (which is what the user explicitly called out).
  it("renders a synthetic block from default-branch commits for an allowlisted tag-less repo", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      // SoT allowlist fetched from claude-skills repo.
      if (url.includes("/repos/yhonda-ohishi/claude-skills/contents/wt-direct-push/config/direct-push-ok.txt")) {
        const body = "yhonda-ohishi/claude-hooks\n";
        return Response.json({ content: btoa(body), encoding: "base64" });
      }

      // Target repo: no tags published → triggers the synthetic path.
      if (url.includes("/repos/yhonda-ohishi/claude-hooks/tags")) {
        return Response.json([]);
      }

      // /repos/{o}/{n} for default_branch lookup.
      if (url.match(/\/repos\/yhonda-ohishi\/claude-hooks(\?|$)/)) {
        return Response.json({ default_branch: "master" });
      }

      // Most recent default-branch commits — only one carries a Refs trailer,
      // the other is noise we expect the loader to skip cleanly.
      if (url.includes("/repos/yhonda-ohishi/claude-hooks/commits")) {
        return Response.json([
          { sha: "deadbeefcafe1234", commit: { message: "feat: hook\n\nRefs #2" } },
          { sha: "1111222233334444", commit: { message: "chore: tidy" } },
        ]);
      }

      // The Refs target — open + clean → checkbox defaults ON.
      if (url.endsWith("/repos/yhonda-ohishi/claude-hooks/issues/2")) {
        return Response.json({
          number: 2, title: "worktree-naming-guard hook", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/yhonda-ohishi/claude-hooks/issues/2",
          updated_at: "2026-05-12T00:00:00Z",
        });
      }

      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    // No `watched` — the repo only appears via the allowlist, proving the
    // Hub-cache ∪ allowlist union path actually picks it up.
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();

    // Synthetic tag identity: <branch>@<sha7> from the HEAD commit.
    expect(html).toContain("master@deadbee");
    // The "direct push" marker replaces the "→ detail" link.
    expect(html).toContain("direct push");
    expect(html).not.toMatch(/→ detail[\s\S]*master@deadbee/);
    // The candidate row + form pair encoding works the same as the tag path.
    expect(html).toContain(`name="pair" value="master@deadbee:2"`);
    expect(html).toContain("worktree-naming-guard hook");
    // Tagless 運用 badge が card 見出しに付く (Refs #312)。CSS 定義は常に
    // 含まれるので、badge の実 HTML (span) でアサートする。
    expect(html).toContain('<span class="mode-badge mode-tagless"');
    expect(html).not.toContain('<span class="mode-badge mode-needs-tag"');
  });

  it("renders an empty card (no synthetic block) when the recent commit window has no Refs", async () => {
    // Direct-push-OK repo, but the recent commits don't reference any issue.
    // Per Refs #224 the repo still shows as a card with a "no referenced
    // issues" note — but it must NOT grow a synthetic tag block.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({
          content: btoa("yhonda-ohishi/claude-hooks\n"),
          encoding: "base64",
        });
      }
      if (url.includes("/repos/yhonda-ohishi/claude-hooks/tags")) {
        return Response.json([]);
      }
      if (url.match(/\/repos\/yhonda-ohishi\/claude-hooks(\?|$)/)) {
        return Response.json({ default_branch: "master" });
      }
      if (url.includes("/repos/yhonda-ohishi/claude-hooks/commits")) {
        return Response.json([
          { sha: "aaa", commit: { message: "no refs here" } },
        ]);
      }
      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // Repo card present with the no-refs note; no synthetic block / tag label.
    expect(html).toContain("yhonda-ohishi/claude-hooks");
    expect(html).toContain("No referenced issues in the recent release window");
    expect(html).not.toContain("master@");
    expect(html).not.toMatch(/name="pair"/);
  });

  // #226: when every referenced issue in a repo is already closed, the whole
  // card collapses to a single compact line ("✅ N closed (released)") instead
  // of a tall stack of expandable "N closed issues" <details>. No close button,
  // no <details>, no checkbox form — just the one-liner.

  it("全 page を no-store にして close 直後の stale 表示を防ぐ", async () => {
    // 旧設計の `max-age=15 / swr=60` (index) や `max-age=30 / swr=120` (detail)
    // は close 直後の `?closed=N` flash が消えた後の reload で旧 open 行を
    // 表示し続ける害があった。SSR は blob KV read のみで cheap なので
    // 全 page no-store に統一する (Refs ippoan/ci-dashboard PR #364 以降)。
    stubGithubApi();
    const req = new Request("http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("disables browser caching when flash params are present", async () => {
    // Flash redirects must always re-render with fresh server state — a
    // cached HTML response would show stale banner content on back/forward.
    stubGithubApi();
    const req = new Request(
      "http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0&closed=42",
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("re-uses cached GitHub responses on the second load (no duplicate fetches)", async () => {
    // The whole point of the KV cache layer: the SSR page hits api.github.com
    // once per fixture URL, then serves from KV on the next request. We count
    // the fetch calls (which the cache helper bypasses on KV-hit) instead of
    // asserting on KV internals.
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      fetchCount++;
      // Empty allowlist so the synthetic path doesn't fire for any other repo.
      // We cache it on success so the second load skips this round-trip too.
      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        // parseAllowlist drops empty content → repos.length === 0 → NO cache
        // write. Return a placeholder entry that gets cached and resolves to
        // a no-op (its tags fetch returns []).
        return Response.json({ content: btoa("ippoan/placeholder\n"), encoding: "base64" });
      }
      if (url.includes("/repos/ippoan/placeholder/tags")) {
        return Response.json([]);
      }
      if (url.match(/\/repos\/ippoan\/placeholder(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }
      if (url.includes("/repos/ippoan/placeholder/commits")) {
        return Response.json([]);
      }
      // archived filter (#155) で meta fetch が走るため、ここも stub して
      // 2 度目の load で KV hit するようにする (= fetch 数が増えない invariant
      // を維持)。stub しないと 500 → throw → 未キャッシュで毎回 fetch する。
      if (url.match(/\/repos\/ippoan\/ci-dashboard(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }
      if (url.includes("/repos/ippoan/ci-dashboard/tags")) {
        return Response.json([
          { name: "v1.2.0", commit: { sha: "a" } },
          { name: "v1.1.0", commit: { sha: "b" } },
        ]);
      }
      if (url.includes("/compare/v1.1.0...v1.2.0")) {
        return Response.json({
          commits: [{ sha: "x", commit: { message: "feat\n\nRefs #1" } }],
        });
      }
      if (url.endsWith("/issues/1")) {
        return Response.json({
          number: 1, title: "x", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/ci-dashboard/issues/1",
          updated_at: "2026-05-01T00:00:00Z",
        });
      }
      return new Response("not stubbed", { status: 500 });
    });

    const e = testEnv({ watched: ["ippoan/ci-dashboard"] });
    const req1 = new Request("http://localhost/releases");
    const ctx1 = createExecutionContext();
    await worker.fetch(req1, e, ctx1);
    await waitOnExecutionContext(ctx1);
    const firstLoadCalls = fetchCount;
    expect(firstLoadCalls).toBeGreaterThan(0);

    const req2 = new Request("http://localhost/releases");
    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(req2, e, ctx2);
    await waitOnExecutionContext(ctx2);
    // Second load should be served entirely from KV — no new GitHub calls.
    expect(fetchCount).toBe(firstLoadCalls);
    expect(res2.status).toBe(200);
  });

  // TAGLESS_REPOS にいる repo が tag を持つ場合、latest tag → HEAD の Unreleased
  // 区間に対する synthetic block を tag blocks の先頭に追加する。
  // ci-dashboard / secrets-inventory のように「PR merge = staging deploy だが
  // release tag も cut する」混合運用の repo で、merge 済み未 release な PR
  // の issue を `/releases` で目視できるようにするのが目的。
  // Refs ippoan/ci-dashboard#147 (cross-repo Refs 修正) + #145 (TAGLESS 追加)。
  it("recovers a pure-tagless issue referenced only in the PR body (no-sinceTag path)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({ content: btoa(""), encoding: "base64" });
      }

      // semver tag 無し (`dev-*` のみ) → isSemverTag で全部弾かれ no-sinceTag パス
      if (url.includes("/repos/ippoan/hooks-repo/tags")) {
        return Response.json([{ name: "dev-0.0.4", commit: { sha: "dddddddd" } }]);
      }

      if (url.match(/\/repos\/ippoan\/hooks-repo(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }

      // default branch の最近 commit (cachedCommits): PR 番号だけ、Refs 無し
      if (url.includes("/repos/ippoan/hooks-repo/commits")) {
        return Response.json([
          { sha: "b21f5ee0000000000", commit: { message: "feat: add npm-ippoan-local-fallback hook (#13)" } },
        ]);
      }

      // PR follow-up: 本文に `Refs #12`
      if (url.endsWith("/repos/ippoan/hooks-repo/pulls/13")) {
        return Response.json({
          number: 13,
          head: { ref: "claude/release-wave-e2e-testing-bJ6wU" },
          body: "## 目的 (Refs #12)\n\n…file: フォールバック hook。\n\nRefs #12\n",
        });
      }

      if (url.endsWith("/repos/ippoan/hooks-repo/issues/12")) {
        return Response.json({
          number: 12, title: "npm 401 時の local file: フォールバック hook", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/hooks-repo/issues/12",
          updated_at: "2026-06-04T08:59:01Z",
        });
      }

      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const e = testEnv({ tagless: ["ippoan/hooks-repo"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();

    // 無 tag の synthetic block (label は `<branch>@<sha7>`) に issue #12 が出る
    expect(html).toContain("main@b21f5ee");
    expect(html).toContain("npm 401 時の local file: フォールバック hook");
  });

  // cross-repo ref: 実装は cdp-relay (本 repo) の PR、issue は別 repo
  // (mcp-cf-workers) に居る。`Refs ippoan/mcp-cf-workers#28` を本 repo の card に
  // surface し、close は mcp-cf-workers に対して行えるよう pair に repo を埋める。
  // Refs ippoan/ci-dashboard#292。
  it("surfaces a cross-repo issue on the shipping repo's card with repo-tagged pair", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({ content: btoa(""), encoding: "base64" });
      }

      // 本 repo (relay-repo) は tag 無し → no-sinceTag synthetic パス
      if (url.includes("/repos/ippoan/relay-repo/tags")) {
        return Response.json([]);
      }
      if (url.match(/\/repos\/ippoan\/relay-repo(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }
      // commit は PR 番号のみ
      if (url.includes("/repos/ippoan/relay-repo/commits")) {
        return Response.json([
          { sha: "c0ffee00000000000", commit: { message: "feat: cdp-relay 初回実装 (#1)" } },
        ]);
      }
      // PR 本文に cross-repo ref
      if (url.endsWith("/repos/ippoan/relay-repo/pulls/1")) {
        return Response.json({
          number: 1,
          head: { ref: "claude/initial-impl" },
          body: "初回実装。\n\nRefs ippoan/mcp-cf-workers#28\n",
        });
      }
      // cross-repo issue を home repo から hydrate
      if (url.endsWith("/repos/ippoan/mcp-cf-workers/issues/28")) {
        return Response.json({
          number: 28, title: "[引継ぎ] cdp-relay 設計", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/mcp-cf-workers/issues/28",
          updated_at: "2026-06-05T00:19:48Z",
        });
      }

      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const e = testEnv({ tagless: ["ippoan/relay-repo"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();

    // cross-repo issue が relay-repo の card に出る
    expect(html).toContain("ippoan/mcp-cf-workers#28");
    expect(html).toContain("[引継ぎ] cdp-relay 設計");
    expect(html).toContain("cross-repo");
    // checkbox の pair が home repo を埋め込んでいる (close が mcp-cf-workers を叩く)
    expect(html).toContain("main@c0ffee0:ippoan/mcp-cf-workers#28");
  });

  // archived repo は GitHub API で issue close ができない (403 read-only) ため、
  // /releases から一切除外する。Refs ippoan/ci-dashboard#155
  // (ippoan/github-mcp-server-rs が monorepo 化で archive されたが Refs を
  // 含む過去 commit のせいで /releases に残り、close を試みて failed
  // していた問題)。
  it("excludes archived repos from /releases entirely", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({ content: btoa(""), encoding: "base64" });
      }

      // /repos/{o}/{n} で archived: true を返す
      if (url.match(/\/repos\/ippoan\/zombie-repo(\?|$)/)) {
        return Response.json({ default_branch: "main", archived: true });
      }

      // archived 判定が効いていれば tag fetch には到達しない。到達したら test fail。
      if (url.includes("/repos/ippoan/zombie-repo/tags")) {
        throw new Error("unexpected fetch: archived filter leaked, tag path reached");
      }

      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const e = testEnv({ watched: ["ippoan/zombie-repo"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("zombie-repo");
    // 何も watched に残らない empty-state に倒れる
    expect(html).toContain("No releases with referenced issues");
  });

  it("shows an unallowlisted tag-less repo as an empty card but never as a synthetic block", async () => {
    // Guard against the auto-merge regression the user called out: a PR repo
    // briefly without tags must NOT show its main-branch commits as a release.
    // Post-#224 the repo still appears as an empty card (full roster), but the
    // synthetic path (/commits fetch + "direct push" marker) must stay unentered.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      // Allowlist is empty.
      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({ content: btoa(""), encoding: "base64" });
      }
      // archived filter (#155) で meta fetch が走るようになったので、
      // 通常 repo として返す (archived: false 相当 = 未指定)。
      if (url.match(/\/repos\/ippoan\/some-pr-repo(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }
      if (url.includes("/repos/ippoan/some-pr-repo/tags")) {
        return Response.json([]);
      }
      // synthetic path 本体の indicator: /commits は loadSyntheticBlock 経由
      // のみで叩かれる。ここに到達したら synthetic path 漏れ。
      if (url.includes("/repos/ippoan/some-pr-repo/commits")) {
        throw new Error("unexpected fetch: synthetic path leaked");
      }
      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const e = testEnv({ watched: ["ippoan/some-pr-repo"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // Empty card shown (full roster)...
    expect(html).toContain("ippoan/some-pr-repo");
    expect(html).toContain("No referenced issues in the recent release window");
    // ...but never promoted to a synthetic block (no marker; /commits not hit,
    // enforced by the throw in the stub above).
    expect(html).not.toContain("direct push");
    expect(html).not.toMatch(/name="pair"/);
  });

  // pr-map gate (Refs #400): `Refs #N` を commit message から拾えても、
  // その issue を解決する `state:"merged"` PR が pr-map に無ければ close 候補
  // から外す。tag-release commit / direct-push commit が「PR 不在の checked
  // 候補」として並ぶ bug の修正。
  it("drops `Refs #N` whose issue has no merged PR in the pr-map", async () => {
    // pr-map cache を seed: #555 だけ merged PR (#42) が紐付き、#999 は無し。
    await env.CI_STATUS.put(
      PR_MAP_CACHE_KEY,
      JSON.stringify({
        storedAt: Date.now(),
        data: {
          "ippoan/gated-repo#555": [{
            repo: "ippoan/gated-repo",
            number: 42,
            title: "feat: thing",
            url: "https://github.com/ippoan/gated-repo/pull/42",
            draft: false,
            updated_at: "2026-06-10T00:00:00Z",
            state: "merged",
          }],
        },
      }),
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({ content: btoa(""), encoding: "base64" });
      }

      if (url.match(/\/repos\/ippoan\/gated-repo(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }
      if (url.includes("/repos/ippoan/gated-repo/tags")) {
        return Response.json([]);
      }
      // 直 push commit 2 本 (どちらも `Refs #N` 持ち、PR 経由ではない):
      //   - #555 → pr-map に merged PR が居る (keep)
      //   - #999 → pr-map に存在しない (drop)
      if (url.includes("/repos/ippoan/gated-repo/commits")) {
        return Response.json([
          { sha: "1111111", commit: { message: "chore: tag-release v1\n\nRefs #999" } },
          { sha: "2222222", commit: { message: "feat: ship thing\n\nRefs #555" } },
        ]);
      }
      // #555 だけ hydrate される想定 (#999 は drop されているので fetch 不要)
      if (url.endsWith("/repos/ippoan/gated-repo/issues/555")) {
        return Response.json({
          number: 555, title: "kept issue", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/gated-repo/issues/555",
          updated_at: "2026-06-10T00:00:00Z",
        });
      }
      // #999 を fetch しに来たら test fail (filter 漏れ)
      if (url.endsWith("/repos/ippoan/gated-repo/issues/999")) {
        throw new Error("unexpected fetch: pr-map gate let #999 through");
      }
      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const e = testEnv({ tagless: ["ippoan/gated-repo"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("kept issue");
    expect(html).not.toContain("#999");
  });

  // cross-repo scope filter (Refs #400): home repo が MAIN_ORGS + YHONDA_REPOS
  // の scope 外 (archived / 削除 / 別 owner) なら cross-repo ref を drop する。
  // close を試みても home 側に権限 / 存在が無く 403/404 で必ず失敗するため。
  it("drops cross-repo refs whose home repo is outside MAIN_ORGS + YHONDA_REPOS", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({ content: btoa(""), encoding: "base64" });
      }
      if (url.match(/\/repos\/ippoan\/shipping-repo(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }
      if (url.includes("/repos/ippoan/shipping-repo/tags")) {
        return Response.json([]);
      }
      // PR #1 の body に 2 種類の cross-repo ref:
      //   - ippoan/in-scope-repo#10 (ippoan org 内 → keep)
      //   - random-org/out-of-scope-repo#99 (scope 外 → drop)
      if (url.includes("/repos/ippoan/shipping-repo/commits")) {
        return Response.json([
          { sha: "abc1234", commit: { message: "feat: ship things (#1)" } },
        ]);
      }
      if (url.endsWith("/repos/ippoan/shipping-repo/pulls/1")) {
        return Response.json({
          number: 1,
          head: { ref: "claude/ship" },
          body: "Refs ippoan/in-scope-repo#10\nRefs random-org/out-of-scope-repo#99",
        });
      }
      // in-scope cross-repo issue は hydrate される
      if (url.endsWith("/repos/ippoan/in-scope-repo/issues/10")) {
        return Response.json({
          number: 10, title: "in-scope issue", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/in-scope-repo/issues/10",
          updated_at: "2026-06-10T00:00:00Z",
        });
      }
      // out-of-scope は filter で drop されるので fetch しに来てはいけない
      if (url.includes("random-org/out-of-scope-repo")) {
        throw new Error("unexpected fetch: scope filter let out-of-scope ref through");
      }
      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const e = testEnv({ tagless: ["ippoan/shipping-repo"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("in-scope issue");
    expect(html).not.toContain("out-of-scope-repo");
  });
});

// ───── /releases index SWR blob (Refs #325) ─────
describe("GET /releases — index SWR blob (Refs #325)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearReleaseCache(env.CI_STATUS);
    await env.CI_STATUS.delete("direct-push-allowlist:v1");
    await env.CI_STATUS.delete("releases:index:v3");
    await env.CI_STATUS.delete("releases:index:refreshing");
    await env.CI_STATUS.delete(PR_MAP_CACHE_KEY);
  });

  function seedIndexBlob(storedAt: number, views: unknown[]): Promise<void> {
    return env.CI_STATUS.put(
      "releases:index:v3",
      JSON.stringify({ storedAt, views }),
    );
  }

  const seededView = {
    repo: "ippoan/ci-dashboard",
    tagless: true,
    olderTags: [],
    tagBlocks: [{
      tag: "main@abc1234",
      prevTag: null,
      synthetic: true,
      issues: [{
        number: 7, title: "blob から出た issue", state: "open",
        labels: [], assignees: [], warnings: [],
        url: "https://github.com/ippoan/ci-dashboard/issues/7",
        updated_at: "2026-06-11T00:00:00Z",
      }],
    }],
  };

  it("fresh blob は GitHub を 1 回も叩かず即 render する", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await seedIndexBlob(Date.now(), [seededView]);

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/releases"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("blob から出た issue");
    // CSS 定義は常に含まれるので note の実 HTML でアサートする
    expect(html).not.toContain('<div class="refreshing-note">');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stale blob は即返し + refreshing note + 背景 refresh (waitUntil fallback)", async () => {
    // 背景 refresh の compute は空 fixture (watched なし) で即完走させる。
    // Refs #329: 空 views で non-empty blob を上書きしない invariant が入った
    // ため、blob 更新の検証は空 blob を seed して行う。
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("not stubbed", { status: 500 }));
    const oldStoredAt = Date.now() - 2 * 60 * 60 * 1000;
    await seedIndexBlob(oldStoredAt, []);

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/releases"), testEnv(), ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // stale 即返し中の note
    expect(html).toContain('<div class="refreshing-note">');

    // waitUntil の背景 refresh が blob を書き直す (空 → 空なので invariant 非該当)
    await waitOnExecutionContext(ctx);
    const blob = await env.CI_STATUS.get("releases:index:v3", "json") as
      { storedAt: number; views: unknown[] };
    expect(blob.storedAt).toBeGreaterThan(oldStoredAt);
  });

  it("stale blob (non-empty) の即返し時も中身が render される", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("not stubbed", { status: 500 }));
    await seedIndexBlob(Date.now() - 2 * 60 * 60 * 1000, [seededView]);

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/releases"), testEnv(), ctx);
    const html = await res.text();
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(html).toContain("blob から出た issue");
    expect(html).toContain('<div class="refreshing-note">');
  });

  it("flash 整合: closed= の issue は stale blob でも candidate から消える", async () => {
    await seedIndexBlob(Date.now(), [seededView]);

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/releases?repo=ippoan%2Fci-dashboard&closed=7"),
      testEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // flash banner には ✅ Closed: #7
    expect(html).toContain("✅ Closed");
    // candidate checkbox (visible table) には出ない — closed 扱いに変換され
    // closed-details 側へ落ちる
    const beforeDetails = html.split('<details class="closed-details">')[0];
    expect(beforeDetails).not.toMatch(/name="pair" value="main@abc1234:7"/);
  });

  it("cold start (blob 無し) は従来どおり同期生成して blob を書く", async () => {
    // watched 空 → 空 index。生成後に blob が存在する。
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/releases"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(await env.CI_STATUS.get("releases:index:v3")).not.toBeNull();
  });
});

// ───── repo 単位の更新中表示 + WS live reload (Refs #327) ─────
describe("GET /releases — 更新中バッジ + live reload (Refs #327)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearReleaseCache(env.CI_STATUS);
    await env.CI_STATUS.delete("direct-push-allowlist:v1");
    await env.CI_STATUS.delete("releases:index:v3");
    await env.CI_STATUS.delete("releases:index:refreshing");
    await env.CI_STATUS.delete(PR_MAP_CACHE_KEY);
  });

  const view = (repo: string) => ({
    repo, tagless: true, olderTags: [],
    tagBlocks: [{
      tag: "main@abc1234", prevTag: null, synthetic: true,
      issues: [{
        number: 1, title: "t", state: "open",
        labels: [], assignees: [], warnings: [],
        url: `https://github.com/${repo}/issues/1`,
        updated_at: "2026-06-11T00:00:00Z",
      }],
    }],
  });

  it("staleRepos の repo card に 🔄 更新中バッジ + note に repo 列挙", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("not stubbed", { status: 500 }));
    await env.CI_STATUS.put("releases:index:v3", JSON.stringify({
      storedAt: 0,
      views: [view("ippoan/foo"), view("ippoan/bar")],
      staleRepos: ["ippoan/foo"],
    }));

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/releases"), testEnv(), ctx);
    const html = await res.text();
    await waitOnExecutionContext(ctx);

    // note に原因 repo が列挙される
    expect(html).toContain("更新待ち");
    expect(html).toContain("<code>ippoan/foo</code>");
    // 該当 card のみバッジ
    const fooCard = html.split("ippoan/bar")[0];
    expect(fooCard).toContain("🔄 更新中");
    const barCard = html.split("ippoan/bar")[1];
    expect(barCard).not.toContain("🔄 更新中");
  });

  it("live reload script (releases-updated listener) を埋め込む", async () => {
    await env.CI_STATUS.put("releases:index:v3", JSON.stringify({
      storedAt: Date.now(), views: [],
    }));
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/releases"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    const html = await res.text();
    expect(html).toContain("releases-updated");
    expect(html).toContain('new WebSocket(proto + "//" + location.host + "/ws")');
    expect(html).toContain("location.reload()");
  });
});

// ───── refresh の rate-limit / 空上書きガード (Refs #329) ─────
describe("refreshReleasesIndex guards (Refs #329)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearReleaseCache(env.CI_STATUS);
    await env.CI_STATUS.delete("releases:index:v3");
    await env.CI_STATUS.delete("releases:index:refreshing");
    await env.CI_STATUS.delete("github:rl-backoff");
  });

  it("rate-limit backoff 中は fan-out せず blob を温存する", async () => {
    const { setRateLimitBackoff } = await import("../src/github-backoff");
    const { GitHubApiError } = await import("../src/github-api");
    const { refreshReleasesIndex } = await import("../src/releases-page");
    await setRateLimitBackoff(env.CI_STATUS, new GitHubApiError(403, "rate limit"));
    const seeded = JSON.stringify({ storedAt: 0, views: [{ repo: "ippoan/x", tagless: true, olderTags: [], tagBlocks: [] }], staleRepos: ["ippoan/x"] });
    await env.CI_STATUS.put("releases:index:v3", seeded);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const outcome = await refreshReleasesIndex(testEnv());

    expect(outcome).toBe("backoff");
    expect(fetchSpy).not.toHaveBeenCalled();
    // blob は stale のまま温存 (cooldown 明けの reschedule で追い付く)
    expect(await env.CI_STATUS.get("releases:index:v3")).toBe(seeded);
  });


  it("done の後も lock は即解放される (Refs #337)", async () => {
    const { refreshReleasesIndex } = await import("../src/releases-page");
    // watched 空 → views [] / recheck 無し → 正常 write の "done" 経路
    const outcome = await refreshReleasesIndex(testEnv());
    expect(outcome).toBe("done");
    expect(await env.CI_STATUS.get("releases:index:v3")).not.toBeNull();
    expect(await env.CI_STATUS.get("releases:index:refreshing")).toBeNull();
  });

  it("lock 残存中は 'lock' を返し blob に触らない", async () => {
    const { refreshReleasesIndex } = await import("../src/releases-page");
    await env.CI_STATUS.put("releases:index:refreshing", "1", { expirationTtl: 60 });
    const seeded = JSON.stringify({ storedAt: 0, views: [] });
    await env.CI_STATUS.put("releases:index:v3", seeded);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const outcome = await refreshReleasesIndex(testEnv());

    expect(outcome).toBe("lock");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await env.CI_STATUS.get("releases:index:v3")).toBe(seeded);
  });
});

// ───── GitHub 認証失効 note (Refs #334) ─────
describe("GET /releases — auth-broken note (Refs #334)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearReleaseCache(env.CI_STATUS);
    await env.CI_STATUS.delete("releases:index:v3");
    await env.CI_STATUS.delete("releases:index:refreshing");
    await env.CI_STATUS.delete("github:auth-broken");
  });

  it("marker があれば再ログイン note を出す", async () => {
    await env.CI_STATUS.put("releases:index:v3", JSON.stringify({ storedAt: Date.now(), views: [] }));
    await env.CI_STATUS.put("github:auth-broken", JSON.stringify({ at: Date.now(), message: "invalid_grant" }));
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/releases"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    expect(html).toContain("GitHub 認証が失効しています");
    expect(html).toContain("/oauth/login?return_to=/releases");
  });
});
