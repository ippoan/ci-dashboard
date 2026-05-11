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

// Stub a /search/issues response with two issues across two repos and one PR
// that must be filtered out. Includes a hostile title to verify escaping.
function stubSearchIssues() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
    const url = typeof req === "string" ? req : (req as Request).url;
    if (!url.includes("/search/issues")) {
      return new Response("not stubbed: " + url, { status: 500 });
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
    // Both repos rendered as separate <section>
    expect(html).toContain("ippoan/rust-alc-api");
    expect(html).toContain("ohishi-exp/daiun-salary");
    // Both <section class="repo"> blocks must be present (= 2)
    const sectionCount = (html.match(/<section class="repo">/g) ?? []).length;
    expect(sectionCount).toBe(2);
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

  it("queries GitHub Search with the expected org filter and state=open", async () => {
    const spy = stubSearchIssues();
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain("/search/issues");
    // q param contains is:issue, state:open, both orgs
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("is:issue");
    expect(decoded).toContain("state:open");
    expect(decoded).toContain("org:ippoan");
    expect(decoded).toContain("org:ohishi-exp");
    expect(url).toContain("per_page=100");
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
