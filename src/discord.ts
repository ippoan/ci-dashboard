// Discord PR close notification (Refs #441 PR1).
//
// 最小実装: webhook URL を CI_STATUS KV (`discord:prCloseWebhookUrl`) に置き、
// pull_request の `closed` action で 1 件の embed を送る。Feature B
// (Bot token + self-heal channel) は PR3–5 で導入する。404 / 429 などの
// failure handling も PR4 (lazy heal) で本格対応。本 PR1 は send 結果を log
// に残すだけで、webhook pipeline の失敗を引き起こさない。
//
// Operator setup (one-time、PR1 段階の手動配線):
//   wrangler kv key put --remote \
//     --namespace-id=ffb983ee8324499f915b11a0b8cf787b \
//     'discord:prCloseWebhookUrl' '<discord-webhook-url>'
//
// PR2 で Hub DO storage (read-after-write 強整合) に移行するため、本 KV key
// は移行後 deprecate 予定。

export const WEBHOOK_URL_KV_KEY = "discord:prCloseWebhookUrl";

// Discord embed 色 (issue #441 の payload 仕様より)。
export const COLOR_MERGED = 0x7f00ff; // 紫
export const COLOR_CLOSED = 0xb23b3b; // 赤

export interface PrClosedEmbedInput {
  /** GitHub repository full name (`owner/name`). */
  repo: string;
  /** PR 番号 (`pull_request.number`)。 */
  number: number;
  /** PR title (`pull_request.title`)。 */
  title: string;
  /** PR の html_url (`pull_request.html_url`)。embed link target。 */
  url: string;
  /** merged かどうか (`pull_request.merged`)。色と state field を決める。 */
  merged: boolean;
  /** close を発火させた actor の login (`sender.login`)。 */
  sender: string;
  /** ISO timestamp。`pull_request.updated_at` を渡す。 */
  closedAt: string;
}

export interface DiscordEmbed {
  title: string;
  url: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp: string;
}

export interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
}

/** PR close 時の embed payload を組む。merged かどうかで色と state field を
 *  出し分ける。 */
export function buildPrClosedEmbed(input: PrClosedEmbedInput): DiscordWebhookPayload {
  const state = input.merged ? "merged" : "closed";
  const color = input.merged ? COLOR_MERGED : COLOR_CLOSED;
  return {
    embeds: [{
      title: `#${input.number} ${input.title}`,
      url: input.url,
      description: `${state} by ${input.sender}`,
      color,
      fields: [
        { name: "repo", value: input.repo, inline: true },
        { name: "state", value: state, inline: true },
      ],
      timestamp: input.closedAt,
    }],
  };
}

/** Discord webhook に embed を 1 件 POST する。HTTP status を返す
 *  (fetch error は 0)。retry / rate-limit / 404 heal は本 PR では未実装。 */
export async function postDiscordWebhook(
  webhookUrl: string,
  payload: DiscordWebhookPayload,
): Promise<number> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** KV から webhook URL を読み出す。未設定 (= 通知 disabled) なら null。 */
export async function readPrCloseWebhookUrl(kv: KVNamespace): Promise<string | null> {
  return await kv.get(WEBHOOK_URL_KV_KEY);
}

/** PR close 通知のエントリポイント。URL 未設定なら no-op。送信失敗時は
 *  log を出すのみで、webhook pipeline は止めない。 */
export async function notifyDiscordPrClosed(
  kv: KVNamespace,
  input: PrClosedEmbedInput,
): Promise<void> {
  const url = await readPrCloseWebhookUrl(kv);
  if (!url) return;
  const payload = buildPrClosedEmbed(input);
  const status = await postDiscordWebhook(url, payload);
  if (status >= 200 && status < 300) return;
  console.log(JSON.stringify({
    msg: "discord-pr-close-notify-failed",
    repo: input.repo,
    number: input.number,
    status,
  }));
}
