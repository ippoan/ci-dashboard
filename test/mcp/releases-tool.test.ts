/**
 * `create_tag_release` (`registerReleasesTools`) を fake McpServer に登録して
 * handler を直接呼ぶ (Refs #517)。
 *
 * この tool はタグ = 本番への配信の引き金なので、GitHub へ送る body を
 * 文字単位で固定する:
 *  - `target` 省略時は従来どおり `{"ref":"main"}` ちょうど
 *  - `target` 指定時だけ `inputs` と `return_run_details` が付く
 *  - schema に無い引数 (`inputs` / `bump` 等) は body に漏れない
 *
 * scope gate (`createScopedRegisterTool`) と org の allowlist (`tokenForOrg` →
 * `validateOrg`) は実物を通す。token は setup が KV に seed した fake を
 * `appTestEnv()` 経由で読むので introspect への往復は起きない。`fetch` は全て
 * spy で差し替え、実物の GitHub へは出さない。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitHubApiError } from "../../src/github-api";
import { registerReleasesTools } from "../../src/mcp/tools/releases";
import { appTestEnv } from "../_helpers/app-env";

const ALL_SCOPES: ReadonlySet<string> = new Set([
  "mcp.read",
  "mcp.write",
  "mcp.workflow",
  "mcp.project",
]);

const REPO = "ippoan/rust-alc-api";
const DISPATCH_URL =
  "https://api.github.com/repos/ippoan/rust-alc-api/actions/workflows/tag-release.yml/dispatches";
const RUN_URL = "https://github.com/ippoan/rust-alc-api/actions/runs/1";

// ----------------------------------------------------------------------------
// Fake McpServer: registerTool だけを capture する (zod は通さない)。
// ----------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

interface RegisteredTool {
  config: { description?: string; inputSchema?: z.ZodRawShape };
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
}

function setup(scopes: ReadonlySet<string> = ALL_SCOPES): RegisteredTool {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) {
      tools.set(name, { config, handler });
    },
  };
  registerReleasesTools(
    server as unknown as McpServer,
    appTestEnv(),
    scopes,
  );
  return tools.get("create_tag_release")!;
}

function spyFetch(response: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
}

const noContent = () => new Response(null, { status: 204 });

/** fetch に渡った body (文字列) を取り出す。 */
function sentBody(fetchSpy: ReturnType<typeof spyFetch>): string {
  const init = fetchSpy.mock.calls[0]![1] as RequestInit;
  return init.body as string;
}

describe("create_tag_release", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("T1: target 省略時の body は {\"ref\":\"main\"} ちょうど", async () => {
    const fetchSpy = spyFetch(noContent);
    const tool = setup();

    const result = await tool.handler({ repo: REPO });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(DISPATCH_URL);
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    expect(sentBody(fetchSpy)).toBe('{"ref":"main"}');
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text.split("\n")).toEqual([
      "tag-release dispatched for ippoan/rust-alc-api",
      "inputs: none (the workflow's own default applies; e.g. ippoan/rust-alc-api defaults to target=backend = monolith v* tag)",
    ]);
  });

  it("T2: target 指定時は inputs と return_run_details を付ける", async () => {
    const fetchSpy = spyFetch(noContent);
    const tool = setup();

    const result = await tool.handler({ repo: REPO, target: "worker-vein" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sentBody(fetchSpy))).toEqual({
      ref: "main",
      inputs: { target: "worker-vein" },
      return_run_details: true,
    });
    expect(result.content[0]!.text.split("\n")).toEqual([
      "tag-release dispatched for ippoan/rust-alc-api",
      "inputs: target=worker-vein",
    ]);
  });

  it("T3: 形に合わない target は zod が弾く", () => {
    const schema = z.object(setup().config.inputSchema!);

    for (const target of ["Worker Vein", "a;b", "a".repeat(41), ""]) {
      expect(schema.safeParse({ repo: REPO, target }).success, target).toBe(false);
    }
  });

  it("T4: schema に無い引数 (inputs / bump) は body に漏れない", async () => {
    const fetchSpy = spyFetch(noContent);
    const tool = setup();

    await tool.handler({
      repo: REPO,
      target: "worker-vein",
      inputs: { x: "y" },
      bump: "major",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchSpy)).not.toContain('"x"');
    expect(sentBody(fetchSpy)).not.toContain("bump");
    expect(JSON.parse(sentBody(fetchSpy))).toEqual({
      ref: "main",
      inputs: { target: "worker-vein" },
      return_run_details: true,
    });
  });

  it("T5: 422 は isError の結果にして返す (target 指定時)", async () => {
    const ghBody = '{"message":"Unexpected inputs provided: [\\"target\\"]","status":"422"}';
    const fetchSpy = spyFetch(() => new Response(ghBody, { status: 422 }));
    const tool = setup();

    const result = await tool.handler({ repo: REPO, target: "worker-vein" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("(422)");
    expect(text).toContain("The workflow was NOT started.");
    expect(text).toContain(ghBody);
    expect(text).toContain("inputs: target=worker-vein");
    expect(text).toContain("may not declare a `target` input");
  });

  it("T5: 422 でも target 省略時は target の注記を付けない", async () => {
    const ghBody = '{"message":"Workflow does not have \'workflow_dispatch\' trigger","status":"422"}';
    const fetchSpy = spyFetch(() => new Response(ghBody, { status: 422 }));
    const tool = setup();

    const result = await tool.handler({ repo: REPO });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchSpy)).toBe('{"ref":"main"}');
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("The workflow was NOT started.");
    expect(text).toContain(ghBody);
    expect(text).not.toContain("target");
  });

  it("T6: mcp.workflow が無ければ forbidden で fetch しない", async () => {
    const fetchSpy = spyFetch(noContent);
    const tool = setup(new Set(["mcp.read", "mcp.write"]));

    const result = await tool.handler({ repo: REPO, target: "worker-vein" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      'forbidden: tool "create_tag_release" requires scope "mcp.workflow"',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("T7: 200 で html_url が返れば run: の行を足す", async () => {
    spyFetch(() => Response.json({ workflow_run_id: 1, html_url: RUN_URL }));
    const tool = setup();

    const result = await tool.handler({ repo: REPO, target: "worker-vein" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text.split("\n")).toEqual([
      "tag-release dispatched for ippoan/rust-alc-api",
      "inputs: target=worker-vein",
      `run: ${RUN_URL}`,
    ]);
  });

  it("T7: 204 なら run: の行は無い", async () => {
    spyFetch(noContent);
    const tool = setup();

    const result = await tool.handler({ repo: REPO, target: "worker-vein" });

    expect(result.content[0]!.text).not.toContain("run:");
  });

  it("T8: allowlist 外の org は拒否して fetch しない", async () => {
    const fetchSpy = spyFetch(noContent);
    const tool = setup();

    await expect(
      tool.handler({ repo: "someone-else/x", target: "worker-vein" }),
    ).rejects.toThrow("Org not allowed: someone-else");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([403, 404])("T10: %i は isError に丸めず throw する", async (status) => {
    const fetchSpy = spyFetch(() => new Response('{"message":"nope"}', { status }));
    const tool = setup();

    const err = await tool.handler({ repo: REPO, target: "worker-vein" }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(status);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("T11: backend / worker-vein / 省略は zod を通る", () => {
    const schema = z.object(setup().config.inputSchema!);

    expect(schema.safeParse({ repo: REPO, target: "backend" }).success).toBe(true);
    expect(schema.safeParse({ repo: REPO, target: "worker-vein" }).success).toBe(true);
    expect(schema.safeParse({ repo: REPO }).success).toBe(true);
  });
});
