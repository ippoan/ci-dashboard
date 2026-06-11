import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { clearReleaseCache } from "../src/release-cache";

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
    await env.CI_STATUS.delete("releases:index:v1");
    await env.CI_STATUS.delete("releases:index:refreshing");
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

  it("renders per-repo tables with stacked tag blocks and pair-encoded checkboxes", async () => {
    // Index data flow per repo: /tags → /compare/prev...current per top-N tag →
    // /issues/:n for each unique referenced issue. The stub answers each step.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      // ci-dashboard: 3 tags, 2 inline blocks (v1.2.0..v1.1.0..v1.0.0)
      if (url.includes("/repos/ippoan/ci-dashboard/tags")) {
        return Response.json([
          { name: "v1.2.0", commit: { sha: "a" } },
          { name: "v1.1.0", commit: { sha: "b" } },
          { name: "v1.0.0", commit: { sha: "c" } },
        ]);
      }
      if (url.includes("/repos/ippoan/ci-dashboard/compare/v1.1.0...v1.2.0")) {
        return Response.json({
          commits: [{ sha: "x", commit: { message: "feat: do thing\n\nRefs #1" } }],
        });
      }
      if (url.includes("/repos/ippoan/ci-dashboard/compare/v1.0.0...v1.1.0")) {
        return Response.json({
          commits: [{ sha: "y", commit: { message: "fix: bug-y\n\nRefs #2" } }],
        });
      }
      if (url.endsWith("/repos/ippoan/ci-dashboard/issues/1")) {
        return Response.json({
          number: 1, title: "clean issue", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/ci-dashboard/issues/1",
          updated_at: "2026-05-01T00:00:00Z",
        });
      }
      if (url.endsWith("/repos/ippoan/ci-dashboard/issues/2")) {
        return Response.json({
          number: 2, title: "warning-flagged", state: "open",
          labels: [{ name: "bug" }], assignees: [],
          html_url: "https://github.com/ippoan/ci-dashboard/issues/2",
          updated_at: "2026-05-01T00:00:00Z",
        });
      }

      // nuxt-notify: 2 tags, 1 block
      if (url.includes("/repos/ippoan/nuxt-notify/tags")) {
        return Response.json([
          { name: "v0.5.0", commit: { sha: "d" } },
          { name: "v0.4.0", commit: { sha: "e" } },
        ]);
      }
      if (url.includes("/repos/ippoan/nuxt-notify/compare/v0.4.0...v0.5.0")) {
        return Response.json({
          commits: [{ sha: "z", commit: { message: "feat\n\nRefs #100" } }],
        });
      }
      if (url.endsWith("/repos/ippoan/nuxt-notify/issues/100")) {
        return Response.json({
          number: 100, title: "feature", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/nuxt-notify/issues/100",
          updated_at: "2026-05-01T00:00:00Z",
        });
      }

      // dead-repo: /tags 403 → loadRepoView throws → repo card omitted.
      return new Response("rate limit", { status: 403 });
    });

    const e = testEnv({ watched: [
      "ippoan/ci-dashboard",
      "ippoan/nuxt-notify",
      "ohishi-exp/dead-repo",
    ] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();

    // Both populated repos rendered as cards; dead-repo dropped.
    expect(html).toContain("ippoan/ci-dashboard");
    expect(html).toContain("ippoan/nuxt-notify");
    expect(html).not.toContain("dead-repo");

    // Tag headers + previous-tag chips.
    expect(html).toContain("v1.2.0");
    expect(html).toContain("v1.1.0");
    expect(html).toContain("v0.5.0");

    // Issue rows show titles inline (no longer just chips).
    expect(html).toContain("clean issue");
    expect(html).toContain("warning-flagged");
    expect(html).toContain("feature");

    // Detail-page link per tag block ("→ detail").
    expect(html).toMatch(/href="\/releases\?repo=ippoan%2Fci-dashboard&tag=v1\.2\.0"/);

    // Checkbox values are `tag:issue` pairs. Per #77 bug-labeled open
    // issues are no longer warned, so #2 starts checked too. (A closed
    // row would still be `(?! checked)`; none in this fixture.)
    expect(html).toMatch(/name="pair" value="v1\.2\.0:1" checked/);
    expect(html).toMatch(/name="pair" value="v1\.1\.0:2" checked/);
    expect(html).toMatch(/name="pair" value="v0\.5\.0:100" checked/);

    // Batch-close form per repo points at the new endpoint.
    expect(html).toContain('action="/api/release-close-batch"');

    // Lookup form still present at the bottom for arbitrary-tag access.
    expect(html).toContain('<form method="GET" action="/releases"');
  });

  it("recovers a PR-body-only Ref in the latest tag window on the index (squash drops it from the subject)", async () => {
    // Refs ippoan/ci-dashboard#301: the index's tag-compare path now runs the
    // detail page's PR follow-up for the MOST RECENT release window, so a
    // `Refs #N` that lives only in the PR body (squash-merge keeps just the
    // `(#PR)` subject) still surfaces on the card. Mirrors alc-app#30, which
    // shipped in v0.0.7 referenced solely by PR #31's body.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      if (url.includes("/repos/ippoan/alc-app/tags")) {
        return Response.json([
          { name: "v0.0.7", commit: { sha: "a" } },
          { name: "v0.0.6", commit: { sha: "b" } },
        ]);
      }
      // Latest window: squash subject carries only `(#31)` — no `Refs` trailer.
      if (url.includes("/repos/ippoan/alc-app/compare/v0.0.6...v0.0.7")) {
        return Response.json({
          commits: [{ sha: "x", commit: { message: "ci: add release-wave-retest.yml (#31)" } }],
        });
      }
      // The Ref lives only in the PR body.
      if (url.endsWith("/repos/ippoan/alc-app/pulls/31")) {
        return Response.json({
          number: 31,
          head: { ref: "claude/great-dijkstra-vpnk8o" },
          body: "wires up the retest receiver.\n\nRefs ippoan/alc-app#30",
        });
      }
      if (url.endsWith("/repos/ippoan/alc-app/issues/30")) {
        return Response.json({
          number: 30, title: "release-wave retest missing", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/alc-app/issues/30",
          updated_at: "2026-06-09T00:00:00Z",
        });
      }
      return new Response("not found", { status: 404 });
    });

    const e = testEnv({ watched: ["ippoan/alc-app"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // #30, recovered from PR #31's body, renders on the alc-app card.
    expect(html).toContain("ippoan/alc-app");
    expect(html).toContain("release-wave retest missing");
    expect(html).toMatch(/name="pair" value="v0\.0\.7:30"/);
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

  it("collapses already-closed issues into a <details> section on the index", async () => {
    // Same minimal index-flow stub as above, but issue #2 is already closed.
    // It must NOT be in the main <table> rows; it should live inside a
    // <details> wrapper labeled "1 closed issue".
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      if (url.includes("/repos/ippoan/ci-dashboard/tags")) {
        return Response.json([
          { name: "v1.2.0", commit: { sha: "a" } },
          { name: "v1.1.0", commit: { sha: "b" } },
        ]);
      }
      if (url.includes("/repos/ippoan/ci-dashboard/compare/v1.1.0...v1.2.0")) {
        return Response.json({
          commits: [
            { sha: "x", commit: { message: "feat\n\nRefs #1" } },
            { sha: "y", commit: { message: "fix\n\nRefs #2" } },
          ],
        });
      }
      if (url.endsWith("/repos/ippoan/ci-dashboard/issues/1")) {
        return Response.json({
          number: 1, title: "still open", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/ci-dashboard/issues/1",
          updated_at: "2026-05-01T00:00:00Z",
        });
      }
      if (url.endsWith("/repos/ippoan/ci-dashboard/issues/2")) {
        return Response.json({
          number: 2, title: "already-done bug", state: "closed",
          labels: [{ name: "bug" }], assignees: [],
          html_url: "https://github.com/ippoan/ci-dashboard/issues/2",
          updated_at: "2026-05-01T00:00:00Z",
        });
      }
      return new Response("not stubbed", { status: 500 });
    });

    const e = testEnv({ watched: ["ippoan/ci-dashboard"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();

    // The closed issue is still on the page (so it can be expanded)…
    expect(html).toContain("already-done bug");
    expect(html).toContain("#2");
    // …but wrapped in a <details> with the right summary copy.
    expect(html).toContain('<details class="closed-details">');
    expect(html).toContain("<summary>1 closed issue</summary>");
    // Tag-release 運用 badge (要 tag) が card 見出しに付く (Refs #312)。
    expect(html).toContain('<span class="mode-badge mode-needs-tag"');
    // Open issue stays in the main candidate table outside the <details>;
    // closed issue's checkbox row is below the <details> boundary.
    const [beforeDetails, afterDetails] = html.split('<details class="closed-details">');
    expect(beforeDetails).toMatch(/name="pair" value="v1\.2\.0:1"/);
    expect(beforeDetails).not.toMatch(/name="pair" value="v1\.2\.0:2"/);
    expect(afterDetails).toMatch(/name="pair" value="v1\.2\.0:2"/);
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
  it("collapses an all-closed repo to a single compact line", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      if (url.includes("/repos/ippoan/ci-dashboard/tags")) {
        return Response.json([
          { name: "v1.0.0", commit: { sha: "a" } },
          { name: "v0.9.0", commit: { sha: "b" } },
        ]);
      }
      if (url.includes("/compare/v0.9.0...v1.0.0")) {
        return Response.json({
          commits: [{ sha: "x", commit: { message: "feat\n\nRefs #1" } }],
        });
      }
      // The only referenced issue is already closed → no open block → the
      // repo card collapses to the compact closed-summary line.
      if (url.endsWith("/repos/ippoan/ci-dashboard/issues/1")) {
        return Response.json({
          number: 1, title: "old work", state: "closed",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/ci-dashboard/issues/1",
          updated_at: "2026-05-01T00:00:00Z",
        });
      }
      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const e = testEnv({ watched: ["ippoan/ci-dashboard"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // Compact one-liner: repo link + deduped closed count, no expandable list.
    expect(html).toContain("ippoan/ci-dashboard");
    expect(html).toContain("repo-card-compact");
    expect(html).toContain("1 closed issue (released)");
    // No expandable closed <details>, no checkbox form, no close button.
    expect(html).not.toContain('<details class="closed-details">');
    expect(html).not.toMatch(/name="pair"/);
    expect(html).not.toContain("Close selected as released");
  });

  it("sets browser-cacheable Cache-Control on the no-flash detail page", async () => {
    stubGithubApi();
    const req = new Request("http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    // Detail page: longer TTL since a single repo+tag changes less often.
    expect(res.headers.get("Cache-Control")).toMatch(/max-age=30/);
    expect(res.headers.get("Cache-Control")).toMatch(/stale-while-revalidate/);
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
  it("prepends an Unreleased synthetic block for a TAGLESS_REPOS repo that has tags", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      // direct-push allowlist は空 (= TAGLESS_REPOS だけで repo を拾う)
      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({ content: btoa(""), encoding: "base64" });
      }

      // 通常通り tag がある repo
      if (url.includes("/repos/ippoan/mixed-repo/tags")) {
        return Response.json([
          { name: "v1.0.0", commit: { sha: "tag1aaaa" } },
        ]);
      }

      // default_branch lookup (loadSyntheticBlock で必要)
      if (url.match(/\/repos\/ippoan\/mixed-repo(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }

      // latest_tag..HEAD の compare (Unreleased zone)
      if (url.includes("/repos/ippoan/mixed-repo/compare/v1.0.0...main")) {
        return Response.json({
          commits: [
            // 1 つ目: bare Refs (古い)
            { sha: "abc1111111111111", commit: { message: "feat: foo\n\nRefs #200" } },
            // 2 つ目: cross-repo style Refs (新しい = HEAD、PR #149 の修正で拾える形)
            { sha: "def2222222222222", commit: { message: "fix: bar\n\nRefs ippoan/mixed-repo#201" } },
          ],
        });
      }

      // tag 内部の compare は空でも問題ない (loadRepoView が prevTag=null なら refs 空)
      // ここでは TOP_TAGS_INLINE=5 中 1 tag のみ提供しているので呼ばれない。

      // 上記 Unreleased zone で抽出される issue
      if (url.endsWith("/repos/ippoan/mixed-repo/issues/200")) {
        return Response.json({
          number: 200, title: "merged-but-unreleased issue", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/mixed-repo/issues/200",
          updated_at: "2026-05-27T00:00:00Z",
        });
      }
      if (url.endsWith("/repos/ippoan/mixed-repo/issues/201")) {
        return Response.json({
          number: 201, title: "cross-repo-style ref", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/mixed-repo/issues/201",
          updated_at: "2026-05-27T01:00:00Z",
        });
      }

      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const e = testEnv({ tagless: ["ippoan/mixed-repo"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();

    // Unreleased synthetic block が出ている (label に "Unreleased" + HEAD sha7)
    expect(html).toContain("Unreleased (main@def2222)");
    // 両方の issue (bare + cross-repo style) が候補として表示される
    expect(html).toContain("merged-but-unreleased issue");
    expect(html).toContain("cross-repo-style ref");
    // 既存 tag block (v1.0.0 / prev 無し) はそのまま — refs が無いので tag 自体は
    // 表示されるが issue は付かない。HTML に tag 名は出てよい。
    expect(html).toContain("ippoan/mixed-repo");
  });

  // squash-merge の subject は `(#PR)` だけを残し、PR 本文の `Refs #N` trailer を
  // 落とす (例: ci-dashboard#272 が "…統合 (#272)" として merge され `Refs #271`
  // は本文のみ)。一覧の Unreleased block は commit message だけ見ていたため、
  // commit から拾えるのは PR #272 (= pull_request、除外される) のみで issue #271
  // が永久に出ず、card が "全部 closed" に潰れていた。Unreleased zone でも detail
  // ページ同様に PR 本文 / branch から ref を回収するようにした回帰ガード。
  // Refs ippoan/ci-dashboard#290。
  it("recovers an Unreleased issue referenced only in the PR body (squash dropped Refs)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({ content: btoa(""), encoding: "base64" });
      }

      if (url.includes("/repos/ippoan/squash-repo/tags")) {
        return Response.json([{ name: "v1.0.0", commit: { sha: "tag1aaaa" } }]);
      }

      if (url.match(/\/repos\/ippoan\/squash-repo(\?|$)/)) {
        return Response.json({ default_branch: "main" });
      }

      // Unreleased zone: 唯一の commit は PR 番号だけ (Refs trailer 無し)
      if (url.includes("/repos/ippoan/squash-repo/compare/v1.0.0...main")) {
        return Response.json({
          commits: [
            { sha: "f7d92dc0000000000", commit: { message: "feat: rollback UI を統合 (#272)" } },
          ],
        });
      }

      // PR follow-up: 本文に `Refs #271`、branch は issue prefix を持たない
      if (url.endsWith("/repos/ippoan/squash-repo/pulls/272")) {
        return Response.json({
          number: 272,
          head: { ref: "claude/admiring-bell-dar5v" },
          body: "## 概要\n\n…統合する。\n\nRefs #271\n",
        });
      }

      // PR 本文経由で初めて拾われる open issue
      if (url.endsWith("/repos/ippoan/squash-repo/issues/271")) {
        return Response.json({
          number: 271, title: "rollback UI を version 行と統合する", state: "open",
          labels: [], assignees: [],
          html_url: "https://github.com/ippoan/squash-repo/issues/271",
          updated_at: "2026-06-04T09:09:27Z",
        });
      }

      return new Response(`not stubbed: ${url}`, { status: 500 });
    });

    const e = testEnv({ tagless: ["ippoan/squash-repo"] });
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, e, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();

    // commit には Refs が無いのに、PR 本文経由で issue #271 が候補に出る
    expect(html).toContain("Unreleased (main@f7d92dc)");
    expect(html).toContain("rollback UI を version 行と統合する");
  });

  // pure-tagless repo (semver tag ゼロ、`dev-*` のみ等: claude-hooks /
  // mcp-cf-workers) は no-sinceTag synthetic パス (default branch の最近 commit)
  // を通る。ここでも squash で本文 `Refs #N` が落ちた issue を PR follow-up で
  // 回収する。Refs ippoan/ci-dashboard#291。
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
});

// ───── /releases index SWR blob (Refs #325) ─────
describe("GET /releases — index SWR blob (Refs #325)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearReleaseCache(env.CI_STATUS);
    await env.CI_STATUS.delete("direct-push-allowlist:v1");
    await env.CI_STATUS.delete("releases:index:v1");
    await env.CI_STATUS.delete("releases:index:refreshing");
  });

  function seedIndexBlob(storedAt: number, views: unknown[]): Promise<void> {
    return env.CI_STATUS.put(
      "releases:index:v1",
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
    // 背景 refresh の compute は空 fixture (watched なし) で即完走させる
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("not stubbed", { status: 500 }));
    const oldStoredAt = Date.now() - 120_000;
    await seedIndexBlob(oldStoredAt, [seededView]);

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/releases"), testEnv(), ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // 旧 blob の中身を即返し + 更新中 note
    expect(html).toContain("blob から出た issue");
    expect(html).toContain('<div class="refreshing-note">');

    // waitUntil の背景 refresh が blob を書き直す (watched 空 → views [])
    await waitOnExecutionContext(ctx);
    const blob = await env.CI_STATUS.get("releases:index:v1", "json") as
      { storedAt: number; views: unknown[] };
    expect(blob.storedAt).toBeGreaterThan(oldStoredAt);
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
    expect(await env.CI_STATUS.get("releases:index:v1")).not.toBeNull();
  });
});

// ───── repo 単位の更新中表示 + WS live reload (Refs #327) ─────
describe("GET /releases — 更新中バッジ + live reload (Refs #327)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearReleaseCache(env.CI_STATUS);
    await env.CI_STATUS.delete("direct-push-allowlist:v1");
    await env.CI_STATUS.delete("releases:index:v1");
    await env.CI_STATUS.delete("releases:index:refreshing");
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
    await env.CI_STATUS.put("releases:index:v1", JSON.stringify({
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
    await env.CI_STATUS.put("releases:index:v1", JSON.stringify({
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
