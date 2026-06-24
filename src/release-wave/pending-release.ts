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
  /**
   * monorepo unit worker 名 (CF script 名)。単一 worker / legacy は null。
   * 非 null の record は `pending-release::<repo>::<worker>` キーで保存される。
   * Refs #427。
   */
  worker_name?: string | null;
  /** `wrangler versions upload` が返した version id (UUID)。flip 対象。 */
  version_id: string;
  /** リリース tag (e.g. v0.2.38)。表示 / compat current_image 用。 */
  tag: string;
  /** version preview URL (workers.dev)。無ければ null。 */
  preview_url: string | null;
  /** upload 報告を受けた UTC ISO。 */
  uploaded_at: string;
}

function pendingReleaseKey(repo: string, workerName?: string | null): string {
  // monorepo unit は `pending-release::<repo>::<worker>`、単一/legacy は
  // `pending-release::<repo>`。`::` 区切りで別 repo prefix と衝突しない。
  return workerName
    ? `${PENDING_RELEASE_PREFIX}${repo}::${workerName}`
    : `${PENDING_RELEASE_PREFIX}${repo}`;
}

/** upsert: (repo, worker) ごとに最新 upload で上書きする (古い未 flip version は捨てる)。 */
export async function recordPendingRelease(
  kv: KVNamespace,
  input: {
    repo: string;
    version_id: string;
    tag: string;
    preview_url?: string | null;
    now: string;
    /** monorepo unit worker 名 (省略時は単一 worker / legacy = repo-key)。 */
    worker_name?: string | null;
  },
): Promise<PendingReleaseRecord> {
  const workerName = input.worker_name ?? null;
  const record: PendingReleaseRecord = {
    schema_version: SCHEMA_VERSION,
    repo: input.repo,
    ...(workerName ? { worker_name: workerName } : {}),
    version_id: input.version_id,
    tag: input.tag,
    preview_url: input.preview_url ?? null,
    uploaded_at: input.now,
  };
  await kv.put(pendingReleaseKey(input.repo, workerName), JSON.stringify(record));
  return record;
}

/** 単一 (repo, worker) の pending release を取得 (無ければ null)。 */
export async function getPendingRelease(
  kv: KVNamespace,
  repo: string,
  workerName?: string | null,
): Promise<PendingReleaseRecord | null> {
  const v = await kv.get<PendingReleaseRecord>(
    pendingReleaseKey(repo, workerName),
    "json",
  );
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

/** flip 完了後に record を消す。monorepo は worker_name で対象 unit を指定。 */
export async function clearPendingRelease(
  kv: KVNamespace,
  repo: string,
  workerName?: string | null,
): Promise<void> {
  await kv.delete(pendingReleaseKey(repo, workerName));
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
  /** monorepo unit worker 名 (単一 worker repo は null)。一括 rollback の dispatch に使う。 */
  worker_name?: string | null;
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
  /** monorepo unit worker 名 (単一 worker repo は null)。flip dispatch の cf_worker_name 源。 */
  worker_name: string | null;
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
 *
 * (repo, worker) ごとに 1 行を導出する。各 key について:
 *
 *  - **flip 機構 (source)** は traffic:: record の有無で決める:
 *    traffic:: を持つ = workers (flip は `wrangler versions deploy <id>@100%` =
 *    traffic-rollback dispatch)、持たない = cloudrun 等 (pending-release/flip
 *    handler が platform routing)。
 *  - **flip 対象 version + release tag** は「未 flip の pending-release:: record」を
 *    最優先で採用する。理由: release tag は CF version (traffic::) には**乗らない**
 *    (`wrangler versions list` の tag は常に null)。tag を持つのは
 *    pending-release:: record だけ。traffic:: 由来の untagged version を優先すると
 *    `!tag → 未tag — flip不可` の gate に永久に弾かれる (= monorepo unit / 単一
 *    worker の release deploy が flip できない実害、Refs #427)。さらに
 *    report-traffic-split は propagation lag で **upload 直後の version を versions
 *    list に含められない**ことがあり、traffic:: 由来だと 1 つ前の untagged 0%
 *    version で shadow される。durable な tag 源は pending-release:: record。
 *  - pending-release:: record が**既に flip 済み** (traffic:: で当該 version が
 *    active = percentage > 0) なら、その release は完了済みなので採用しない
 *    (#248 の「flip 済みなのに Pending に残る」回避)。
 *  - pending-release:: record が無い / flip 済みなら、従来どおり traffic:: 由来の
 *    promotable (untagged。手動 upload / legacy 経路) に fall back する。
 */
export function computeUnifiedPending(
  trafficRecords: TrafficRecord[],
  pendingRecords: PendingReleaseRecord[],
): UnifiedPending[] {
  const out: UnifiedPending[] = [];
  // (repo, worker) 複合キー。monorepo unit を repo 単位で潰さず個別に扱う。
  const composite = (repo: string, worker: string | null): string =>
    `${repo}::${worker ?? ""}`;

  const trafficByKey = new Map<string, TrafficRecord>();
  for (const rec of trafficRecords) {
    trafficByKey.set(composite(rec.repo, rec.worker_name ?? null), rec);
  }
  const pendingByKey = new Map<string, PendingReleaseRecord>();
  for (const r of pendingRecords) {
    pendingByKey.set(composite(r.repo, r.worker_name ?? null), r);
  }

  // traffic:: / pending-release:: のどちらか一方でも持つ全 (repo, worker) を
  // 1 度ずつ処理する。
  const keys = new Set<string>([
    ...trafficByKey.keys(),
    ...pendingByKey.keys(),
  ]);

  for (const k of keys) {
    const tr = trafficByKey.get(k) ?? null;
    const pr = pendingByKey.get(k) ?? null;
    // flip 機構: traffic:: を持つ = workers、持たない = cloudrun 等。
    const source: PendingSource = tr ? "traffic" : "pending";
    const active = tr ? currentActiveOf(tr) : null;

    // pending-release:: record が指す version が既に flip 済み (traffic:: で active)
    // か。pending-release:: は deploy 時 (frontend-ci) に作られ traffic-report では
    // clear されないため、flip 後も stale record として残る (Refs #248)。
    const prFlipped =
      pr != null &&
      tr != null &&
      (tr.versions ?? []).some(
        (v) => v.version_id === pr.version_id && v.percentage > 0,
      );

    // 未 flip の pending-release:: record があれば、それを tagged な真実として採用。
    if (pr && !prFlipped) {
      out.push({
        repo: pr.repo,
        worker_name: pr.worker_name ?? null,
        version_id: pr.version_id,
        tag: pr.tag,
        uploaded_at: pr.uploaded_at,
        preview_url: pr.preview_url ?? null,
        source,
        rollback_to: active?.version_id ?? null,
        rollback_tag: active?.tag ?? null,
      });
      continue;
    }

    // pending-release:: record が無い / flip 済み → traffic:: 由来の promotable
    // (untagged。手動 upload / legacy 経路。tag が無ければ flip gate で弾かれる)。
    if (tr) {
      const v = noTrafficPromotable(tr);
      if (!v) continue;
      out.push({
        repo: tr.repo,
        worker_name: tr.worker_name ?? null,
        version_id: v.version_id,
        tag: v.tag ?? null,
        uploaded_at: v.created_on ?? "",
        preview_url: null,
        source: "traffic",
        rollback_to: active?.version_id ?? null,
        rollback_tag: active?.tag ?? null,
      });
    }
  }
  out.sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1));
  return out;
}
