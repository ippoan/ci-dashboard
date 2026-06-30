import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CHANNEL_SETTINGS_KV_KEYS,
  DiscordApiError,
  DISCORD_API_BASE,
  createChannel,
  createWebhook,
  healChannel,
  readChannelSettings,
} from "../src/discord-heal";

const BOT = "Nz...test-bot-token";
const GUILD = "11111";
const CHANNEL = "22222";
const PARENT = "33333";
const CHANNEL_NAME = "pr-notify";

async function clearKv(): Promise<void> {
  for (const k of Object.values(CHANNEL_SETTINGS_KV_KEYS)) {
    await env.CI_STATUS.delete(k);
  }
}

describe("readChannelSettings", () => {
  beforeEach(clearKv);

  it("guildId と channelName が両方無ければ null", async () => {
    expect(await readChannelSettings(env.CI_STATUS)).toBeNull();
  });

  it("guildId だけだと null (channelName 必須)", async () => {
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.guildId, GUILD);
    expect(await readChannelSettings(env.CI_STATUS)).toBeNull();
  });

  it("両方揃えば返す、parentCategoryId は無ければ undefined", async () => {
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.guildId, GUILD);
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.channelName, CHANNEL_NAME);
    expect(await readChannelSettings(env.CI_STATUS)).toEqual({
      guildId: GUILD,
      channelName: CHANNEL_NAME,
      parentCategoryId: undefined,
    });
  });

  it("parentCategoryId も読む (任意 field)", async () => {
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.guildId, GUILD);
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.channelName, CHANNEL_NAME);
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.parentCategoryId, PARENT);
    expect(await readChannelSettings(env.CI_STATUS)).toEqual({
      guildId: GUILD,
      channelName: CHANNEL_NAME,
      parentCategoryId: PARENT,
    });
  });
});

describe("createChannel", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("POST /guilds/{id}/channels に Bot token + name/type=0 を送る", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: CHANNEL, name: CHANNEL_NAME, type: 0 }, { status: 201 }),
    );
    const id = await createChannel(BOT, GUILD, CHANNEL_NAME);
    expect(id).toBe(CHANNEL);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [callUrl, init] = fetchSpy.mock.calls[0]!;
    expect(callUrl).toBe(`${DISCORD_API_BASE}/guilds/${GUILD}/channels`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bot ${BOT}`);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init!.body as string);
    expect(body.name).toBe(CHANNEL_NAME);
    expect(body.type).toBe(0);
    expect(body.parent_id).toBeUndefined();
  });

  it("parentCategoryId 指定時は body に parent_id が乗る", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: CHANNEL, name: CHANNEL_NAME, type: 0 }, { status: 201 }),
    );
    await createChannel(BOT, GUILD, CHANNEL_NAME, PARENT);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.parent_id).toBe(PARENT);
  });

  it("4xx で DiscordApiError + status + body を保持する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ message: "Missing Permissions", code: 50013 }),
      { status: 403 },
    ));
    await expect(createChannel(BOT, GUILD, CHANNEL_NAME))
      .rejects.toMatchObject({
        name: "DiscordApiError",
        status: 403,
        message: expect.stringContaining("discord-create-channel-failed: 403"),
      });
  });
});

describe("createWebhook", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("POST /channels/{id}/webhooks に Bot token + name を送り、url field を返す", async () => {
    const wh = "https://discord.com/api/webhooks/abc/def";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: "abc", token: "def", channel_id: CHANNEL, url: wh }, { status: 200 }),
    );
    const url = await createWebhook(BOT, CHANNEL);
    expect(url).toBe(wh);
    const [callUrl, init] = fetchSpy.mock.calls[0]!;
    expect(callUrl).toBe(`${DISCORD_API_BASE}/channels/${CHANNEL}/webhooks`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bot ${BOT}`);
    const body = JSON.parse(init!.body as string);
    expect(body.name).toBe("ci-dashboard PR notifier");
  });

  it("url field 無し response でも id+token から組み立てる", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: "abc", token: "def", channel_id: CHANNEL }, { status: 200 }),
    );
    const url = await createWebhook(BOT, CHANNEL);
    expect(url).toBe("https://discord.com/api/webhooks/abc/def");
  });

  it("webhookName を上書きできる", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: "x", token: "y", channel_id: CHANNEL, url: "u" }, { status: 200 }),
    );
    await createWebhook(BOT, CHANNEL, "custom name");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.name).toBe("custom name");
  });

  it("4xx で DiscordApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 500 }));
    await expect(createWebhook(BOT, CHANNEL))
      .rejects.toBeInstanceOf(DiscordApiError);
  });
});

describe("healChannel (end-to-end)", () => {
  beforeEach(clearKv);
  afterEach(() => { vi.restoreAllMocks(); });

  it("botToken 空なら null (= heal 不能、後段で skip)", async () => {
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.guildId, GUILD);
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.channelName, CHANNEL_NAME);
    expect(await healChannel("", env.CI_STATUS)).toBeNull();
  });

  it("KV settings 未設定なら null", async () => {
    expect(await healChannel(BOT, env.CI_STATUS)).toBeNull();
  });

  it("settings + token あれば create-channel → create-webhook 連鎖 → HealResult", async () => {
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.guildId, GUILD);
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.channelName, CHANNEL_NAME);
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.parentCategoryId, PARENT);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: CHANNEL, name: CHANNEL_NAME, type: 0 }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(
        { id: "wh1", token: "tok1", channel_id: CHANNEL, url: "https://discord.com/api/webhooks/wh1/tok1" },
        { status: 200 },
      ));
    const result = await healChannel(BOT, env.CI_STATUS);
    expect(result).toEqual({
      newUrl: "https://discord.com/api/webhooks/wh1/tok1",
      channelId: CHANNEL,
      channelName: CHANNEL_NAME,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // 1 件目: guild の channels endpoint、parent_id が body にあること
    const ch = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(ch.parent_id).toBe(PARENT);
    // 2 件目: channel の webhooks endpoint
    expect(fetchSpy.mock.calls[1]![0]).toBe(`${DISCORD_API_BASE}/channels/${CHANNEL}/webhooks`);
  });

  it("create-channel 失敗時は webhook 段に進まず DiscordApiError を throw", async () => {
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.guildId, GUILD);
    await env.CI_STATUS.put(CHANNEL_SETTINGS_KV_KEYS.channelName, CHANNEL_NAME);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Missing Permissions", { status: 403 }),
    );
    await expect(healChannel(BOT, env.CI_STATUS)).rejects.toBeInstanceOf(DiscordApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // webhook 呼ばない
  });
});
