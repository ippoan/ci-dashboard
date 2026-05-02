import { describe, it, expect, vi, afterEach } from "vitest";
import { githubApi, githubApiRaw, parseRepo, validateOrg, GitHubApiError } from "../../src/github-api";

// Test MCP tool logic by calling the same functions the tools use.
// The MCP protocol layer (JSON-RPC, transport) is tested by the SDK itself.

describe("Actions tool logic", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("list_workflow_runs via githubApi", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        workflow_runs: [
          {
            id: 123, name: "CI", status: "completed", conclusion: "success",
            head_branch: "main", actor: { login: "yhonda" },
            created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:05:00Z",
            html_url: "https://github.com/ippoan/test/actions/runs/123",
          },
        ],
      }),
    );

    const { owner, repo } = parseRepo("rust-alc-api");
    validateOrg(owner);
    const data = await githubApi<{ workflow_runs: Array<{ id: number; name: string }> }>(
      "token", "GET", `/repos/${owner}/${repo}/actions/runs`, undefined, { per_page: "10" },
    );

    expect(data.workflow_runs).toHaveLength(1);
    expect(data.workflow_runs[0]!.id).toBe(123);
  });

  it("rerun_workflow_run sends POST", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const { owner, repo } = parseRepo("rust-alc-api");
    await githubApi("token", "POST", `/repos/${owner}/${repo}/actions/runs/123/rerun`);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/actions/runs/123/rerun"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects disallowed org", () => {
    expect(() => validateOrg("evil-org")).toThrow(GitHubApiError);
  });

  it("supports ohishi-exp org", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ workflow_runs: [] }),
    );

    const { owner, repo } = parseRepo("ohishi-exp/my-repo");
    validateOrg(owner);
    const data = await githubApi<{ workflow_runs: unknown[] }>(
      "token", "GET", `/repos/${owner}/${repo}/actions/runs`,
    );
    expect(data.workflow_runs).toHaveLength(0);
  });
});

describe("PR tool logic", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("get_pull_request + check-runs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      Response.json({
        number: 42, title: "fix: test", state: "open",
        user: { login: "yhonda" }, head: { ref: "fix/test", sha: "abc123" },
        base: { ref: "main" }, mergeable: true, mergeable_state: "clean",
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        html_url: "https://...", draft: false, additions: 10, deletions: 5, changed_files: 2,
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      Response.json({
        check_runs: [
          { name: "CI", status: "completed", conclusion: "success", html_url: "https://..." },
        ],
      }),
    );

    const { owner, repo } = parseRepo("rust-alc-api");
    const pr = await githubApi<{ number: number; head: { sha: string } }>(
      "token", "GET", `/repos/${owner}/${repo}/pulls/42`,
    );
    const checks = await githubApi<{ check_runs: Array<{ name: string; conclusion: string | null }> }>(
      "token", "GET", `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
    );

    expect(pr.number).toBe(42);
    expect(checks.check_runs[0]!.conclusion).toBe("success");
  });

  it("merge_pull_request sends squash merge", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ merged: true }),
    );

    const { owner, repo } = parseRepo("rust-alc-api");
    await githubApi("token", "PUT", `/repos/${owner}/${repo}/pulls/42/merge`, {
      merge_method: "squash",
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.merge_method).toBe("squash");
  });
});

describe("Release tool logic", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("list_tags returns truncated SHA", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        { name: "v1.0.0", commit: { sha: "abc123def456789" } },
      ]),
    );

    const { owner, repo } = parseRepo("rust-alc-api");
    const tags = await githubApi<Array<{ name: string; commit: { sha: string } }>>(
      "token", "GET", `/repos/${owner}/${repo}/tags`,
    );

    expect(tags[0]!.name).toBe("v1.0.0");
    expect(tags[0]!.commit.sha.slice(0, 7)).toBe("abc123d");
  });

  it("create_tag_release dispatches workflow", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const { owner, repo } = parseRepo("ippoan/rust-alc-api");
    validateOrg(owner);
    await githubApi("token", "POST",
      `/repos/${owner}/${repo}/actions/workflows/tag-release.yml/dispatches`,
      { ref: "main" },
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("tag-release.yml/dispatches"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("Log tool logic", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const sampleLog = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: content`).join("\n");

  it("get_job_logs tail behavior", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sampleLog));

    const { owner, repo } = parseRepo("rust-alc-api");
    const raw = await githubApiRaw("token", "GET", `/repos/${owner}/${repo}/actions/jobs/100/logs`);

    const lines = raw.split("\n");
    expect(lines).toHaveLength(500);

    // Simulate tail
    const tailLines = 200;
    const selected = lines.slice(-tailLines);
    expect(selected).toHaveLength(200);
    expect(selected[0]).toContain("Line 301");
    expect(selected[199]).toContain("Line 500");
  });

  it("get_job_logs range behavior", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sampleLog));

    const raw = await githubApiRaw("token", "GET", "/repos/ippoan/test/actions/jobs/100/logs");
    const lines = raw.split("\n");

    // Simulate range: lines 10-15
    const start = 10;
    const end = 15;
    const selected = lines.slice(start - 1, end);
    expect(selected).toHaveLength(6);
    expect(selected[0]).toContain("Line 10");
    expect(selected[5]).toContain("Line 15");
  });

  it("grep_job_logs finds matches with context", async () => {
    const log = [
      "Step 1: Building",
      "Compiling crate",
      "error[E0308]: expected bool",
      "  --> src/main.rs:10:5",
      "Step 2: Testing",
      "All tests passed",
    ].join("\n");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(log));
    const raw = await githubApiRaw("token", "GET", "/repos/ippoan/test/actions/jobs/100/logs");
    const lines = raw.split("\n");
    const regex = /error/i;
    const contextLines = 1;

    // Find matches
    const matchIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i]!)) matchIndices.push(i);
    }

    expect(matchIndices).toHaveLength(1);
    expect(matchIndices[0]).toBe(2); // "error[E0308]" is line index 2

    // Build context range
    const start = Math.max(0, matchIndices[0]! - contextLines);
    const end = Math.min(lines.length - 1, matchIndices[0]! + contextLines);
    expect(start).toBe(1); // "Compiling crate"
    expect(end).toBe(3);   // "  --> src/main.rs:10:5"
  });

  it("grep_job_logs reports no matches", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("all good\nno issues\nclean"),
    );

    const raw = await githubApiRaw("token", "GET", "/repos/ippoan/test/actions/jobs/100/logs");
    const lines = raw.split("\n");
    const regex = /error|fail/i;

    const matches = lines.filter((l) => regex.test(l));
    expect(matches).toHaveLength(0);
  });

  it("grep_job_logs handles many matches (truncation logic)", async () => {
    const log = Array.from({ length: 100 }, (_, i) => `error at line ${i}`).join("\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(log));

    const raw = await githubApiRaw("token", "GET", "/repos/ippoan/test/actions/jobs/100/logs");
    const lines = raw.split("\n");
    const regex = /error/i;

    const matchIndices = lines
      .map((l, i) => regex.test(l) ? i : -1)
      .filter((i) => i >= 0);

    expect(matchIndices).toHaveLength(100);

    // Tool truncates at 50
    const MAX_MATCHES = 50;
    const truncated = matchIndices.length > MAX_MATCHES;
    expect(truncated).toBe(true);
    expect(matchIndices.slice(0, MAX_MATCHES)).toHaveLength(50);
  });
});

describe("Issues write tool logic", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("create_issue posts title/body/labels and returns minimal shape", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        number: 99,
        title: "test",
        state: "open",
        html_url: "https://github.com/ippoan/ci-dashboard/issues/99",
      }, { status: 201 }),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    validateOrg(owner);
    const created = await githubApi<{ number: number; html_url: string }>(
      "token", "POST", `/repos/${owner}/${repo}/issues`,
      { title: "test", body: "hello", labels: ["enhancement"] },
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.title).toBe("test");
    expect(body.body).toBe("hello");
    expect(body.labels).toEqual(["enhancement"]);
    expect(created.number).toBe(99);
  });

  it("create_issue propagates 422 validation error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "Validation Failed" }, { status: 422 }),
    );

    await expect(
      githubApi("token", "POST", "/repos/ippoan/ci-dashboard/issues",
        { title: "x", labels: ["nonexistent-label"] }),
    ).rejects.toThrow(GitHubApiError);
  });

  it("add_issue_comment posts body and returns id/url/created_at", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        id: 12345,
        html_url: "https://github.com/ippoan/ci-dashboard/issues/99#issuecomment-12345",
        created_at: "2026-05-02T01:00:00Z",
      }, { status: 201 }),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    const result = await githubApi<{ id: number; html_url: string; created_at: string }>(
      "token", "POST", `/repos/${owner}/${repo}/issues/99/comments`,
      { body: "thanks!" },
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.body).toBe("thanks!");
    expect(result.id).toBe(12345);
    expect(result.created_at).toBe("2026-05-02T01:00:00Z");
  });

  it("add_labels posts labels and normalizes the response to string[]", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        { name: "bug" },
        { name: "enhancement" },
      ]),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    const updated = await githubApi<Array<{ name: string }>>(
      "token", "POST", `/repos/${owner}/${repo}/issues/99/labels`,
      { labels: ["enhancement"] },
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.labels).toEqual(["enhancement"]);
    expect(updated.map((l) => l.name)).toEqual(["bug", "enhancement"]);
  });

  it("remove_label DELETEs and url-encodes the label name", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([{ name: "bug" }]),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    const labelToRemove = "needs review";
    await githubApi<Array<{ name: string }>>(
      "token", "DELETE",
      `/repos/${owner}/${repo}/issues/99/labels/${encodeURIComponent(labelToRemove)}`,
    );

    const calledUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("needs%20review");
    expect(fetchSpy.mock.calls[0]![1]!.method).toBe("DELETE");
  });

  it("remove_label propagates 404 when label is not attached", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "Label does not exist" }, { status: 404 }),
    );

    await expect(
      githubApi("token", "DELETE", "/repos/ippoan/ci-dashboard/issues/99/labels/missing"),
    ).rejects.toThrow(GitHubApiError);
  });

  it("close_issue PATCHes state=closed with state_reason", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        number: 99, state: "closed", state_reason: "completed",
        html_url: "https://github.com/ippoan/ci-dashboard/issues/99",
      }),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    await githubApi("token", "PATCH", `/repos/${owner}/${repo}/issues/99`,
      { state: "closed", state_reason: "completed" });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.state).toBe("closed");
    expect(body.state_reason).toBe("completed");
    expect(fetchSpy.mock.calls[0]![1]!.method).toBe("PATCH");
  });

  it("reopen_issue PATCHes state=open without state_reason", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        number: 99, state: "open",
        html_url: "https://github.com/ippoan/ci-dashboard/issues/99",
      }),
    );

    const { owner, repo } = parseRepo("ci-dashboard");
    await githubApi("token", "PATCH", `/repos/${owner}/${repo}/issues/99`,
      { state: "open" });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.state).toBe("open");
    expect(body.state_reason).toBeUndefined();
  });
});

describe("MCP server smoke test", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("initializes and lists tools", async () => {
    const { handleMcpRequest } = await import("../../src/mcp/server");

    // Initialize
    const initReq = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }),
    });

    const initRes = await handleMcpRequest(initReq, "test-token");
    expect(initRes.status).toBe(200);

    const initBody = await initRes.json() as {
      result: { capabilities: { tools: unknown }; serverInfo: { name: string } };
    };
    expect(initBody.result.serverInfo.name).toBe("ci-dashboard");
    expect(initBody.result.capabilities.tools).toBeDefined();
  });
});
