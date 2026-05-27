import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { OrgIssue } from "../src/mcp/tools/issues";
import {
  upsertIssue,
  listCachedOpenIssues,
  reconcileIssues,
  webhookIssueToOrgIssue,
  applyIssueCommentEvent,
  issueKey,
  __testing,
} from "../src/issue-cache";

function makeIssue(over: Partial<OrgIssue> = {}): OrgIssue {
  return {
    repo: "ippoan/ci-dashboard",
    number: 1,
    title: "test issue",
    state: "open",
    author: "yhonda",
    labels: [],
    assignees: [],
    comments: 0,
    created_at: "2026-05-27T00:00:00Z",
    updated_at: "2026-05-27T00:00:00Z",
    url: "https://github.com/ippoan/ci-dashboard/issues/1",
    ...over,
  };
}

async function clearCache(): Promise<void> {
  // KV.list でテスト間 leak しないよう全 prefix を flush。
  for (const prefix of [__testing.KEY_PREFIX, "issues:"]) {
    let cursor: string | undefined;
    do {
      const page = await env.CI_STATUS.list({ prefix, cursor });
      await Promise.all(page.keys.map((k) => env.CI_STATUS.delete(k.name)));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
}

describe("issue-cache", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearCache();
  });

  describe("upsertIssue", () => {
    it("open issue は put、closed は delete する", async () => {
      const issue = makeIssue({ number: 42 });
      await upsertIssue(env.CI_STATUS, issue);
      const stored = await env.CI_STATUS.get(issueKey(issue.repo, 42), "json");
      expect(stored).toEqual(issue);

      await upsertIssue(env.CI_STATUS, { ...issue, state: "closed" });
      const after = await env.CI_STATUS.get(issueKey(issue.repo, 42));
      expect(after).toBeNull();
    });

    it("watermark を touch しない (webhook 配信ミス時に list-since で拾える担保)", async () => {
      await env.CI_STATUS.put(__testing.KEY_WATERMARK, "2026-05-26T00:00:00Z");
      await upsertIssue(env.CI_STATUS, makeIssue());
      const wm = await env.CI_STATUS.get(__testing.KEY_WATERMARK);
      expect(wm).toBe("2026-05-26T00:00:00Z");
    });
  });

  describe("listCachedOpenIssues", () => {
    it("複数 repo の open issue を全件返す", async () => {
      await upsertIssue(env.CI_STATUS, makeIssue({ number: 1 }));
      await upsertIssue(env.CI_STATUS, makeIssue({ number: 2, repo: "ohishi-exp/other" }));
      const all = await listCachedOpenIssues(env.CI_STATUS);
      expect(all).toHaveLength(2);
      expect(all.map((i) => i.number).sort()).toEqual([1, 2]);
    });

    it("cache 空なら空配列", async () => {
      const all = await listCachedOpenIssues(env.CI_STATUS);
      expect(all).toEqual([]);
    });
  });

  describe("reconcileIssues", () => {
    function mockSearchResponse(items: OrgIssue[]) {
      return Response.json({
        total_count: items.length,
        incomplete_results: false,
        items: items.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          user: { login: i.author },
          labels: i.labels.map((n) => ({ name: n })),
          assignees: i.assignees.map((a) => ({ login: a })),
          comments: i.comments,
          created_at: i.created_at,
          updated_at: i.updated_at,
          html_url: i.url,
          repository_url: `https://api.github.com/repos/${i.repo}`,
        })),
      });
    }

    it("fresh window 内は GitHub を叩かない", async () => {
      // watermark を「ちょっと前」にセット → fresh 判定で skip
      const recent = new Date(Date.now() - 10 * 1000).toISOString();
      await env.CI_STATUS.put(__testing.KEY_WATERMARK, recent);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const result = await reconcileIssues(env, { mainOrgs: ["ippoan"], yhondaRepos: [] });
      expect(result.fetched).toBe(false);
      expect(result.patched).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("cold start で全件 fetch + watermark セット", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        // auth-worker token 取得呼び出しは skip して mock 値返す
        if (url.includes("auth-worker") || url.includes("/mcp/token")) {
          return Response.json({ access_token: "tok" });
        }
        if (url.includes("/search/issues")) {
          return mockSearchResponse([
            makeIssue({ number: 10 }),
            makeIssue({ number: 11, repo: "ippoan/other" }),
          ]);
        }
        return new Response("ignored", { status: 404 });
      });

      const result = await reconcileIssues(env, {
        mainOrgs: ["ippoan"], yhondaRepos: [],
      });
      expect(result.fetched).toBe(true);
      // 2 query (main + yhonda) で各 2 件 → 計 4 件 (mock は両 query 同レスポンス)
      expect(result.patched).toBeGreaterThan(0);

      const wm = await env.CI_STATUS.get(__testing.KEY_WATERMARK);
      expect(wm).toBeTruthy();
      expect(Date.parse(wm!)).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("webhookIssueToOrgIssue", () => {
    it("webhook payload を OrgIssue 形に正規化", async () => {
      const issue = webhookIssueToOrgIssue({
        action: "opened",
        issue: {
          number: 7,
          title: "from webhook",
          state: "open",
          user: { login: "alice" },
          labels: [{ name: "bug" }, { name: "p1" }],
          assignees: [{ login: "bob" }],
          comments: 3,
          created_at: "2026-05-27T01:00:00Z",
          updated_at: "2026-05-27T02:00:00Z",
          html_url: "https://github.com/x/y/issues/7",
        },
        repository: { full_name: "x/y" },
      });
      expect(issue).toEqual({
        repo: "x/y",
        number: 7,
        title: "from webhook",
        state: "open",
        author: "alice",
        labels: ["bug", "p1"],
        assignees: ["bob"],
        comments: 3,
        created_at: "2026-05-27T01:00:00Z",
        updated_at: "2026-05-27T02:00:00Z",
        url: "https://github.com/x/y/issues/7",
      });
    });

    it("user が null (deleted account) でも author=空文字で受ける", () => {
      const issue = webhookIssueToOrgIssue({
        action: "opened",
        issue: {
          number: 1, title: "x", state: "open", user: null,
          labels: [], assignees: [], comments: 0,
          created_at: "t", updated_at: "t", html_url: "u",
        },
        repository: { full_name: "a/b" },
      });
      expect(issue.author).toBe("");
    });
  });

  describe("applyIssueCommentEvent", () => {
    it("created で comments を +1", async () => {
      await upsertIssue(env.CI_STATUS, makeIssue({ number: 5, comments: 2 }));
      await applyIssueCommentEvent(env.CI_STATUS, {
        action: "created",
        issue: { number: 5 },
        repository: { full_name: "ippoan/ci-dashboard" },
      });
      const updated = await env.CI_STATUS.get(
        issueKey("ippoan/ci-dashboard", 5), "json",
      ) as OrgIssue;
      expect(updated.comments).toBe(3);
    });

    it("deleted で comments を -1 (0 未満にはならない)", async () => {
      await upsertIssue(env.CI_STATUS, makeIssue({ number: 5, comments: 0 }));
      await applyIssueCommentEvent(env.CI_STATUS, {
        action: "deleted",
        issue: { number: 5 },
        repository: { full_name: "ippoan/ci-dashboard" },
      });
      const updated = await env.CI_STATUS.get(
        issueKey("ippoan/ci-dashboard", 5), "json",
      ) as OrgIssue;
      expect(updated.comments).toBe(0);
    });

    it("edited は no-op (件数変わらない)", async () => {
      await upsertIssue(env.CI_STATUS, makeIssue({ number: 5, comments: 2 }));
      await applyIssueCommentEvent(env.CI_STATUS, {
        action: "edited",
        issue: { number: 5 },
        repository: { full_name: "ippoan/ci-dashboard" },
      });
      const updated = await env.CI_STATUS.get(
        issueKey("ippoan/ci-dashboard", 5), "json",
      ) as OrgIssue;
      expect(updated.comments).toBe(2);
    });

    it("cache miss は no-op で throw しない", async () => {
      await expect(applyIssueCommentEvent(env.CI_STATUS, {
        action: "created",
        issue: { number: 999 },
        repository: { full_name: "unknown/repo" },
      })).resolves.toBeUndefined();
    });
  });
});
