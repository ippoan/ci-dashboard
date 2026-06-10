import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { escapeHtml, buildClaudeCodeLaunchUrl, CLAUDE_CODE_LAUNCH_REPOS, isFixtureIssue } from "../src/issues-page";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => "test-secret" } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "test-internal" } as unknown as SecretsStoreSecret,
    CI_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => "test-webhook-secret" } as unknown as SecretsStoreSecret,
  };
}

// Stub /search/issues + /graphql. The page fires parallel calls:
//   - /search/issues `is:issue` × 2 (main orgs + yhonda repo: filter)
//   - /search/issues `is:pr`    × 4 (main orgs × {open, merged}
//                                    + yhonda repo: filter × {open, merged})
//   - /graphql for the per-org Projects v2 listing + per-project items
// We branch on URL + (for GraphQL) on the request body so each call gets the
// data its handler expects. By default the project map is empty so existing
// assertions still see the per-repo grouping. Pass `withProjects` to seed a
// project that maps to `ippoan/rust-alc-api#7` (i.e. the hostile-title issue),
// which is what the project-section tests below rely on. Pass `withPrs` to
// seed an open PR that references `ippoan/rust-alc-api#7` for the PR-chip
// tests; pass `withMergedPrs` to seed a merged PR for the same issue.
function stubFetch(
  opts: { withProjects?: boolean; withPrs?: boolean; withMergedPrs?: boolean } = {},
) {
  const withProjects = !!opts.withProjects;
  const withPrs = !!opts.withPrs;
  const withMergedPrs = !!opts.withMergedPrs;
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
      if (body.includes("projectV2(number:")) {
        // Phase 2/Refs #135: /issues page uses fetchProjectItems via
        // getOrFetchProjectIssueMap (shared with /projects). Returns the
        // richer ProjectItemSummary shape with fieldValues. Map our seed
        // project to the rust-alc-api#7 issue (hostile-title) + a draft we
        // must ignore.
        return Response.json({
          data: { repositoryOwner: { projectV2: { items: { nodes: [
            { id: "PVTI_1", type: "ISSUE", content: {
              __typename: "Issue",
              number: 7, title: "x", url: "u", state: "OPEN",
              repository: { nameWithOwner: "ippoan/rust-alc-api" },
            }, fieldValues: { nodes: [] } },
            { id: "PVTI_2", type: "DRAFT_ISSUE", content: {
              __typename: "DraftIssue", title: "draft",
            }, fieldValues: { nodes: [] } },
          ] } } } },
        });
      }
      if (body.includes("items(first:")) {
        // Legacy fetchProjectIssueMap shape (node(id:$id) → ProjectV2). 現状
        // /issues は projectV2(number:) 経路に移行 (Refs #135) したため未到達
        // だが、mcp tool 等が将来的に呼ぶ可能性があるため残す。
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

    // ---- PR search branch (is:pr) ----
    if (decoded.includes("is:pr")) {
      const isMerged = decoded.includes("is:merged");
      if (decoded.includes("repo:yhonda-ohishi/claude-skills")) {
        return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      }
      if (isMerged) {
        if (!withMergedPrs) {
          return Response.json({ total_count: 0, incomplete_results: false, items: [] });
        }
        return Response.json({
          total_count: 1, incomplete_results: false,
          items: [{
            number: 50,
            title: "feat: previously merged work",
            state: "closed",
            body: "Refs #7",
            user: { login: "yhonda-ohishi" },
            labels: [], assignees: [], comments: 0,
            created_at: "2026-04-20T00:00:00Z",
            updated_at: "2026-04-22T00:00:00Z",
            html_url: "https://github.com/ippoan/rust-alc-api/pull/50",
            repository_url: "https://api.github.com/repos/ippoan/rust-alc-api",
            draft: false,
            pull_request: { url: "https://api.github.com/...", merged_at: "2026-04-22T00:00:00Z" },
          }],
        });
      }
      if (!withPrs) {
        return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      }
      return Response.json({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            number: 42,
            title: "feat: fix XSS in title rendering",
            state: "open",
            body: "Refs #7\n\nPart of the title-escape hardening pass.",
            user: { login: "yhonda-ohishi" },
            labels: [],
            assignees: [],
            comments: 0,
            created_at: "2026-05-11T00:00:00Z",
            updated_at: "2026-05-11T03:00:00Z",
            html_url: "https://github.com/ippoan/rust-alc-api/pull/42",
            repository_url: "https://api.github.com/repos/ippoan/rust-alc-api",
            draft: false,
            pull_request: { url: "https://api.github.com/..." },
          },
        ],
      });
    }

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
    // Main cross-org search (`org:ippoan org:ohishi-exp`) returns all rows
    // in one call. auth-worker delegation (#116) issues a user-scope token
    // that spans both orgs, so per-org fan-out from the App era is gone.
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
    await env.CI_STATUS.delete("issues-page:pr-map:v2");
    // KV cache (Refs #129) も毎テスト前にクリア。watermark が残っていると
    // reconcile が fresh window 判定で skip し、cold-start の fetch が
    // 走らないため stub が当たらず空 cache を返す。
    await env.CI_STATUS.delete("issues:watermark");
    // Refs #304: backoff / soft-lock marker が漏れると後続テストの reconcile
    // が silent no-op になり cold-start fixture が当たらない。
    await env.CI_STATUS.delete("github:rl-backoff");
    await env.CI_STATUS.delete("issues:reconciling");
    await env.CI_STATUS.delete("issues-page:pr-map:refreshing");
    // Refs #135: /issues も project-cache の KV (`project:*`) を共有するため
    // テスト間で flush しないと前テストの fixture が漏れる。
    for (const prefix of ["issue:", "project:"]) {
      let cursor: string | undefined;
      do {
        const page = await env.CI_STATUS.list({ prefix, cursor });
        await Promise.all(page.keys.map((k) => env.CI_STATUS.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
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

  it("queries GitHub Search twice for issues + four times for PRs (main + yhonda × open + merged)", async () => {
    const spy = stubSearchIssues();
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    // auth-worker delegation (#116): user-scope token spans multiple orgs,
    // so cross-org `org:ippoan org:ohishi-exp` fits in one search call.
    // /search/issues is hit:
    //   is:issue × 2 (main orgs combined + yhonda repo: filter)
    //   is:pr    × 4 (each repo shape × {open, merged} so CLAUDE.md's
    //                 "merged but release-close pending" issues get chips)
    // = 6 total. /graphql calls for the Projects v2 map are ignored here.
    const searchCalls = spy.mock.calls.filter((c) =>
      String(c[0]).includes("/search/issues"));
    expect(searchCalls).toHaveLength(6);
    const urls = searchCalls.map((c) => c[0] as string);
    const decoded = urls.map((u) => decodeURIComponent(u));
    const issueDecoded = decoded.filter((d) => d.includes("is:issue") && !d.includes("is:pr"));
    expect(issueDecoded).toHaveLength(2);
    const prDecoded = decoded.filter((d) => d.includes("is:pr"));
    expect(prDecoded.filter((d) => d.includes("is:merged"))).toHaveLength(2);
    expect(prDecoded.filter((d) => d.includes("state:open"))).toHaveLength(2);

    // Main call: ippoan + ohishi-exp orgs without a repo: qualifier.
    const main = issueDecoded.find((d) => d.includes("org:ippoan"));
    expect(main).toBeDefined();
    expect(main!).toContain("is:issue");
    expect(main!).toContain("state:open");
    expect(main!).toContain("org:ippoan");
    expect(main!).toContain("org:ohishi-exp");
    expect(main!).not.toContain("repo:yhonda-ohishi/claude-");

    // yhonda-ohishi call: repo: qualifiers (OR) for the active claude tooling
    // repo only (claude-hooks has migrated to ippoan/claude-hooks and is now
    // covered by the org:ippoan scan) — and CRUCIALLY no `org:yhonda-ohishi`.
    // GitHub Search silently drops `repo:` when combined with `org:` (it widens
    // the result to the entire org), so fetchOrgIssues must omit `org:` whenever
    // the caller-supplied query contains a `repo:` qualifier. Regression guard
    // for issue #53.
    const yhonda = issueDecoded.find((d) => d.includes("repo:yhonda-ohishi/claude-skills"));
    expect(yhonda).toBeDefined();
    expect(yhonda!).toContain("is:issue");
    expect(yhonda!).toContain("state:open");
    expect(yhonda!).toContain("repo:yhonda-ohishi/claude-skills");
    expect(yhonda!).not.toContain("repo:yhonda-ohishi/claude-hooks");
    expect(yhonda!).not.toContain("org:yhonda-ohishi");

    // Every call must exclude archived repos so old projects (e.g.
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

  // When the SDK can't auth against auth-worker (no DCR / no stored tokens /
  // introspect 401 / refresh 401), don't show a 502 dead-end — bounce the
  // user to `/oauth/login` so they can log in and come back to `/issues`.
  it("redirects to /oauth/login when getGitHubToken hits an auth error", async () => {
    // Drop the seeded gh-token cache so `getGitHubToken` falls through to
    // `readDcrFromKv`. KV has no DCR record either, so the SDK throws
    // `"No DCR client registered. Visit /oauth/login first..."` — the
    // canonical auth-failure shape.
    await env.CI_STATUS.delete("auth-client-worker:gh-token");
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/oauth/login?return_to=/issues");
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
      // Both `is:issue` and `is:pr` shapes hit /search/issues and we want
      // an empty result for both — the search response shape is identical.
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
    await env.CI_STATUS.delete("issues-page:pr-map:v2");
    // KV cache (Refs #129) も毎テスト前にクリア。watermark が残っていると
    // reconcile が fresh window 判定で skip し、cold-start の fetch が
    // 走らないため stub が当たらず空 cache を返す。
    await env.CI_STATUS.delete("issues:watermark");
    // Refs #304: backoff / soft-lock marker が漏れると後続テストの reconcile
    // が silent no-op になり cold-start fixture が当たらない。
    await env.CI_STATUS.delete("github:rl-backoff");
    await env.CI_STATUS.delete("issues:reconciling");
    await env.CI_STATUS.delete("issues-page:pr-map:refreshing");
    // Refs #135: /issues も project-cache の KV (`project:*`) を共有するため
    // テスト間で flush しないと前テストの fixture が漏れる。
    for (const prefix of ["issue:", "project:"]) {
      let cursor: string | undefined;
      do {
        const page = await env.CI_STATUS.list({ prefix, cursor });
        await Promise.all(page.keys.map((k) => env.CI_STATUS.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
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
        // Both projects claim the same issue #7. Refs #135: /issues は
        // fetchProjectItems (projectV2(number:) query) 経由なので新 shape で
        // 返す。両 project の items query で同じ #7 を出して 2 refs にする。
        if (body.includes("projectV2(number:")) {
          return Response.json({
            data: { repositoryOwner: { projectV2: { items: { nodes: [
              { id: "PVTI_1", type: "ISSUE", content: {
                __typename: "Issue",
                number: 7, title: "x", url: "u", state: "OPEN",
                repository: { nameWithOwner: "ippoan/rust-alc-api" },
              }, fieldValues: { nodes: [] } },
            ] } } } },
          });
        }
        // Legacy node(id:) shape — kept for fetchProjectIssueMap callers
        // (現状 unreachable).
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
      const decoded = decodeURIComponent(url);
      // PR search: return empty so the test focuses on project chips.
      if (decoded.includes("is:pr")) {
        return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      }
      if (decoded.includes("repo:yhonda-ohishi/claude-skills")) {
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

describe("buildClaudeCodeLaunchUrl()", () => {
  it("returns claude.ai/code URL pre-attached with the standard repo set and an issue-ref prompt", () => {
    const url = buildClaudeCodeLaunchUrl("ippoan/auth-worker", 130);
    expect(url.startsWith("https://claude.ai/code?")).toBe(true);
    // repositories= must be raw comma-separated (claude.ai/code accepts `,`)
    expect(url).toContain(`repositories=${CLAUDE_CODE_LAUNCH_REPOS.join(",")}`);
    // prompt is URL-encoded; decode and verify it references the issue.
    const params = new URL(url).searchParams;
    expect(params.get("prompt")).toBe("ippoan/auth-worker#130 を read して処理");
  });

  it("encodes `()'!*` so the URL is safe in Markdown link syntax", () => {
    // We rely on `encodeURIComponent` for most chars; the helper adds an
    // extra pass for `!*'()` which encodeURIComponent leaves untouched.
    // Use a number — parens come from the prompt's static text, not the
    // arguments, so we verify by injecting via the repo string.
    const url = buildClaudeCodeLaunchUrl("ippoan/foo(bar)", 1);
    expect(url).not.toMatch(/[()'!*]/);
    expect(url).toContain("foo%28bar%29");
  });

  it("preserves commas between repositories (not URL-encoded)", () => {
    const url = buildClaudeCodeLaunchUrl("ippoan/ci-dashboard", 42);
    const reposPart = url.split("repositories=")[1]!.split("&")[0]!;
    expect(reposPart.includes(",")).toBe(true);
    expect(reposPart).not.toContain("%2C");
  });
});

describe("GET /issues — Claude Code launch button", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete("issues-page:project-map");
    await env.CI_STATUS.delete("issues-page:pr-map:v2");
    // KV cache (Refs #129) も毎テスト前にクリア。watermark が残っていると
    // reconcile が fresh window 判定で skip し、cold-start の fetch が
    // 走らないため stub が当たらず空 cache を返す。
    await env.CI_STATUS.delete("issues:watermark");
    // Refs #304: backoff / soft-lock marker が漏れると後続テストの reconcile
    // が silent no-op になり cold-start fixture が当たらない。
    await env.CI_STATUS.delete("github:rl-backoff");
    await env.CI_STATUS.delete("issues:reconciling");
    await env.CI_STATUS.delete("issues-page:pr-map:refreshing");
    // Refs #135: /issues も project-cache の KV (`project:*`) を共有するため
    // テスト間で flush しないと前テストの fixture が漏れる。
    for (const prefix of ["issue:", "project:"]) {
      let cursor: string | undefined;
      do {
        const page = await env.CI_STATUS.list({ prefix, cursor });
        await Promise.all(page.keys.map((k) => env.CI_STATUS.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders a 🚀 launch link per issue row pointing at claude.ai/code", async () => {
    stubFetch();
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // Each rendered issue gets one cc-launch anchor. With the default stub
    // we have 3 issues total (#7, #3, and the claude-skills #1), all in
    // per-repo sections (no project map seeded).
    const launchAnchors = html.match(/<a class="cc-launch"/g) ?? [];
    expect(launchAnchors.length).toBe(3);
    // URL contains the expected issue-specific prompt.
    expect(html).toContain(
      `href="${escapeHtml(buildClaudeCodeLaunchUrl("ippoan/rust-alc-api", 7))}"`,
    );
    // Opens in a new tab.
    expect(html).toContain('target="_blank"');
  });

  it("renders a launch link in the Project section too", async () => {
    stubFetch({ withProjects: true });
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    const projectSection = html.match(
      /<section class="projects">[\s\S]*?<\/section>/,
    );
    expect(projectSection).not.toBeNull();
    expect(projectSection![0]).toContain('<a class="cc-launch"');
    expect(projectSection![0]).toContain(
      escapeHtml(buildClaudeCodeLaunchUrl("ippoan/rust-alc-api", 7)),
    );
  });
});

describe("GET /issues — Related-PR chips", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete("issues-page:project-map");
    await env.CI_STATUS.delete("issues-page:pr-map:v2");
    // KV cache (Refs #129) も毎テスト前にクリア。watermark が残っていると
    // reconcile が fresh window 判定で skip し、cold-start の fetch が
    // 走らないため stub が当たらず空 cache を返す。
    await env.CI_STATUS.delete("issues:watermark");
    // Refs #304: backoff / soft-lock marker が漏れると後続テストの reconcile
    // が silent no-op になり cold-start fixture が当たらない。
    await env.CI_STATUS.delete("github:rl-backoff");
    await env.CI_STATUS.delete("issues:reconciling");
    await env.CI_STATUS.delete("issues-page:pr-map:refreshing");
    // Refs #135: /issues も project-cache の KV (`project:*`) を共有するため
    // テスト間で flush しないと前テストの fixture が漏れる。
    for (const prefix of ["issue:", "project:"]) {
      let cursor: string | undefined;
      do {
        const page = await env.CI_STATUS.list({ prefix, cursor });
        await Promise.all(page.keys.map((k) => env.CI_STATUS.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders a pr-chip on issues that have an open PR referencing them via Refs #N", async () => {
    stubFetch({ withPrs: true });
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // The seeded PR is rust-alc-api#42 referencing #7. We expect a pr-chip
    // linking to that PR on issue #7's row, and no chip on the other rows.
    expect(html).toContain('<a class="pr-chip"');
    expect(html).toContain("https://github.com/ippoan/rust-alc-api/pull/42");
    expect(html).toContain(">🔗 #42<");
    // Issue #3 (ohishi-exp) and #1 (claude-skills) have no referencing PR.
    const chipCount = (html.match(/class="pr-chip(?:\s|")/g) ?? []).length;
    expect(chipCount).toBe(1);
  });

  it("renders a purple .merged pr-chip when only a merged PR references the issue", async () => {
    stubFetch({ withMergedPrs: true });
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // Seeded merged PR is rust-alc-api#50 referencing #7.
    expect(html).toContain('class="pr-chip merged"');
    expect(html).toContain("https://github.com/ippoan/rust-alc-api/pull/50");
    expect(html).toContain(">✅ #50 (merged)<");
  });

  it("renders both open and merged chips when both exist for the same issue", async () => {
    stubFetch({ withPrs: true, withMergedPrs: true });
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // Open chip ordered before merged chip in the rendered HTML.
    const openIdx = html.indexOf(">🔗 #42<");
    const mergedIdx = html.indexOf(">✅ #50 (merged)<");
    expect(openIdx).toBeGreaterThan(-1);
    expect(mergedIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeLessThan(mergedIdx);
  });

  it("marks draft PRs with the .draft class", async () => {
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
      const decoded = decodeURIComponent(url);
      if (decoded.includes("is:pr")) {
        // Only return the draft PR for the open-state search — merged search
        // gets an empty result so the assertions below only see the draft chip.
        if (decoded.includes("is:merged")
          || decoded.includes("repo:yhonda-ohishi/claude-skills")) {
          return Response.json({ total_count: 0, incomplete_results: false, items: [] });
        }
        return Response.json({
          total_count: 1, incomplete_results: false,
          items: [{
            number: 88,
            title: "WIP: draft fix",
            state: "open",
            body: "Closes #7",
            user: { login: "yhonda-ohishi" },
            labels: [], assignees: [], comments: 0,
            created_at: "2026-05-11T00:00:00Z", updated_at: "2026-05-11T03:00:00Z",
            html_url: "https://github.com/ippoan/rust-alc-api/pull/88",
            repository_url: "https://api.github.com/repos/ippoan/rust-alc-api",
            draft: true,
            pull_request: { url: "..." },
          }],
        });
      }
      if (decoded.includes("repo:yhonda-ohishi/claude-skills")) {
        return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      }
      return Response.json({
        total_count: 1, incomplete_results: false,
        items: [{
          number: 7, title: "the issue", state: "open",
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
    expect(html).toContain('class="pr-chip draft"');
    expect(html).toContain("(draft)");
  });

  it("does not blank the page when the PR search call fails — shows a banner instead", async () => {
    // Issue calls succeed but PR search rejects with 403. The issues page
    // should still render with a stale/error banner for the related-PR map,
    // not return 502.
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
      const decoded = decodeURIComponent(url);
      if (decoded.includes("is:pr")) {
        return new Response("rate limited", { status: 403 });
      }
      return Response.json({ total_count: 0, incomplete_results: false, items: [] });
    });
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Related-PR links unavailable");
  });
});

describe("isFixtureIssue()", () => {
  it("matches the `[CI fixture]` title prefix (case-insensitive, leading space tolerant)", () => {
    expect(isFixtureIssue({ title: "[CI fixture] Open issue used by tests" })).toBe(true);
    expect(isFixtureIssue({ title: "  [ci FIXTURE] whatever" })).toBe(true);
  });
  it("does not match ordinary issue titles", () => {
    expect(isFixtureIssue({ title: "Add feature X" })).toBe(false);
    expect(isFixtureIssue({ title: "fix: [CI fixture] mentioned mid-title" })).toBe(false);
  });
});

describe("GET /issues — CI fixture rows", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete("issues-page:project-map");
    await env.CI_STATUS.delete("issues-page:pr-map:v2");
    await env.CI_STATUS.delete("issues:watermark");
    // Refs #304: backoff / soft-lock marker が漏れると後続テストの reconcile
    // が silent no-op になり cold-start fixture が当たらない。
    await env.CI_STATUS.delete("github:rl-backoff");
    await env.CI_STATUS.delete("issues:reconciling");
    await env.CI_STATUS.delete("issues-page:pr-map:refreshing");
    for (const prefix of ["issue:", "project:"]) {
      let cursor: string | undefined;
      do {
        const page = await env.CI_STATUS.list({ prefix, cursor });
        await Promise.all(page.keys.map((k) => env.CI_STATUS.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("flags a fixture issue with a 🔒 保全 badge and suppresses its launch button", async () => {
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
      const decoded = decodeURIComponent(url);
      if (decoded.includes("is:pr")) {
        return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      }
      // main org:ippoan call returns the fixture issue; the yhonda repo: call is
      // empty. The CI fixture now lives in ippoan/claude-hooks (migrated from
      // yhonda-ohishi/claude-hooks), so it surfaces via the org:ippoan scan.
      if (decoded.includes("org:ippoan")) {
        return Response.json({
          total_count: 1, incomplete_results: false,
          items: [{
            number: 2,
            title: "[CI fixture] Open issue used by tests/test-worktree-naming-guard.sh (T1, T5)",
            state: "open",
            user: { login: "yhonda-ohishi" },
            labels: [], assignees: [], comments: 0,
            created_at: "2026-05-30T00:00:00Z", updated_at: "2026-05-30T00:00:00Z",
            html_url: "https://github.com/ippoan/claude-hooks/issues/2",
            repository_url: "https://api.github.com/repos/ippoan/claude-hooks",
          }],
        });
      }
      return Response.json({ total_count: 0, incomplete_results: false, items: [] });
    });
    const req = new Request("http://localhost/issues");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    // Badge present, row dimmed, and the launch cell is a static lock — not a
    // clickable cc-launch anchor.
    expect(html).toContain("🔒 保全");
    expect(html).toContain('class="fixture-badge"');
    expect(html).toContain('<tr class="fixture">');
    expect(html).toContain('class="cc-launch-disabled"');
    expect(html).not.toContain('<a class="cc-launch"');
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

// ───── SWR (Refs #304) ─────
//
// Warm cache (issue:* が KV に居る) 時は GitHub を一切待たずに render し、
// reconcile / PR map refresh は ctx.waitUntil で裏実行される。
describe("GET /issues — SWR (Refs #304)", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete("issues-page:project-map");
    await env.CI_STATUS.delete("issues-page:pr-map:v2");
    await env.CI_STATUS.delete("issues:watermark");
    await env.CI_STATUS.delete("github:rl-backoff");
    await env.CI_STATUS.delete("issues:reconciling");
    await env.CI_STATUS.delete("issues-page:pr-map:refreshing");
    for (const prefix of ["issue:", "project:"]) {
      let cursor: string | undefined;
      do {
        const page = await env.CI_STATUS.list({ prefix, cursor });
        await Promise.all(page.keys.map((k) => env.CI_STATUS.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function seedIssue(repo: string, number: number, title: string): Promise<void> {
    await env.CI_STATUS.put(`issue:${repo}#${number}`, JSON.stringify({
      repo, number, title, state: "open", author: "y", labels: [], assignees: [],
      comments: 0, created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
      url: `https://github.com/${repo}/issues/${number}`,
    }));
  }

  async function seedPrMap(storedAt: number): Promise<void> {
    await env.CI_STATUS.put("issues-page:pr-map:v2", JSON.stringify({ storedAt, data: {} }));
  }

  function searchCalls(spy: ReturnType<typeof vi.spyOn>): number {
    return spy.mock.calls.filter((c) => {
      const u = typeof c[0] === "string" ? c[0] : (c[0] as Request).url;
      return u.includes("/search/issues");
    }).length;
  }

  it("warm + fresh: GitHub Search を 1 回も呼ばない", async () => {
    const fetchSpy = stubSearchIssues();
    await seedIssue("ippoan/rust-alc-api", 7, "cached issue");
    await env.CI_STATUS.put("issues:watermark", new Date(Date.now() - 5_000).toISOString());
    await seedPrMap(Date.now());

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/issues"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("cached issue");
    expect(html).not.toContain("Refreshing in background");
    expect(searchCalls(fetchSpy as never)).toBe(0);
  });

  it("warm + stale: 旧データを即返しして background で 6 call refresh", async () => {
    const fetchSpy = stubSearchIssues();
    await seedIssue("ippoan/rust-alc-api", 7, "old cached title");
    const oldWm = new Date(Date.now() - 120_000).toISOString();
    await env.CI_STATUS.put("issues:watermark", oldWm);
    await seedPrMap(Date.now() - 700_000);

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/issues"), testEnv(), ctx);

    // 即返し: 旧 cache の中身 + 🔄 バナー、生エラー無し
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("old cached title");
    expect(html).toContain("Refreshing in background");

    // background 完了後: issues ×2 + PR ×4 = 6 call、watermark が進む
    await waitOnExecutionContext(ctx);
    expect(searchCalls(fetchSpy as never)).toBe(6);
    const wm = await env.CI_STATUS.get("issues:watermark");
    expect(Date.parse(wm!)).toBeGreaterThan(Date.parse(oldWm));
    // stub の fresh data が KV に反映されている (#7 の本物 title)
    const updated = await env.CI_STATUS.get("issue:ippoan/rust-alc-api#7", "json") as { title: string };
    expect(updated.title).toContain("alert('xss')");
  });

  it("warm + GitHub 403: 200 で cache 表示、backoff marker が立ち 2 回目は 0 call + cooldown バナー", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      if (url.includes("/graphql")) {
        return Response.json({ data: { repositoryOwner: { projectsV2: { nodes: [] } } } });
      }
      return new Response("API rate limit exceeded", { status: 403 });
    });
    await seedIssue("ippoan/rust-alc-api", 7, "survives rate limit");
    await env.CI_STATUS.put("issues:watermark", new Date(Date.now() - 120_000).toISOString());
    await seedPrMap(Date.now() - 700_000);

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/issues"), testEnv(), ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("survives rate limit");
    expect(html).not.toContain("Failed to fetch issues");

    // background の 403 で backoff marker が立つ (waitUntil は pre-catch 済み)
    await waitOnExecutionContext(ctx);
    expect(await env.CI_STATUS.get("github:rl-backoff")).not.toBeNull();

    // 2 回目: backoff 中 → search 0 call + cooldown バナー
    // NB: 既に spy 済みの fetch への vi.spyOn は同一 spy を返し 1 回目の履歴が
    // 累積するため、mockClear してから delta を測る。
    const fetchSpy2 = vi.spyOn(globalThis, "fetch").mockImplementation(async (req) => {
      const url = typeof req === "string" ? req : (req as Request).url;
      if (url.includes("/graphql")) {
        return Response.json({ data: { repositoryOwner: { projectsV2: { nodes: [] } } } });
      }
      return new Response("should not be called", { status: 500 });
    });
    fetchSpy2.mockClear();
    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(new Request("http://localhost/issues"), testEnv(), ctx2);
    await waitOnExecutionContext(ctx2);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(html2).toContain("rate-limit cooldown");
    expect(searchCalls(fetchSpy2 as never)).toBe(0);
  });

  it("warm + auth error: 302 せず 200 で cache を返す (background では redirect 不可)", async () => {
    stubSearchIssues();
    await seedIssue("ippoan/rust-alc-api", 7, "warm survives auth expiry");
    await env.CI_STATUS.put("issues:watermark", new Date(Date.now() - 120_000).toISOString());
    await seedPrMap(Date.now());
    // token cache を落とす → background reconcile が auth error で fail する
    await env.CI_STATUS.delete("auth-client-worker:gh-token");

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/issues"), testEnv(), ctx);
    // waitUntil の reject が pre-catch されていれば resolve する
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect((await res.text())).toContain("warm survives auth expiry");
  });

  it("cold + backoff: 「issue ゼロ」と誤表示せず 503 cooldown を返す", async () => {
    const { setRateLimitBackoff } = await import("../src/github-backoff");
    const { GitHubApiError } = await import("../src/github-api");
    await setRateLimitBackoff(env.CI_STATUS, new GitHubApiError(403, "rate limit"));
    const fetchSpy = stubSearchIssues();

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/issues"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(await res.text()).toContain("rate-limit cooldown");
    expect(searchCalls(fetchSpy as never)).toBe(0);
  });
});
