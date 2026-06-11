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

// ───── GitHub 認証失効 marker (Refs #334) ─────
//
// auth-worker delegation の refresh_token が失効 (invalid_grant — 並列 refresh
// race、ippoan/auth-worker#270) すると background refresh が全断するが、
// background では /oauth/login へ 302 できず log にしか出ない。marker を立てて
// /issues・/releases が「再ログインが必要」banner を出せるようにする。
// token 取得が成功する経路 (reconcile / refresh 成功) で消す。

const AUTH_BROKEN_KEY = "github:auth-broken";
const AUTH_BROKEN_TTL_SECONDS = 6 * 60 * 60;

/** auth-worker delegation 系のエラーか (= 再ログインで解決するか)。
 *  issues-page の cold start 302 判定と同じ規約 (@ippoan/auth-client-worker
 *  は Error.message に常に診断文字列を入れる)。 */
export function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /No (DCR client registered|OAuth tokens stored)/.test(msg) ||
    /auth-worker \/mcp\/(introspect|token).*failed \((400|401|403)/.test(msg) ||
    /invalid_grant/.test(msg) ||
    /JWT inactive/.test(msg)
  );
}

export interface AuthBrokenMarker {
  at: number;
  message: string;
}

/** auth error を観測した background 経路から呼ぶ。non-auth エラーは no-op。 */
export async function noteGitHubAuthBroken(kv: KVNamespace, err: unknown): Promise<void> {
  if (!isAuthError(err)) return;
  const marker: AuthBrokenMarker = {
    at: Date.now(),
    message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  };
  await kv.put(AUTH_BROKEN_KEY, JSON.stringify(marker), {
    expirationTtl: AUTH_BROKEN_TTL_SECONDS,
  });
}

export async function getGitHubAuthBroken(kv: KVNamespace): Promise<AuthBrokenMarker | null> {
  return await kv.get(AUTH_BROKEN_KEY, "json") as AuthBrokenMarker | null;
}

/** token 取得が成功した経路 (refresh / reconcile 完走) から呼んで自動回復。 */
export async function clearGitHubAuthBroken(kv: KVNamespace): Promise<void> {
  await kv.delete(AUTH_BROKEN_KEY);
}
