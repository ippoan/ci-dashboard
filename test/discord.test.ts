import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  buildPrClosedEmbed,
  maskWebhookUrl,
  notifyDiscordPrClosed,
  readPrCloseWebhookUrl,
  writePrCloseWebhookUrl,
  WEBHOOK_URL_KV_KEY,
  COLOR_MERGED,
  COLOR_CLOSED,
} from "../src/discord";
import { CHANNEL_SETTINGS_KV_KEYS } from "../src/discord-heal";

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

// 簡易 Hub DO stub。`/discord-webhook-url` GET/PUT は in-memory Map で
// 表現し、`/discord-heal-record` POST は heal records 配列に append、
// `/discord-heal-records` GET は records を返す (Refs #441 PR4)。
// その他の path は no-op `Response("OK")`。test 側で `getHealRecords()`
// で観測できる。
interface MockHub {
  stub: DurableObjectStub;
  getWebhookUrl(): string | undefined;
  getHealRecords(): unknown[];
}
function makeMockHubRich(initialUrl?: string): MockHub {
  const store = new Map<string, string>();
  if (initialUrl) store.set("discord:prCloseWebhookUrl", initialUrl);
  const healRecords: unknown[] = [];
  const stub = {
    fetch: async (req: Request) => {
      const u = new URL(req.url);
      if (u.pathname === "/discord-webhook-url") {
        if (req.method === "GET") {
          return new Response(store.get("discord:prCloseWebhookUrl") ?? "", { status: 200 });
        }
        if (req.method === "PUT") {
          const { url } = await req.json<{ url: string | null }>();
          if (!url) store.delete("discord:prCloseWebhookUrl");
          else store.set("discord:prCloseWebhookUrl", url);
          return new Response("OK");
        }
      }
      if (u.pathname === "/discord-heal-record" && req.method === "POST") {
        healRecords.unshift(await req.json());
        return new Response("OK");
      }
      if (u.pathname === "/discord-heal-records" && req.method === "GET") {
        return Response.json(healRecords);
      }
      return new Response("OK");
    },
  } as unknown as DurableObjectStub;
  return {
    stub,
    getWebhookUrl: () => store.get("discord:prCloseWebhookUrl"),
    getHealRecords: () => healRecords.slice(),
  };
}
// 大半の test は stub だけで足りるので convenience ラッパー。
function makeMockHubStub(initialUrl?: string): DurableObjectStub {
  return makeMockHubRich(initialUrl).stub;
}

function minimalEnv(hub: DurableObjectStub): Env {
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

describe("readPrCloseWebhookUrl (Hub DO path)", () => {
  it("Hub が 200 + 空 body を返したら null", async () => {
    const hub = makeMockHubStub();
    expect(await readPrCloseWebhookUrl(hub)).toBeNull();
  });

  it("Hub が URL 入り 200 を返したらその値", async () => {
    const hub = makeMockHubStub("https://discord.com/api/webhooks/x/y");
    expect(await readPrCloseWebhookUrl(hub)).toBe("https://discord.com/api/webhooks/x/y");
  });

  it("Hub が throw しても null で fail-open", async () => {
    const hub = { fetch: async () => { throw new Error("hub down"); } } as unknown as DurableObjectStub;
    expect(await readPrCloseWebhookUrl(hub)).toBeNull();
  });

  it("Hub が non-OK を返しても null で fail-open", async () => {
    const hub = { fetch: async () => new Response("err", { status: 500 }) } as unknown as DurableObjectStub;
    expect(await readPrCloseWebhookUrl(hub)).toBeNull();
  });
});

describe("notifyDiscordPrClosed (Hub DO path)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("Hub に URL 無しなら fetch を呼ばない (no-op)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await notifyDiscordPrClosed(makeMockHubStub(), null, null, {
      repo: "ippoan/ci-dashboard",
      number: 1, title: "t", url: "https://x",
      merged: true, sender: "u", closedAt: "2026-06-27T00:00:00.000Z",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Hub に URL があれば embed payload を POST する", async () => {
    const webhook = "https://discord.com/api/webhooks/123/abc";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await notifyDiscordPrClosed(makeMockHubStub(webhook), null, null, {
      repo: "ippoan/ci-dashboard",
      number: 42, title: "t",
      url: "https://github.com/ippoan/ci-dashboard/pull/42",
      merged: true, sender: "yhonda", closedAt: "2026-06-27T00:00:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe(webhook);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init!.body as string);
    expect(body.embeds[0].title).toBe("#42 t");
    expect(body.embeds[0].color).toBe(COLOR_MERGED);
  });

  it("Discord が 4xx を返しても throw せず log のみ", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(notifyDiscordPrClosed(makeMockHubStub("https://discord.com/api/webhooks/x/y"), null, null, {
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
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(notifyDiscordPrClosed(makeMockHubStub("https://discord.com/api/webhooks/x/y"), null, null, {
      repo: "r", number: 1, title: "t", url: "u",
      merged: false, sender: "u", closedAt: "2026-06-27T00:00:00.000Z",
    })).resolves.toBeUndefined();
  });
});

describe("webhook pull_request → Discord notify integration", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete(WEBHOOK_URL_KV_KEY);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function postWebhook(body: string, hub: DurableObjectStub): Promise<void> {
    const sig = await sign(body, WEBHOOK_SECRET);
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request" },
      }),
      minimalEnv(hub),
      ctx,
    );
    await waitOnExecutionContext(ctx);
  }

  it("PR closed (merged) → Hub に URL あれば Discord に embed POST", async () => {
    const webhook = "https://discord.com/api/webhooks/abc/def";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 99, merged: true, merge_commit_sha: "deadbeef",
        base: { ref: "main" },
        title: "Fix something",
        html_url: "https://github.com/ippoan/ci-dashboard/pull/99",
        updated_at: "2026-06-27T10:00:00Z",
      },
      repository: { full_name: "ippoan/ci-dashboard", default_branch: "main" },
      sender: { login: "yhonda" },
    });
    await postWebhook(body, makeMockHubStub(webhook));

    const discordCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith(webhook));
    expect(discordCalls).toHaveLength(1);
    const sent = JSON.parse(discordCalls[0]![1]!.body as string);
    expect(sent.embeds[0].title).toBe("#99 Fix something");
    expect(sent.embeds[0].description).toBe("merged by yhonda");
    expect(sent.embeds[0].color).toBe(COLOR_MERGED);
  });

  it("PR closed-without-merge → 赤色 + state=closed で 1 件 POST", async () => {
    const webhook = "https://discord.com/api/webhooks/abc/def";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 100, merged: false, merge_commit_sha: null,
        base: { ref: "main" },
        title: "Dropped",
        html_url: "https://github.com/ippoan/ci-dashboard/pull/100",
        updated_at: "2026-06-27T11:00:00Z",
      },
      repository: { full_name: "ippoan/ci-dashboard", default_branch: "main" },
      sender: { login: "alice" },
    });
    await postWebhook(body, makeMockHubStub(webhook));

    const discordCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).startsWith(webhook));
    expect(discordCalls).toHaveLength(1);
    const sent = JSON.parse(discordCalls[0]![1]!.body as string);
    expect(sent.embeds[0].color).toBe(COLOR_CLOSED);
    expect(sent.embeds[0].description).toBe("closed by alice");
    expect(sent.embeds[0].fields).toContainEqual({ name: "state", value: "closed", inline: true });
  });

  it("PR opened / synchronize / edited / reopened は Discord を呼ばない", async () => {
    const hub = makeMockHubStub("https://discord.com/api/webhooks/x/y");
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
      await postWebhook(body, hub);
    }
    const discordCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("https://discord.com/api/webhooks/"));
    expect(discordCalls).toHaveLength(0);
  });

  it("Hub に URL 未設定なら closed でも Discord を呼ばない", async () => {
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
    await postWebhook(body, makeMockHubStub());
    const discordCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("https://discord.com/api/webhooks/"));
    expect(discordCalls).toHaveLength(0);
  });

  it("PR closed payload に title / html_url / sender が無くても fallback で POST", async () => {
    const webhook = "https://discord.com/api/webhooks/x/y";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 55, merged: false, merge_commit_sha: null, base: { ref: "main" },
      },
      repository: { full_name: "ippoan/ci-dashboard", default_branch: "main" },
    });
    await postWebhook(body, makeMockHubStub(webhook));
    const discordCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("https://discord.com/api/webhooks/"));
    expect(discordCalls).toHaveLength(1);
    const sent = JSON.parse(discordCalls[0]![1]!.body as string);
    expect(sent.embeds[0].title).toBe("#55 PR #55");
    expect(sent.embeds[0].url).toBe("https://github.com/ippoan/ci-dashboard/pull/55");
    expect(sent.embeds[0].description).toBe("closed by unknown");
  });

  it("legacy KV (`discord:prCloseWebhookUrl`) → Hub DO への lazy migration を端から検証 (= 実 Hub DO 経由の挙動を smoke で確認)", async () => {
    // 本テストは src/discord.ts と src/webhook.ts の挙動を直接的に検証する目的ではなく、
    // Hub DO の getDiscordPrCloseWebhookUrl 経路 (= legacy KV seed) と
    // putDiscordPrCloseWebhookUrl 経路 (= heal で書き戻し) のハッピーパスが繋がる
    // ことを確認する。実 Hub DO (cloudflare:test ランタイム上の DO) を直接叩く。
    // makeMockHub では DO storage を持たないのでこの test は実 isolate を経由する。
    // index.ts で export している CIDashboardHub を `env.CI_HUB` で取得する。
    const hubStub = (env as unknown as { CI_HUB: DurableObjectNamespace }).CI_HUB
      .get((env as unknown as { CI_HUB: DurableObjectNamespace }).CI_HUB.idFromName("singleton-test-pr2"));
    await env.CI_STATUS.put(WEBHOOK_URL_KV_KEY, "https://discord.com/api/webhooks/legacy/seed");
    const got = await readPrCloseWebhookUrl(hubStub);
    expect(got).toBe("https://discord.com/api/webhooks/legacy/seed");
    // PUT で上書きできる
    await hubStub.fetch(new Request("http://hub/discord-webhook-url", {
      method: "PUT",
      body: JSON.stringify({ url: "https://discord.com/api/webhooks/new/value" }),
    }));
    const after = await readPrCloseWebhookUrl(hubStub);
    expect(after).toBe("https://discord.com/api/webhooks/new/value");
    // null で削除
    await hubStub.fetch(new Request("http://hub/discord-webhook-url", {
      method: "PUT",
      body: JSON.stringify({ url: null }),
    }));
    // KV を消した上で再 read → null (DO storage も空、KV も空)
    await env.CI_STATUS.delete(WEBHOOK_URL_KV_KEY);
    const finalRead = await readPrCloseWebhookUrl(hubStub);
    expect(finalRead).toBeNull();
  });
});

describe("maskWebhookUrl (Refs #441 PR4)", () => {
  it("token 部分を **** に置換", () => {
    expect(maskWebhookUrl("https://discord.com/api/webhooks/12345/abcdef-token"))
      .toBe("https://discord.com/api/webhooks/12345/****");
  });
  it("token 末尾の query string は保つ", () => {
    expect(maskWebhookUrl("https://discord.com/api/webhooks/12345/token?wait=true"))
      .toBe("https://discord.com/api/webhooks/12345/****?wait=true");
  });
  it("マッチしない文字列はそのまま", () => {
    expect(maskWebhookUrl("not-a-webhook")).toBe("not-a-webhook");
  });
});

describe("writePrCloseWebhookUrl (Refs #441 PR4)", () => {
  it("Hub の /discord-webhook-url PUT を叩いて true", async () => {
    const hub = makeMockHubRich();
    expect(await writePrCloseWebhookUrl(hub.stub, "https://x")).toBe(true);
    expect(hub.getWebhookUrl()).toBe("https://x");
  });
  it("null で delete", async () => {
    const hub = makeMockHubRich("https://existing");
    expect(await writePrCloseWebhookUrl(hub.stub, null)).toBe(true);
    expect(hub.getWebhookUrl()).toBeUndefined();
  });
  it("Hub が throw したら false で fail-open", async () => {
    const stub = { fetch: async () => { throw new Error("down"); } } as unknown as DurableObjectStub;
    expect(await writePrCloseWebhookUrl(stub, "x")).toBe(false);
  });
});

describe("notifyDiscordPrClosed 404 lazy heal (Refs #441 PR4)", () => {
  const BOT = "Nz...test";
  const DEAD_URL = "https://discord.com/api/webhooks/old/deadtoken";
  const NEW_CHANNEL = "9999";
  const NEW_WH = "https://discord.com/api/webhooks/wh-new/tok-new";

  beforeEach(async () => {
    for (const k of Object.values(CHANNEL_SETTINGS_KV_KEYS)) {
      await env.CI_STATUS.delete(k);
    }
    await env.CI_STATUS.delete(WEBHOOK_URL_KV_KEY);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function seedSettings(): Promise<unknown[]> {
    return Promise.all([
      env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.guildId, "guild-1"),
      env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.channelName, "pr-notify"),
    ]);
  }

  it("404 + token + settings → healChannel → URL rotate → retry → heal record", async () => {
    await seedSettings();
    const hub = makeMockHubRich(DEAD_URL);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      // 1) initial send → 404 Unknown Webhook
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Unknown Webhook", code: 10015 }), { status: 404 }))
      // 2) Discord API: create channel (healChannel step 1)
      .mockResolvedValueOnce(Response.json({ id: NEW_CHANNEL, name: "pr-notify", type: 0 }, { status: 201 }))
      // 3) Discord API: create webhook (healChannel step 2)
      .mockResolvedValueOnce(Response.json({ id: "wh-new", token: "tok-new", channel_id: NEW_CHANNEL, url: NEW_WH }, { status: 200 }))
      // 4) retry send → 204
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await notifyDiscordPrClosed(hub.stub, env.CI_STATUS, BOT, {
      repo: "x/y", number: 1, title: "t", url: "u",
      merged: true, sender: "yhonda", closedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    // URL が rotate された
    expect(hub.getWebhookUrl()).toBe(NEW_WH);
    // heal record が 1 件記録された (token mask 済み)
    const recs = hub.getHealRecords();
    expect(recs).toHaveLength(1);
    const r = recs[0] as Record<string, string>;
    expect(r.deadUrl).toBe("https://discord.com/api/webhooks/old/****");
    expect(r.newUrl).toBe("https://discord.com/api/webhooks/wh-new/****");
    expect(r.channelId).toBe(NEW_CHANNEL);
    expect(r.channelName).toBe("pr-notify");
    expect(r.reason).toBe("404 Unknown Webhook on send");
    expect(typeof r.at).toBe("string");
    // 最後の fetch (retry) が新 URL に飛んでいる
    expect(fetchSpy.mock.calls[3]![0]).toBe(NEW_WH);
  });

  it("404 + token 無し → heal skip、log のみ", async () => {
    const hub = makeMockHubRich(DEAD_URL);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await notifyDiscordPrClosed(hub.stub, env.CI_STATUS, null, {
      repo: "x/y", number: 1, title: "t", url: "u",
      merged: false, sender: "u", closedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // heal/retry なし
    expect(hub.getHealRecords()).toHaveLength(0);
    const failLog = logSpy.mock.calls.map((c) => String(c[0]))
      .find((s) => s.includes("discord-pr-close-notify-failed"));
    expect(failLog).toBeTruthy();
  });

  it("404 + KV settings 無し → healChannel が null → heal skip", async () => {
    // settings 未投入のまま (clearKv 後の状態)
    const hub = makeMockHubRich(DEAD_URL);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await notifyDiscordPrClosed(hub.stub, env.CI_STATUS, BOT, {
      repo: "x/y", number: 1, title: "t", url: "u",
      merged: false, sender: "u", closedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // healChannel が settings 無しで null → Discord API は呼ばない
    expect(hub.getHealRecords()).toHaveLength(0);
  });

  it("404 + create-channel が 403 を返す → DiscordApiError catch、heal record 無し、log", async () => {
    await seedSettings();
    const hub = makeMockHubRich(DEAD_URL);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response("Missing Permissions", { status: 403 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await notifyDiscordPrClosed(hub.stub, env.CI_STATUS, BOT, {
      repo: "x/y", number: 1, title: "t", url: "u",
      merged: false, sender: "u", closedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2); // initial + create-channel (403)
    expect(hub.getHealRecords()).toHaveLength(0);
    // discord-heal-failed と discord-pr-close-notify-failed の 2 本が log に出る
    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes("discord-heal-failed"))).toBe(true);
    expect(logs.some((s) => s.includes("discord-pr-close-notify-failed"))).toBe(true);
  });

  it("404 ではない (e.g. 429) → heal せず log のみ", async () => {
    await seedSettings();
    const hub = makeMockHubRich(DEAD_URL);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await notifyDiscordPrClosed(hub.stub, env.CI_STATUS, BOT, {
      repo: "x/y", number: 1, title: "t", url: "u",
      merged: false, sender: "u", closedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 429 は heal trigger ではない
    expect(hub.getHealRecords()).toHaveLength(0);
  });

  it("404 → heal 成功 → retry 後の send も失敗した場合、heal record は残るが log も出す", async () => {
    await seedSettings();
    const hub = makeMockHubRich(DEAD_URL);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ id: NEW_CHANNEL, name: "pr-notify", type: 0 }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ id: "wh-new", token: "tok-new", channel_id: NEW_CHANNEL, url: NEW_WH }, { status: 200 }))
      // retry も 500
      .mockResolvedValueOnce(new Response("err", { status: 500 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await notifyDiscordPrClosed(hub.stub, env.CI_STATUS, BOT, {
      repo: "x/y", number: 1, title: "t", url: "u",
      merged: true, sender: "u", closedAt: "2026-06-30T00:00:00.000Z",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(hub.getHealRecords()).toHaveLength(1); // heal は成功
    const finalLog = logSpy.mock.calls.map((c) => String(c[0]))
      .find((s) => s.includes("discord-pr-close-notify-failed"));
    expect(finalLog).toBeTruthy();
    expect(JSON.parse(finalLog!).status).toBe(500);
  });
});

describe("CIDashboardHub /discord-heal-record + /discord-heal-records (Refs #441 PR4)", () => {
  it("実 Hub DO の append + list 経路を smoke 検証", async () => {
    const hub = (env as unknown as { CI_HUB: DurableObjectNamespace }).CI_HUB;
    const stub = hub.get(hub.idFromName("singleton-test-pr4-heal-records"));
    // 初期状態: 空
    const empty = await stub.fetch(new Request("http://hub/discord-heal-records"));
    expect(await empty.json()).toEqual([]);
    // 1 件 append
    const rec = {
      at: "2026-06-30T00:00:00.000Z",
      deadUrl: "https://discord.com/api/webhooks/old/****",
      newUrl: "https://discord.com/api/webhooks/new/****",
      channelName: "pr-notify",
      channelId: "9999",
      reason: "404 Unknown Webhook on send",
    };
    await stub.fetch(new Request("http://hub/discord-heal-record", {
      method: "POST", body: JSON.stringify(rec),
    }));
    const after = await stub.fetch(new Request("http://hub/discord-heal-records"));
    const list = await after.json<unknown[]>();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(rec);
  });
});
