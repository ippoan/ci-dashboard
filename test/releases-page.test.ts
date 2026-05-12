import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: "test-secret",
    GITHUB_TOKEN: "test-token",
    CI_HUB: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("OK") }),
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
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders the lookup form when repo+tag are missing", async () => {
    const req = new Request("http://localhost/releases");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Enter a release tag");
    expect(html).toContain('<form method="GET" action="/releases"');
    expect(html).toContain('name="repo"');
    expect(html).toContain('name="tag"');
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

  it("warning rows are NOT checked by default; clean rows ARE", async () => {
    stubGithubApi();
    const req = new Request("http://localhost/releases?repo=ippoan/ci-dashboard&tag=v1.2.0");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    const html = await res.text();

    // #42 has no warnings → checkbox starts checked.
    expect(html).toMatch(/name="issue" value="42" checked/);
    // #50 is closed, #99 has bug label → both start unchecked.
    expect(html).toMatch(/name="issue" value="50"(?! checked)/);
    expect(html).toMatch(/name="issue" value="99"(?! checked)/);

    // Warning icon + tooltip present for warning rows.
    expect(html).toContain("⚠️");
    expect(html).toContain("already closed");
    expect(html).toContain("bug label");
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
});
