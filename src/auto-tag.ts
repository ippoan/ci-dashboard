// Auto-tag on PR merge (Refs #460).
//
// 「PR が default branch に merge された瞬間、その repo の tag-release.yml
// workflow を自動で dispatch する」flag set を Hub DO storage に持つ。
// SoT を DO に置く理由は Discord webhook URL (Refs #441 PR2) と同じ —
// UI で flip した直後の merge を取りこぼさないよう強整合 read が要る
// (KV だと最大 ~60s の global propagation 窓ができる)。

/** Hub DO から auto-tag 対象 repo の全集合を読む。Hub 到達不能 / 非 OK は
 *  空配列で fail-open (= 通知 disabled 相当 = どの repo も対象外)。 */
export async function readAutoTagRepos(
  hub: DurableObjectStub,
): Promise<string[]> {
  try {
    const res = await hub.fetch(new Request("http://hub/auto-tag-repos"));
    if (!res.ok) return [];
    return await res.json<string[]>();
  } catch {
    return [];
  }
}

/** Hub DO の `PUT /auto-tag-repos` で set を全置換。UI form-POST から叩く。
 *  重複と空白は Hub 側で正規化されるので caller は気にしなくて良い。 */
export async function writeAutoTagRepos(
  hub: DurableObjectStub,
  repos: string[],
): Promise<boolean> {
  try {
    const res = await hub.fetch(new Request("http://hub/auto-tag-repos", {
      method: "PUT",
      body: JSON.stringify({ repos }),
    }));
    return res.ok;
  } catch {
    return false;
  }
}

/** webhook 経路の hot path で「この repo は auto-tag 対象か」を boolean で
 *  返す薄いラッパ。fail-open: Hub 不達は false (= dispatch しない)。 */
export async function isAutoTagRepo(
  hub: DurableObjectStub,
  repo: string,
): Promise<boolean> {
  const list = await readAutoTagRepos(hub);
  return list.includes(repo);
}

/** Hub DO endpoint が受け取る PUT body の shape。Hub 側で trim + 重複除去 +
 *  ソートして storage に書く (見た目の安定とテストの diff を見やすくする
 *  ための副次効果)。 */
export interface AutoTagReposPutBody {
  repos: string[];
}

/** 正規化: trim + 空除去 + 重複除去 + ソート。Hub の write 側で呼ぶ。
 *  caller (UI) と Hub の両方で同じロジックを使えるよう公開しておく。 */
export function normalizeAutoTagRepos(input: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of input) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    seen.add(trimmed);
  }
  return Array.from(seen).sort();
}
