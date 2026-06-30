// Discord channel self-heal primitives (Refs #441 PR3).
//
// Discord は channel 削除を push しない (Incoming Webhook は片方向)。
// 死んだ webhook URL は 404 Unknown Webhook (10015) を返すので、その時に
// Bot token で channel を作り直し → webhook を再発行して URL を hub DO に
// 書き戻す lazy heal を組む。
//
// 本 PR3 は **primitives のみ** — 404 検知 + heal 発火 + heal 結果の hub
// 記録 + WS broadcast は PR4 で結線する。
//
// 設定値:
//   Bot token: CF Secrets Store binding `DISCORD_BOT_TOKEN`
//     scope: Manage Channels + Manage Webhooks
//   guildId / channelName / parentCategoryId: KV `discord:*`
//     - `discord:guildId` (必須)
//     - `discord:channelName` (必須)
//     - `discord:parentCategoryId` (任意、置きたい category があれば)
//
// Bot token / KV のいずれかが未設定なら `healChannel` は null を返す
// (= PR4 が「heal 不能」として log + skip)。

export const CHANNEL_SETTINGS_KV_KEYS = {
  guildId: "discord:guildId",
  parentCategoryId: "discord:parentCategoryId",
  channelName: "discord:channelName",
} as const;

export const DISCORD_API_BASE = "https://discord.com/api/v10";

// Discord channel type 0 = GUILD_TEXT.
const CHANNEL_TYPE_GUILD_TEXT = 0;

export interface ChannelSettings {
  guildId: string;
  channelName: string;
  parentCategoryId?: string;
}

export interface HealResult {
  /** 再発行された webhook URL。caller (PR4) が hub DO に PUT する。 */
  newUrl: string;
  /** 作成された channel の Discord snowflake ID。observability 用。 */
  channelId: string;
  /** Channel name (= settings.channelName)。`reportHeal` の body で使う。 */
  channelName: string;
}

/** Discord API 4xx/5xx を loud に伝えるための専用 error。`status` を持つので
 *  PR4 側で `if (err instanceof DiscordApiError && err.status === 403)` の
 *  ような分岐を書ける (例: Bot 権限不足 = 403)。 */
export class DiscordApiError extends Error {
  readonly status: number;
  /** Discord API が返した raw body (max 200 文字、log 用)。 */
  readonly responseBody: string;
  constructor(op: string, status: number, body: string) {
    super(`discord-${op}-failed: ${status} ${body.slice(0, 200)}`);
    this.name = "DiscordApiError";
    this.status = status;
    this.responseBody = body.slice(0, 200);
  }
}

/** KV から channel settings を読み出す。必須 2 つ (guildId + channelName)
 *  が揃わなければ null (= heal 不能 / disabled)。parentCategoryId は任意。 */
export async function readChannelSettings(kv: KVNamespace): Promise<ChannelSettings | null> {
  const guildId = await kv.get(CHANNEL_SETTINGS_KV_KEYS.guildId);
  const channelName = await kv.get(CHANNEL_SETTINGS_KV_KEYS.channelName);
  if (!guildId || !channelName) return null;
  const parentCategoryId = await kv.get(CHANNEL_SETTINGS_KV_KEYS.parentCategoryId);
  return {
    guildId,
    channelName,
    parentCategoryId: parentCategoryId ?? undefined,
  };
}

interface CreateChannelResponse {
  id: string;
  name: string;
  type: number;
}

interface CreateWebhookResponse {
  id: string;
  token: string;
  channel_id: string;
  url?: string;
}

/** Bot token で新規 text channel を作る (POST /guilds/{id}/channels)。
 *  返値は作成された channel の snowflake ID。
 *  4xx/5xx で `DiscordApiError` を throw する (caller が catch して log)。 */
export async function createChannel(
  botToken: string,
  guildId: string,
  channelName: string,
  parentCategoryId?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    name: channelName,
    type: CHANNEL_TYPE_GUILD_TEXT,
  };
  if (parentCategoryId) body.parent_id = parentCategoryId;
  const res = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/channels`, {
    method: "POST",
    headers: {
      "authorization": `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new DiscordApiError("create-channel", res.status, text);
  }
  const data = await res.json<CreateChannelResponse>();
  return data.id;
}

/** Bot token で channel に webhook を作る (POST /channels/{id}/webhooks)。
 *  返値は完全な webhook URL (POST PR-close embed の send 先)。Discord API は
 *  `url` field を返すが、無い場合は `id` + `token` から組み立てる
 *  (古い API でも一貫した shape にする). */
export async function createWebhook(
  botToken: string,
  channelId: string,
  webhookName = "ci-dashboard PR notifier",
): Promise<string> {
  const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/webhooks`, {
    method: "POST",
    headers: {
      "authorization": `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: webhookName }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new DiscordApiError("create-webhook", res.status, text);
  }
  const data = await res.json<CreateWebhookResponse>();
  if (data.url) return data.url;
  return `https://discord.com/api/webhooks/${data.id}/${data.token}`;
}

/** End-to-end heal: KV から settings 読み → channel 作成 → webhook 再発行
 *  → 新 URL を返す。settings 未設定 / bot token 空なら null。Discord API の
 *  4xx/5xx はそのまま `DiscordApiError` で throw する (PR4 が catch して log
 *  + heal 失敗を hub に記録する)。 */
export async function healChannel(
  botToken: string,
  kv: KVNamespace,
): Promise<HealResult | null> {
  if (!botToken) return null;
  const settings = await readChannelSettings(kv);
  if (!settings) return null;
  const channelId = await createChannel(
    botToken, settings.guildId, settings.channelName, settings.parentCategoryId,
  );
  const newUrl = await createWebhook(botToken, channelId);
  return { newUrl, channelId, channelName: settings.channelName };
}
