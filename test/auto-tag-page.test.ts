import { describe, it, expect } from "vitest";
import {
  handleAutoTagPage,
  handleAutoTagPagePost,
} from "../src/auto-tag-page";
import { normalizeAutoTagRepos } from "../src/auto-tag";

interface MockHub {
  stub: DurableObjectStub;
  get(): string[];
  setReject(reason: "throw" | null): void;
}

function makeMockHub(initial: string[] = []): MockHub {
  let stored = [...initial];
  let reject: "throw" | null = null;
  const stub = {
    fetch: async (req: Request) => {
      const u = new URL(req.url);
      if (reject === "throw") throw new Error("hub unreachable");
      if (u.pathname === "/auto-tag-repos" && req.method === "GET") {
        return Response.json(stored);
      }
      if (u.pathname === "/auto-tag-repos" && req.method === "PUT") {
        const body = await req.json<{ repos: string[] }>();
        stored = normalizeAutoTagRepos(body.repos ?? []);
        return Response.json(stored);
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as DurableObjectStub;
  return {
    stub,
    get: () => stored.slice(),
    setReject: (r) => { reject = r; },
  };
}

function makeFormReq(repos: string): Request {
  const form = new FormData();
  form.set("repos", repos);
  return new Request("http://localhost/auto-tag", {
    method: "POST",
    body: form,
  });
}

describe("handleAutoTagPage (GET /auto-tag)", () => {
  it("renders page with empty textarea when no repos stored", async () => {
    const h = makeMockHub();
    const res = await handleAutoTagPage(h.stub);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Auto-tag on PR merge");
    expect(body).toContain('<textarea name="repos"');
    expect(body).toMatch(/<textarea[^>]*>(\s*)<\/textarea>/);
  });

  it("pre-fills textarea with current set joined by newline", async () => {
    const h = makeMockHub(["a/x", "b/y"]);
    const res = await handleAutoTagPage(h.stub);
    const body = await res.text();
    expect(body).toContain("a/x\nb/y");
  });

  it("HTML-escapes any pathological repo names", async () => {
    const h = makeMockHub(["evil/<script>"]);
    const res = await handleAutoTagPage(h.stub);
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("handleAutoTagPagePost (POST /auto-tag)", () => {
  it("writes the set and re-renders with flash on success", async () => {
    const h = makeMockHub();
    const res = await handleAutoTagPagePost(
      makeFormReq("ippoan/foo\nippoan/bar"),
      h.stub,
    );
    expect(res.status).toBe(200);
    expect(h.get()).toEqual(["ippoan/bar", "ippoan/foo"]); // normalized + sorted
    const body = await res.text();
    expect(body).toContain("保存しました");
  });

  it("clears the set when textarea is submitted empty", async () => {
    const h = makeMockHub(["a/x", "b/y"]);
    const res = await handleAutoTagPagePost(makeFormReq(""), h.stub);
    expect(res.status).toBe(200);
    expect(h.get()).toEqual([]);
  });

  it("dedupes and trims via Hub-side normalization", async () => {
    const h = makeMockHub();
    await handleAutoTagPagePost(
      makeFormReq("  a/x  \nA/X\na/x\n\nb/y"),
      h.stub,
    );
    // Case-sensitive on the repo names — A/X is a different repo from a/x.
    expect(h.get()).toEqual(["A/X", "a/x", "b/y"]);
  });

  it("returns 502 with error flash when Hub is unreachable", async () => {
    const h = makeMockHub(["a/x"]);
    h.setReject("throw");
    const res = await handleAutoTagPagePost(makeFormReq("c/z"), h.stub);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("保存に失敗しました");
  });
});
