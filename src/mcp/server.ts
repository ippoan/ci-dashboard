import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { GitHubAppEnv } from "../github-app-auth";
import { registerActionsTools } from "./tools/actions";
import { registerPullsTools } from "./tools/pulls";
import { registerReleasesTools } from "./tools/releases";
import { registerLogsTools } from "./tools/logs";
import { registerRepositoryTools } from "./tools/repository";
import { registerCommitsTools } from "./tools/commits";
import { registerIssuesTools } from "./tools/issues";
import { registerProjectsTools } from "./tools/projects";

function createMcpServer(env: GitHubAppEnv): McpServer {
  const server = new McpServer({
    name: "ci-dashboard",
    version: "1.0.0",
  });

  registerActionsTools(server, env);
  registerPullsTools(server, env);
  registerReleasesTools(server, env);
  registerLogsTools(server, env);
  registerRepositoryTools(server, env);
  registerCommitsTools(server, env);
  registerIssuesTools(server, env);
  registerProjectsTools(server, env);

  return server;
}

export async function handleMcpRequest(request: Request, env: GitHubAppEnv): Promise<Response> {
  const server = createMcpServer(env);
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
