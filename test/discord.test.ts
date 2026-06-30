import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  buildPrClosedEmbed,
  notifyDiscordPrClosed,
  WEBHOOK_URL_KV_KEY,
  COLOR_MERGED,
  COLOR_CLOSED,
} from "../src/discord";

const WEBHOOK_SECRET = "test-secret";

async function sign(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function minimalEnv(): Env {
  const hub: DurableObjectStub = {
    fetch: async () => new Response("OK"),
  } as unknown as DurableObjectStub;
  return {
    CI_STATUS: env.CI_STATUS,
    WEBHOOK_SECRET: { get: async () => WEBHOOK_SECRET } as unknown as SecretsStoreSecret,
    INTERNAL_SHARED_SECRET: { get: async () => "test-internal" } as unknown as SecretsStoreSecret,
    CI_HUB: { idFromName: () => ({}), get: () => hub } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("OK") }) } as unknown as DurableObjectNamespace,
    RELEASE_WAVE_WEBHOOK_SECRET: { get: async () => "test-webhook-secret" } as unknown as SecretsStoreSecret,
  };
}

describe("buildPrClosedEmbed", () => {
  it("merged PR → 紫色 + state=merged + 'merged by …' description", () => {
    const out = buildPrClosedEmbed({
      repo: "ohishi-exp/rust-ichibanboshi",
      number: 1234,
      title: "Add fuel surcharge calc engine",
      url: "https://github.com/ohishi-exp/rust-ichibanboshi/pull/1234",
      merged: true,
      sender: "yhonda-ohishi",
      closedAt: "2026-06-27T08:00:00.000Z",
    });
    expect(out.embeds).toHaveLength(1);
    const e = out.embeds[0]!;
    expect(e.title).toBe("#1234 Add fuel surcharge calc engine");
    expect(e.url).toBe("https://github.com/ohishi-exp/rust-ichibanboshi/pull/1234");
    expect(e.description).toBe("merged by yhonda-ohishi");
    expect(e.color).toBe(COLOR_MERGED);
    expect(e.fields).toContainEqual({ name: "repo", value: "ohishi-exp/rust-ichibanboshi", inline: true });
    expect(e.fields).toContainEqual({ name: "state", value: "merged", inline: true });
    expect(e.timestamp).toBe("2026-06-27T08:00:00.000Z");
  });

  it("closed-without-merge → 赤色 + state=closed + 'closed by …' description", () => {
    const out = buildPrClosedEmbed({
      repo: "ippoan/ci-dashboard",
      number: 7,
      title: "Drop deprecated route",
      url: "https://github.com/ippoan/ci-dashboard/pull/7",
      merged: false,
      sender: "alice",
      closedAt: "2026-06-27T09:00:00.000Z",
    });
    const e = out.embeds[0]!;
    expect(e.description).toBe("closed by alice");
    expect(e.color).toBe(COLOR_CLOSED);
    expect(e.fields).toContainEqual({ name: "state", value: "closed", inline: true });
  });
});

describe("notifyDiscordPrClosed (KV path)", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete(WEBHOOK_URL_KV_KEY);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("KV に webhook URL が無ければ fetch を呼ばない (no-op)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await notifyDiscordPrClosed(env.CI_STATUS, {
      repo: "ippoan/ci-dashboard",
      number: 1,
      title: "t",
      url: "https://x",
      merged: true,
      sender: "u",
      closedAt: "2026-06-27T00:00:00.000Z",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("KV に URL があれば embed payload を POST する", async () => {
    const url = "https://discord.com/api/webhooks/123/abc";
    await env.CI_STATUS.put(WEBHOOK_URL_KV_KEY, url);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await notifyDiscordPrClosed(env.CI_STATUS, {
      repo: "ippoan/ci-dashboard",
      number: 42,
      title: "t",
      url: "https://github.com/ippoan/ci-dashboard/pull/42",
      merged: true,
      sender: "yhonda",
      closedAt: "2026-06-27T00:00:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init!.body as string);
    expect(body.embeds[0].title).toBe("#42 t");
    expect(body.embeds[0].color).toBe(COLOR_MERGED);
  });

  it("Discord が 4xx を返しても throw せず log のみ", async () => {
    await env.CI_STATUS.put(WEBHOOK_URL_KV_KEY, "https://discord.com/api/webhooks/x/y");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(notifyDiscordPrClosed(env.CI_STATUS, {
      repo: "r", number: 1, title: "t", url: "u",
      merged: false, sender: "u", closedAt: "2026-06-27T00:00:00.000Z",
    })).resolves.toBeUndefined();
    const line = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("discord-pr-close-notify-failed"));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!).status).toBe(404);
  });

  it("fetch が throw しても notifyDiscordPrClosed は throw しない", async () => {
    await env.CI_STATUS.put(WEBHOOK_URL_KV_KEY, "https://discord.com/api/webhooks/x/y");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(notifyDiscordPrClosed(env.CI_STATUS, {
      repo: "r", number: 1, title: "t", url: "u",
      merged: false, sender: "u", closedAt: "2026-06-27T00:00:00.000Z",
    })).resolves.toBeUndefined();
  });
});

describe("webhook pull_request → Discord notify integration", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete(WEBHOOK_URL_KV_KEY);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function postWebhook(body: string): Promise<void> {
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      minimalEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
  }

  it("PR closed (merged) → URL 設定済みなら Discord に embed POST", async () => {
    const url = "https://discord.com/api/webhooks/abc/def";
    await env.CI_STATUS.put(WEBHOOK_URL_KV_KEY, url);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 99,
        merged: true,
        merge_commit_sha: "deadbeef",
        base: { ref: "main" },
        title: "Fix something",
        html_url: "https://github.com/ippoan/ci-dashboard/pull/99",
        updated_at: "2026-06-27T10:00:00Z",
      },
      repository: { full_name: "ippoan/ci-dashboard", default_branch: "main" },
      sender: { login: "yhonda" },
    });
    await postWebhook(body);

    const discordCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith(url));
    expect(discordCalls).toHaveLength(1);
    const sent = JSON.parse(discordCalls[0]![1]!.body as string);
    expect(sent.embeds[0].title).toBe("#99 Fix something");
    expect(sent.embeds[0].description).toBe("merged by yhonda");
    expect(sent.embeds[0].color).toBe(COLOR_MERGED);
  });

  it("PR closed-without-merge → 赤色 + state=closed で 1 件 POST", async () => {
    const url = "https://discord.com/api/webhooks/abc/def";
    await env.CI_STATUS.put(WEBHOOK_URL_KV_KEY, url);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 100,
        merged: false,
        merge_commit_sha: null,
        base: { ref: "main" },
        title: "Dropped",
        html_url: "https://github.com/ippoan/ci-dashboard/pull/100",
        updated_at: "2026-06-27T11:00:00Z",
      },
      repository: { full_name: "ippoan/ci-dashboard", default_branch: "main" },
      sender: { login: "alice" },
    });
    await postWebhook(body);

    const discordCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith(url));
    expect(discordCalls).toHaveLength(1);
    const sent = JSON.parse(discordCalls[0]![1]!.body as string);
    expect(sent.embeds[0].color).toBe(COLOR_CLOSED);
    expect(sent.embeds[0].description).toBe("closed by alice");
    expect(sent.embeds[0].fields).toContainEqual({ name: "state", value: "closed", inline: true });
  });

  it("PR opened / synchronize / edited は Discord を呼ばない", async () => {
    await env.CI_STATUS.put(WEBHOOK_URL_KV_KEY, "https://discord.com/api/webhooks/x/y");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    for (const action of ["opened", "synchronize", "edited", "reopened"]) {
      const body = JSON.stringify({
        action,
        pull_request: {
          number: 1, merged: false, merge_commit_sha: null, base: { ref: "main" },
          title: "x", html_url: "u", updated_at: "2026-06-27T00:00:00Z",
        },
        repository: { full_name: "ippoan/ci-dashboard", default_branch: "main" },
        sender: { login: "u" },
      });
      await postWebhook(body);
    }
    const discordCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("https://discord.com/api/webhooks/"));
    expect(discordCalls).toHaveLength(0);
  });

  it("PR closed (URL 未設定) → Discord 呼び出し 0、他の pipeline は通常動作", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 1, merged: true, merge_commit_sha: "abc", base: { ref: "main" },
        title: "x", html_url: "u", updated_at: "2026-06-27T00:00:00Z",
      },
      repository: { full_name: "ippoan/ci-dashboard", default_branch: "main" },
      sender: { login: "u" },
    });
    await postWebhook(body);
    const discordCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("https://discord.com/api/webhooks/"));
    expect(discordCalls).toHaveLength(0);
  });

  it("PR closed payload に title / html_url / sender が無くても落ちず POST する (fallback 文字列)", async () => {
    await env.CI_STATUS.put(WEBHOOK_URL_KV_KEY, "https://discord.com/api/webhooks/x/y");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 55, merged: false, merge_commit_sha: null, base: { ref: "main" },
        // title / html_url / updated_at すべて省略
      },
      repository: { full_name: "ippoan/ci-dashboard", default_branch: "main" },
      // sender も省略
    });
    await postWebhook(body);
    const discordCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("https://discord.com/api/webhooks/"));
    expect(discordCalls).toHaveLength(1);
    const sent = JSON.parse(discordCalls[0]![1]!.body as string);
    expect(sent.embeds[0].title).toBe("#55 PR #55");
    expect(sent.embeds[0].url).toBe("https://github.com/ippoan/ci-dashboard/pull/55");
    expect(sent.embeds[0].description).toBe("closed by unknown");
  });
});
