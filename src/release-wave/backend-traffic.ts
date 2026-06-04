/**
 * Cloud Run backend の「実 traffic split」(status.traffic[]) の KV 永続化。
 *
 * release-wave-handler の cloudrun flip / rollback 後に release-wave-gcp の
 * `/cloudrun/stage-check` (GetService) で取得した実 traffic を報告し、
 * `backend-traffic::<repo>` として COMPAT_KV に保存する。/release-wave の backend
 * 表示で「今 GCP で各 revision が何 % traffic を持つか」を実態ベースで出す。
 *
 * これが要るのは、Cloud Run の release-wave 運用が **tag push → `--no-traffic`
 * deploy (新 revision 0%) → Flip (新 100%)** だから。Flip 前は常に「旧 revision
 * 100% + 新 pending revision 0%」の 2 revision 状態になり、報告値ベースの
 * `backend::<repo>.current_image` (= flip 後の target_tag) だけでは pending
 * revision (0%) が Traffic 表示に出ない。GCP の `status.traffic[]` を映すことで
 * frontend の `traffic::<repo>` (Cloudflare Workers の version split) と対称になる。
 *
 * frontend (`traffic.ts`) は 1 repo = 1 worker だが、backend は 1 repo = N service
 * (例 rust-alc-api 本体 + gateway) なので **service 単位**で traffic を持つ。
 *
 * KV namespace は COMPAT_KV (CI_STATUS と同一 namespace、prefix で分離)。
 * `backend-traffic::` prefix は `frontend::` / `backend::` / `traffic::` /
 * `pending-release::` と衝突しない。
 */

const BACKEND_TRAFFIC_PREFIX = "backend-traffic::";

/** 現行 schema version (破壊的変更時に bump)。 */
const SCHEMA_VERSION = 1 as const;

/** Cloud Run 1 revision の traffic 配分。 */
export interface BackendRevisionTraffic {
  /** short revision name (例 `rust-alc-api-00042-abc`)。 */
  revision: string;
  /** traffic 配分 % (0〜100)。 */
  percent: number;
  /**
   * Cloud Run revision tag (例 `pending-v1-4-3`、`v1.4.2` 等)。
   * `status.traffic[].tag` 由来。無ければ null。
   */
  tag: string | null;
}

/** 1 Cloud Run service の traffic 配分。 */
export interface BackendServiceTraffic {
  /** Cloud Run service 名 (例 `rust-alc-api`)。 */
  service: string;
  /** revision 配分。percent 降順 (100% を上に) で並ぶ。 */
  revisions: BackendRevisionTraffic[];
}

/** `backend-traffic::<repo>` value。repo ごとに最新の service 別 traffic を保持 (upsert)。 */
export interface BackendTrafficRecord {
  schema_version: number;
  /** "owner/name"。 */
  repo: string;
  /** service 別の traffic split。service 名昇順で並ぶ。 */
  services: BackendServiceTraffic[];
  /** 報告を受けた UTC ISO。 */
  reported_at: string;
}

function backendTrafficKey(repo: string): string {
  return `${BACKEND_TRAFFIC_PREFIX}${repo}`;
}

/**
 * 報告された service 別 traffic で record を置き換える (upsert、最新報告で全置換)。
 *
 * 各 service の revisions は percent 降順 (同率は revision 名昇順) に、service は
 * service 名昇順に整列して保存する。報告は flip/rollback callback で全 service を
 * まとめて 1 回送る前提なので read-modify-write の merge はしない (frontend の
 * `traffic.ts` と違い tag の蓄積も不要 — tag は GCP の `status.traffic[]` が常に
 * 最新を返す)。
 */
export async function recordBackendTraffic(
  kv: KVNamespace,
  input: {
    repo: string;
    services: BackendServiceTraffic[];
    now: string;
  },
): Promise<BackendTrafficRecord> {
  const services = input.services
    .map((s) => ({
      service: s.service,
      revisions: [...s.revisions].sort((a, b) => {
        if (b.percent !== a.percent) return b.percent - a.percent;
        // 同 percent は revision 名昇順で安定させる。
        return a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0;
      }),
    }))
    .sort((a, b) =>
      a.service < b.service ? -1 : a.service > b.service ? 1 : 0,
    );

  const record: BackendTrafficRecord = {
    schema_version: SCHEMA_VERSION,
    repo: input.repo,
    services,
    reported_at: input.now,
  };
  await kv.put(backendTrafficKey(input.repo), JSON.stringify(record));
  return record;
}

/** 単一 repo の backend traffic を取得 (無ければ / schema 不一致は null)。 */
export async function getBackendTraffic(
  kv: KVNamespace,
  repo: string,
): Promise<BackendTrafficRecord | null> {
  const v = await kv.get<BackendTrafficRecord>(backendTrafficKey(repo), "json");
  if (!v || v.schema_version !== SCHEMA_VERSION) return null;
  return v;
}

/**
 * 指定 repo 群の backend traffic を repo→record の Map で返す (record 無しは含めない)。
 * compat グラフに出る backend だけ引きたいので個別 get を並列で叩く。
 */
export async function getBackendTrafficForRepos(
  kv: KVNamespace,
  repos: Iterable<string>,
): Promise<Map<string, BackendTrafficRecord>> {
  const list = [...new Set(repos)];
  const entries = await Promise.all(
    list.map(
      async (repo) => [repo, await getBackendTraffic(kv, repo)] as const,
    ),
  );
  const out = new Map<string, BackendTrafficRecord>();
  for (const [repo, rec] of entries) {
    if (rec) out.set(repo, rec);
  }
  return out;
}
