import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { clearReleaseCache } from "../src/release-cache";

// `watched` populates the Hub `/statuses` response so the no-params index
// page can enumerate repos. Defaults to empty so existing tests keep their
// pre-#41 behavior (form-only).
function testEnv(opts: { watched?: string[] } = {}): Env {
  const watched = opts.watched ?? [];
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: "test-secret",
    GITHUB_TOKEN: "test-token",
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

  it("closed rows are NOT checked by default; open rows (including bug-labeled) ARE", async () => {
    stubGithubApi();
    const req = new Request("http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    const html = await res.text();

    // #42 has no warnings → checkbox starts checked.
    expect(html).toMatch(/name="issue" value="42" checked/);
    // #50 is closed → still unchecked.
    expect(html).toMatch(/name="issue" value="50"(?! checked)/);
    // #99 has the `bug` label but is open. Per #77 the label no longer
    // triggers a warning, so the checkbox starts checked.
    expect(html).toMatch(/name="issue" value="99" checked/);

    // Warning icon + tooltip remain for the closed row only.
    expect(html).toContain("⚠️");
    expect(html).toContain("already closed");
    expect(html).not.toContain("bug label");
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
  });

  it("omits a synthetic block when the recent commit window has no Refs", async () => {
    // Direct-push-OK repo, but the recent commits don't reference any issue —
    // we drop the whole RepoView so the landing page doesn't grow a noisy
    // empty card.
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
    // Repo dropped → empty-state hint shown, no synthetic block markup.
    expect(html).toContain("No releases with referenced issues");
    expect(html).not.toContain("yhonda-ohishi/claude-hooks");
  });

  // #59: once every referenced issue in a repo card is closed, the
  // "✅ Close selected as released" button has nothing to act on and
  // round-trips empty. Hide it; keep the closed-history <details> as
  // audit context.
  it("hides the close button when all visible candidates are already closed", async () => {
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
      // The referenced issue is already closed → block.issues is non-empty
      // (so the tag block renders) but hasVisibleCandidate is false.
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
    // Card itself still renders so the closed-history <details> stays visible.
    expect(html).toContain("ippoan/ci-dashboard");
    expect(html).toContain("1 closed issue");
    // But the actions row (and its button) is gone.
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

  it("does not turn an unallowlisted tag-less repo into a synthetic block", async () => {
    // Guard against the auto-merge regression the user called out: a PR repo
    // briefly without tags must NOT show its main-branch commits here.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;

      // Allowlist is empty.
      if (url.includes("/contents/wt-direct-push/config/direct-push-ok.txt")) {
        return Response.json({ content: btoa(""), encoding: "base64" });
      }
      if (url.includes("/repos/ippoan/some-pr-repo/tags")) {
        return Response.json([]);
      }
      // /repos/{o}/{n} should NOT be hit for the non-allowlisted path; fail
      // loudly if it is so we notice the regression in CI.
      if (url.match(/\/repos\/ippoan\/some-pr-repo(\?|$)/)) {
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
    expect(html).toContain("No releases with referenced issues");
    expect(html).not.toContain("direct push");
  });
});
