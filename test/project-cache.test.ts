import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  getOrFetchOrgProjects,
  getOrFetchProjectItems,
  getOrFetchProjectIssueMap,
  invalidateOrgList,
  invalidateOrgItems,
  invalidateIssuesPageProjectMap,
  applyProjectsV2Event,
  applyProjectsV2ItemEvent,
  __testing,
} from "../src/project-cache";

const { orgListKey, itemsKey, ISSUES_PAGE_PROJECT_MAP_KEY } = __testing;

async function clearCache(): Promise<void> {
  for (const prefix of ["project:", "issues-page:project-map"]) {
    let cursor: string | undefined;
    do {
      const page = await env.CI_STATUS.list({ prefix, cursor });
      await Promise.all(page.keys.map((k) => env.CI_STATUS.delete(k.name)));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
}

// 最小の GraphQL stub。`projectsV2` list と project `items` の両 query 形に
// 反応する。auth-worker /mcp/token も握り潰す。
function stubGraphQLOnce() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (req, init) => {
    const url = typeof req === "string" ? req : (req as Request).url;
    if (url.includes("auth-worker") || url.includes("/mcp/token")) {
      return Response.json({ access_token: "tok" });
    }
    if (url.includes("/graphql")) {
      const body = (init?.body as string | undefined)
        ?? (typeof req === "string" ? "" : await (req as Request).clone().text());
      if (body.includes("projectsV2(first:")) {
        return Response.json({
          data: { repositoryOwner: { projectsV2: { nodes: [
            { id: "PVT_1", number: 1, title: "Board A",
              url: "https://github.com/orgs/ippoan/projects/1",
              closed: false, shortDescription: null },
          ] } } },
        });
      }
      if (body.includes("projectV2(number:")) {
        return Response.json({
          data: { repositoryOwner: { projectV2: { items: { nodes: [
            { id: "PVTI_1", type: "ISSUE", content: {
              __typename: "Issue", number: 1, title: "t",
              url: "u", state: "OPEN",
              repository: { nameWithOwner: "ippoan/x" },
            }, fieldValues: { nodes: [] } },
          ] } } } },
        });
      }
    }
    return new Response("ignored", { status: 404 });
  });
}

describe("project-cache", () => {
  beforeEach(clearCache);
  afterEach(() => { vi.restoreAllMocks(); });

  describe("getOrFetchOrgProjects", () => {
    it("cache miss は GraphQL を叩いて KV に書く、hit は API 0 call", async () => {
      const spy = stubGraphQLOnce();
      const first = await getOrFetchOrgProjects(env, ["ippoan"]);
      expect(first).toHaveLength(1);
      expect(first[0]!.projects[0]!.title).toBe("Board A");
      const graphqlCalls1 = spy.mock.calls.filter((c) =>
        String(c[0]).includes("/graphql")).length;
      expect(graphqlCalls1).toBeGreaterThan(0);

      const second = await getOrFetchOrgProjects(env, ["ippoan"]);
      expect(second).toEqual(first);
      const graphqlCalls2 = spy.mock.calls.filter((c) =>
        String(c[0]).includes("/graphql")).length;
      // 2 回目は cache hit なので GraphQL call 数増えない
      expect(graphqlCalls2).toBe(graphqlCalls1);
    });
  });

  describe("getOrFetchProjectItems", () => {
    it("cache miss → fetch → cache hit で API 0 call", async () => {
      const spy = stubGraphQLOnce();
      const first = await getOrFetchProjectItems(env, "ippoan", 1);
      expect(first).toHaveLength(1);
      const graphqlCalls1 = spy.mock.calls.filter((c) =>
        String(c[0]).includes("/graphql")).length;
      expect(graphqlCalls1).toBeGreaterThan(0);

      await getOrFetchProjectItems(env, "ippoan", 1);
      const graphqlCalls2 = spy.mock.calls.filter((c) =>
        String(c[0]).includes("/graphql")).length;
      expect(graphqlCalls2).toBe(graphqlCalls1);
    });
  });

  describe("invalidate*", () => {
    it("invalidateOrgList は該当 org の list key だけ消す", async () => {
      await env.CI_STATUS.put(orgListKey("ippoan"), '[]');
      await env.CI_STATUS.put(orgListKey("ohishi-exp"), '[]');
      await invalidateOrgList(env.CI_STATUS, "ippoan");
      expect(await env.CI_STATUS.get(orgListKey("ippoan"))).toBeNull();
      expect(await env.CI_STATUS.get(orgListKey("ohishi-exp"))).toBe('[]');
    });

    it("invalidateOrgItems は該当 org の全 items key を消す", async () => {
      await env.CI_STATUS.put(itemsKey("ippoan", 1), '[]');
      await env.CI_STATUS.put(itemsKey("ippoan", 2), '[]');
      await env.CI_STATUS.put(itemsKey("ohishi-exp", 1), '[]');
      await invalidateOrgItems(env.CI_STATUS, "ippoan");
      expect(await env.CI_STATUS.get(itemsKey("ippoan", 1))).toBeNull();
      expect(await env.CI_STATUS.get(itemsKey("ippoan", 2))).toBeNull();
      expect(await env.CI_STATUS.get(itemsKey("ohishi-exp", 1))).toBe('[]');
    });

    it("invalidateIssuesPageProjectMap は issues-page の project-map key を消す", async () => {
      await env.CI_STATUS.put(ISSUES_PAGE_PROJECT_MAP_KEY, '{}');
      await invalidateIssuesPageProjectMap(env.CI_STATUS);
      expect(await env.CI_STATUS.get(ISSUES_PAGE_PROJECT_MAP_KEY)).toBeNull();
    });
  });

  describe("applyProjectsV2Event", () => {
    it("organization.login から org を引いて list + items + project-map を flush", async () => {
      await env.CI_STATUS.put(orgListKey("ippoan"), '[]');
      await env.CI_STATUS.put(itemsKey("ippoan", 1), '[]');
      await env.CI_STATUS.put(ISSUES_PAGE_PROJECT_MAP_KEY, '{}');
      await applyProjectsV2Event(env.CI_STATUS, {
        action: "edited",
        projects_v2: { id: 1, node_id: "PVT_1" },
        organization: { login: "ippoan" },
      });
      expect(await env.CI_STATUS.get(orgListKey("ippoan"))).toBeNull();
      expect(await env.CI_STATUS.get(itemsKey("ippoan", 1))).toBeNull();
      expect(await env.CI_STATUS.get(ISSUES_PAGE_PROJECT_MAP_KEY)).toBeNull();
    });

    it("organization が無くても projects_v2.owner.login で fallback", async () => {
      await env.CI_STATUS.put(orgListKey("ippoan"), '[]');
      await applyProjectsV2Event(env.CI_STATUS, {
        action: "created",
        projects_v2: { id: 2, node_id: "PVT_2", owner: { login: "ippoan" } },
      });
      expect(await env.CI_STATUS.get(orgListKey("ippoan"))).toBeNull();
    });

    it("org が解決できない時は no-op", async () => {
      await env.CI_STATUS.put(orgListKey("ippoan"), '[]');
      await applyProjectsV2Event(env.CI_STATUS, {
        action: "edited",
        projects_v2: { id: 1, node_id: "PVT_1" },
      });
      expect(await env.CI_STATUS.get(orgListKey("ippoan"))).toBe('[]');
    });
  });

  describe("getOrFetchProjectIssueMap (Refs #135)", () => {
    it("Project items の Issue を repo#number → ProjectRef[] に集約する", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (req, init) => {
        const url = typeof req === "string" ? req : (req as Request).url;
        if (url.includes("auth-worker") || url.includes("/mcp/token")) {
          return Response.json({ access_token: "tok" });
        }
        if (url.includes("/graphql")) {
          const body = (init?.body as string | undefined)
            ?? (typeof req === "string" ? "" : await (req as Request).clone().text());
          if (body.includes("projectsV2(first:")) {
            return Response.json({
              data: { repositoryOwner: { projectsV2: { nodes: [
                { id: "PVT_1", number: 1, title: "Board",
                  url: "https://github.com/orgs/ippoan/projects/1",
                  closed: false, shortDescription: null },
              ] } } },
            });
          }
          if (body.includes("projectV2(number:")) {
            return Response.json({
              data: { repositoryOwner: { projectV2: { items: { nodes: [
                { id: "PVTI_1", type: "ISSUE", content: {
                  __typename: "Issue", number: 42, title: "t",
                  url: "u", state: "OPEN",
                  repository: { nameWithOwner: "ippoan/foo" },
                }, fieldValues: { nodes: [] } },
                { id: "PVTI_2", type: "DRAFT_ISSUE", content: {
                  __typename: "DraftIssue", title: "d",
                }, fieldValues: { nodes: [] } },
              ] } } } },
            });
          }
        }
        return new Response("ignored", { status: 404 });
      });

      const result = await getOrFetchProjectIssueMap(env, ["ippoan"]);
      expect(result.error).toBeNull();
      expect(result.stale).toBe(false);
      // Issue だけ map に乗る、DraftIssue は無視
      const ref = result.map.get("ippoan/foo#42");
      expect(ref).toHaveLength(1);
      expect(ref![0]!.title).toBe("Board");
      expect(ref![0]!.org).toBe("ippoan");
      expect(ref![0]!.number).toBe(1);
    });

    it("org list fetch が fail したら error をセットして空 map を返す", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response("rate limit", { status: 403 });
      });
      const result = await getOrFetchProjectIssueMap(env, ["ippoan"]);
      expect(result.map.size).toBe(0);
      expect(result.error).toBeTruthy();
    });

    it("2 回目は cache hit で GraphQL を叩かない", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (req, init) => {
        const url = typeof req === "string" ? req : (req as Request).url;
        if (url.includes("auth-worker") || url.includes("/mcp/token")) {
          return Response.json({ access_token: "tok" });
        }
        if (url.includes("/graphql")) {
          const body = (init?.body as string | undefined)
            ?? (typeof req === "string" ? "" : await (req as Request).clone().text());
          if (body.includes("projectsV2(first:")) {
            return Response.json({
              data: { repositoryOwner: { projectsV2: { nodes: [
                { id: "PVT_1", number: 1, title: "B", url: "u",
                  closed: false, shortDescription: null },
              ] } } },
            });
          }
          if (body.includes("projectV2(number:")) {
            return Response.json({
              data: { repositoryOwner: { projectV2: { items: { nodes: [] } } } },
            });
          }
        }
        return new Response("ignored", { status: 404 });
      });
      await getOrFetchProjectIssueMap(env, ["ippoan"]);
      const calls1 = spy.mock.calls.filter((c) =>
        String(c[0]).includes("/graphql")).length;
      await getOrFetchProjectIssueMap(env, ["ippoan"]);
      const calls2 = spy.mock.calls.filter((c) =>
        String(c[0]).includes("/graphql")).length;
      expect(calls2).toBe(calls1);
    });
  });

  describe("applyProjectsV2ItemEvent", () => {
    it("items + issues-page project-map だけ flush し、list は保つ", async () => {
      await env.CI_STATUS.put(orgListKey("ippoan"), '[]');
      await env.CI_STATUS.put(itemsKey("ippoan", 1), '[]');
      await env.CI_STATUS.put(ISSUES_PAGE_PROJECT_MAP_KEY, '{}');
      await applyProjectsV2ItemEvent(env.CI_STATUS, {
        action: "created",
        projects_v2_item: {
          id: 1, node_id: "PVTI_1", project_node_id: "PVT_1",
          content_node_id: "I_1", content_type: "Issue",
        },
        organization: { login: "ippoan" },
      });
      expect(await env.CI_STATUS.get(orgListKey("ippoan"))).toBe('[]'); // 残る
      expect(await env.CI_STATUS.get(itemsKey("ippoan", 1))).toBeNull(); // 消える
      expect(await env.CI_STATUS.get(ISSUES_PAGE_PROJECT_MAP_KEY)).toBeNull(); // 消える
    });

    it("organization が無い (user-owned projects 等) なら no-op", async () => {
      await env.CI_STATUS.put(itemsKey("ippoan", 1), '[]');
      await applyProjectsV2ItemEvent(env.CI_STATUS, {
        action: "created",
        projects_v2_item: {
          id: 1, node_id: "PVTI_1", project_node_id: "PVT_1",
          content_node_id: "I_1", content_type: "Issue",
        },
      });
      expect(await env.CI_STATUS.get(itemsKey("ippoan", 1))).toBe('[]');
    });
  });
});
