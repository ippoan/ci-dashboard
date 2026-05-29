/**
 * Worker version の traffic split (gradual deployment) の KV 永続化。
 *
 * 各 frontend worker の「今どの version に何 % traffic が乗っているか」を
 * frontend CI が deploy 時に報告し (`wrangler deployments list` 相当)、
 * ci-dashboard が `traffic::<repo>` として COMPAT_KV に保存する。
 * /release-wave の Compatibility グラフ下に「version split」として出す。
 *
 * 「100% がどの version id か / 0% (no-traffic) がどの version id か」を一目で
 * 見られるようにするのが目的 (要望: 0% の場合 100% はどの id か)。
 */

const TRAFFIC_PREFIX = "traffic::";
// schema 変遷:
//   v1: { version_id, percentage }
//   v2: + created_on (deploy/upload 日時)
//   v3: + tag (upload 時点の git release tag)。tag は deploy CI ごとに「その回
//       upload した version」分しか報告されないため、recordTraffic で version_id
//       単位に **merge 蓄積** する (過去 version の tag を保持)。
// reader は v1/v2/v3 全部許容する (後方互換)。
const SCHEMA_VERSION = 3 as const;

/** version 1 件の traffic 配分。 */
export interface TrafficVersion {
  /** wrangler version id (UUID 等)。 */
  version_id: string;
  /** traffic 配分 % (0〜100)。 */
  percentage: number;
  /**
   * version の deploy(100%) / upload(0%) 日時 (UTC ISO)。
   * `wrangler versions list` の metadata.created_on 由来。
   * 取得できなかった / v1 record では null。
   */
  created_on?: string | null;
  /**
   * upload された時点の git release tag (例 "v0.2.43")。deploy CI が
   * github.ref_name を報告。100% と 0% で別 tag になり得る。
   * 不明 (過去 version で報告前 / 報告無し) は null。
   */
  tag?: string | null;
}

/** `traffic::<repo>` value。repo ごとに最新の deployment 配分のみ保持 (upsert)。 */
export interface TrafficRecord {
  schema_version: number;
  /** "owner/name"。 */
  repo: string;
  /**
   * version 配分。percentage 降順 → 同率は created_on 降順 (新しい順) で並ぶ。
   * 100% (active) と 0% (no-traffic / promote 待ち) が混在する。
   */
  versions: TrafficVersion[];
  /** 報告を受けた UTC ISO。 */
  reported_at: string;
}

function trafficKey(repo: string): string {
  return `${TRAFFIC_PREFIX}${repo}`;
}

/**
 * 報告された versions[] で record を更新する。version 配分そのものは最新報告で
 * 置き換える (wrangler 側で消えた version は残さない) が、各 version の **tag は
 * 既存 record と merge 蓄積**する:
 *   - 新報告に tag があればそれを採用
 *   - 無ければ既存 record の同 version_id の tag を引き継ぐ
 * deploy CI は「その回 upload した version」の tag しか送れないため、過去 version
 * の tag を取りこぼさないようこの merge を行う。
 *
 * versions は percentage 降順 → 同率は created_on 降順 (新しい順) で並べて保存。
 */
export async function recordTraffic(
  kv: KVNamespace,
  input: {
    repo: string;
    versions: TrafficVersion[];
    now: string;
  },
): Promise<TrafficRecord> {
  // 既存 record から version_id → tag を引き継ぐ準備。
  const prev = await getTraffic(kv, input.repo);
  const prevTagById = new Map<string, string>();
  if (prev) {
    for (const v of prev.versions) {
      if (v.tag) prevTagById.set(v.version_id, v.tag);
    }
  }

  const merged = input.versions.map((v) => ({
    version_id: v.version_id,
    percentage: v.percentage,
    created_on: v.created_on ?? null,
    // 新報告の tag 優先、無ければ既存 record の tag を保持。
    tag: v.tag ?? prevTagById.get(v.version_id) ?? null,
  }));

  merged.sort((a, b) => {
    if (b.percentage !== a.percentage) return b.percentage - a.percentage;
    // 同 percentage は created_on 降順 (新しい version を上に)。null は末尾。
    const ca = a.created_on ?? "";
    const cb = b.created_on ?? "";
    if (ca === cb) return 0;
    if (!ca) return 1;
    if (!cb) return -1;
    return ca < cb ? 1 : -1;
  });
  const record: TrafficRecord = {
    schema_version: SCHEMA_VERSION,
    repo: input.repo,
    versions: merged,
    reported_at: input.now,
  };
  await kv.put(trafficKey(input.repo), JSON.stringify(record));
  return record;
}

/**
 * 単一 repo の traffic を取得 (無ければ null)。
 * v1 / v2 / v3 の record を許容する (v1 は created_on 無し、v1/v2 は tag 無し)。
 */
export async function getTraffic(
  kv: KVNamespace,
  repo: string,
): Promise<TrafficRecord | null> {
  const v = await kv.get<TrafficRecord>(trafficKey(repo), "json");
  if (!v || v.schema_version < 1 || v.schema_version > 3) return null;
  return v;
}

/**
 * 指定 repo 群の traffic を repo→record の Map で返す (record 無しは含めない)。
 * compat グラフに出る repo だけ引きたいので個別 get を並列で叩く。
 */
export async function getTrafficForRepos(
  kv: KVNamespace,
  repos: Iterable<string>,
): Promise<Map<string, TrafficRecord>> {
  const list = [...new Set(repos)];
  const entries = await Promise.all(
    list.map(async (repo) => [repo, await getTraffic(kv, repo)] as const),
  );
  const out = new Map<string, TrafficRecord>();
  for (const [repo, rec] of entries) {
    if (rec) out.set(repo, rec);
  }
  return out;
}
