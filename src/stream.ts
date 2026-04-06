import type { Env } from "./index";
import { getAllStatuses } from "./status";

export function handleStream(
  _request: Request,
  env: Env,
  ctx: ExecutionContext
): Response {
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let previousSnapshot = "";

      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      // Send initial state immediately
      const initial = await getAllStatuses(env);
      const initialJson = JSON.stringify(initial);
      send(initialJson);
      previousSnapshot = initialJson;

      // Poll KV for changes
      while (!cancelled) {
        await scheduler.wait(2000);
        if (cancelled) break;

        const current = await getAllStatuses(env);
        const currentJson = JSON.stringify(current);

        if (currentJson !== previousSnapshot) {
          send(currentJson);
          previousSnapshot = currentJson;
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  ctx.waitUntil(
    new Promise<void>((resolve) => {
      // Resolve when the stream is cancelled
      const check = setInterval(() => {
        if (cancelled) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    })
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
