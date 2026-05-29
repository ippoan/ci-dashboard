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
// v2: TrafficVersion に created_on を追加 (deploy/upload 日時)。v1 record は
// created_on 無しとして読めるよう、reader は両方許容する (後方互換)。
const SCHEMA_VERSION = 2 as const;

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
 * upsert: repo ごとに最新報告で上書きする。
 * versions は percentage 降順 → 同率は created_on 降順 (新しい順) で並べて保存。
 * これで「100% (active)」が先頭、その後に 0% の新しい version から並ぶ。
 */
export async function recordTraffic(
  kv: KVNamespace,
  input: {
    repo: string;
    versions: TrafficVersion[];
    now: string;
  },
): Promise<TrafficRecord> {
  const versions = [...input.versions].sort((a, b) => {
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
    versions,
    reported_at: input.now,
  };
  await kv.put(trafficKey(input.repo), JSON.stringify(record));
  return record;
}

/**
 * 単一 repo の traffic を取得 (無ければ null)。
 * v1 / v2 どちらの record も許容する (v1 は created_on 無し)。古い v0 等は無視。
 */
export async function getTraffic(
  kv: KVNamespace,
  repo: string,
): Promise<TrafficRecord | null> {
  const v = await kv.get<TrafficRecord>(trafficKey(repo), "json");
  if (!v || (v.schema_version !== 1 && v.schema_version !== 2)) return null;
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
