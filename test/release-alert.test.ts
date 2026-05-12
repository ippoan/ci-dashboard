import { describe, it, expect, vi, afterEach } from "vitest";
import { computeReleaseAlert, recomputeAlert } from "../src/release-alert";

// `computeReleaseAlert` fans out to several GitHub endpoints; we stub
// globalThis.fetch and route by URL. Each test sets up a fixture map so the
// assertions read like a script of "given these tags / commits / issues,
// expect this alert payload".

interface Fixture {
  tags?: Array<{ name: string }>;
  compare?: Record<string, { commits: Array<{ commit: { message: string } }> }>;
  pulls?: Record<number, { head: { ref: string }; body: string | null }>;
  issues?: Record<number, {
    number: number;
    title: string;
    state: string;
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;
    html_url: string;
    updated_at: string;
    pull_request?: unknown;
  }>;
}

function stubGithub(fx: Fixture) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const u = new URL(url);
    const path = u.pathname;

    if (path.endsWith("/tags")) {
      return Response.json(fx.tags ?? []);
    }
    const cmp = path.match(/\/compare\/(.+?)\.\.\.(.+)$/);
    if (cmp) {
      const key = `${cmp[1]}...${cmp[2]}`;
      return Response.json(fx.compare?.[key] ?? { commits: [] });
    }
    const prMatch = path.match(/\/pulls\/(\d+)$/);
    if (prMatch) {
      const n = Number(prMatch[1]);
      const pr = fx.pulls?.[n];
      if (!pr) return new Response("not found", { status: 404 });
      return Response.json(pr);
    }
    const issueMatch = path.match(/\/issues\/(\d+)$/);
    if (issueMatch) {
      const n = Number(issueMatch[1]);
      const issue = fx.issues?.[n];
      if (!issue) return new Response("not found", { status: 404 });
      return Response.json(issue);
    }
    return new Response("unstubbed: " + path, { status: 500 });
  });
}

function openIssue(n: number, title = `issue ${n}`) {
  return {
    number: n, title, state: "open",
    labels: [], assignees: [],
    html_url: `https://github.com/ippoan/foo/issues/${n}`,
    updated_at: "2026-05-01T00:00:00Z",
  };
}
function closedIssue(n: number, title = `issue ${n}`) {
  return { ...openIssue(n, title), state: "closed" };
}

describe("computeReleaseAlert", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns null when the repo has no tags", async () => {
    stubGithub({ tags: [] });
    const result = await computeReleaseAlert("token", "ippoan/foo");
    expect(result).toBeNull();
  });

  it("returns null when the latest tag's commits reference no issues", async () => {
    stubGithub({
      tags: [{ name: "v1.1.0" }, { name: "v1.0.0" }],
      compare: {
        "v1.0.0...v1.1.0": { commits: [{ commit: { message: "feat: noop" } }] },
      },
    });
    const result = await computeReleaseAlert("token", "ippoan/foo");
    expect(result).toBeNull();
  });

  it("returns null when every referenced issue is already closed", async () => {
    stubGithub({
      tags: [{ name: "v1.1.0" }, { name: "v1.0.0" }],
      compare: {
        "v1.0.0...v1.1.0": {
          commits: [{ commit: { message: "feat: thing\nRefs #42" } }],
        },
      },
      issues: { 42: closedIssue(42) },
    });
    const result = await computeReleaseAlert("token", "ippoan/foo");
    expect(result).toBeNull();
  });

  it("returns alert with open issues for the latest tag (no override)", async () => {
    stubGithub({
      tags: [{ name: "v1.2.0" }, { name: "v1.1.0" }, { name: "v1.0.0" }],
      compare: {
        "v1.1.0...v1.2.0": {
          commits: [
            { commit: { message: "feat: x\nRefs #10\nRefs #11" } },
            { commit: { message: "fix: y\nRefs #12" } },
          ],
        },
      },
      issues: {
        10: openIssue(10, "open one"),
        11: closedIssue(11, "already closed"),
        12: openIssue(12, "open two"),
      },
    });
    const result = await computeReleaseAlert("token", "ippoan/foo");
    expect(result).not.toBeNull();
    expect(result!.repo).toBe("ippoan/foo");
    expect(result!.tag).toBe("v1.2.0");
    expect(result!.prevTag).toBe("v1.1.0");
    expect(result!.openIssues.map((i) => i.number)).toEqual([10, 12]);
    expect(result!.openIssues[0]!.title).toBe("open one");
    expect(result!.openIssues[0]!.url).toBe("https://github.com/ippoan/foo/issues/10");
    // detectedAt is an ISO timestamp produced at compute time
    expect(() => new Date(result!.detectedAt).toISOString()).not.toThrow();
  });

  it("respects an explicit tag override (older release)", async () => {
    stubGithub({
      tags: [{ name: "v2.0.0" }, { name: "v1.2.0" }, { name: "v1.1.0" }],
      compare: {
        "v1.1.0...v1.2.0": {
          commits: [{ commit: { message: "feat: q\nRefs #99" } }],
        },
      },
      issues: { 99: openIssue(99) },
    });
    const result = await computeReleaseAlert("token", "ippoan/foo", "v1.2.0");
    expect(result?.tag).toBe("v1.2.0");
    expect(result?.openIssues[0]?.number).toBe(99);
  });

  it("throws on unknown tag override", async () => {
    stubGithub({
      tags: [{ name: "v1.0.0" }],
    });
    await expect(
      computeReleaseAlert("token", "ippoan/foo", "v9.9.9"),
    ).rejects.toThrow(/Tag .* not present/);
  });

  it("rejects disallowed orgs", async () => {
    await expect(
      computeReleaseAlert("token", "evil-org/foo"),
    ).rejects.toThrow(/Org not allowed/);
  });

  it("falls back to commit walk when no previous tag exists (first release)", async () => {
    // Stub `/commits` (the first-release branch) instead of /compare.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const u = new URL(url);
      const path = u.pathname;
      if (path.endsWith("/tags")) return Response.json([{ name: "v1.0.0" }]);
      if (path.endsWith("/commits")) {
        return Response.json([{ commit: { message: "feat: bootstrap\nRefs #1" } }]);
      }
      const issueMatch = path.match(/\/issues\/(\d+)$/);
      if (issueMatch) return Response.json(openIssue(Number(issueMatch[1])));
      return new Response("unstubbed", { status: 500 });
    });
    const result = await computeReleaseAlert("token", "ippoan/foo");
    expect(result?.openIssues.map((i) => i.number)).toEqual([1]);
  });

  it("filters out PR records that share issue numbers", async () => {
    stubGithub({
      tags: [{ name: "v1.1.0" }, { name: "v1.0.0" }],
      compare: {
        "v1.0.0...v1.1.0": {
          commits: [{ commit: { message: "fix: x\nRefs #50\nRefs #51" } }],
        },
      },
      issues: {
        50: openIssue(50),
        // #51 is actually a PR (carries pull_request discriminator) — must be dropped
        51: { ...openIssue(51), pull_request: { url: "x" } },
      },
    });
    const result = await computeReleaseAlert("token", "ippoan/foo");
    expect(result?.openIssues.map((i) => i.number)).toEqual([50]);
  });
});

describe("recomputeAlert", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("delegates to computeReleaseAlert with explicit tag", async () => {
    stubGithub({
      tags: [{ name: "v1.1.0" }, { name: "v1.0.0" }],
      compare: {
        "v1.0.0...v1.1.0": {
          commits: [{ commit: { message: "fix\nRefs #7" } }],
        },
      },
      issues: { 7: openIssue(7) },
    });
    const fresh = await recomputeAlert("token", "ippoan/foo", "v1.1.0");
    expect(fresh?.tag).toBe("v1.1.0");
    expect(fresh?.openIssues[0]?.number).toBe(7);
  });

  it("returns null when the previously-tracked issues are now all closed", async () => {
    stubGithub({
      tags: [{ name: "v1.1.0" }, { name: "v1.0.0" }],
      compare: {
        "v1.0.0...v1.1.0": {
          commits: [{ commit: { message: "fix\nRefs #7" } }],
        },
      },
      issues: { 7: closedIssue(7) },
    });
    const fresh = await recomputeAlert("token", "ippoan/foo", "v1.1.0");
    expect(fresh).toBeNull();
  });
});
