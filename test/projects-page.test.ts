import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => "test-secret" } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "test-internal" } as unknown as SecretsStoreSecret,
    CI_HUB: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("OK") }),
    } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
  };
}

// Stub /graphql for the projects page. Two GraphQL shapes are issued:
//   - `projectsV2(first:` — one per org (3 calls: ippoan, ohishi-exp, yhonda-ohishi)
//   - `items(first:` (with `$number`) — one per (org, project) pair
// `failItemFetchFor` lets a test simulate a per-project failure to verify the
// page still renders the rest of the board grid.
function stubGraphQL(opts: { failItemsFor?: string } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (req, init) => {
    const url = typeof req === "string" ? req : (req as Request).url;
    const body = (init?.body as string | undefined)
      ?? (typeof req === "string" ? "" : await (req as Request).clone().text());

    if (!url.includes("/graphql")) {
      return new Response("not stubbed: " + url, { status: 500 });
    }

    // Per-org project list. Match on the org login that appears in `variables`.
    if (body.includes("projectsV2(first:") && !body.includes("items(first:")) {
      if (body.includes('"ippoan"')) {
        return Response.json({
          data: { repositoryOwner: { projectsV2: { nodes: [
            { id: "PVT_1", number: 1, title: "Camera Monitoring",
              url: "https://github.com/orgs/ippoan/projects/1",
              closed: false, shortDescription: "device health" },
          ] } } },
        });
      }
      if (body.includes('"yhonda-ohishi"')) {
        return Response.json({
          data: { repositoryOwner: { projectsV2: { nodes: [
            { id: "PVT_2", number: 2, title: "Personal Board",
              url: "https://github.com/users/yhonda-ohishi/projects/2",
              closed: false, shortDescription: null },
          ] } } },
        });
      }
      // ohishi-exp returns empty
      return Response.json({
        data: { repositoryOwner: { projectsV2: { nodes: [] } } },
      });
    }

    // Per-project items.
    if (body.includes("items(first:") && body.includes("ProjectItems")) {
      // Optional failure injection — used to verify the page survives a
      // single project's items() call failing.
      if (opts.failItemsFor && body.includes(`"${opts.failItemsFor}"`)) {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (body.includes('"ippoan"')) {
        return Response.json({
          data: { repositoryOwner: { projectV2: { items: { nodes: [
            {
              id: "ITEM_1",
              type: "ISSUE",
              content: {
                __typename: "Issue",
                number: 7,
                title: "<script>alert('xss')</script>",
                url: "https://github.com/ippoan/rust-alc-api/issues/7",
                state: "OPEN",
                repository: { nameWithOwner: "ippoan/rust-alc-api" },
              },
              fieldValues: { nodes: [
                {
                  __typename: "ProjectV2ItemFieldSingleSelectValue",
                  name: "In Progress",
                  optionId: "opt_inp",
                  field: { name: "Status" },
                },
                {
                  __typename: "ProjectV2ItemFieldTextValue",
                  text: "P1",
                  field: { name: "Priority" },
                },
              ] },
            },
            {
              id: "ITEM_2",
              type: "DRAFT_ISSUE",
              content: { __typename: "DraftIssue", title: "TBD" },
              fieldValues: { nodes: [] },
            },
          ] } } } },
        });
      }
      if (body.includes('"yhonda-ohishi"')) {
        return Response.json({
          data: { repositoryOwner: { projectV2: { items: { nodes: [] } } } },
        });
      }
    }

    return Response.json({ data: { repositoryOwner: null } });
  });
}

describe("GET /projects", () => {
  // Phase 2 (#131) で導入された KV cache を毎テスト前にクリア。残ると
  // 次の it で stubGraphQL を当てても cache hit して fetch が走らない。
  beforeEach(async () => {
    for (const prefix of ["project:", "issues-page:project-map"]) {
      let cursor: string | undefined;
      do {
        const page = await env.CI_STATUS.list({ prefix, cursor });
        await Promise.all(page.keys.map((k) => env.CI_STATUS.delete(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders an HTML page with the Projects tab active and 🗂️ Projects header", async () => {
    stubGraphQL();
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/projects"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("🗂️ Projects");
    expect(html).toMatch(/tab tab-active[^>]*>\s*🗂️ Projects/);
  });

  it("groups projects by org and renders <details> per project with item table", async () => {
    stubGraphQL();
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/projects"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // Two org sections rendered (ippoan + yhonda-ohishi); ohishi-exp is empty
    // and skipped to avoid noise.
    expect(html).toContain('<section class="org">');
    expect(html).toMatch(/<h2>ippoan<span class="count">\(1\)<\/span>/);
    expect(html).toMatch(/<h2>yhonda-ohishi<span class="count">\(1\)<\/span>/);
    // ohishi-exp appears in the header summary line but must NOT get its own
    // <section> (empty orgs are skipped).
    expect(html).not.toMatch(/<h2>ohishi-exp<span/);

    // Per-project <details> with item count in summary.
    expect(html).toContain('<details class="project">');
    expect(html).toContain("#1");
    expect(html).toContain("Camera Monitoring");
    expect(html).toContain("device health");
    expect(html).toContain("2 items"); // 1 issue + 1 draft

    // yhonda-ohishi's project shows "No items.".
    expect(html).toContain("No items.");
  });

  it("escapes content titles to prevent XSS", async () => {
    stubGraphQL();
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/projects"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert");
  });

  it("renders field chips for Status and Priority", async () => {
    stubGraphQL();
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/projects"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    expect(html).toContain('class="field-chip"');
    expect(html).toContain("Status:");
    expect(html).toContain("In Progress");
    expect(html).toContain("Priority:");
    expect(html).toContain("P1");
  });

  it("links Issue repo + url, and tags PR/Issue type explicitly", async () => {
    stubGraphQL();
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/projects"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const html = await res.text();
    // Issue row links out to the github issue URL
    expect(html).toContain('href="https://github.com/ippoan/rust-alc-api/issues/7"');
    // Repo cell shows owner/repo#number
    expect(html).toContain("ippoan/rust-alc-api</a>#7");
    // Type column distinguishes Issue from Draft
    expect(html).toContain("<td class=\"type\">Issue</td>");
    expect(html).toContain("<td class=\"type\">Draft</td>");
  });

  it("survives a per-project items() failure with an inline error block", async () => {
    // ippoan's items() call fails. The page should still render yhonda-ohishi's
    // project and show ippoan's failure inline rather than 502'ing the page.
    stubGraphQL({ failItemsFor: "ippoan" });
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/projects"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Camera Monitoring");
    expect(html).toContain("Failed to load items:");
    // yhonda-ohishi's section still renders fine.
    expect(html).toContain("Personal Board");
  });

  it("returns 502 when the per-org project list fetch fails outright", async () => {
    // Make every /graphql call fail. The page can't recover without the
    // project list, so it should respond with the error page (502).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service Unavailable", { status: 503 }),
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/projects"), testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("Failed to fetch projects");
  });
});
