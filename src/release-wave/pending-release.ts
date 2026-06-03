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
