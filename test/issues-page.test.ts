import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { escapeHtml } from "../src/issues-page";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: "test-secret",
    GITHUB_TOKEN: "test-token",
    CI_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
  };
}

// Stub /search/issues. The handler fires two queries (main orgs + yhonda repo
// filter) so we branch on the `q` param to return different items per call.
// Main response covers two repos and a PR that must be filtered out; yhonda
// response covers one claude-skills issue. A hostile title verifies escaping.
function stubSearchIssues() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
    const url = typeof req === "string" ? req : (req as Request).url;
    if (!url.includes("/search/issues")) {
      return new Response("not stubbed: " + url, { status: 500 });
    }
    const decoded = decodeURIComponent(url);
    if (decoded.includes("repo:yhonda-ohishi/claude-skills")) {
      return Response.json({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            number: 1,
            title: "claude-skills issue",
            state: "open",
            user: { login: "yhonda-ohishi" },
            labels: [],
            assignees: [],
            comments: 0,
            created_at: "2026-05-12T00:00:00Z",
            updated_at: "2026-05-12T00:00:00Z",
            html_url: "https://github.com/yhonda-ohishi/claude-skills/issues/1",
            repository_url: "https://api.github.com/repos/yhonda-ohishi/claude-skills",
          },
        ],
      });
    }
    return Response.json({
      total_count: 3,
      incomplete_results: false,
      items: [
        {
          number: 7,
          title: "<script>alert('xss')</script> & ok",
          state: "open",
          user: { login: "yhonda-ohishi" },
          labels: [{ name: "bug" }, { name: "needs-triage" }],
          assignees: [],
          comments: 0,
          created_at: "2026-05-10T00:00:00Z",
          updated_at: "2026-05-10T03:00:00Z",
          html_url: "https://github.com/ippoan/rust-alc-api/issues/7",
          repository_url: "https://api.github.com/repos/ippoan/rust-alc-api",
        },
        {
          number: 3,
          title: "Add feature X",
          state: "open",
          user: { login: "yhonda-ohishi" },
          labels: [],
          assignees: [{ login: "yhonda-ohishi" }],
          comments: 2,
          created_at: "2026-05-09T00:00:00Z",
          updated_at: "2026-05-09T05:00:00Z",
          html_url: "https://github.com/ohishi-exp/daiun-salary/issues/3",
          repository_url: "https://api.github.com/repos/ohishi-exp/daiun-salary",
        },
        {
          number: 99,
          title: "This is a PR, must be excluded",
          state: "open",
          user: { login: "yhonda-ohishi" },
          labels: [],
          assignees: [],
          comments: 0,
          created_at: "2026-05-08T00:00:00Z",
          updated_at: "2026-05-08T00:00:00Z",
          html_url: "https://github.com/ippoan/rust-alc-api/pull/99",
          repository_url: "https://api.github.com/repos/ippoan/rust-alc-api",
          pull_request: { url: "https://api.github.com/..." },
        },
      ],
    });
  });
}

describe("GET /issues", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders an HTML page with repo-grouped tables", async () => {
    stubSearchIssues();
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Open Issues");
    // All three repos rendered as separate <section>: 2 from main call +
    // 1 from yhonda-ohishi claude-skills call (merged via Promise.all).
    expect(html).toContain("ippoan/rust-alc-api");
    expect(html).toContain("ohishi-exp/daiun-salary");
    expect(html).toContain("yhonda-ohishi/claude-skills");
    const sectionCount = (html.match(/<section class="repo">/g) ?? []).length;
    expect(sectionCount).toBe(3);
    // Issue numbers + dates
    expect(html).toContain("#7");
    expect(html).toContain("#3");
    expect(html).toContain("2026-05-10");
    // PR is filtered out
    expect(html).not.toContain("#99");
    expect(html).not.toContain("must be excluded");
    // Labels rendered as chips
    expect(html).toContain(">bug<");
    expect(html).toContain(">needs-triage<");
    // Back link to /
    expect(html).toContain('href="/"');
  });

  it("escapes HTML in issue titles (XSS guard)", async () => {
    stubSearchIssues();
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // Raw <script> must not appear in the body
    expect(html).not.toContain("<script>alert('xss')</script>");
    // Escaped form must appear
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(html).toContain("&amp;");
  });

  it("queries GitHub Search twice: main orgs and yhonda-ohishi/claude-* repo filter", async () => {
    const spy = stubSearchIssues();
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(spy).toHaveBeenCalledTimes(2);
    const urls = spy.mock.calls.map((c) => c[0] as string);
    const decoded = urls.map((u) => decodeURIComponent(u));

    // Main call: ippoan + ohishi-exp orgs without a repo: qualifier.
    const main = decoded.find((d) => d.includes("org:ippoan"));
    expect(main).toBeDefined();
    expect(main!).toContain("is:issue");
    expect(main!).toContain("state:open");
    expect(main!).toContain("org:ippoan");
    expect(main!).toContain("org:ohishi-exp");
    expect(main!).not.toContain("repo:yhonda-ohishi/claude-");

    // yhonda-ohishi call: repo: qualifiers (OR) for the two active claude
    // tooling repos only — and CRUCIALLY no `org:yhonda-ohishi`. GitHub Search
    // silently drops `repo:` when combined with `org:` (it widens the result
    // to the entire org), so fetchOrgIssues must omit `org:` whenever the
    // caller-supplied query contains a `repo:` qualifier. Regression guard
    // for issue #53.
    const yhonda = decoded.find((d) => d.includes("repo:yhonda-ohishi/claude-skills"));
    expect(yhonda).toBeDefined();
    expect(yhonda!).toContain("is:issue");
    expect(yhonda!).toContain("state:open");
    expect(yhonda!).toContain("repo:yhonda-ohishi/claude-skills");
    expect(yhonda!).toContain("repo:yhonda-ohishi/claude-hooks");
    expect(yhonda!).not.toContain("org:yhonda-ohishi");

    for (const u of urls) expect(u).toContain("per_page=100");
  });

  it("returns a friendly error page when GitHub API fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 403 }),
    );
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(502);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("Failed to fetch issues");
    expect(html).toContain("← CI Dashboard");
  });

  it("renders an empty-state message when no issues match", async () => {
    // Use mockImplementation, not mockResolvedValue: handleIssuesPage fires two
    // fetches in parallel and a single Response instance has a one-shot body.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ total_count: 0, incomplete_results: false, items: [] }),
    );
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No open issues");
    expect((html.match(/<section class="repo">/g) ?? []).length).toBe(0);
  });
});

describe("escapeHtml()", () => {
  it("escapes the five HTML special characters", () => {
    expect(escapeHtml(`<a href="x" & 'b'>`)).toBe(
      "&lt;a href=&quot;x&quot; &amp; &#39;b&#39;&gt;",
    );
  });

  it("is a no-op for plain text", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });
});
