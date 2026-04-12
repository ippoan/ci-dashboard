import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerActionsTools } from "./tools/actions";
import { registerPullsTools } from "./tools/pulls";
import { registerReleasesTools } from "./tools/releases";
import { registerLogsTools } from "./tools/logs";

function createMcpServer(token: string): McpServer {
  const server = new McpServer({
    name: "ci-dashboard",
    version: "1.0.0",
  });

  registerActionsTools(server, token);
  registerPullsTools(server, token);
  registerReleasesTools(server, token);
  registerLogsTools(server, token);

  return server;
}

export async function handleMcpRequest(request: Request, token: string): Promise<Response> {
  const server = createMcpServer(token);
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
