/**
 * Phase 3c の MCP tools (`registerReleaseWaveTools`) を、fake McpServer +
 * fake DO stub で薄くテストする。
 *
 * 深い state machine / DO 挙動は state.test.ts / do.test.ts で検証済みなので
 * 本テストの目的は wiring 確認だけ:
 *  - 各 tool が想定の DO method を呼ぶ
 *  - input 引数が DO RPC に正しく渡る
 *  - DO 戻り値が MCP response 形式 (`content[].text` JSON / `isError`) に
 *    そのまま map される
 */

import { describe, it, expect, vi } from "vitest";
import { registerReleaseWaveTools } from "../../src/mcp/tools/release-wave";
import type { Env } from "../../src/index";
import type { ReleaseWaveHub } from "../../src/release-wave/do";

// ----------------------------------------------------------------------------
// Fake McpServer: registerTool だけを capture する。
// ----------------------------------------------------------------------------

type ToolHandler = (
  input: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

interface RegisteredTool {
  name: string;
  config: { description?: string; inputSchema?: unknown };
  handler: ToolHandler;
}

function fakeMcpServer(): {
  registerTool: (
    name: string,
    config: RegisteredTool["config"],
    handler: ToolHandler,
  ) => void;
  tools: Map<string, RegisteredTool>;
} {
  const tools = new Map<string, RegisteredTool>();
  return {
    registerTool(name, config, handler) {
      tools.set(name, { name, config, handler });
    },
    tools,
  };
}

// ----------------------------------------------------------------------------
// Fake env + DO stub
// ----------------------------------------------------------------------------

/** ReleaseWaveHub の各 RPC method を vitest spy で差し替えた fake stub。 */
function fakeHub(): {
  hub: ReleaseWaveHub;
  spies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const spies = {
    start: vi.fn(),
    stageReport: vi.fn(),
    approve: vi.fn(),
    flipReport: vi.fn(),
    rollback: vi.fn(),
    abort: vi.fn(),
    fail: vi.fn(),
    contractApplied: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
  };
  return { hub: spies as unknown as ReleaseWaveHub, spies };
}

function fakeEnv(hub: ReleaseWaveHub): Env {
  const namespace = {
    idFromName: () => ({}),
    get: () => hub,
  } as unknown as DurableObjectNamespace;
  return {
    RELEASE_WAVE_HUB: namespace,
  } as unknown as Env;
}

// ----------------------------------------------------------------------------
// Helper: register + retrieve tool
// ----------------------------------------------------------------------------

function setup(): {
  tools: Map<string, RegisteredTool>;
  spies: ReturnType<typeof fakeHub>["spies"];
} {
  const { hub, spies } = fakeHub();
  const env = fakeEnv(hub);
  const server = fakeMcpServer();
  registerReleaseWaveTools(
    server as unknown as Parameters<typeof registerReleaseWaveTools>[0],
    env,
  );
  return { tools: server.tools, spies };
}

const STUB_OK = { ok: true, data: { wave_id: "w1", state: "staging" } } as const;
const STUB_ERR = {
  ok: false,
  code: "INVALID_TRANSITION" as const,
  error: "boom",
};

// ----------------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------------

describe("registerReleaseWaveTools registration", () => {
  it("registers exactly 8 tools with expected names", () => {
    const { tools } = setup();
    expect(Array.from(tools.keys()).sort()).toEqual(
      [
        "release_wave_abort",
        "release_wave_approve",
        "release_wave_contract_applied",
        "release_wave_flip",
        "release_wave_rollback",
        "release_wave_stage",
        "release_wave_start",
        "release_wave_status",
      ].sort(),
    );
  });

  it("status tool is marked readOnly", () => {
    const { tools } = setup();
    const t = tools.get("release_wave_status")!;
    // McpServer types annotations as part of config; surface check
    expect(
      (t.config as { annotations?: { readOnlyHint?: boolean } }).annotations
        ?.readOnlyHint,
    ).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Wiring per tool
// ----------------------------------------------------------------------------

describe("release_wave_start", () => {
  it("calls hub.start with raw inputs and formats success", async () => {
    const { tools, spies } = setup();
    spies.start.mockResolvedValue(STUB_OK);
    const r = await tools.get("release_wave_start")!.handler({
      wave_id: "w1",
      flip_policy: "auto",
      note: "ship it",
      repos: [{ repo: "ippoan/a", target_tag: "v1.0.0", head_sha: "abc" }],
    });
    expect(spies.start).toHaveBeenCalledWith({
      wave_id: "w1",
      flip_policy: "auto",
      note: "ship it",
      repos: [{ repo: "ippoan/a", target_tag: "v1.0.0", head_sha: "abc" }],
    });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain('"wave_id"');
  });

  it("formats RpcError as isError + JSON code/error", async () => {
    const { tools, spies } = setup();
    spies.start.mockResolvedValue({
      ok: false,
      code: "WAVE_IN_PROGRESS",
      error: "another wave running",
    });
    const r = await tools.get("release_wave_start")!.handler({
      wave_id: "w2",
      flip_policy: "auto",
      repos: [{ repo: "ippoan/a", target_tag: "v1", head_sha: "x" }],
    });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.code).toBe("WAVE_IN_PROGRESS");
    expect(parsed.error).toContain("running");
  });

  it("defaults note to '' when omitted", async () => {
    const { tools, spies } = setup();
    spies.start.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_start")!.handler({
      wave_id: "w1",
      flip_policy: "auto",
      repos: [{ repo: "ippoan/a", target_tag: "v1", head_sha: "x" }],
    });
    expect(spies.start).toHaveBeenCalledWith(
      expect.objectContaining({ note: "" }),
    );
  });
});

describe("release_wave_stage", () => {
  it("passes optional fields through, nullifying when missing", async () => {
    const { tools, spies } = setup();
    spies.stageReport.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_stage")!.handler({
      wave_id: "w1",
      repo: "ippoan/a",
      ok: true,
    });
    expect(spies.stageReport).toHaveBeenCalledWith({
      wave_id: "w1",
      repo: "ippoan/a",
      ok: true,
      preview_url: null,
      flip_from_revision: null,
      error: null,
    });
  });

  it("passes explicit optional values", async () => {
    const { tools, spies } = setup();
    spies.stageReport.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_stage")!.handler({
      wave_id: "w1",
      repo: "ippoan/a",
      ok: false,
      error: "build failed",
    });
    expect(spies.stageReport).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "build failed" }),
    );
  });
});

describe("release_wave_status", () => {
  it("calls hub.get with wave_id", async () => {
    const { tools, spies } = setup();
    spies.get.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_status")!.handler({ wave_id: "w1" });
    expect(spies.get).toHaveBeenCalledWith("w1");
  });

  it("propagates NOT_FOUND as isError", async () => {
    const { tools, spies } = setup();
    spies.get.mockResolvedValue({
      ok: false,
      code: "NOT_FOUND",
      error: "no such wave",
    });
    const r = await tools.get("release_wave_status")!.handler({
      wave_id: "ghost",
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).code).toBe("NOT_FOUND");
  });
});

describe("release_wave_approve", () => {
  it("forwards approved_by", async () => {
    const { tools, spies } = setup();
    spies.approve.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_approve")!.handler({
      wave_id: "w1",
      approved_by: "ops@example.com",
    });
    expect(spies.approve).toHaveBeenCalledWith({
      wave_id: "w1",
      approved_by: "ops@example.com",
    });
  });
});

describe("release_wave_flip", () => {
  it("calls flipReport (= per-repo flip callback, not operator override)", async () => {
    const { tools, spies } = setup();
    spies.flipReport.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_flip")!.handler({
      wave_id: "w1",
      repo: "ippoan/a",
      ok: true,
    });
    expect(spies.flipReport).toHaveBeenCalledWith({
      wave_id: "w1",
      repo: "ippoan/a",
      ok: true,
      error: null,
    });
  });
});

describe("release_wave_rollback", () => {
  it("defaults force to false", async () => {
    const { tools, spies } = setup();
    spies.rollback.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_rollback")!.handler({
      wave_id: "w1",
      rolled_back_by: "ops",
    });
    expect(spies.rollback).toHaveBeenCalledWith({
      wave_id: "w1",
      rolled_back_by: "ops",
      force: false,
    });
  });

  it("passes force=true when provided", async () => {
    const { tools, spies } = setup();
    spies.rollback.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_rollback")!.handler({
      wave_id: "w1",
      rolled_back_by: "ops",
      force: true,
    });
    expect(spies.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("propagates ROLLBACK_UNSAFE as isError", async () => {
    const { tools, spies } = setup();
    spies.rollback.mockResolvedValue({
      ok: false,
      code: "ROLLBACK_UNSAFE",
      error: "contract migration applied",
    });
    const r = await tools.get("release_wave_rollback")!.handler({
      wave_id: "w1",
      rolled_back_by: "ops",
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).code).toBe("ROLLBACK_UNSAFE");
  });
});

describe("release_wave_abort", () => {
  it("forwards aborted_by + reason", async () => {
    const { tools, spies } = setup();
    spies.abort.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_abort")!.handler({
      wave_id: "w1",
      aborted_by: "ops",
      reason: "smoke broken",
    });
    expect(spies.abort).toHaveBeenCalledWith({
      wave_id: "w1",
      aborted_by: "ops",
      reason: "smoke broken",
    });
  });
});

describe("release_wave_contract_applied", () => {
  it("forwards repo + migration_id", async () => {
    const { tools, spies } = setup();
    spies.contractApplied.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_contract_applied")!.handler({
      wave_id: "w1",
      repo: "ippoan/rust-alc-api",
      migration_id: "20260601_001_drop",
    });
    expect(spies.contractApplied).toHaveBeenCalledWith({
      wave_id: "w1",
      repo: "ippoan/rust-alc-api",
      migration_id: "20260601_001_drop",
    });
  });
});

// ----------------------------------------------------------------------------
// Generic error path (1 経路で代表)
// ----------------------------------------------------------------------------

describe("error formatting", () => {
  it("isError true when DO returns ok=false (regardless of code)", async () => {
    const { tools, spies } = setup();
    spies.abort.mockResolvedValue(STUB_ERR);
    const r = await tools.get("release_wave_abort")!.handler({
      wave_id: "w1",
      aborted_by: "ops",
      reason: "test",
    });
    expect(r.isError).toBe(true);
  });
});
