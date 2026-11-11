/**
 * Release Wave の MCP App ビュー (src/mcp/apps/release-wave-view.ts) の wiring。
 *
 * - ui:// リソースが MCP Apps の mimeType + CSP で登録される
 * - status / pending_state が `_meta.ui.resourceUri` でビューを指す
 * - ビューが読む structuredContent が text と同じ中身で返る
 *
 * ビュー自体の描画・ボタン操作は ext-apps の AppBridge を使ったテスト用ホストで
 * 手元確認している (Chrome + sandbox iframe + CSP)。
 */

import { describe, it, expect, vi } from "vitest";
import {
  registerReleaseWaveView,
  releaseWaveViewHtml,
  RELEASE_WAVE_VIEW_URI,
  MCP_APP_MIME_TYPE,
  EXT_APPS_VERSION,
} from "../../src/mcp/apps/release-wave-view";
import { registerReleaseWaveTools } from "../../src/mcp/tools/release-wave";
import type { Env } from "../../src/index";
import type { ReleaseWaveHub } from "../../src/release-wave/do";

const ALL_SCOPES: ReadonlySet<string> = new Set([
  "mcp.read",
  "mcp.write",
  "mcp.workflow",
  "mcp.project",
]);

type Handler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function fakeServer() {
  const tools = new Map<string, { config: { _meta?: { ui?: { resourceUri?: string } } }; handler: Handler }>();
  const resources = new Map<
    string,
    { name: string; config: { mimeType?: string }; read: () => Promise<{ contents: Array<Record<string, unknown>> }> }
  >();
  return {
    registerTool(name: string, config: Record<string, unknown>, handler: Handler) {
      tools.set(name, { config: config as never, handler });
    },
    registerResource(
      name: string,
      uri: string,
      config: { mimeType?: string },
      read: () => Promise<{ contents: Array<Record<string, unknown>> }>,
    ) {
      resources.set(uri, { name, config, read });
    },
    tools,
    resources,
  };
}

describe("registerReleaseWaveView", () => {
  it("registers the ui:// resource as an MCP App with a jsDelivr-only CSP", async () => {
    const s = fakeServer();
    registerReleaseWaveView(s as never);
    const r = s.resources.get(RELEASE_WAVE_VIEW_URI)!;
    expect(r.config.mimeType).toBe(MCP_APP_MIME_TYPE);
    const { contents } = await r.read();
    const c = contents[0] as {
      uri: string;
      mimeType: string;
      text: string;
      _meta: { ui: { csp: { resourceDomains: string[] } } };
    };
    expect(c.uri).toBe(RELEASE_WAVE_VIEW_URI);
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c._meta.ui.csp.resourceDomains).toEqual(["https://cdn.jsdelivr.net"]);
    expect(c.text).toContain(
      `https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps@${EXT_APPS_VERSION}/dist/src/app-with-deps.js`,
    );
  });

  it("view html has no leftover placeholder and calls the release_wave tools", () => {
    const html = releaseWaveViewHtml();
    expect(html).not.toContain("__EXT_APPS_URL__");
    for (const tool of [
      "release_wave_pending_state",
      "release_wave_pending_flip",
      "release_wave_pending_flip_all",
      "release_wave_status",
      "release_wave_approve",
      "release_wave_rollback",
      "release_wave_abort",
      "release_wave_fail",
    ]) {
      expect(html).toContain(`"${tool}"`);
    }
  });
});

describe("release_wave tools → view", () => {
  function setup(waveData: unknown) {
    const s = fakeServer();
    const hub = { get: vi.fn().mockResolvedValue({ ok: true, data: waveData }) } as unknown as ReleaseWaveHub;
    const env = {
      RELEASE_WAVE_HUB: {
        idFromName: () => ({}),
        get: () => hub,
      },
    } as unknown as Env;
    registerReleaseWaveTools(s as never, env, ALL_SCOPES);
    return s;
  }

  it("status and pending_state point at the view", () => {
    const s = setup({});
    for (const name of ["release_wave_status", "release_wave_pending_state"]) {
      expect(s.tools.get(name)!.config._meta?.ui?.resourceUri).toBe(RELEASE_WAVE_VIEW_URI);
    }
  });

  it("status returns structuredContent equal to the text payload", async () => {
    const wave = { wave_id: "w1", state: "flipped", repos: [], events: [] };
    const s = setup(wave);
    const r = await s.tools.get("release_wave_status")!.handler({ wave_id: "w1" });
    expect(r.structuredContent).toEqual(JSON.parse(r.content[0]!.text));
    expect(r.structuredContent).toMatchObject({ wave_id: "w1", state: "flipped" });
  });

  it("pending_flip accepts an optional worker_name", () => {
    const s = setup({});
    const schema = (s.tools.get("release_wave_pending_flip")!.config as { inputSchema?: Record<string, unknown> })
      .inputSchema!;
    expect(Object.keys(schema).sort()).toEqual(["repo", "worker_name"]);
  });
});
