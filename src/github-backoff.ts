import { GitHubApiError } from "./github-api";

// 共有 rate-limit backoff marker (Refs #304)。
//
// /issues の SWR 化で reconcile / PR map refresh が background 実行になるが、
// user-scope token の quota が枯渇している間に再検証を繰り返すと
// 「枯渇 → さらに叩く → 枯渇が伸びる」のハンマリングになる。403/429 を
// 観測したら KV に marker を置き、TTL が切れるまで GitHub fetch 系を no-op
// させる。marker は watermark / storedAt を一切動かさないので、解除後の
// 最初のリクエストで即 refresh が走る (= staleness が複利しない)。
const BACKOFF_KEY = "github:rl-backoff";
const BACKOFF_TTL_SECONDS = 300;

export interface RateLimitBackoff {
  setAt: number;
  /** バナーの「HH:MM 頃に再開」表示用。KV get は残 TTL を返さないので
   *  value 側に持つ。 */
  until: number;
  status: number;
  message: string;
}

/** GitHub の rate limit 由来とみなすエラーか。primary (403) / secondary
 *  (429) の両方を拾う。github-api.ts は response body を message に含める
 *  ので文言 match も併用する。 */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof GitHubApiError && (err.status === 403 || err.status === 429)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /rate limit/i.test(msg);
}

export async function setRateLimitBackoff(kv: KVNamespace, err: unknown): Promise<void> {
  const now = Date.now();
  const msg = err instanceof Error ? err.message : String(err);
  const entry: RateLimitBackoff = {
    setAt: now,
    until: now + BACKOFF_TTL_SECONDS * 1000,
    status: err instanceof GitHubApiError ? err.status : 0,
    message: msg.slice(0, 200),
  };
  await kv.put(BACKOFF_KEY, JSON.stringify(entry), {
    expirationTtl: BACKOFF_TTL_SECONDS,
  });
}

export async function getRateLimitBackoff(kv: KVNamespace): Promise<RateLimitBackoff | null> {
  return await kv.get(BACKOFF_KEY, "json") as RateLimitBackoff | null;
}

// Test 用に内部定数を公開。production code からは呼ばない。
export const __testing = {
  BACKOFF_KEY,
  BACKOFF_TTL_SECONDS,
};
