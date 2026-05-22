import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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

// Stub /search/issues + /graphql. The page fires three parallel calls:
//   - /search/issues with main-org `q` (ippoan + ohishi-exp)
//   - /search/issues with yhonda-ohishi `repo:` filter
//   - /graphql for the per-org Projects v2 listing + per-project items
// We branch on URL + (for GraphQL) on the request body so each call gets the
// data its handler expects. By default the project map is empty so existing
// assertions still see the per-repo grouping. Pass `withProjects` to seed a
// project that maps to `ippoan/rust-alc-api#7` (i.e. the hostile-title issue),
// which is what the project-section tests below rely on.
function stubFetch(opts: { withProjects?: boolean } = {}) {
  const withProjects = !!opts.withProjects;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (req, init) => {
    const url = typeof req === "string" ? req : (req as Request).url;
    // `init.body` is set by `githubGraphQL`; a bare Request also exposes it.
    const body = (init?.body as string | undefined)
      ?? (typeof req === "string" ? "" : await (req as Request).clone().text());

    // ---- GraphQL branch (Projects v2) ----
    if (url.includes("/graphql")) {
      if (body.includes("projectsV2(first:")) {
        // First-pass: list of projects per org. Only `ippoan` has one in
        // these fixtures; the other orgs return an empty list.
        if (body.includes('"ippoan"') && withProjects) {
          return Response.json({
            data: { repositoryOwner: { projectsV2: { nodes: [
              { id: "PVT_1", number: 1, title: "Camera Monitoring",
                url: "https://github.com/orgs/ippoan/projects/1",
                closed: false, shortDescription: null },
            ] } } },
          });
        }
        return Response.json({
          data: { repositoryOwner: { projectsV2: { nodes: [] } } },
        });
      }
      if (body.includes("items(first:")) {
        // Second-pass: items for a specific project. Map our seed project to
        // the rust-alc-api#7 issue (the hostile-title one), plus a draft we
        // must ignore.
        return Response.json({
          data: { node: { items: { nodes: [
            { content: {
              __typename: "Issue",
              number: 7,
              repository: { nameWithOwner: "ippoan/rust-alc-api" },
            } },
            { content: { __typename: "DraftIssue" } },
          ] } } },
        });
      }
      return Response.json({ data: { repositoryOwner: null } });
    }

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

// Backwards-compatible alias for the assertion suite that pre-dated the
// project section.
function stubSearchIssues() {
  return stubFetch();
}

describe("GET /issues", () => {
  // The project map is KV-cached for 5 min. Without per-test cache eviction
  // the second test in a file reuses the first test's response (and an empty
  // map from a no-project fixture happily masks any subsequent fetch).
  beforeEach(async () => {
    await env.CI_STATUS.delete("issues-page:project-map");
  });
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

    // `/search/issues` is hit exactly twice; the extra `/graphql` calls for
    // the Projects v2 map are ignored by this assertion.
    const searchCalls = spy.mock.calls.filter((c) =>
      String(c[0]).includes("/search/issues"));
    expect(searchCalls).toHaveLength(2);
    const urls = searchCalls.map((c) => c[0] as string);
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

    // Both calls must exclude archived repos so old projects (e.g.
    // ippoan/cf-secrets-mcp) don't leak open issues into the dashboard.
    // Regression guard for issue #99.
    expect(main!).toContain("archived:false");
    expect(yhonda!).toContain("archived:false");

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
    // Use mockImplementation, not mockResolvedValue: the page fires three
    // fetches in parallel (2× /search/issues, 1+ /graphql) and a single
    // Response instance has a one-shot body. The /graphql branch must return
    // a GraphQL-shaped payload (`data.organization`) so the projects helper
    // doesn't throw — an empty projectsV2 keeps the project section absent.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req, init) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      const body = (init?.body as string | undefined) ?? "";
      if (url.includes("/graphql")) {
        if (body.includes("projectsV2(first:")) {
          return Response.json({
            data: { repositoryOwner: { projectsV2: { nodes: [] } } },
          });
        }
        return Response.json({ data: { repositoryOwner: null } });
      }
      return Response.json({ total_count: 0, incomplete_results: false, items: [] });
    });
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No open issues");
    expect((html.match(/<section class="repo">/g) ?? []).length).toBe(0);
    expect((html.match(/<section class="projects">/g) ?? []).length).toBe(0);
  });
});

describe("GET /issues — Project section", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete("issues-page:project-map");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders a 'Project 付き' section with project chips and excludes those issues from their repo section", async () => {
    stubFetch({ withProjects: true });
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();

    // The project section exists and labels the seeded board.
    expect(html).toContain('<section class="projects">');
    expect(html).toContain("Project 付き");
    expect(html).toContain("Camera Monitoring");
    // Chip is rendered as an anchor with the project URL.
    expect(html).toMatch(
      /<a class="project-chip"[^>]*href="https:\/\/github\.com\/orgs\/ippoan\/projects\/1"/,
    );

    // rust-alc-api#7 lives in the project section, so its per-repo section
    // must drop it. Issue #7 was the only rust-alc-api issue (PR #99 already
    // filtered), so the rust-alc-api per-repo section should disappear
    // entirely.
    const repoSectionTags = html.match(/<section class="repo">[\s\S]*?<\/section>/g) ?? [];
    for (const sec of repoSectionTags) {
      if (sec.includes("ippoan/rust-alc-api")) {
        // If it did render, it must not contain #7.
        expect(sec).not.toContain(">#7<");
      }
    }
    // The remaining per-repo sections are ohishi-exp/daiun-salary and
    // yhonda-ohishi/claude-skills (neither tagged with a project).
    expect(html).toContain("ohishi-exp/daiun-salary");
    expect(html).toContain("yhonda-ohishi/claude-skills");
  });

  it("renders multiple project chips when an issue belongs to multiple projects", async () => {
    // Override the stub to add a second project that also contains rust-alc-api#7.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req, init) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      const body = (init?.body as string | undefined) ?? "";
      if (url.includes("/graphql")) {
        if (body.includes("projectsV2(first:")) {
          if (body.includes('"ippoan"')) {
            return Response.json({
              data: { repositoryOwner: { projectsV2: { nodes: [
                { id: "PVT_1", number: 1, title: "Board A",
                  url: "https://github.com/orgs/ippoan/projects/1",
                  closed: false, shortDescription: null },
                { id: "PVT_2", number: 2, title: "Board B",
                  url: "https://github.com/orgs/ippoan/projects/2",
                  closed: false, shortDescription: null },
              ] } } },
            });
          }
          return Response.json({
            data: { repositoryOwner: { projectsV2: { nodes: [] } } },
          });
        }
        // Both projects claim the same issue #7. Map both project IDs to
        // the same item list so the issue ends up with two refs.
        return Response.json({
          data: { node: { items: { nodes: [
            { content: {
              __typename: "Issue",
              number: 7,
              repository: { nameWithOwner: "ippoan/rust-alc-api" },
            } },
          ] } } },
        });
      }
      // Search responses — only the rust-alc-api#7 issue matters here.
      if (decodeURIComponent(url).includes("repo:yhonda-ohishi/claude-skills")) {
        return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      }
      return Response.json({
        total_count: 1,
        incomplete_results: false,
        items: [{
          number: 7, title: "shared between two projects", state: "open",
          user: { login: "yhonda-ohishi" }, labels: [], assignees: [], comments: 0,
          created_at: "2026-05-10T00:00:00Z", updated_at: "2026-05-10T03:00:00Z",
          html_url: "https://github.com/ippoan/rust-alc-api/issues/7",
          repository_url: "https://api.github.com/repos/ippoan/rust-alc-api",
        }],
      });
    });

    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // Both chips appear in the project row for #7.
    const projectSection = html.match(
      /<section class="projects">[\s\S]*?<\/section>/,
    );
    expect(projectSection).not.toBeNull();
    const sec = projectSection![0];
    expect(sec).toContain("Board A");
    expect(sec).toContain("Board B");
    const chipMatches = sec.match(/project-chip/g) ?? [];
    expect(chipMatches.length).toBeGreaterThanOrEqual(2);
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
