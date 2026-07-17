/**
 * Tag Release all + Auto Flip (armed 機構) — Refs ippoan/ci-dashboard#476。
 *
 * 「全 repo を tag release し、対象 repo の release が全部完了したら自動的に
 * flip する」機能。ボタン押下時点で needsRelease だった repo 集合を armed set
 * として KV に登録し (`arm`)、各 repo の release deploy が no-traffic upload 後に
 * 叩く `POST /webhooks/release-wave/pending-release` の到達を完了検知シグナルに
 * 使う。armed set の全 repo が pending に揃い、compat gate を通過した時点で
 * ci-dashboard worker が `pendingFlipAllCore` を armed set 限定で発火する。
 *
 * armed record の SoT は ReleaseWaveHub DO storage (強整合、Refs #490)。以前は
 * COMPAT_KV に置いていたが、KV get の edge cache (~60s) が arm 直後の webhook に
 * null を読ませる窓を作り、recheck queue send 失敗と重なると発火しないまま TTL
 * 消滅した。timeout は record の `expires_at` で判定する (webhook / recheck 到達
 * 時に超過を明示検知して clear。UI も超過 record は表示しない)。
 *
 * 監視は worker 側 (webhook 駆動) — セッション / ブラウザ非依存。設計の詳細は
 * docs/plan-auto-flip-tag-release.md を参照。
 *
 * `runContinuousAutoFlip` (末尾、Refs #494) は上記の 1 回限りバッチ arm とは
 * 別の機構: Auto-tag ON (Refs #460) の repo 単体を対象に、release 完了ごとに
 * 継続的に (TTL 無し・他 repo 非依存で) flip する。
 */

import type { Env } from "../index";
import { dispatchTagRelease } from "../tag-release";
import { computeGlobalCompatibility } from "./compat";
import { loadUnifiedPending, pendingFlipAllCore } from "./api";
import type { PendingReleaseRecord } from "./pending-release";
import type { ReleaseWaveHub } from "./do";
import { isAutoTagRepo } from "../auto-tag";

const SCHEMA_VERSION = 1 as const;

/** armed set の既定 TTL (秒)。全部揃わなければこの時間でタイムアウト中断。 */
export const AUTO_FLIP_DEFAULT_TTL_SECONDS = 30 * 60;

/** KV expirationTtl の下限 (Cloudflare KV は 60 秒未満を受け付けない)。 */
const KV_MIN_TTL_SECONDS = 60;

/** ReleaseWaveHub singleton stub (webhook.ts / api.ts の hubStub と同じ解決)。 */
function hubStub(env: Env): DurableObjectStub<ReleaseWaveHub> {
  const id = env.RELEASE_WAVE_HUB.idFromName("singleton");
  return env.RELEASE_WAVE_HUB.get(id) as DurableObjectStub<ReleaseWaveHub>;
}

/** CI_HUB (Hub DO) singleton stub。auto-tag flag (`autoTag:repos`、Refs #460) の
 *  read に使う (auto-tag.ts / index.ts の getHub と同じ解決)。 */
function ciHubStub(env: Env): DurableObjectStub {
  const id = env.CI_HUB.idFromName("singleton");
  return env.CI_HUB.get(id);
}

/**
 * global compatibility gate 判定を単体関数に抽出 (`maybeAutoFlip` と
 * `runContinuousAutoFlip` (Refs #494) で共有)。非互換 (checked && !verified) な
 * ら理由文字列、互換 / 判定不能 (compat 取得失敗) なら null を返す。
 *
 * 呼び出し側の fail-open / fail-closed の判断は関数の外で行う: `maybeAutoFlip`
 * (手動 arm 起点) は null (判定不能) を素通しとして扱うが、`runContinuousAutoFlip`
 * (完全自動) は COMPAT_KV 未 bind 時点で呼ばずスキップする (fail-closed)。
 */
async function computeCompatGateReason(env: Env): Promise<string | null> {
  try {
    const compat = await computeGlobalCompatibility(env.COMPAT_KV!);
    if (compat.checked && !compat.verified) {
      const reds = compat.backends.flatMap((b) =>
        b.matrix
          .filter((m) => !m.tested_against_target)
          .map((m) => `${m.frontend}→${b.backend_repo}`),
      );
      return (
        `compatibility 未検証: ` +
        (reds.slice(0, 8).join(", ") + (reds.length > 8 ? " …" : ""))
      );
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Queue job (Refs #481): armed 中の auto-flip を webhook 到達と切り離して定期
 * 再評価する。webhook 駆動だけだと (1) 最後の repo の release が自分の
 * `kv.list` にまだ反映されず ready 未検知、(2) その後の再トリガー欠如、で armed が
 * 固着する。既存の `WEBHOOK_QUEUE` に遅延メッセージを流し、armed が clear /
 * expire するまで再評価ループを自走させる。
 */
export interface AutoFlipRecheckMessage {
  kind: "auto-flip-recheck";
}

/**
 * Queue job (Refs #485): pending-release webhook が「今 release した版」の権威
 * record を queue に載せ、consumer 側で flip を実行する。webhook が inline で
 * flip すると、直前に自分で書いた pending-release を KV から読み直す過程で edge
 * cache の stale な version を掴み、**古い版を 100% に昇格させて arm を成功として
 * clear する**事故が起きた (auth-worker v0.2.113 で発生、#485)。版そのものを
 * message で運べば KV 再読みに依存せず正しい版を flip できる。GitHub dispatch を
 * webhook 応答から切り離す狙いも兼ねる (best-effort、応答をブロックしない)。
 */
export interface AutoFlipFlipMessage {
  kind: "auto-flip-flip";
  /** webhook が報告した権威版 (KV から読み直さない flip 対象)。 */
  authoritative: PendingReleaseRecord;
}

/** recheck の遅延 (秒)。KV list の結果キャッシュ (最大 60s) を跨いで再評価する。 */
export const AUTO_FLIP_RECHECK_DELAY_SECONDS = 60;

/** 重複予約防止 marker。scheduleReleasesIndexRekick (#337) と同方式。 */
const AUTO_FLIP_RECHECK_MARKER = "auto-flip::recheck-scheduled";

/** armed 状態の record。ReleaseWaveHub DO storage に最新 1 件だけ保持。 */
export interface AutoFlipArmRecord {
  schema_version: typeof SCHEMA_VERSION;
  /** arm 時に needsRelease だった repo 集合 ("owner/name"、昇順・重複排除済み)。 */
  repos: string[];
  /** arm した UTC ISO。 */
  armed_at: string;
  /** タイムアウト期限 UTC ISO (armed_at + ttl)。超過で自動 flip せず中断。 */
  expires_at: string;
  /** arm した operator email (audit)。 */
  actor: string;
  /** armed = 監視中 / blocked = compat gate で自動 flip を止めた (手動対応待ち)。 */
  status: "armed" | "blocked";
  /** status=blocked の理由 (非互換 frontend→backend 等)。armed なら null。 */
  blocked_reason: string | null;
}

/** armed record を登録する (最新で上書き。timeout は expires_at の読み手判定)。 */
export async function armAutoFlip(
  env: Env,
  input: { repos: string[]; actor: string; now: string; ttlSeconds?: number },
): Promise<AutoFlipArmRecord | null> {
  if (!env.COMPAT_KV) return null;
  const ttl = input.ttlSeconds ?? AUTO_FLIP_DEFAULT_TTL_SECONDS;
  const repos = [...new Set(input.repos.map((r) => r.trim()).filter(Boolean))].sort();
  const armedAtMs = Date.parse(input.now);
  const expiresAt = new Date(armedAtMs + ttl * 1000).toISOString();
  const record: AutoFlipArmRecord = {
    schema_version: SCHEMA_VERSION,
    repos,
    armed_at: input.now,
    expires_at: expiresAt,
    actor: input.actor,
    status: "armed",
    blocked_reason: null,
  };
  await hubStub(env).putAutoFlipArm(record);
  return record;
}

/**
 * 現在の armed record を取得 (無ければ null)。DO 読みなので arm 直後でも
 * 取りこぼさない (Refs #490)。expires_at 超過の判定は caller が行う
 * (maybeAutoFlip は超過検知で clear、UI は表示だけ抑止する)。
 */
export async function getAutoFlipArm(
  env: Env,
): Promise<AutoFlipArmRecord | null> {
  if (!env.COMPAT_KV) return null;
  const v = await hubStub(env).getAutoFlipArm();
  if (!v || v.schema_version !== SCHEMA_VERSION) return null;
  return v;
}

/** armed record を消す (flip 完了 / disarm / timeout 中断)。 */
export async function clearAutoFlipArm(env: Env): Promise<void> {
  if (!env.COMPAT_KV) return;
  await hubStub(env).deleteAutoFlipArm();
}

/** armed を blocked に落とす (compat gate 不通過)。expires_at 据え置きで上書き。 */
export async function setAutoFlipArmBlocked(
  env: Env,
  arm: AutoFlipArmRecord,
  reason: string,
): Promise<void> {
  if (!env.COMPAT_KV) return;
  const record: AutoFlipArmRecord = {
    ...arm,
    status: "blocked",
    blocked_reason: reason,
  };
  await hubStub(env).putAutoFlipArm(record);
}

/** armed set の release 進捗。 */
export interface ArmProgress {
  total: number;
  released: number;
  /** release 完了 (pending に tag 付きで載った) repo。 */
  releasedRepos: string[];
  /** まだ release されていない repo。 */
  pendingRepos: string[];
  /** 全 repo が揃ったか (= 自動 flip 可能)。 */
  ready: boolean;
}

/**
 * armed set のうち何 repo が release 完了したかを算出する。
 *
 * 「release 完了」= その repo が Pending releases (単一真実) に tag 付き version
 * として載っていること。monorepo で unit が複数あっても repo 単位で 1 度でも
 * 揃えば完了扱い (arm は repo 単位で登録するため)。
 */
export async function computeArmProgress(
  env: Env,
  arm: AutoFlipArmRecord,
): Promise<ArmProgress> {
  const pending = await loadUnifiedPending(env);
  const releasedSet = new Set(
    pending.filter((u) => !!u.tag).map((u) => u.repo),
  );
  const releasedRepos = arm.repos.filter((r) => releasedSet.has(r));
  const pendingRepos = arm.repos.filter((r) => !releasedSet.has(r));
  return {
    total: arm.repos.length,
    released: releasedRepos.length,
    releasedRepos,
    pendingRepos,
    ready: arm.repos.length > 0 && pendingRepos.length === 0,
  };
}

/** UI (repo-status-section) に armed 状態を渡すためのビュー。 */
export interface AutoFlipArmView {
  arm: AutoFlipArmRecord;
  progress: ArmProgress;
}

/** maybeAutoFlip の結果 (log / test 用の判別 union)。 */
export type AutoFlipOutcome =
  | { action: "none" }
  | { action: "expired" }
  | { action: "blocked"; reason: string }
  | { action: "flipped"; flipped: number }
  | { action: "flip_failed"; error: string }
  /** flip を queue に載せた (実 flip は consumer が権威版で実行、Refs #485)。 */
  | { action: "enqueued" };

/**
 * pending-release webhook 到達時に呼ぶ完了検知 + 自動 flip。
 *
 * armed が無ければ no-op。expires_at 超過なら clear して中断。全 repo が揃い
 * compat gate を通過したら armed set 限定で flip all を発火し armed を clear
 * する。非互換なら blocked に落として手動対応に委ねる。best-effort で呼ぶこと
 * (webhook 応答をこの副作用で失敗させない)。
 */
export async function maybeAutoFlip(
  env: Env,
  now: string,
  justReleasedRepo?: string | null,
  /**
   * pending-release webhook が報告した権威版。渡すと当該 repo の flip 対象を
   * KV 再読みでなくこの版に固定する (stale cache 由来の誤 version flip を防ぐ、
   * Refs #485)。省略時は従来どおり KV から解決 (recheck ループ / 手動経路)。
   */
  justReleasedRecord?: PendingReleaseRecord | null,
): Promise<AutoFlipOutcome> {
  if (!env.COMPAT_KV) return { action: "none" };
  const arm = await getAutoFlipArm(env);
  if (!arm) return { action: "none" };

  // timeout: 期限超過なら armed を破棄 (全部揃わなかった = 中断)。
  if (now > arm.expires_at) {
    await clearAutoFlipArm(env);
    return { action: "expired" };
  }

  // 既に blocked = operator の手動対応待ち。再判定しない。
  if (arm.status === "blocked") return { action: "none" };

  const progress = await computeArmProgress(env, arm);
  // `kv.list` は最大 60s ラグる (Refs #481)。pending-release webhook が「今 release
  // した」と確証を持つ repo (= 直前に tag 付き pending-release:: を書いた repo) は、
  // list 反映を待たず released 扱いにして readiness を判定する。これで「最後の repo
  // の webhook が自分の list 未反映で ready を取り逃す」共通ケースを即 flip できる。
  const pendingRepos =
    justReleasedRepo && arm.repos.includes(justReleasedRepo)
      ? progress.pendingRepos.filter((r) => r !== justReleasedRepo)
      : progress.pendingRepos;
  const ready = arm.repos.length > 0 && pendingRepos.length === 0;
  if (!ready) return { action: "none" };

  // compat gate: 非互換 (checked && !verified) なら自動 flip せず blocked に落とす。
  // checked=false (誰も互換性 test していない) は既存 approve gate と同じく素通し。
  // compat 取得失敗時は gate をかけられないため blocked にはせず素通しする
  // (loud fail させると全 auto-flip が止まる。既存 UI も compat 失敗は degrade)。
  const gateReason = await computeCompatGateReason(env);
  if (gateReason) {
    await setAutoFlipArmBlocked(env, arm, gateReason);
    return { action: "blocked", reason: gateReason };
  }

  // 全 repo release 完了 + gate OK → armed set 限定で flip all。
  // justReleasedRecord があれば当該 repo の flip 対象をその権威版に固定する
  // (KV 再読みの stale cache を避ける、Refs #485)。
  const result = await pendingFlipAllCore(
    env,
    `auto-flip (${arm.actor})`,
    new Set(arm.repos),
    justReleasedRecord ? [justReleasedRecord] : undefined,
  );
  if (!result.ok) {
    // flip 発火失敗。armed は残し、次の webhook / operator に再試行を委ねる
    // (期限内なら次回 webhook で再発火、超過したら timeout で中断)。
    return { action: "flip_failed", error: result.error };
  }
  await clearAutoFlipArm(env);
  return { action: "flipped", flipped: result.flipped.length };
}

// ----------------------------------------------------------------------------
// Auto-tag ON repo の継続 auto-flip (Refs #494)
// ----------------------------------------------------------------------------

/** `runContinuousAutoFlip` の結果 (log / test 用の判別 union)。 */
export type ContinuousAutoFlipOutcome =
  | { action: "skip"; reason: "not-auto-tag" | "no-compat-kv" }
  | { action: "blocked"; reason: string }
  | { action: "flipped" }
  | { action: "flip_failed"; error: string };

/**
 * Auto-tag ON (`autoTag:repos`、Refs #460) の repo の pending release を、
 * release 完了 (pending-release webhook 到達) の度に即 flip する (Refs #494)。
 *
 * `armAutoFlip` の 1 回限りバッチ arm (#476) とは完全に独立: 他 repo の足並みを
 * 待たず、TTL も持たず、repo 単体を対象に毎 release で判定する継続監視。
 *
 * compat gate (global compatibility、`computeCompatGateReason` を armed 機構と
 * 共有) に引っかかれば flip せず skip する。**手動 arm と異なり判定不能
 * (COMPAT_KV 未 bind) でも fail-closed でスキップする** — armed は operator が
 * 明示的にボタンを押す確認ステップを経ているが、こちらは release の度に完全
 * 無人で発火するため、gate をかけられない状況で自動的に traffic を切り替えない
 * 方を安全側とする。skip した release は自動リトライしない (次の release /
 * 既存の手動 Flip ボタンに委ねる。継続的な再評価ループは持たない)。
 */
export async function runContinuousAutoFlip(
  env: Env,
  record: PendingReleaseRecord,
): Promise<ContinuousAutoFlipOutcome> {
  if (!env.CI_HUB) return { action: "skip", reason: "not-auto-tag" };
  const flagged = await isAutoTagRepo(ciHubStub(env), record.repo);
  if (!flagged) return { action: "skip", reason: "not-auto-tag" };

  if (!env.COMPAT_KV) return { action: "skip", reason: "no-compat-kv" };
  const gateReason = await computeCompatGateReason(env);
  if (gateReason) return { action: "blocked", reason: gateReason };

  const result = await pendingFlipAllCore(
    env,
    `auto-tag-flip (${record.repo})`,
    new Set([record.repo]),
    [record],
  );
  if (!result.ok) return { action: "flip_failed", error: result.error };
  return { action: "flipped" };
}

// ----------------------------------------------------------------------------
// Queue 駆動の定期再評価ループ (Refs #481)
// ----------------------------------------------------------------------------

/**
 * 次の recheck を遅延 enqueue する。armed が無ければ何もしない (無駄な tick を
 * 積まない)。重複予約は KV marker で dedup し、arm 時・各 webhook 時・recheck 時に
 * 何度呼んでも同時に走る chain は 1 本に保つ (scheduleReleasesIndexRekick と同方式)。
 * queue binding が無い環境 (dev / test) は no-op — その場合 webhook 駆動のみで動く。
 */
export async function scheduleAutoFlipRecheck(env: Env): Promise<void> {
  if (!env.WEBHOOK_QUEUE || !env.COMPAT_KV) return;
  const arm = await getAutoFlipArm(env);
  if (!arm || arm.status !== "armed") return; // 監視対象が無ければ予約しない
  if (await env.COMPAT_KV.get(AUTO_FLIP_RECHECK_MARKER)) return; // 予約済み
  await env.COMPAT_KV.put(AUTO_FLIP_RECHECK_MARKER, "1", {
    expirationTtl: KV_MIN_TTL_SECONDS,
  });
  try {
    await env.WEBHOOK_QUEUE.send(
      { kind: "auto-flip-recheck" },
      { delaySeconds: AUTO_FLIP_RECHECK_DELAY_SECONDS },
    );
  } catch {
    // 送信失敗は次の webhook / arm の enqueue に委ねる (marker は TTL で自然消滅)。
  }
}

/**
 * recheck queue job の本体。webhook 到達と切り離して maybeAutoFlip を実行し、まだ
 * armed が残るなら次の tick を予約してループを継続する (armed が clear / expire /
 * blocked になったら停止)。best-effort — 例外は握り潰し、ループが死なないよう
 * 続行可能な限り再予約する。
 */
export async function runAutoFlipRecheck(env: Env): Promise<void> {
  // このジョブが消化された = 次の予約を許可するため marker を消す (delay > marker
  // TTL でなくても確実に再予約できるようにする)。
  if (env.COMPAT_KV) {
    try {
      await env.COMPAT_KV.delete(AUTO_FLIP_RECHECK_MARKER);
    } catch {
      // marker 削除失敗は TTL 消滅に委ねる。
    }
  }
  let outcome: AutoFlipOutcome = { action: "none" };
  try {
    outcome = await maybeAutoFlip(env, new Date().toISOString());
  } catch (e) {
    outcome = {
      action: "flip_failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  console.log(
    JSON.stringify({ msg: "auto-flip-recheck", outcome }),
  );
  // まだ armed が残る (未 ready / flip 失敗) 場合のみ次の tick を予約する。
  // flipped / expired / disarmed / blocked では arm が armed でなくなるので停止。
  try {
    await scheduleAutoFlipRecheck(env);
  } catch {
    // 次の webhook 到達が拾う。
  }
}

// ----------------------------------------------------------------------------
// Queue 駆動の flip (権威版を message で運ぶ、Refs #485)
// ----------------------------------------------------------------------------

/**
 * pending-release webhook から呼ぶ。armed 中なら「今 release した権威版」を queue に
 * 載せ、実 flip は consumer (`runAutoFlipFlip`) に委ねる。これで flip 対象の version を
 * KV から読み直さず message で運び、edge cache の stale な版を掴む事故 (#485) を防ぐ。
 *
 * - armed でなければ no-op (無関係な release で queue を汚さない)。
 * - queue binding が無い環境 (dev / test) は inline fallback として `maybeAutoFlip` を
 *   権威版付きで直接呼ぶ (挙動互換 + 同じく正しい版を flip)。
 * - best-effort — 送信失敗時も inline fallback に落とす。
 */
export async function enqueueAutoFlipFlip(
  env: Env,
  record: PendingReleaseRecord,
): Promise<AutoFlipOutcome> {
  if (!env.COMPAT_KV) return { action: "none" };
  const arm = await getAutoFlipArm(env);
  if (!arm || arm.status !== "armed") return { action: "none" };
  if (!env.WEBHOOK_QUEUE) {
    // queue が無い環境は従来どおり inline flip (権威版で)。
    return maybeAutoFlip(env, new Date().toISOString(), record.repo, record);
  }
  try {
    await env.WEBHOOK_QUEUE.send({ kind: "auto-flip-flip", authoritative: record });
    return { action: "enqueued" };
  } catch {
    // 送信失敗は inline fallback (best-effort)。
    return maybeAutoFlip(env, new Date().toISOString(), record.repo, record);
  }
}

/**
 * `auto-flip-flip` queue job の本体。message が運んだ権威版で当該 repo の flip 対象を
 * 固定して `maybeAutoFlip` を実行する。arm が既に clear / expired / blocked なら
 * `maybeAutoFlip` 側が no-op で畳む (idempotent — 同 batch に複数 message があっても
 * 最初の 1 本が flip して arm を消し、残りは none)。
 */
export async function runAutoFlipFlip(
  env: Env,
  record: PendingReleaseRecord,
): Promise<AutoFlipOutcome> {
  return maybeAutoFlip(env, new Date().toISOString(), record.repo, record);
}

// ----------------------------------------------------------------------------
// form-POST handlers (/release-wave ページは strict CSP なので JS fetch 不可)
// ----------------------------------------------------------------------------

/** CF Access が転送する authenticated user email。dev fallback は "operator"。 */
function actorEmail(req: Request): string {
  const v = req.headers.get("Cf-Access-Authenticated-User-Email");
  return (v && v.trim()) || "operator";
}

function redirectToList(): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: "/release-wave" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function errorPage(title: string, bodyHtml: string, status: number): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title></head><body>
${bodyHtml}
<p><a href="/release-wave">&larr; Release Wave に戻る</a></p>
</body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** form / JSON から repos (カンマ区切り or 配列) を取り出す。 */
async function parseRepos(req: Request): Promise<string[]> {
  let reposRaw: string | null = null;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    reposRaw = new URLSearchParams(await req.text()).get("repos");
  } else {
    try {
      const j = await req.json<{ repos?: string | string[] }>();
      reposRaw = Array.isArray(j.repos) ? j.repos.join(",") : (j.repos ?? null);
    } catch {
      reposRaw = null;
    }
  }
  return (reposRaw ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * POST /api/release-wave/auto-flip/arm  (form field `repos` = カンマ区切り)。
 *
 * 対象 repo の `tag-release.yml` を一括 dispatch し、armed set を登録する。
 * dispatch が 1 件でも失敗したら armed せず失敗一覧を報告する (all-or-nothing:
 * 揃わない repo があると auto-flip は永久に発火しないため、部分 arm は避ける)。
 */
export async function handleReleaseWaveAutoFlipArm(
  req: Request,
  env: Env,
): Promise<Response> {
  if (!env.COMPAT_KV) {
    return errorPage(
      "Auto-flip arm failed",
      `<p>auto-flip arm failed: COMPAT_KV is not bound</p>`,
      500,
    );
  }
  const repos = [...new Set(await parseRepos(req))].sort();
  if (repos.length === 0) {
    return errorPage(
      "Auto-flip arm failed",
      `<p>auto-flip arm failed: no repos provided</p>`,
      400,
    );
  }

  // 1. 各 repo の tag-release.yml を逐次 dispatch。
  const failures: string[] = [];
  for (const repo of repos) {
    const r = await dispatchTagRelease(env, repo);
    if (!r.ok) failures.push(`${repo}: ${r.error ?? "unknown error"}`);
  }
  if (failures.length > 0) {
    const items = failures.map((f) => `<li>${escapeHtml(f)}</li>`).join("");
    return errorPage(
      "Auto-flip arm partially failed",
      `<p>auto-flip arm: ${repos.length - failures.length}/${repos.length} dispatched, ${failures.length} failed. armed はキャンセルしました (再試行してください):</p>
<ul>${items}</ul>`,
      502,
    );
  }

  // 2. 全 dispatch 成功 → armed set を登録。
  await armAutoFlip(env, {
    repos,
    actor: actorEmail(req),
    now: new Date().toISOString(),
  });

  // 3. webhook 到達と切り離した再評価ループを起動する (Refs #481)。webhook が
  // list ラグや取りこぼしで ready を検知し損ねても、この recheck が拾って flip する。
  await scheduleAutoFlipRecheck(env);

  return redirectToList();
}

/** POST /api/release-wave/auto-flip/disarm  — armed を手動解除する。 */
export async function handleReleaseWaveAutoFlipDisarm(
  req: Request,
  env: Env,
): Promise<Response> {
  await clearAutoFlipArm(env);
  return redirectToList();
}
