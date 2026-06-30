// Discord PR close notification (Refs #441 PR1 + PR2).
//
// PR1 の最小実装: webhook URL を CI_STATUS KV (`discord:prCloseWebhookUrl`)
// に置き、pull_request の `closed` action で 1 件の embed を送る。
//
// PR2 (本 PR): URL の SoT を `CIDashboardHub` DO storage に移した。理由は
// PR3 以降の self-heal が「死んだ URL → 新 URL」を書き換えた直後に同 DO で
// 強整合 read する必要があるため (KV global propagation は最大 ~60s で
// 読み手が古い死 URL を引き続ける窓ができる)。
//
// KV (`discord:prCloseWebhookUrl`) は **legacy seed** として残す: 旧 PR1
// で operator が `wrangler kv key put` した値を Hub DO の `getDiscord...`
// が初回 read で吸い上げ → DO に書き写し → 以後は DO のみが読まれる
// (releases index v3 → v4 migration と同じ pattern)。
//
// 値の更新経路:
//   - 旧 (PR1): operator が `wrangler kv key put` で KV に書く
//   - 新 (PR2): operator は KV に書いて 1 回 deploy する (= 初回 send で
//     Hub DO に migrate)。以降の rotate は Hub DO `PUT /discord-webhook-url`
//     経由 (= PR3 の healChannel() も同 endpoint を叩く)。
//
// Failure handling (4xx / fetch error) は send 結果を log に残すだけで
// webhook pipeline は止めない。404 lazy heal は PR4 で結線する。

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

/** Hub DO から webhook URL を読み出す (Refs #441 PR2)。Hub 側で legacy KV
 *  からの lazy migration を行うので、本関数は単純な GET 1 本で OK。
 *  Hub 到達不能 / 非 OK は null (= 通知 disabled 扱い) で fail-open。 */
export async function readPrCloseWebhookUrl(
  hub: DurableObjectStub,
): Promise<string | null> {
  try {
    const res = await hub.fetch(new Request("http://hub/discord-webhook-url"));
    if (!res.ok) return null;
    const text = await res.text();
    return text ? text : null;
  } catch {
    return null;
  }
}

/** PR close 通知のエントリポイント。URL 未設定なら no-op。送信失敗時は
 *  log を出すのみで、webhook pipeline は止めない。 */
export async function notifyDiscordPrClosed(
  hub: DurableObjectStub,
  input: PrClosedEmbedInput,
): Promise<void> {
  const url = await readPrCloseWebhookUrl(hub);
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
