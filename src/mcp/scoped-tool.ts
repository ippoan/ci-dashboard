import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

/**
 * ci-dashboard MCP tool が要求する scope の 4 分類 (Refs #498)。
 *   mcp.read     — list / get / search / grep 系
 *   mcp.write    — issue / PR の作成・変更・close・delete・merge
 *   mcp.workflow — workflow run 制御・tag-release・release_wave_*
 *   mcp.project  — Projects v2 の書き込み系
 */
export type McpScope = "mcp.read" | "mcp.write" | "mcp.workflow" | "mcp.project";

interface ScopedToolConfig<Args extends ZodRawShape> {
  description?: string;
  inputSchema?: Args;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  /** この tool を呼ぶのに要る scope。呼び出し元の binding_jwt scope 集合に
   *  含まれていなければ `tools/call` を isError で拒否する。 */
  requiresScope: McpScope;
}

/**
 * `McpServer.registerTool` の scope-gated ラッパーを組み立てる。`scopes` は
 * binding_jwt middleware (`src/mcp/auth.ts`) が resolve した呼び出し元の
 * scope 集合 — 未認証 bypass (unit test 等で claims を渡さない場合) は空 Set
 * になり、requiresScope を持つ全 tool (mcp.read の read-only tool も含む) が
 * forbidden になる (= fail-closed)。
 *
 * MCP spec に 403 は無いため `isError: true` の CallToolResult で返す
 * (secrets-inventory と同じ規約、Refs ippoan/secrets-inventory#43)。
 * `tools/list` は scope に関係なく全 tool を返す (McpServer 標準挙動のまま) —
 * client がどの tool が存在するか discover できる UX を優先し、scope 不足は
 * 呼び出し時にのみ弾く。
 */
export function createScopedRegisterTool(server: McpServer, scopes: ReadonlySet<string>) {
  return function registerScopedTool<Args extends ZodRawShape>(
    name: string,
    config: ScopedToolConfig<Args>,
    handler: ToolCallback<Args>,
  ) {
    const { requiresScope, ...rest } = config;
    const gated = (async (...args: Parameters<ToolCallback<Args>>) => {
      if (!scopes.has(requiresScope)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `forbidden: tool "${name}" requires scope "${requiresScope}"`,
            },
          ],
        };
      }
      return (
        handler as unknown as (
          ...a: Parameters<ToolCallback<Args>>
        ) => ReturnType<ToolCallback<Args>>
      )(...args);
    }) as ToolCallback<Args>;
    return server.registerTool(name, rest, gated);
  };
}

/**
 * `scope` claim (OAuth 慣例で空白区切り文字列) を Set に変換する。
 * claims 未提供 (= middleware bypass) は空 Set (= 全 requiresScope tool が invoke 不可)。
 */
export function parseScopes(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(/\s+/).filter((s) => s.length > 0));
}
