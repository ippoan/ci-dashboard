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

// binding_jwt middleware 導入 (Refs #498) 後、tool 登録時に scope 集合が要る。
// 本テストは wiring 検証が目的で scope gate 自体は scoped-tool.test.ts の
// 責務なので、常に全 scope を渡して gate を無効化する。
const ALL_SCOPES: ReadonlySet<string> = new Set([
  "mcp.read",
  "mcp.write",
  "mcp.workflow",
  "mcp.project",
]);

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

/** 空の COMPAT_KV stub (frontend:: / backend:: いずれも空)。 */
function emptyCompatKv(): KVNamespace {
  return {
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace;
}

function fakeEnv(hub: ReleaseWaveHub, compatKv?: KVNamespace): Env {
  const namespace = {
    idFromName: () => ({}),
    get: () => hub,
  } as unknown as DurableObjectNamespace;
  return {
    RELEASE_WAVE_HUB: namespace,
    COMPAT_KV: compatKv ?? emptyCompatKv(),
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
    ALL_SCOPES,
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
  it("registers exactly 10 tools with expected names", () => {
    const { tools } = setup();
    expect(Array.from(tools.keys()).sort()).toEqual(
      [
        "release_wave_abort",
        "release_wave_approve",
        "release_wave_contract_applied",
        "release_wave_fail",
        "release_wave_flip",
        "release_wave_pending_flip",
        "release_wave_pending_flip_all",
        "release_wave_pending_state",
        "release_wave_rollback",
        "release_wave_status",
      ].sort(),
    );
  });

  it("pending_state tool is marked readOnly", () => {
    const { tools } = setup();
    const t = tools.get("release_wave_pending_state")!;
    expect(
      (t.config as { annotations?: { readOnlyHint?: boolean } }).annotations
        ?.readOnlyHint,
    ).toBe(true);
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

  it("includes a compatibility field for an ok result", async () => {
    const { hub, spies } = fakeHub();
    spies.get.mockResolvedValue({
      ok: true,
      data: {
        wave_id: "w1",
        state: "staging",
        repos: [{ repo: "ippoan/rust-alc-api" }],
      },
    });
    const server = fakeMcpServer();
    registerReleaseWaveTools(
      server as unknown as Parameters<typeof registerReleaseWaveTools>[0],
      fakeEnv(hub),
      ALL_SCOPES,
    );
    const r = await server.tools
      .get("release_wave_status")!
      .handler({ wave_id: "w1" });
    const payload = JSON.parse(r.content[0]!.text);
    expect(payload.compatibility).toBeDefined();
    expect(payload.compatibility.backends).toEqual([]);
    expect(payload.compatibility.checked).toBe(false);
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
      force: false,
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

describe("release_wave_fail", () => {
  it("forwards wave_id + reason to hub.fail", async () => {
    const { tools, spies } = setup();
    spies.fail.mockResolvedValue(STUB_OK);
    await tools.get("release_wave_fail")!.handler({
      wave_id: "w1",
      reason: "stuck in flipping",
    });
    expect(spies.fail).toHaveBeenCalledWith({
      wave_id: "w1",
      reason: "stuck in flipping",
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

// pending flip 系は DO RPC ではなく COMPAT_KV + dispatch を直接叩く
// (= /release-wave の Flip / Flip all ボタンと同じ core)。fakeEnv は
// emptyCompatKv なので、ここでは「pending 無し」経路の wiring だけを見る。
// 実 dispatch を伴う成功経路は api.test.ts の handler test がカバーする。
describe("release_wave_pending_flip", () => {
  it("returns NOT_FOUND (isError) when the repo has no pending release", async () => {
    const { tools } = setup();
    const r = await tools
      .get("release_wave_pending_flip")!
      .handler({ repo: "ippoan/no-such" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).code).toBe("NOT_FOUND");
  });
});

describe("release_wave_pending_flip_all", () => {
  it("is a no-op (ok, flipped:[]) when nothing is pending", async () => {
    const { tools } = setup();
    const r = await tools
      .get("release_wave_pending_flip_all")!
      .handler({ flipped_by: "ops@example.com" });
    expect(r.isError).toBeUndefined();
    const payload = JSON.parse(r.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.flipped).toEqual([]);
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
