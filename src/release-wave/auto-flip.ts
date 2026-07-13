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
 * timeout は KV `expirationTtl` で表現する (DO alarm / cron 不要)。全部揃わない
 * まま TTL 到達で armed record が消滅 = タイムアウト中断。KV TTL のラグと
 * in-memory KV (test) 非対応に備え、`expires_at` を record にも持ち webhook
 * 到達時に超過を明示検知して clear する。
 *
 * 監視は worker 側 (webhook 駆動) — セッション / ブラウザ非依存。設計の詳細は
 * docs/plan-auto-flip-tag-release.md を参照。
 */

import type { Env } from "../index";
import { dispatchTagRelease } from "../tag-release";
import { computeGlobalCompatibility } from "./compat";
import { loadUnifiedPending, pendingFlipAllCore } from "./api";

const AUTO_FLIP_ARM_KEY = "auto-flip-arm::latest";
const SCHEMA_VERSION = 1 as const;

/** armed set の既定 TTL (秒)。全部揃わなければこの時間でタイムアウト中断。 */
export const AUTO_FLIP_DEFAULT_TTL_SECONDS = 30 * 60;

/** KV expirationTtl の下限 (Cloudflare KV は 60 秒未満を受け付けない)。 */
const KV_MIN_TTL_SECONDS = 60;

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

/** recheck の遅延 (秒)。KV list の結果キャッシュ (最大 60s) を跨いで再評価する。 */
export const AUTO_FLIP_RECHECK_DELAY_SECONDS = 60;

/** 重複予約防止 marker。scheduleReleasesIndexRekick (#337) と同方式。 */
const AUTO_FLIP_RECHECK_MARKER = "auto-flip::recheck-scheduled";

/** armed 状態の record。KV `auto-flip-arm::latest` に最新 1 件だけ保持。 */
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

/** armed record を登録する (最新で上書き、expirationTtl で timeout を表現)。 */
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
  await env.COMPAT_KV.put(AUTO_FLIP_ARM_KEY, JSON.stringify(record), {
    expirationTtl: Math.max(KV_MIN_TTL_SECONDS, ttl),
  });
  return record;
}

/** 現在の armed record を取得 (無ければ null)。 */
export async function getAutoFlipArm(
  env: Env,
): Promise<AutoFlipArmRecord | null> {
  if (!env.COMPAT_KV) return null;
  const v = await env.COMPAT_KV.get<AutoFlipArmRecord>(AUTO_FLIP_ARM_KEY, "json");
  if (!v || v.schema_version !== SCHEMA_VERSION) return null;
  return v;
}

/** armed record を消す (flip 完了 / disarm / timeout 中断)。 */
export async function clearAutoFlipArm(env: Env): Promise<void> {
  if (!env.COMPAT_KV) return;
  await env.COMPAT_KV.delete(AUTO_FLIP_ARM_KEY);
}

/** armed を blocked に落とす (compat gate 不通過)。残 TTL を保って上書き。 */
export async function setAutoFlipArmBlocked(
  env: Env,
  arm: AutoFlipArmRecord,
  reason: string,
  now: string,
): Promise<void> {
  if (!env.COMPAT_KV) return;
  const remainingSec = Math.floor(
    (Date.parse(arm.expires_at) - Date.parse(now)) / 1000,
  );
  const record: AutoFlipArmRecord = {
    ...arm,
    status: "blocked",
    blocked_reason: reason,
  };
  await env.COMPAT_KV.put(AUTO_FLIP_ARM_KEY, JSON.stringify(record), {
    expirationTtl: Math.max(KV_MIN_TTL_SECONDS, remainingSec),
  });
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
  | { action: "flip_failed"; error: string };

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
  let gateReason: string | null = null;
  try {
    const compat = await computeGlobalCompatibility(env.COMPAT_KV);
    if (compat.checked && !compat.verified) {
      const reds = compat.backends.flatMap((b) =>
        b.matrix
          .filter((m) => !m.tested_against_target)
          .map((m) => `${m.frontend}→${b.backend_repo}`),
      );
      gateReason =
        `compatibility 未検証: ` +
        (reds.slice(0, 8).join(", ") + (reds.length > 8 ? " …" : ""));
    }
  } catch {
    gateReason = null;
  }
  if (gateReason) {
    await setAutoFlipArmBlocked(env, arm, gateReason, now);
    return { action: "blocked", reason: gateReason };
  }

  // 全 repo release 完了 + gate OK → armed set 限定で flip all。
  const result = await pendingFlipAllCore(
    env,
    `auto-flip (${arm.actor})`,
    new Set(arm.repos),
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
