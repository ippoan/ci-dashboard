import { describe, it, expect, vi, afterEach } from "vitest";
import { githubGraphQL, GitHubApiError } from "../../src/github-api";
import { resolveProjectId, resolveIssueContentId } from "../../src/mcp/tools/projects";

// These tests exercise the GraphQL helper + Projects v2 tool logic against
// mocked fetch responses. The MCP transport itself is covered by tools.test.ts.

describe("githubGraphQL helper", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("POSTs to /graphql with query + variables and returns data", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: { ok: true } }),
    );

    const result = await githubGraphQL<{ ok: boolean }>(
      "token", "query{ ok }", { foo: "bar" },
    );

    expect(result.ok).toBe(true);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe("https://api.github.com/graphql");
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("query{ ok }");
    expect(body.variables).toEqual({ foo: "bar" });
  });

  it("throws GitHubApiError(400) on errors[]", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ errors: [{ message: "boom" }, { message: "kaboom" }] }),
    );

    await expect(githubGraphQL("token", "query{}"))
      .rejects.toMatchObject({
        name: "GitHubApiError",
        status: 400,
        message: expect.stringContaining("boom; kaboom"),
      });
  });

  it("throws GitHubApiError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    await expect(githubGraphQL("token", "query{}")).rejects.toThrow(GitHubApiError);
  });
});

describe("resolveProjectId", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns project id when present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: { repositoryOwner: { projectV2: { id: "PVT_abc" } } } }),
    );
    const id = await resolveProjectId("token", "ippoan", 7);
    expect(id).toBe("PVT_abc");
  });

  it("throws 404 when project missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: { repositoryOwner: { projectV2: null } } }),
    );
    await expect(resolveProjectId("token", "ippoan", 99))
      .rejects.toMatchObject({ status: 404 });
  });

  it("rejects disallowed org before hitting network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(resolveProjectId("token", "evil-org", 1))
      .rejects.toMatchObject({ status: 403 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts each allowed org (ippoan, ohishi-exp, yhonda-ohishi)", async () => {
    // Each call gets its own Response (a Response body can only be consumed once).
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(Response.json({
        data: { repositoryOwner: { projectV2: { id: "PVT_x" } } },
      })),
    );
    for (const org of ["ippoan", "ohishi-exp", "yhonda-ohishi"]) {
      await expect(resolveProjectId("token", org, 1)).resolves.toBe("PVT_x");
    }
  });
});

describe("resolveIssueContentId", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns issue/PR node id from issueOrPullRequest union", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: { repository: { issueOrPullRequest: { id: "I_xyz" } } },
      }),
    );
    const id = await resolveIssueContentId("token", "ippoan", "ci-dashboard", 63);
    expect(id).toBe("I_xyz");
  });

  it("throws 404 when issue/PR missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: { repository: { issueOrPullRequest: null } } }),
    );
    await expect(resolveIssueContentId("token", "ippoan", "ci-dashboard", 9999))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe("Projects v2 tools — integration via MCP server", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // Helper: drive a tool through the MCP HTTP transport, returning the parsed
  // text payload. Each call uses its own fetch mock queue.
  async function callTool(name: string, args: Record<string, unknown>) {
    const { handleMcpRequest } = await import("../../src/mcp/server");
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const res = await handleMcpRequest(req, "test-token");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    if (body.result?.isError) {
      const text = body.result.content?.[0]?.text ?? "(no message)";
      throw new Error(text);
    }
    const text = body.result?.content?.[0]?.text ?? "";
    return JSON.parse(text) as unknown;
  }

  it("list_org_projects groups results per org and filters closed by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { projectsV2: { nodes: [
          { id: "PVT_1", number: 1, title: "Active", url: "https://github.com/orgs/ippoan/projects/1", closed: false, shortDescription: null },
          { id: "PVT_2", number: 2, title: "Done", url: "https://github.com/orgs/ippoan/projects/2", closed: true, shortDescription: null },
        ] } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { projectsV2: { nodes: [
          { id: "PVT_3", number: 1, title: "Exp", url: "https://github.com/orgs/ohishi-exp/projects/1", closed: false, shortDescription: "exp" },
        ] } } },
      }));

    const result = await callTool("list_org_projects", {
      orgs: ["ippoan", "ohishi-exp"],
    }) as Array<{ org: string; projects: Array<{ number: number; closed: boolean }> }>;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0]!.org).toBe("ippoan");
    expect(result[0]!.projects).toHaveLength(1);
    expect(result[0]!.projects[0]!.number).toBe(1);
    expect(result[1]!.org).toBe("ohishi-exp");
    expect(result[1]!.projects[0]!.number).toBe(1);
  });

  it("list_org_projects with include_closed=true returns closed projects too", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      data: { repositoryOwner: { projectsV2: { nodes: [
        { id: "PVT_1", number: 1, title: "A", url: "u", closed: false, shortDescription: null },
        { id: "PVT_2", number: 2, title: "B", url: "u", closed: true, shortDescription: null },
      ] } } },
    }));

    const result = await callTool("list_org_projects", {
      orgs: ["ippoan"], include_closed: true,
    }) as Array<{ projects: unknown[] }>;
    expect(result[0]!.projects).toHaveLength(2);
  });

  it("list_org_projects rejects disallowed orgs (no fetch issued)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(callTool("list_org_projects", { orgs: ["evil-org"] }))
      .rejects.toThrow(/not allowed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("list_org_projects works for user-owned logins (yhonda-ohishi is a User, not an Organization)", async () => {
    // GitHub's `organization(login:)` resolver throws "Could not resolve to
    // an Organization" for user logins. The tool must use `repositoryOwner`
    // and accept the `User`-branch fragment. Regression guard for #75.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      data: { repositoryOwner: { projectsV2: { nodes: [
        { id: "PVT_y", number: 3, title: "Personal Roadmap",
          url: "https://github.com/users/yhonda-ohishi/projects/3",
          closed: false, shortDescription: null },
      ] } } },
    }));

    const result = await callTool("list_org_projects", {
      orgs: ["yhonda-ohishi"],
    }) as Array<{ org: string; projects: Array<{ number: number; title: string }> }>;

    expect(result[0]!.org).toBe("yhonda-ohishi");
    expect(result[0]!.projects[0]!.number).toBe(3);
    expect(result[0]!.projects[0]!.title).toBe("Personal Roadmap");

    // The outgoing query must use repositoryOwner with both fragments — the
    // production bug was that the User branch was missing entirely.
    const query = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).query as string;
    expect(query).toContain("repositoryOwner(login:$login)");
    expect(query).toContain("... on Organization");
    expect(query).toContain("... on User");
    expect(query).not.toContain("organization(login:");
  });

  it("get_project returns fields with options for single_select", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      data: { repositoryOwner: { projectV2: {
        id: "PVT_1", number: 1, title: "P", url: "u", closed: false, shortDescription: null,
        fields: { nodes: [
          { __typename: "ProjectV2FieldCommon", id: "F_t", name: "Title", dataType: "TITLE" },
          { __typename: "ProjectV2SingleSelectField", id: "F_s", name: "Status", dataType: "SINGLE_SELECT",
            options: [
              { id: "opt_todo", name: "Todo" },
              { id: "opt_doing", name: "In Progress" },
              { id: "opt_done", name: "Done" },
            ] },
        ] },
      } } },
    }));

    const result = await callTool("get_project", { org: "ippoan", number: 1 }) as {
      number: number; fields: Array<{ name: string; options?: Array<{ name: string }> }>;
    };
    expect(result.number).toBe(1);
    expect(result.fields).toHaveLength(2);
    const status = result.fields.find((f) => f.name === "Status")!;
    expect(status.options!.map((o) => o.name)).toEqual(["Todo", "In Progress", "Done"]);
  });

  it("add_issue_to_project resolves projectId + contentId then mutates", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { projectV2: { id: "PVT_1" } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { repository: { issueOrPullRequest: { id: "I_42" } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { addProjectV2ItemById: { item: { id: "PVTI_xyz" } } },
      }));

    const result = await callTool("add_issue_to_project", {
      org: "ippoan", project_number: 1,
      repo: "ippoan/ci-dashboard", issue_number: 42,
    }) as { item_id: string; project_id: string; content_id: string };

    expect(result.item_id).toBe("PVTI_xyz");
    expect(result.project_id).toBe("PVT_1");
    expect(result.content_id).toBe("I_42");

    const mutationBody = JSON.parse(fetchSpy.mock.calls[2]![1]!.body as string);
    expect(mutationBody.query).toContain("addProjectV2ItemById");
    expect(mutationBody.variables.projectId).toBe("PVT_1");
    expect(mutationBody.variables.contentId).toBe("I_42");
  });

  it("set_project_item_field maps single_select option name → optionId", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      // resolveProjectId
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { projectV2: { id: "PVT_1" } } },
      }))
      // getProjectFields
      .mockResolvedValueOnce(Response.json({
        data: { node: { fields: { nodes: [
          { __typename: "ProjectV2SingleSelectField", id: "F_s", name: "Status",
            dataType: "SINGLE_SELECT", options: [
              { id: "opt_todo", name: "Todo" },
              { id: "opt_done", name: "Done" },
            ] },
        ] } } },
      }))
      // updateProjectV2ItemFieldValue
      .mockResolvedValueOnce(Response.json({
        data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_xyz" } } },
      }));

    const result = await callTool("set_project_item_field", {
      org: "ippoan", project_number: 1,
      item_id: "PVTI_xyz", field_name: "Status", value: "Done",
    }) as { field: string; dataType: string; value: unknown };

    expect(result.field).toBe("Status");
    expect(result.dataType).toBe("SINGLE_SELECT");
    expect(result.value).toBe("Done");

    const mutationBody = JSON.parse(fetchSpy.mock.calls[2]![1]!.body as string);
    expect(mutationBody.variables.value.singleSelectOptionId).toBe("opt_done");
    expect(mutationBody.variables.fieldId).toBe("F_s");
  });

  it("set_project_item_field surfaces a useful error when option missing", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { projectV2: { id: "PVT_1" } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { node: { fields: { nodes: [
          { __typename: "ProjectV2SingleSelectField", id: "F_s", name: "Status",
            dataType: "SINGLE_SELECT", options: [{ id: "opt_todo", name: "Todo" }] },
        ] } } },
      }));

    await expect(callTool("set_project_item_field", {
      org: "ippoan", project_number: 1,
      item_id: "PVTI_xyz", field_name: "Status", value: "Done",
    })).rejects.toThrow(/Option not found.*Available: Todo/);
  });

  it("set_project_item_field with text field passes value as text", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { projectV2: { id: "PVT_1" } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { node: { fields: { nodes: [
          { __typename: "ProjectV2FieldCommon", id: "F_t", name: "Notes", dataType: "TEXT" },
        ] } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_xyz" } } },
      }));

    await callTool("set_project_item_field", {
      org: "ippoan", project_number: 1,
      item_id: "PVTI_xyz", field_name: "Notes", value: "hello",
    });

    const mutationBody = JSON.parse(fetchSpy.mock.calls[2]![1]!.body as string);
    expect(mutationBody.variables.value).toEqual({ text: "hello" });
  });

  it("set_project_item_field with value=null calls clearProjectV2ItemFieldValue", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { projectV2: { id: "PVT_1" } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { node: { fields: { nodes: [
          { __typename: "ProjectV2FieldCommon", id: "F_t", name: "Notes", dataType: "TEXT" },
        ] } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_xyz" } } },
      }));

    const result = await callTool("set_project_item_field", {
      org: "ippoan", project_number: 1,
      item_id: "PVTI_xyz", field_name: "Notes", value: null,
    }) as { cleared: boolean };

    expect(result.cleared).toBe(true);
    const mutationBody = JSON.parse(fetchSpy.mock.calls[2]![1]!.body as string);
    expect(mutationBody.query).toContain("clearProjectV2ItemFieldValue");
  });

  it("remove_project_item issues deleteProjectV2Item mutation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { projectV2: { id: "PVT_1" } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { deleteProjectV2Item: { deletedItemId: "PVTI_xyz" } },
      }));

    const result = await callTool("remove_project_item", {
      org: "ippoan", project_number: 1, item_id: "PVTI_xyz",
    }) as { deleted_item_id: string };

    expect(result.deleted_item_id).toBe("PVTI_xyz");
    const mutationBody = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
    expect(mutationBody.query).toContain("deleteProjectV2Item");
    expect(mutationBody.variables.itemId).toBe("PVTI_xyz");
  });

  it("create_project_field for single_select sends options with default color", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { projectV2: { id: "PVT_1" } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { createProjectV2Field: { projectV2Field: {
          __typename: "ProjectV2SingleSelectField",
          id: "F_new", name: "Priority", dataType: "SINGLE_SELECT",
          options: [{ id: "o1", name: "P0" }, { id: "o2", name: "P1" }],
        } } },
      }));

    await callTool("create_project_field", {
      org: "ippoan", project_number: 1,
      name: "Priority", data_type: "single_select",
      single_select_options: ["P0", "P1"],
    });

    const mutationBody = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
    expect(mutationBody.variables.input.dataType).toBe("SINGLE_SELECT");
    expect(mutationBody.variables.input.singleSelectOptions).toEqual([
      { name: "P0", color: "GRAY", description: "" },
      { name: "P1", color: "GRAY", description: "" },
    ]);
  });

  it("create_project_field rejects single_select without options", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
      data: { repositoryOwner: { projectV2: { id: "PVT_1" } } },
    }));
    await expect(callTool("create_project_field", {
      org: "ippoan", project_number: 1,
      name: "Priority", data_type: "single_select",
    })).rejects.toThrow(/single_select_options is required/);
  });

  it("list_project_items flattens content + field values", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      data: { repositoryOwner: { projectV2: { items: { nodes: [
        {
          id: "PVTI_1", type: "ISSUE",
          content: {
            __typename: "Issue", number: 63, title: "MCP: Projects v2",
            url: "https://github.com/ippoan/ci-dashboard/issues/63",
            state: "OPEN", repository: { nameWithOwner: "ippoan/ci-dashboard" },
          },
          fieldValues: { nodes: [
            { __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "In Progress", optionId: "opt_doing",
              field: { name: "Status" } },
            { __typename: "ProjectV2ItemFieldTextValue",
              text: "epic-001", field: { name: "Epic" } },
          ] },
        },
      ] } } } },
    }));

    const items = await callTool("list_project_items", {
      org: "ippoan", number: 1,
    }) as Array<{
      content: { type: string; number: number; repo: string };
      fields: Record<string, unknown>;
    }>;

    expect(items).toHaveLength(1);
    expect(items[0]!.content.type).toBe("issue");
    expect(items[0]!.content.number).toBe(63);
    expect(items[0]!.content.repo).toBe("ippoan/ci-dashboard");
    expect(items[0]!.fields).toEqual({ Status: "In Progress", Epic: "epic-001" });
  });

  it("create_project resolves ownerId then creates and returns id/number/title/url", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { id: "O_ippoan" } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { createProjectV2: { projectV2: {
          id: "PVT_new", number: 7, title: "監視カメラ死活管理",
          url: "https://github.com/orgs/ippoan/projects/7",
          shortDescription: null,
        } } },
      }));

    const result = await callTool("create_project", {
      org: "ippoan", title: "監視カメラ死活管理",
    }) as { id: string; number: number; title: string; url: string };

    expect(result.id).toBe("PVT_new");
    expect(result.number).toBe(7);
    expect(result.title).toBe("監視カメラ死活管理");
    expect(result.url).toBe("https://github.com/orgs/ippoan/projects/7");

    // ownerId query — uses `repositoryOwner(login:)` so both User and
    // Organization logins resolve.
    const ownerQ = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(ownerQ.query).toContain("repositoryOwner(login:$login)");
    expect(ownerQ.variables).toEqual({ login: "ippoan" });

    // createProjectV2 mutation
    const createQ = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
    expect(createQ.query).toContain("createProjectV2");
    expect(createQ.variables.ownerId).toBe("O_ippoan");
    expect(createQ.variables.title).toBe("監視カメラ死活管理");
  });

  it("create_project applies short_description via a second updateProjectV2 mutation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { id: "O_ippoan" } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { createProjectV2: { projectV2: {
          id: "PVT_new", number: 7, title: "T",
          url: "https://github.com/orgs/ippoan/projects/7",
          shortDescription: null,
        } } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { updateProjectV2: { projectV2: { shortDescription: "epic-001 横断管理" } } },
      }));

    const result = await callTool("create_project", {
      org: "ippoan", title: "T", short_description: "epic-001 横断管理",
    }) as { number: number; shortDescription: string | null; warning?: string };

    expect(result.number).toBe(7);
    expect(result.shortDescription).toBe("epic-001 横断管理");
    expect(result.warning).toBeUndefined();

    const updateQ = JSON.parse(fetchSpy.mock.calls[2]![1]!.body as string);
    expect(updateQ.query).toContain("updateProjectV2");
    expect(updateQ.variables).toEqual({ id: "PVT_new", desc: "epic-001 横断管理" });
  });

  it("create_project returns the project + warning when shortDescription update fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        data: { repositoryOwner: { id: "O_ippoan" } },
      }))
      .mockResolvedValueOnce(Response.json({
        data: { createProjectV2: { projectV2: {
          id: "PVT_new", number: 7, title: "T",
          url: "https://github.com/orgs/ippoan/projects/7",
          shortDescription: null,
        } } },
      }))
      .mockResolvedValueOnce(Response.json({
        errors: [{ message: "rate limited" }],
      }));

    const result = await callTool("create_project", {
      org: "ippoan", title: "T", short_description: "x",
    }) as { number: number; shortDescription: string | null; warning?: string };

    // Project still surfaced — caller can retry just the description.
    expect(result.number).toBe(7);
    expect(result.shortDescription).toBeNull();
    expect(result.warning).toMatch(/Project created \(number=7\).*rate limited/);
  });

  it("create_project throws 404 when org not found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
      data: { repositoryOwner: null },
    }));

    await expect(callTool("create_project", {
      org: "ippoan", title: "T",
    })).rejects.toThrow(/Owner not found: ippoan/);
  });

  it("create_project rejects disallowed orgs (no fetch issued)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(callTool("create_project", {
      org: "evil-org", title: "T",
    })).rejects.toThrow(/not allowed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
