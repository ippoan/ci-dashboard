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
