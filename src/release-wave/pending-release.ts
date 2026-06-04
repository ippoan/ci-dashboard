/**
 * Pending release (no-traffic version) の KV 永続化。
 *
 * 設計の親 issue: ippoan/ci-dashboard#181 (Refs #174)
 *
 * frontend-ci.yml の release deploy が `wrangler versions upload` (no-traffic)
 * した後、その version_id / tag / preview_url を
 * `POST /webhooks/release-wave/pending-release` に報告する。ci-dashboard は
 * `pending-release::<repo>` を COMPAT_KV に upsert し、/release-wave 一覧の
 * 「Pending releases」セクションに出して Flip ボタンで 100% promote させる。
 *
 * release-wave (stage→approve→flip) とは独立した、単独 v* リリースの
 * no-traffic version を flip する経路。
 */

const PENDING_RELEASE_PREFIX = "pending-release::";
const SCHEMA_VERSION = 1 as const;

/** no-traffic version の昇格待ち record。`repo` 単位で最新 1 件のみ保持。 */
export interface PendingReleaseRecord {
  schema_version: typeof SCHEMA_VERSION;
  /** "owner/name"。 */
  repo: string;
  /** `wrangler versions upload` が返した version id (UUID)。flip 対象。 */
  version_id: string;
  /** リリース tag (e.g. v0.2.38)。表示 / compat current_image 用。 */
  tag: string;
  /** version preview URL (workers.dev)。無ければ null。 */
  preview_url: string | null;
  /** upload 報告を受けた UTC ISO。 */
  uploaded_at: string;
}

function pendingReleaseKey(repo: string): string {
  return `${PENDING_RELEASE_PREFIX}${repo}`;
}

/** upsert: repo ごとに最新 upload で上書きする (古い未 flip version は捨てる)。 */
export async function recordPendingRelease(
  kv: KVNamespace,
  input: {
    repo: string;
    version_id: string;
    tag: string;
    preview_url?: string | null;
    now: string;
  },
): Promise<PendingReleaseRecord> {
  const record: PendingReleaseRecord = {
    schema_version: SCHEMA_VERSION,
    repo: input.repo,
    version_id: input.version_id,
    tag: input.tag,
    preview_url: input.preview_url ?? null,
    uploaded_at: input.now,
  };
  await kv.put(pendingReleaseKey(input.repo), JSON.stringify(record));
  return record;
}

/** 単一 repo の pending release を取得 (無ければ null)。 */
export async function getPendingRelease(
  kv: KVNamespace,
  repo: string,
): Promise<PendingReleaseRecord | null> {
  const v = await kv.get<PendingReleaseRecord>(pendingReleaseKey(repo), "json");
  if (!v || v.schema_version !== SCHEMA_VERSION) return null;
  return v;
}

/** 全 pending release を列挙 (uploaded_at 降順)。 */
export async function listPendingReleases(
  kv: KVNamespace,
): Promise<PendingReleaseRecord[]> {
  const out: PendingReleaseRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: PENDING_RELEASE_PREFIX, cursor });
    for (const key of page.keys) {
      const rec = await kv.get<PendingReleaseRecord>(key.name, "json");
      if (rec && rec.schema_version === SCHEMA_VERSION) {
        out.push(rec);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1));
  return out;
}

/** flip 完了後に record を消す。 */
export async function clearPendingRelease(
  kv: KVNamespace,
  repo: string,
): Promise<void> {
  await kv.delete(pendingReleaseKey(repo));
}

// ----------------------------------------------------------------------------
// Flip group (= wave 一括 flip / 一括 rollback の単位) — Refs #237 / #96
// ----------------------------------------------------------------------------
//
// 「wave = 複数 repo の pending release を一括 flip する箱」。一括 flip 時に
// 各 repo の「直前の active version (= 戻し先)」を控えて 1 件の flip-group として
// 保存し、後から同じ set を一括 rollback できるようにする。最新 1 件のみ保持
// (= 直近の一括 flip を rollback する用途)。

const FLIP_GROUP_KEY = "flip-group::latest";
const FLIP_GROUP_SCHEMA = 1 as const;

/** flip-group に含まれる repo 1 件分。 */
export interface FlipGroupItem {
  /** "owner/name"。 */
  repo: string;
  /** 今回 100% に flip した version id。 */
  flipped_version_id: string;
  /** flip した version の release tag。 */
  flipped_tag: string;
  /** flip 直前に active だった version id (= 一括 rollback の戻し先)。不明なら null。 */
  rollback_to: string | null;
  /** 戻し先 version の release tag (不明なら null)。 */
  rollback_tag: string | null;
}

/** 直近の一括 flip の record (最新 1 件のみ KV 保持)。 */
export interface FlipGroupRecord {
  schema_version: typeof FLIP_GROUP_SCHEMA;
  /** 一括 flip を実行した UTC ISO。 */
  flipped_at: string;
  /** 実行者 email (audit)。 */
  actor: string;
  /** 一括 flip した repo 群。 */
  items: FlipGroupItem[];
}

/** 一括 flip 実行時に flip-group を保存する (最新で上書き)。 */
export async function recordFlipGroup(
  kv: KVNamespace,
  input: { flipped_at: string; actor: string; items: FlipGroupItem[] },
): Promise<FlipGroupRecord> {
  const record: FlipGroupRecord = {
    schema_version: FLIP_GROUP_SCHEMA,
    flipped_at: input.flipped_at,
    actor: input.actor,
    items: input.items,
  };
  await kv.put(FLIP_GROUP_KEY, JSON.stringify(record));
  return record;
}

/** 直近の flip-group を取得 (無ければ null)。 */
export async function getFlipGroup(
  kv: KVNamespace,
): Promise<FlipGroupRecord | null> {
  const v = await kv.get<FlipGroupRecord>(FLIP_GROUP_KEY, "json");
  if (!v || v.schema_version !== FLIP_GROUP_SCHEMA) return null;
  return v;
}

/** 一括 rollback 完了後に flip-group を消す。 */
export async function clearFlipGroup(kv: KVNamespace): Promise<void> {
  await kv.delete(FLIP_GROUP_KEY);
}

// ----------------------------------------------------------------------------
// 単一真実の Pending releases 導出 (Refs #237)
// ----------------------------------------------------------------------------
//
// 「flip 待ちの no-traffic version」を 1 系統に統合する。従来は
// pending-release:: KV と traffic:: の 0% version が別々に表示され drift して
// いた。ここでは:
//   - workers (traffic::<repo> を持つ): Cloudflare 実機 (traffic-report) の
//     no-traffic promotable version を真実とする。flip は traffic-rollback 経由
//     (= wrangler versions deploy <id>@100%)。
//   - cloudrun 等 (traffic:: を持たない): pending-release:: record を使う。
//     flip は pending-release/flip 経由 (handler が platform routing)。
// traffic:: を持つ repo は traffic:: を優先し、pending-release:: は無視する。

import type { TrafficRecord, TrafficVersion } from "./traffic";

/** flip 入口の種別。traffic=workers / pending=cloudrun 等。 */
export type PendingSource = "traffic" | "pending";

/** Pending releases の 1 行 (統合表現)。 */
export interface UnifiedPending {
  repo: string;
  version_id: string;
  tag: string | null;
  uploaded_at: string;
  preview_url: string | null;
  source: PendingSource;
  /** flip 直前の active version (= rollback 先)。traffic source のみ取れる。 */
  rollback_to: string | null;
  rollback_tag: string | null;
}

/**
 * traffic record から「flip 待ちの最新 no-traffic version」を返す。
 * = 0% かつ現 active より新しい version の最新 1 件 (renderTrafficVersionsBlock の
 * zeroShown と同義)。無ければ null。
 */
export function noTrafficPromotable(
  rec: TrafficRecord,
): TrafficVersion | null {
  const versions = rec.versions ?? [];
  const active = versions.filter((v) => v.percentage > 0);
  const activeNewest = active
    .map((v) => v.created_on)
    .filter((c): c is string => !!c)
    .sort()
    .at(-1);
  const zero = versions
    .filter((v) => v.percentage <= 0)
    .filter((v) => {
      if (!activeNewest) return true; // active の日時不明 → 全て候補
      if (!v.created_on) return false; // 日時不明の古い 0% は除外
      return v.created_on > activeNewest; // active より新しいものだけ
    })
    .sort((a, b) => {
      const ca = a.created_on ?? "";
      const cb = b.created_on ?? "";
      if (ca === cb) return 0;
      if (!ca) return 1;
      if (!cb) return -1;
      return ca < cb ? 1 : -1; // 新しい順
    });
  return zero[0] ?? null;
}

/** traffic record の現 active version (= rollback 先候補) を返す。 */
function currentActiveOf(
  rec: TrafficRecord,
): { version_id: string; tag: string | null } | null {
  const hist = rec.deploy_history ?? [];
  if (hist[0]) return { version_id: hist[0].version_id, tag: hist[0].tag ?? null };
  const a =
    (rec.versions ?? []).find((v) => v.percentage === 100) ??
    (rec.versions ?? []).find((v) => v.percentage > 0);
  return a ? { version_id: a.version_id, tag: a.tag ?? null } : null;
}

/**
 * Pending releases の単一真実リストを組む (Refs #237)。uploaded_at 降順。
 */
export function computeUnifiedPending(
  trafficByRepo: Map<string, TrafficRecord>,
  pendingRecords: PendingReleaseRecord[],
): UnifiedPending[] {
  const out: UnifiedPending[] = [];
  const seen = new Set<string>();
  for (const [repo, rec] of trafficByRepo) {
    const v = noTrafficPromotable(rec);
    if (!v) continue;
    const active = currentActiveOf(rec);
    out.push({
      repo,
      version_id: v.version_id,
      tag: v.tag ?? null,
      uploaded_at: v.created_on ?? "",
      preview_url: null,
      source: "traffic",
      rollback_to: active?.version_id ?? null,
      rollback_tag: active?.tag ?? null,
    });
    seen.add(repo);
  }
  for (const r of pendingRecords) {
    if (seen.has(r.repo)) continue; // traffic:: の no-traffic promotable を持つ repo は traffic:: 優先
    const rec = trafficByRepo.get(r.repo) ?? null;
    // flip 済み判定: pending-release:: が指す version が traffic:: で既に active
    // (percentage > 0) なら、その release は既に flip 済み。pending-release:: は
    // deploy 時 (frontend-ci) に作られ traffic-report では clear されないため、
    // flip 後も stale record として残る。これを出すと「flip 済みなのに Pending に
    // 残る」状態になる (Refs ippoan/ci-dashboard#248)。
    // ※ deploy 直後 (未 flip) は traffic:: に当該 version が無い (= active 判定
    //    false) ので、ちゃんと Pending に出る。
    if (
      rec &&
      (rec.versions ?? []).some(
        (v) => v.version_id === r.version_id && v.percentage > 0,
      )
    ) {
      continue;
    }
    // pending source (cloudrun 等) でも traffic:: record があれば現 active を
    // rollback 先として控える (= 一括 flip → flip-group rollback の戻し先確保、
    // Refs ippoan/ci-dashboard#241)。traffic:: が無ければ null (戻し先不明)。
    const active = rec ? currentActiveOf(rec) : null;
    out.push({
      repo: r.repo,
      version_id: r.version_id,
      tag: r.tag,
      uploaded_at: r.uploaded_at,
      preview_url: r.preview_url ?? null,
      source: "pending",
      rollback_to: active?.version_id ?? null,
      rollback_tag: active?.tag ?? null,
    });
  }
  out.sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1));
  return out;
}
