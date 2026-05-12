import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { githubGraphQL, parseRepo, validateOrg, GitHubApiError } from "../../github-api";

// --------------------------------------------------------------------------
// GitHub Projects v2 tooling.
//
// Projects v2 is GraphQL-only — there is no REST surface. Most write
// operations need three indirections:
//   1. project number → projectId          (resolveProjectId)
//   2. issue/PR number → contentId         (resolveIssueContentId)
//   3. field name → fieldId (+ optionId)   (fetched via getProjectFields)
// We hide these behind ergonomic tool inputs (name/number) so the caller
// doesn't have to deal with node IDs.
// --------------------------------------------------------------------------

interface ProjectField {
  __typename: string;
  id: string;
  name: string;
  dataType: string;
  options?: Array<{ id: string; name: string }>;
  configuration?: {
    iterations?: Array<{ id: string; title: string; startDate: string; duration: number }>;
    completedIterations?: Array<{ id: string; title: string; startDate: string; duration: number }>;
  };
}

interface ProjectV2 {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  shortDescription: string | null;
  fields: { nodes: ProjectField[] };
}

export async function resolveProjectId(
  token: string, org: string, number: number,
): Promise<string> {
  validateOrg(org);
  const data = await githubGraphQL<{ organization: { projectV2: { id: string } | null } | null }>(
    token,
    `query($org:String!,$number:Int!){
      organization(login:$org){
        projectV2(number:$number){ id }
      }
    }`,
    { org, number },
  );
  const id = data.organization?.projectV2?.id;
  if (!id) throw new GitHubApiError(404, `Project not found: ${org}/projects/${number}`);
  return id;
}

export async function resolveIssueContentId(
  token: string, owner: string, repo: string, number: number,
): Promise<string> {
  validateOrg(owner);
  const data = await githubGraphQL<{
    repository: { issueOrPullRequest: { id: string } | null } | null;
  }>(
    token,
    `query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner, name:$repo){
        issueOrPullRequest(number:$number){
          ... on Issue { id }
          ... on PullRequest { id }
        }
      }
    }`,
    { owner, repo, number },
  );
  const id = data.repository?.issueOrPullRequest?.id;
  if (!id) throw new GitHubApiError(404, `Issue/PR not found: ${owner}/${repo}#${number}`);
  return id;
}

async function getProjectFields(
  token: string, projectId: string,
): Promise<ProjectField[]> {
  const data = await githubGraphQL<{ node: { fields: { nodes: ProjectField[] } } | null }>(
    token,
    `query($id:ID!){
      node(id:$id){
        ... on ProjectV2 {
          fields(first:50){
            nodes{
              __typename
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField {
                id name dataType
                options{ id name }
              }
              ... on ProjectV2IterationField {
                id name dataType
                configuration{
                  iterations{ id title startDate duration }
                  completedIterations{ id title startDate duration }
                }
              }
            }
          }
        }
      }
    }`,
    { id: projectId },
  );
  return data.node?.fields.nodes ?? [];
}

function summarizeField(f: ProjectField) {
  const base: Record<string, unknown> = { id: f.id, name: f.name, dataType: f.dataType };
  if (f.options) base.options = f.options.map((o) => ({ id: o.id, name: o.name }));
  if (f.configuration?.iterations) {
    base.iterations = [
      ...f.configuration.iterations,
      ...(f.configuration.completedIterations ?? []),
    ].map((i) => ({ id: i.id, title: i.title, startDate: i.startDate, duration: i.duration }));
  }
  return base;
}

export function registerProjectsTools(server: McpServer, token: string): void {
  // --------------------------------------------------------------------
  // Read tools
  // --------------------------------------------------------------------

  server.registerTool(
    "list_org_projects",
    {
      description:
        "List GitHub project boards / kanban boards / roadmaps (Projects v2) " +
        "across one or more organizations. Use when you need to find existing " +
        "planning boards, sprint boards, or cross-repo coordination views. " +
        "Returns number/title/url/closed for each project, grouped by org. " +
        "Use `get_project` afterwards to inspect fields / columns.",
      inputSchema: {
        orgs: z.array(z.string()).min(1)
          .describe("Organization logins (e.g. ['ippoan', 'ohishi-exp', 'yhonda-ohishi'])"),
        first: z.number().min(1).max(100).default(50)
          .describe("Max projects per org (default 50)"),
        include_closed: z.boolean().default(false)
          .describe("Include closed projects (default false)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ orgs, first, include_closed }) => {
      for (const o of orgs) validateOrg(o);
      const perOrg = await Promise.all(orgs.map(async (org) => {
        const data = await githubGraphQL<{
          organization: {
            projectsV2: { nodes: Array<{
              id: string; number: number; title: string;
              url: string; closed: boolean; shortDescription: string | null;
            }> };
          } | null;
        }>(
          token,
          `query($org:String!,$first:Int!){
            organization(login:$org){
              projectsV2(first:$first, orderBy:{field:NUMBER,direction:DESC}){
                nodes{ id number title url closed shortDescription }
              }
            }
          }`,
          { org, first },
        );
        const nodes = data.organization?.projectsV2.nodes ?? [];
        const filtered = include_closed ? nodes : nodes.filter((p) => !p.closed);
        return {
          org,
          projects: filtered.map((p) => ({
            number: p.number,
            title: p.title,
            url: p.url,
            closed: p.closed,
            shortDescription: p.shortDescription,
          })),
        };
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(perOrg, null, 2) }] };
    },
  );

  server.registerTool(
    "get_project",
    {
      description:
        "Inspect a GitHub project board / kanban / roadmap (Projects v2): " +
        "metadata and full field / column definitions, including single-select " +
        "options (Status: Todo/In Progress/Done etc.) and iteration values " +
        "(sprints). Required before `set_project_item_field` if you need to " +
        "know valid column/option names.",
      inputSchema: {
        org: z.string().describe("Organization login"),
        number: z.number().describe("Project number (the integer in the project URL)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ org, number }) => {
      validateOrg(org);
      const data = await githubGraphQL<{
        organization: { projectV2: ProjectV2 | null } | null;
      }>(
        token,
        `query($org:String!,$number:Int!){
          organization(login:$org){
            projectV2(number:$number){
              id number title url closed shortDescription
              fields(first:50){
                nodes{
                  __typename
                  ... on ProjectV2FieldCommon { id name dataType }
                  ... on ProjectV2SingleSelectField {
                    id name dataType
                    options{ id name }
                  }
                  ... on ProjectV2IterationField {
                    id name dataType
                    configuration{
                      iterations{ id title startDate duration }
                      completedIterations{ id title startDate duration }
                    }
                  }
                }
              }
            }
          }
        }`,
        { org, number },
      );
      const p = data.organization?.projectV2;
      if (!p) throw new GitHubApiError(404, `Project not found: ${org}/projects/${number}`);
      const result = {
        id: p.id,
        number: p.number,
        title: p.title,
        url: p.url,
        closed: p.closed,
        shortDescription: p.shortDescription,
        fields: p.fields.nodes.map(summarizeField),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "list_project_items",
    {
      description:
        "List cards / items on a GitHub project board (Projects v2) — the " +
        "issues, PRs, and draft items currently tracked on the kanban / " +
        "roadmap. Each item includes its current field values (Status, " +
        "Priority, Epic, Iteration, etc.), so use this to see what is in " +
        "each kanban column or what is assigned to a given Epic.",
      inputSchema: {
        org: z.string().describe("Organization login"),
        number: z.number().describe("Project number"),
        first: z.number().min(1).max(100).default(50)
          .describe("Max items to return (default 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ org, number, first }) => {
      validateOrg(org);
      const data = await githubGraphQL<{
        organization: { projectV2: { items: { nodes: ProjectItemNode[] } } | null } | null;
      }>(
        token,
        `query($org:String!,$number:Int!,$first:Int!){
          organization(login:$org){
            projectV2(number:$number){
              items(first:$first){
                nodes{
                  id
                  type
                  content{
                    __typename
                    ... on Issue { number title url state repository{ nameWithOwner } }
                    ... on PullRequest { number title url state repository{ nameWithOwner } }
                    ... on DraftIssue { title }
                  }
                  fieldValues(first:30){
                    nodes{
                      __typename
                      ... on ProjectV2ItemFieldTextValue {
                        text field{ ... on ProjectV2FieldCommon { name } }
                      }
                      ... on ProjectV2ItemFieldNumberValue {
                        number field{ ... on ProjectV2FieldCommon { name } }
                      }
                      ... on ProjectV2ItemFieldDateValue {
                        date field{ ... on ProjectV2FieldCommon { name } }
                      }
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name optionId field{ ... on ProjectV2FieldCommon { name } }
                      }
                      ... on ProjectV2ItemFieldIterationValue {
                        title iterationId
                        field{ ... on ProjectV2FieldCommon { name } }
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { org, number, first },
      );
      const nodes = data.organization?.projectV2?.items.nodes ?? [];
      const result = nodes.map(formatItem);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // --------------------------------------------------------------------
  // Write tools
  // --------------------------------------------------------------------

  server.registerTool(
    "add_issue_to_project",
    {
      description:
        "Add an issue (or PR) as a card to a GitHub project board / kanban " +
        "(Projects v2). Use for cross-repo planning: putting issues from " +
        "multiple repositories onto a single tracking board, assigning work " +
        "to a sprint/Epic, or building a roadmap. Returns the new item's id, " +
        "which is needed by `set_project_item_field` and `remove_project_item`.",
      inputSchema: {
        org: z.string().describe("Project owner organization (e.g. 'ippoan')"),
        project_number: z.number().describe("Project number"),
        repo: z.string()
          .describe("Repository hosting the issue/PR (e.g. 'rust-alc-api' or 'ippoan/rust-alc-api')"),
        issue_number: z.number().describe("Issue or PR number to add"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ org, project_number, repo, issue_number }) => {
      validateOrg(org);
      const { owner, repo: name } = parseRepo(repo);
      validateOrg(owner);
      const [projectId, contentId] = await Promise.all([
        resolveProjectId(token, org, project_number),
        resolveIssueContentId(token, owner, name, issue_number),
      ]);
      const data = await githubGraphQL<{
        addProjectV2ItemById: { item: { id: string } };
      }>(
        token,
        `mutation($projectId:ID!,$contentId:ID!){
          addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}){
            item{ id }
          }
        }`,
        { projectId, contentId },
      );
      const result = {
        item_id: data.addProjectV2ItemById.item.id,
        project_id: projectId,
        content_id: contentId,
        repo: `${owner}/${name}`,
        issue_number,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "remove_project_item",
    {
      description:
        "Remove a card / item from a GitHub project board / kanban " +
        "(Projects v2). Detaches the issue from the board but does not " +
        "delete the underlying issue/PR.",
      inputSchema: {
        org: z.string().describe("Project owner organization"),
        project_number: z.number().describe("Project number"),
        item_id: z.string().describe("Item node ID (from `list_project_items` or `add_issue_to_project`)"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ org, project_number, item_id }) => {
      const projectId = await resolveProjectId(token, org, project_number);
      const data = await githubGraphQL<{
        deleteProjectV2Item: { deletedItemId: string };
      }>(
        token,
        `mutation($projectId:ID!,$itemId:ID!){
          deleteProjectV2Item(input:{projectId:$projectId, itemId:$itemId}){
            deletedItemId
          }
        }`,
        { projectId, itemId: item_id },
      );
      const result = { deleted_item_id: data.deleteProjectV2Item.deletedItemId };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "set_project_item_field",
    {
      description:
        "Set or change a field on a card / item on a GitHub project board " +
        "(Projects v2). Use to move a card between kanban columns (Status: " +
        "Todo → In Progress → Done), set Priority (P0/P1), assign to an Epic, " +
        "set a sprint/Iteration, or update any custom planning field. " +
        "Specify the field by name; for single_select / iteration fields, " +
        "pass the option name / iteration title in `value` (resolved to the " +
        "underlying option/iteration ID internally). For text/number/date, " +
        "pass the literal value. Pass `value: null` to clear the field.",
      inputSchema: {
        org: z.string().describe("Project owner organization"),
        project_number: z.number().describe("Project number"),
        item_id: z.string().describe("Item node ID"),
        field_name: z.string().describe("Field name (matches `name` from `get_project`)"),
        value: z.union([z.string(), z.number(), z.null()])
          .describe("New field value (string for text/date/single_select/iteration, number for number, null to clear)"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ org, project_number, item_id, field_name, value }) => {
      const projectId = await resolveProjectId(token, org, project_number);
      const fields = await getProjectFields(token, projectId);
      const field = fields.find((f) => f.name === field_name);
      if (!field) {
        const available = fields.map((f) => f.name).join(", ");
        throw new GitHubApiError(404, `Field not found: ${field_name}. Available: ${available}`);
      }

      // Build the GraphQL `value` input based on the field's data type.
      const valueInput: Record<string, unknown> = {};
      if (value === null) {
        // Clearing → use clearProjectV2ItemFieldValue mutation instead.
        const data = await githubGraphQL<{
          clearProjectV2ItemFieldValue: { projectV2Item: { id: string } };
        }>(
          token,
          `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!){
            clearProjectV2ItemFieldValue(input:{
              projectId:$projectId, itemId:$itemId, fieldId:$fieldId
            }){ projectV2Item{ id } }
          }`,
          { projectId, itemId: item_id, fieldId: field.id },
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            item_id: data.clearProjectV2ItemFieldValue.projectV2Item.id,
            field: field_name,
            cleared: true,
          }, null, 2) }],
        };
      }

      switch (field.dataType) {
        case "TEXT":
          if (typeof value !== "string") {
            throw new GitHubApiError(400, `Field ${field_name} (TEXT) requires a string value`);
          }
          valueInput.text = value;
          break;
        case "NUMBER": {
          const n = typeof value === "number" ? value : Number(value);
          if (Number.isNaN(n)) {
            throw new GitHubApiError(400, `Field ${field_name} (NUMBER) requires a numeric value`);
          }
          valueInput.number = n;
          break;
        }
        case "DATE":
          if (typeof value !== "string") {
            throw new GitHubApiError(400, `Field ${field_name} (DATE) requires an ISO date string (YYYY-MM-DD)`);
          }
          valueInput.date = value;
          break;
        case "SINGLE_SELECT": {
          const optionName = String(value);
          const opt = field.options?.find((o) => o.name === optionName);
          if (!opt) {
            const avail = (field.options ?? []).map((o) => o.name).join(", ");
            throw new GitHubApiError(404, `Option not found on ${field_name}: ${optionName}. Available: ${avail}`);
          }
          valueInput.singleSelectOptionId = opt.id;
          break;
        }
        case "ITERATION": {
          const iterTitle = String(value);
          const all = [
            ...(field.configuration?.iterations ?? []),
            ...(field.configuration?.completedIterations ?? []),
          ];
          const it = all.find((i) => i.title === iterTitle);
          if (!it) {
            const avail = all.map((i) => i.title).join(", ");
            throw new GitHubApiError(404, `Iteration not found on ${field_name}: ${iterTitle}. Available: ${avail}`);
          }
          valueInput.iterationId = it.id;
          break;
        }
        default:
          throw new GitHubApiError(
            400,
            `Field ${field_name} has unsupported dataType ${field.dataType} for set_project_item_field`,
          );
      }

      const data = await githubGraphQL<{
        updateProjectV2ItemFieldValue: { projectV2Item: { id: string } };
      }>(
        token,
        `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:ProjectV2FieldValue!){
          updateProjectV2ItemFieldValue(input:{
            projectId:$projectId, itemId:$itemId, fieldId:$fieldId, value:$value
          }){ projectV2Item{ id } }
        }`,
        { projectId, itemId: item_id, fieldId: field.id, value: valueInput },
      );
      const result = {
        item_id: data.updateProjectV2ItemFieldValue.projectV2Item.id,
        field: field_name,
        dataType: field.dataType,
        value,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "create_project_field",
    {
      description:
        "Add a custom column / field to a GitHub project board (Projects v2): " +
        "Status column (single_select), Priority, Epic label (text), due date, " +
        "estimate (number), etc. For `single_select`, supply `single_select_options` " +
        "(array of option names) — these become the kanban column values. " +
        "`iteration` (sprint) fields cannot be created here — make them in the " +
        "GitHub UI.",
      inputSchema: {
        org: z.string().describe("Project owner organization"),
        project_number: z.number().describe("Project number"),
        name: z.string().describe("Field name"),
        data_type: z.enum(["text", "number", "date", "single_select"])
          .describe("Field data type"),
        single_select_options: z.array(z.string()).optional()
          .describe("Required when data_type='single_select': option names"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ org, project_number, name, data_type, single_select_options }) => {
      const projectId = await resolveProjectId(token, org, project_number);

      const dataTypeMap = {
        text: "TEXT", number: "NUMBER", date: "DATE", single_select: "SINGLE_SELECT",
      } as const;
      const gqlDataType = dataTypeMap[data_type];

      const input: Record<string, unknown> = {
        projectId, dataType: gqlDataType, name,
      };
      if (data_type === "single_select") {
        if (!single_select_options || single_select_options.length === 0) {
          throw new GitHubApiError(400, "single_select_options is required for data_type='single_select'");
        }
        // GitHub requires a color and description per option; default to GRAY/empty.
        input.singleSelectOptions = single_select_options.map((n) => ({
          name: n, color: "GRAY", description: "",
        }));
      }

      const data = await githubGraphQL<{
        createProjectV2Field: { projectV2Field: { __typename: string } };
      }>(
        token,
        `mutation($input:CreateProjectV2FieldInput!){
          createProjectV2Field(input:$input){
            projectV2Field{
              __typename
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField {
                id name dataType options{ id name }
              }
            }
          }
        }`,
        { input },
      );
      const result = {
        field: data.createProjectV2Field.projectV2Field,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "create_project",
    {
      description:
        "Create a new GitHub project board / kanban / roadmap / planning view " +
        "(Projects v2) under an organization. Use for spinning up a new " +
        "tracking board, a sprint planning surface, a milestone board, or a " +
        "cross-repo coordination view (e.g. one Epic spanning multiple " +
        "repositories). Returns the new project's id/number/title/url — " +
        "`number` can be fed directly into `add_issue_to_project` / " +
        "`set_project_item_field` / `create_project_field`. If " +
        "`short_description` is provided, a follow-up `updateProjectV2` " +
        "mutation is issued (the create mutation does not accept it). On " +
        "that follow-up failing, the created project is still returned with " +
        "a `warning` field.",
      inputSchema: {
        org: z.string().describe("Organization login (e.g. 'ippoan')"),
        title: z.string().min(1).describe("Project title"),
        short_description: z.string().optional()
          .describe("Optional short description (applied via a second updateProjectV2 mutation)"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ org, title, short_description }) => {
      validateOrg(org);

      // Step 1: resolve the org's GraphQL node ID (needed as ownerId).
      const ownerResult = await githubGraphQL<{
        organization: { id: string } | null;
      }>(
        token,
        `query($org:String!){ organization(login:$org){ id } }`,
        { org },
      );
      const ownerId = ownerResult.organization?.id;
      if (!ownerId) throw new GitHubApiError(404, `Organization not found: ${org}`);

      // Step 2: createProjectV2 (title only — shortDescription is not part of CreateProjectV2Input).
      const created = await githubGraphQL<{
        createProjectV2: { projectV2: {
          id: string; number: number; title: string; url: string;
          shortDescription: string | null;
        } };
      }>(
        token,
        `mutation($ownerId:ID!,$title:String!){
          createProjectV2(input:{ownerId:$ownerId, title:$title}){
            projectV2{ id number title url shortDescription }
          }
        }`,
        { ownerId, title },
      );
      const project = created.createProjectV2.projectV2;

      const result: {
        id: string; number: number; title: string; url: string;
        shortDescription: string | null; warning?: string;
      } = {
        id: project.id,
        number: project.number,
        title: project.title,
        url: project.url,
        shortDescription: project.shortDescription,
      };

      // Step 3 (optional): apply shortDescription. If this fails the project
      // already exists — surface that fact via `warning` instead of throwing so
      // the caller knows to retry only the description.
      if (short_description !== undefined) {
        try {
          const updated = await githubGraphQL<{
            updateProjectV2: { projectV2: { shortDescription: string | null } };
          }>(
            token,
            `mutation($id:ID!,$desc:String!){
              updateProjectV2(input:{projectId:$id, shortDescription:$desc}){
                projectV2{ shortDescription }
              }
            }`,
            { id: project.id, desc: short_description },
          );
          result.shortDescription = updated.updateProjectV2.projectV2.shortDescription;
        } catch (err) {
          result.warning =
            `Project created (number=${project.number}) but setting shortDescription failed: ` +
            (err instanceof Error ? err.message : String(err));
        }
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

// --------------------------------------------------------------------------
// Internal item formatting (kept out of the schema namespace)
// --------------------------------------------------------------------------

interface ProjectItemNode {
  id: string;
  type: string;
  content:
    | {
        __typename: "Issue" | "PullRequest";
        number: number; title: string; url: string; state: string;
        repository: { nameWithOwner: string };
      }
    | { __typename: "DraftIssue"; title: string }
    | null;
  fieldValues: { nodes: ProjectFieldValueNode[] };
}

type ProjectFieldValueNode =
  | { __typename: "ProjectV2ItemFieldTextValue"; text: string; field: { name?: string } }
  | { __typename: "ProjectV2ItemFieldNumberValue"; number: number; field: { name?: string } }
  | { __typename: "ProjectV2ItemFieldDateValue"; date: string; field: { name?: string } }
  | { __typename: "ProjectV2ItemFieldSingleSelectValue"; name: string; optionId: string; field: { name?: string } }
  | { __typename: "ProjectV2ItemFieldIterationValue"; title: string; iterationId: string; field: { name?: string } }
  | { __typename: string };

function formatItem(node: ProjectItemNode) {
  const content = node.content;
  let contentSummary: Record<string, unknown> = { type: "unknown" };
  if (content) {
    if (content.__typename === "Issue" || content.__typename === "PullRequest") {
      contentSummary = {
        type: content.__typename === "Issue" ? "issue" : "pull_request",
        repo: content.repository.nameWithOwner,
        number: content.number,
        title: content.title,
        state: content.state,
        url: content.url,
      };
    } else if (content.__typename === "DraftIssue") {
      contentSummary = { type: "draft_issue", title: content.title };
    }
  }

  const values: Record<string, unknown> = {};
  for (const v of node.fieldValues.nodes) {
    const fname = (v as { field?: { name?: string } }).field?.name;
    if (!fname) continue;
    switch (v.__typename) {
      case "ProjectV2ItemFieldTextValue":
        values[fname] = (v as { text: string }).text; break;
      case "ProjectV2ItemFieldNumberValue":
        values[fname] = (v as { number: number }).number; break;
      case "ProjectV2ItemFieldDateValue":
        values[fname] = (v as { date: string }).date; break;
      case "ProjectV2ItemFieldSingleSelectValue":
        values[fname] = (v as { name: string }).name; break;
      case "ProjectV2ItemFieldIterationValue":
        values[fname] = (v as { title: string }).title; break;
    }
  }

  return {
    item_id: node.id,
    item_type: node.type,
    content: contentSummary,
    fields: values,
  };
}
