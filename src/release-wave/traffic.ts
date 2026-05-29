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
const SCHEMA_VERSION = 1 as const;

/** version 1 件の traffic 配分。 */
export interface TrafficVersion {
  /** wrangler version id (UUID 等)。 */
  version_id: string;
  /** traffic 配分 % (0〜100)。 */
  percentage: number;
}

/** `traffic::<repo>` value。repo ごとに最新の deployment 配分のみ保持 (upsert)。 */
export interface TrafficRecord {
  schema_version: typeof SCHEMA_VERSION;
  /** "owner/name"。 */
  repo: string;
  /** version 配分 (percentage 降順)。100% / 0% の version が並ぶ。 */
  versions: TrafficVersion[];
  /** 報告を受けた UTC ISO。 */
  reported_at: string;
}

function trafficKey(repo: string): string {
  return `${TRAFFIC_PREFIX}${repo}`;
}

/** upsert: repo ごとに最新報告で上書きする。versions は percentage 降順で保存。 */
export async function recordTraffic(
  kv: KVNamespace,
  input: {
    repo: string;
    versions: TrafficVersion[];
    now: string;
  },
): Promise<TrafficRecord> {
  const versions = [...input.versions].sort(
    (a, b) => b.percentage - a.percentage,
  );
  const record: TrafficRecord = {
    schema_version: SCHEMA_VERSION,
    repo: input.repo,
    versions,
    reported_at: input.now,
  };
  await kv.put(trafficKey(input.repo), JSON.stringify(record));
  return record;
}

/** 単一 repo の traffic を取得 (無ければ null)。 */
export async function getTraffic(
  kv: KVNamespace,
  repo: string,
): Promise<TrafficRecord | null> {
  const v = await kv.get<TrafficRecord>(trafficKey(repo), "json");
  if (!v || v.schema_version !== SCHEMA_VERSION) return null;
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
