/**
 * auth-worker MCP OAuth Provider への delegation client.
 *
 * PAT / GitHub App private key を Cloudflare 上に保持する代わりに、`auth-
 * worker` (auth.ippoan.org) を OAuth App owner として使い、`/mcp/introspect`
 * 経由で `github_token` を取り出す。本 Worker が保持するのは:
 *
 *   - `JWT_FOR_CI_DASHBOARD` — device flow で 1 度だけ取得した access JWT。
 *     auth-worker が consumer 識別 + 認可状態を持つ key。
 *   - `INTERNAL_SHARED_SECRET` — auth-worker と共有する固定 secret。
 *     `/mcp/introspect` の Authorization header に載せる。
 *
 * どちらも 1 KB 未満で Cloudflare Secrets Store に収まる。OAuth Client Secret
 * と GitHub App PEM は本 Worker 上に一切存在しない (auth-worker が保有)。
 *
 * 解決された `github_token` は KV (`auth-worker:gh-token`) に ~55 min cache
 * し、有効期間内は毎リクエストの /mcp/introspect 往復を避ける。
 */

// The concrete Worker `Env` (src/index.ts) extends this with the rest of the
// Worker bindings. We keep it narrow so test helpers can construct it without
// pulling the full Env.
export interface AuthWorkerEnv {
  /** Long-lived access JWT issued by auth-worker (device flow, RFC 8628).
   *  Stored as a Secrets Store binding so the value is fetched via `.get()`. */
  JWT_FOR_CI_DASHBOARD: SecretsStoreSecret;
  /** Shared secret with auth-worker for `/mcp/introspect`. Cloudflare Secrets
   *  Store binding (same shape as JWT). */
  INTERNAL_SHARED_SECRET: SecretsStoreSecret;
  /** KV used to cache the resolved github_token. */
  CI_STATUS: KVNamespace;
}

const TOKEN_CACHE_KEY = "auth-worker:gh-token";
// auth-worker's introspect returns `exp` (JWT exp claim) which itself is
// typically 30 d. We cache the resolved github_token for at most ~55 min so
// it churns well before any consumer-side TTL drift.
const TOKEN_CACHE_TTL_SECONDS = 3300;
const TOKEN_REFRESH_BEFORE_EXPIRY_MS = 60_000;

/** auth-worker `/mcp/introspect` endpoint. Override via env if the deploy
 *  ever points elsewhere (testing / staging auth-worker). */
const DEFAULT_INTROSPECT_ENDPOINT = "https://auth.ippoan.org/mcp/introspect";

interface CachedGitHubToken {
  token: string;
  expires_at_ms: number;
}

interface IntrospectResponse {
  active: boolean;
  github_token?: string;
  github_login?: string;
  exp?: number;
  scope?: string;
  /** Provided when `active === false` to help operators diagnose. */
  error?: string;
}

/** Return a usable GitHub access token. KV-cached for ~55 min so cold hits to
 *  auth-worker are rare. Throws if the JWT is inactive (operator must re-do
 *  device flow) or the network call fails. */
export async function getGitHubToken(
  env: AuthWorkerEnv,
  endpoint: string = DEFAULT_INTROSPECT_ENDPOINT,
): Promise<string> {
  const cached = await env.CI_STATUS.get(TOKEN_CACHE_KEY, "json") as CachedGitHubToken | null;
  if (cached && cached.expires_at_ms > Date.now() + TOKEN_REFRESH_BEFORE_EXPIRY_MS) {
    return cached.token;
  }

  const [jwt, secret] = await Promise.all([
    env.JWT_FOR_CI_DASHBOARD.get(),
    env.INTERNAL_SHARED_SECRET.get(),
  ]);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: secret,
      "Content-Type": "application/json",
      "User-Agent": "ci-dashboard-mcp",
    },
    body: JSON.stringify({ token: jwt }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`auth-worker /mcp/introspect failed (${res.status}): ${text}`);
  }
  const data = await res.json() as IntrospectResponse;
  if (!data.active || !data.github_token) {
    throw new Error(
      `auth-worker reports JWT inactive (${data.error ?? "no reason given"}). ` +
      `Re-run device flow against auth.ippoan.org and update JWT_FOR_CI_DASHBOARD secret.`,
    );
  }

  const expFromJwt = data.exp ? data.exp * 1000 : Number.MAX_SAFE_INTEGER;
  const cap = Date.now() + TOKEN_CACHE_TTL_SECONDS * 1000;
  const entry: CachedGitHubToken = {
    token: data.github_token,
    expires_at_ms: Math.min(expFromJwt, cap),
  };
  await env.CI_STATUS.put(TOKEN_CACHE_KEY, JSON.stringify(entry), {
    expirationTtl: TOKEN_CACHE_TTL_SECONDS,
  });
  return data.github_token;
}
