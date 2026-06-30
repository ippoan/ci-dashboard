// Discord PR close notification (Refs #441 PR1 + PR2 + PR4).
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
// PR4 (本 PR): `notifyDiscordPrClosed` に 404 lazy heal を結線。Discord は
// channel 削除を push しないため、死んだ webhook URL は次の send で
// 404 Unknown Webhook (10015) を返すことでしか検知できない。404 を見たら
// `healChannel()` (PR3) で新 channel + webhook を再発行し、Hub DO の
// `PUT /discord-webhook-url` で URL を rotate、`POST /discord-heal-record`
// で heal 履歴を Hub に記録 (WS で `{type: "discord-heal"}` を broadcast)、
// そして新 URL に embed を retry する。
//
// Bot token / KV settings が未設定なら heal は disabled (= 404 でも何もせず
// log のみ)。本 pipeline は **常に** 失敗を log のみに留め、webhook 全体を
// 止めない。

export const WEBHOOK_URL_KV_KEY = "discord:prCloseWebhookUrl";

// Discord embed 色 (issue #441 の payload 仕様より)。
export const COLOR_MERGED = 0x7f00ff; // 紫
export const COLOR_CLOSED = 0xb23b3b; // 赤
// CI workflow_run failure 用 (Refs #455)。PR close (`COLOR_CLOSED`) と
// 区別するため、より明るい赤橙にする。
export const COLOR_CI_FAILED = 0xd93f0b;

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

/** Hub DO の `PUT /discord-webhook-url` で URL を rotate (Refs #441 PR4)。
 *  PR2 で導入済みの endpoint を呼ぶラッパー。返値は成否 boolean。 */
export async function writePrCloseWebhookUrl(
  hub: DurableObjectStub,
  url: string | null,
): Promise<boolean> {
  try {
    const res = await hub.fetch(new Request("http://hub/discord-webhook-url", {
      method: "PUT",
      body: JSON.stringify({ url }),
    }));
    return res.ok;
  } catch {
    return false;
  }
}

/** Discord webhook URL の token 部分を `****` に置換する (Refs #441 PR4)。
 *  heal 履歴 / WS broadcast / log に URL を残す時に bot 認証相当の
 *  webhook token を漏らさないため。Discord の実 URL は `/webhooks/<digits>/<token>`
 *  だが、defense in depth で id 部の文字種は問わない (= test fixture 含め
 *  常に mask されることを保証)。 */
export function maskWebhookUrl(url: string): string {
  return url.replace(/\/webhooks\/([^/]+)\/[^/?]+/, "/webhooks/$1/****");
}

/** Hub DO に heal record を 1 件記録 (Refs #441 PR4)。Hub 側で append +
 *  WS broadcast を原子的に行う。失敗は fail-open (log だけ残して return)。 */
export interface DiscordHealRecord {
  /** heal を実行した時刻 (ISO 8601)。 */
  at: string;
  /** 死亡 detection した URL (token mask 済み)。 */
  deadUrl: string;
  /** 再発行された URL (token mask 済み)。 */
  newUrl: string;
  /** 再作成された channel name。 */
  channelName: string;
  /** 再作成された channel の Discord snowflake ID。 */
  channelId: string;
  /** heal の trigger 理由 (e.g. `"404 Unknown Webhook on send"`)。 */
  reason: string;
}

async function reportHeal(
  hub: DurableObjectStub,
  rec: DiscordHealRecord,
): Promise<void> {
  try {
    await hub.fetch(new Request("http://hub/discord-heal-record", {
      method: "POST",
      body: JSON.stringify(rec),
    }));
  } catch (err) {
    console.log(JSON.stringify({
      msg: "discord-heal-record-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

/** Discord 送信の共通本体 (Refs #441 PR4 / #455)。PR close と CI fail で
 *  heal/retry の流れが完全に同じなので、payload と log context だけを
 *  差し替えて再利用する。
 *
 *  通常 send → 200 系で return。それ以外:
 *    - 404 + `botToken` あり: `healChannel()` で新 webhook を再発行し、
 *      Hub DO storage の URL を更新 → heal を Hub に記録 → 新 URL で retry。
 *    - 404 + token 無し / heal 失敗 / 404 以外の非 OK: log のみで return。
 *  どのパスでも throw しない (webhook pipeline は止めない)。 */
async function sendDiscordPayload(
  hub: DurableObjectStub,
  kv: KVNamespace | null,
  botToken: string | null,
  payload: DiscordWebhookPayload,
  failedMsg: string,
  logContext: Record<string, unknown>,
): Promise<void> {
  const url = await readPrCloseWebhookUrl(hub);
  if (!url) return;
  let status = await postDiscordWebhook(url, payload);
  if (status >= 200 && status < 300) return;

  // 404 lazy heal (Refs #441 PR4)。token + KV settings の両方が揃っている
  // 時だけ試みる。それ以外は素直に log + 諦め。
  if (status === 404 && botToken && kv) {
    try {
      const { healChannel } = await import("./discord-heal");
      const heal = await healChannel(botToken, kv);
      if (heal) {
        const rotated = await writePrCloseWebhookUrl(hub, heal.newUrl);
        if (rotated) {
          await reportHeal(hub, {
            at: new Date().toISOString(),
            deadUrl: maskWebhookUrl(url),
            newUrl: maskWebhookUrl(heal.newUrl),
            channelName: heal.channelName,
            channelId: heal.channelId,
            reason: "404 Unknown Webhook on send",
          });
          status = await postDiscordWebhook(heal.newUrl, payload);
          if (status >= 200 && status < 300) return;
        }
      }
    } catch (err) {
      // healChannel が DiscordApiError 等を throw した時。403 (Bot 権限不足)
      // 等は operator action 待ちなので loud log で残す。pipeline は止めない。
      console.log(JSON.stringify({
        msg: "discord-heal-failed",
        ...logContext,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  console.log(JSON.stringify({
    msg: failedMsg,
    ...logContext,
    status,
  }));
}

/** PR close 通知のエントリポイント (Refs #441 PR4 = 404 lazy heal 結線)。
 *  `kv` / `botToken` を null にすると heal は無効化 (= PR3 以前と同等挙動)。
 *  operator が Bot token + KV settings を投入するまでは null を渡す。 */
export async function notifyDiscordPrClosed(
  hub: DurableObjectStub,
  kv: KVNamespace | null,
  botToken: string | null,
  input: PrClosedEmbedInput,
): Promise<void> {
  await sendDiscordPayload(
    hub, kv, botToken, buildPrClosedEmbed(input),
    "discord-pr-close-notify-failed",
    { repo: input.repo, number: input.number },
  );
}

export interface CiFailedEmbedInput {
  /** GitHub repository full name (`owner/name`). */
  repo: string;
  /** `workflow_run.name` (例: `CI`, `Deploy`, `Release Wave`)。 */
  workflow: string;
  /** `workflow_run.head_branch` (branch / tag)。 */
  branch: string;
  /** `workflow_run.conclusion` (`failure` を想定。embed の文言用)。 */
  conclusion: string;
  /** `workflow_run.actor.login`。 */
  actor: string;
  /** `workflow_run.html_url` (Actions run page、embed link target)。 */
  runUrl: string;
  /** `workflow_run.id` (log 識別子)。 */
  runId: number;
  /** ISO timestamp。`workflow_run.updated_at`。 */
  updatedAt: string;
}

/** CI workflow_run 失敗 embed (Refs #455)。PR close と区別するため
 *  COLOR_CI_FAILED + `❌ <workflow> failed` タイトルにする。 */
export function buildCiFailedEmbed(input: CiFailedEmbedInput): DiscordWebhookPayload {
  return {
    embeds: [{
      title: `❌ ${input.workflow} failed`,
      url: input.runUrl,
      description: `${input.repo} @ ${input.branch} (by ${input.actor})`,
      color: COLOR_CI_FAILED,
      fields: [
        { name: "repo", value: input.repo, inline: true },
        { name: "workflow", value: input.workflow, inline: true },
        { name: "branch", value: input.branch, inline: true },
      ],
      timestamp: input.updatedAt,
    }],
  };
}

/** CI workflow_run 失敗通知のエントリポイント (Refs #455)。PR close と
 *  同じ Hub DO の webhook URL + 404 lazy heal infra を共有する。
 *  `kv` / `botToken` を null にすると heal は無効化 (URL 無しなら no-op)。 */
export async function notifyDiscordCiFailed(
  hub: DurableObjectStub,
  kv: KVNamespace | null,
  botToken: string | null,
  input: CiFailedEmbedInput,
): Promise<void> {
  await sendDiscordPayload(
    hub, kv, botToken, buildCiFailedEmbed(input),
    "discord-ci-failed-notify-failed",
    { repo: input.repo, workflow: input.workflow, runId: input.runId },
  );
}
