import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import type { CIStatus } from "../src/webhook";

const WEBHOOK_SECRET = "test-secret";

function testEnv(): Env {
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET,
  };
}

describe("GET /stream", () => {
  it("returns SSE headers", async () => {
    const req = new Request("http://localhost/stream");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");

    // Read the first SSE message (initial state)
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain("data: ");

    // Parse the SSE data
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const data = JSON.parse(dataLine!.replace("data: ", ""));
    expect(Array.isArray(data)).toBe(true);

    // Cancel the stream
    await reader.cancel();
    await waitOnExecutionContext(ctx);
  });

  it("sends initial data with existing KV entries", async () => {
    const status: CIStatus = {
      repo: "ippoan/rust-alc-api",
      workflow: "ci.yml",
      branch: "main",
      status: "completed",
      conclusion: "success",
      run_id: 300,
      run_url: "https://github.com/ippoan/rust-alc-api/actions/runs/300",
      actor: "yhonda",
      updated_at: "2026-04-06T12:00:00Z",
      started_at: "2026-04-06T11:55:00Z",
    };
    await env.CI_STATUS.put("ippoan/rust-alc-api", JSON.stringify(status));

    const req = new Request("http://localhost/stream");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, testEnv(), ctx);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const { value } = await reader.read();
    const text = decoder.decode(value);
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    const data = JSON.parse(dataLine!.replace("data: ", ""));

    expect(data).toHaveLength(1);
    expect(data[0].repo).toBe("ippoan/rust-alc-api");
    expect(data[0].conclusion).toBe("success");

    await reader.cancel();
    await waitOnExecutionContext(ctx);
  });
});
