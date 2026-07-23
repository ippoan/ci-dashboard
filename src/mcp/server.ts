import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "../index";
import { registerActionsTools } from "./tools/actions";
import { registerPullsTools } from "./tools/pulls";
import { registerReleasesTools } from "./tools/releases";
import { registerLogsTools } from "./tools/logs";
import { registerRepositoryTools } from "./tools/repository";
import { registerCommitsTools } from "./tools/commits";
import { registerIssuesTools } from "./tools/issues";
import { registerProjectsTools } from "./tools/projects";
import { registerReleaseWaveTools } from "./tools/release-wave";
import { parseScopes } from "./scoped-tool";
import type { BindingJwtClaims } from "./auth";

function createMcpServer(env: Env, scopes: ReadonlySet<string>): McpServer {
  const server = new McpServer({
    name: "ci-dashboard",
    version: "1.0.0",
  });

  registerActionsTools(server, env, scopes);
  registerPullsTools(server, env, scopes);
  registerReleasesTools(server, env, scopes);
  registerLogsTools(server, env, scopes);
  registerRepositoryTools(server, env, scopes);
  registerCommitsTools(server, env, scopes);
  registerIssuesTools(server, env, scopes);
  registerProjectsTools(server, env, scopes);
  // Release Wave tools (issue #137 Phase 3c)。`RELEASE_WAVE_HUB` binding を
  // 使うため Env 型で受ける必要があり、createMcpServer の env 型を Env に
  // widen した。既存 tools は AuthClientWorkerEnv の subset を見るだけなので
  // Env (extends) を渡しても互換。
  registerReleaseWaveTools(server, env, scopes);

  return server;
}

/**
 * `claims` は binding_jwt middleware (`src/mcp/auth.ts`) が `/mcp` の前段で
 * 検証した呼び出し元の scope。Refs ippoan/ci-dashboard#498: middleware 導入
 * 前は `/mcp` が完全匿名で全 48 tool 実行可能だった。
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  claims?: BindingJwtClaims,
): Promise<Response> {
  const scopes = parseScopes(claims?.scope);
  const server = createMcpServer(env, scopes);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}
