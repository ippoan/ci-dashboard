import { appTestEnv } from "./_helpers/app-env";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  computeReleaseAlert,
  recomputeAlert,
  computeReleaseAlertForPr,
} from "../src/release-alert";

// `computeReleaseAlert` fans out to several GitHub endpoints; we stub
// globalThis.fetch and route by URL. Each test sets up a fixture map so the
// assertions read like a script of "given these tags / commits / issues,
// expect this alert payload".

interface Fixture {
  tags?: Array<{ name: string }>;
  compare?: Record<string, { commits: Array<{ commit: { message: string } }> }>;
  pulls?: Record<number, { head: { ref: string }; body: string | null }>;
  // For PR-merge alert tests: /pulls/<n>/commits returns this array.
  prCommits?: Record<number, Array<{ commit: { message: string } }>>;
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
    const prCommitsMatch = path.match(/\/pulls\/(\d+)\/commits$/);
    if (prCommitsMatch) {
      const n = Number(prCommitsMatch[1]);
      return Response.json(fx.prCommits?.[n] ?? []);
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
    const result = await computeReleaseAlert(appTestEnv(), "ippoan/foo");
    expect(result).toBeNull();
  });

  it("returns null when the latest tag's commits reference no issues", async () => {
    stubGithub({
      tags: [{ name: "v1.1.0" }, { name: "v1.0.0" }],
      compare: {
        "v1.0.0...v1.1.0": { commits: [{ commit: { message: "feat: noop" } }] },
      },
    });
    const result = await computeReleaseAlert(appTestEnv(), "ippoan/foo");
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
    const result = await computeReleaseAlert(appTestEnv(), "ippoan/foo");
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
    const result = await computeReleaseAlert(appTestEnv(), "ippoan/foo");
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
    const result = await computeReleaseAlert(appTestEnv(), "ippoan/foo", "v1.2.0");
    expect(result?.tag).toBe("v1.2.0");
    expect(result?.openIssues[0]?.number).toBe(99);
  });

  it("throws on unknown tag override", async () => {
    stubGithub({
      tags: [{ name: "v1.0.0" }],
    });
    await expect(
      computeReleaseAlert(appTestEnv(), "ippoan/foo", "v9.9.9"),
    ).rejects.toThrow(/Tag .* not present/);
  });

  it("rejects disallowed orgs", async () => {
    await expect(
      computeReleaseAlert(appTestEnv(), "evil-org/foo"),
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
    const result = await computeReleaseAlert(appTestEnv(), "ippoan/foo");
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
    const result = await computeReleaseAlert(appTestEnv(), "ippoan/foo");
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
    const fresh = await recomputeAlert(appTestEnv(), "ippoan/foo", "v1.1.0");
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
    const fresh = await recomputeAlert(appTestEnv(), "ippoan/foo", "v1.1.0");
    expect(fresh).toBeNull();
  });
});

describe("computeReleaseAlertForPr", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("collects Refs from PR body, branch name, and commits", async () => {
    stubGithub({
      pulls: {
        42: {
          head: { ref: "10-fix-thing" },
          body: "Resolves the bug.\n\nRefs #20\nRefs #21",
        },
      },
      prCommits: {
        42: [
          { commit: { message: "fix: x\nRefs #30" } },
          { commit: { message: "test: y" } },
        ],
      },
      issues: {
        10: openIssue(10, "branch issue"),
        20: openIssue(20, "body ref one"),
        21: closedIssue(21, "already closed"),
        30: openIssue(30, "commit ref"),
      },
    });
    const result = await computeReleaseAlertForPr(
      appTestEnv(), "ippoan/secrets-inventory-gcp", 42, "deadbeef12345", "main",
    );
    expect(result).not.toBeNull();
    expect(result!.repo).toBe("ippoan/secrets-inventory-gcp");
    expect(result!.tag).toBe("main@deadbee");
    expect(result!.prNumber).toBe(42);
    expect(result!.prevTag).toBeNull();
    // 10 (branch) + 20 (body) + 30 (commit). 21 closed → dropped.
    expect(result!.openIssues.map((i) => i.number)).toEqual([10, 20, 30]);
  });

  it("returns null when the PR references no issues", async () => {
    stubGithub({
      pulls: { 1: { head: { ref: "feat-no-prefix" }, body: "no refs" } },
      prCommits: { 1: [{ commit: { message: "feat: thing" } }] },
    });
    const result = await computeReleaseAlertForPr(
      appTestEnv(), "ippoan/foo", 1, "abc1234", "main",
    );
    expect(result).toBeNull();
  });

  it("returns null when every referenced issue is closed", async () => {
    stubGithub({
      pulls: { 2: { head: { ref: "5-fix-x" }, body: null } },
      prCommits: { 2: [{ commit: { message: "fix: x" } }] },
      issues: { 5: closedIssue(5) },
    });
    const result = await computeReleaseAlertForPr(
      appTestEnv(), "ippoan/foo", 2, "abc1234", "main",
    );
    expect(result).toBeNull();
  });

  it("falls back to pr-<n> label when mergeSha is null", async () => {
    stubGithub({
      pulls: { 3: { head: { ref: "8-fix" }, body: null } },
      prCommits: { 3: [] },
      issues: { 8: openIssue(8) },
    });
    const result = await computeReleaseAlertForPr(
      appTestEnv(), "ippoan/foo", 3, null, "main",
    );
    expect(result?.tag).toBe("main@pr-3");
  });

  it("rejects disallowed orgs", async () => {
    await expect(
      computeReleaseAlertForPr(appTestEnv(), "evil-org/foo", 1, "abc", "main"),
    ).rejects.toThrow(/Org not allowed/);
  });

  it("drops PR records that share issue numbers", async () => {
    stubGithub({
      pulls: { 4: { head: { ref: "feat-thing" }, body: "Refs #50\nRefs #51" } },
      prCommits: { 4: [] },
      issues: {
        50: openIssue(50, "real issue"),
        51: { ...openIssue(51, "actually a pr"), pull_request: { url: "x" } },
      },
    });
    const result = await computeReleaseAlertForPr(
      appTestEnv(), "ippoan/foo", 4, "abc1234", "main",
    );
    expect(result?.openIssues.map((i) => i.number)).toEqual([50]);
  });
});
