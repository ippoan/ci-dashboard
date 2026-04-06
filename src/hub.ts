import { DurableObject } from "cloudflare:workers";

export class CIDashboardHub extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    // Auto ping/pong for keepalive
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast") {
      const data = await request.text();
      this.broadcast(data);
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }

  broadcast(data: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Client disconnected, will be cleaned up by webSocketClose
      }
    }
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Clients don't send meaningful messages, ignore
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }
}
