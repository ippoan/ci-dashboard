// public repo の default branch への push (= squash merge / direct push) を
// ippoan/code-search-index (semantic code search) の索引更新 workflow に
// 伝える (Refs #503)。tag-release.ts の dispatch と同じ「純粋に成否だけを
// 返す薄い関数」として切り出す。

import type { Env } from "./index";
import { tokenForOrg } from "./github-api";

const INDEX_REPO = "ippoan/code-search-index";
const INDEX_WORKFLOW = "index.yml";

export interface CodeSearchDispatchResult {
  ok: boolean;
  /** ok=false のとき HTTP status のヒント (403 / 502)。 */
  status: number;
  error?: string;
}

/**
 * code-search-index の `index.yml` workflow を main 上で dispatch する。
 *
 * 連続 merge による重複起動は index 側の `concurrency: group: index` が
 * 「実行中 1 + 待ち最新 1」に畳むため、caller 側の debounce は持たない。
 * 失敗は結果で返すだけで pipeline は止めない (auto-tag と同じ fail-open)。
 */
export async function dispatchCodeSearchIndex(
  env: Env,
): Promise<CodeSearchDispatchResult> {
  let token: string;
  try {
    token = await tokenForOrg(env, "ippoan");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 403, error: msg };
  }

  const res = await fetch(
    `https://api.github.com/repos/${INDEX_REPO}/actions/workflows/${INDEX_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ci-dashboard",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: 502, error: `GitHub API ${res.status}: ${text}` };
  }

  return { ok: true, status: 200 };
}
