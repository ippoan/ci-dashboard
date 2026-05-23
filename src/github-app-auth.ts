/**
 * GitHub App authentication for Cloudflare Workers.
 *
 * Replaces classic PAT (`GITHUB_TOKEN` secret) with a 3-step App→installation
 * token flow:
 *
 *   1. Sign a short-lived (10 min) RS256 JWT with the App's private key
 *      using Web Crypto API.
 *   2. Exchange the JWT for an installation token (1 h TTL) via
 *      `POST /app/installations/{id}/access_tokens`.
 *   3. KV-cache the installation token for ~55 min so we re-mint it before
 *      expiry without exhausting GitHub's rate limit.
 *
 * Why per-org tokens: a GitHub App installation token is scoped to the org
 * it's installed on. Searches that span multiple orgs (the issues page's
 * `org:ippoan org:ohishi-exp` shape) cannot be served by a single token —
 * the caller must fan out one search per org and merge the results.
 * `getInstallationToken(env, org)` is the single entrypoint; per-org
 * fan-out lives in the search helpers (fetchOrgIssues / fetchProjectIssueMap /
 * fetchOpenPrsByIssue).
 */

export interface GitHubAppEnv {
  GITHUB_APP_ID: string;
  /** RSA private key, PEM-encoded (multiline, BEGIN/END PRIVATE KEY headers). */
  GITHUB_APP_PRIVATE_KEY: string;
  /**
   * JSON map of `org → installation_id`, e.g.
   *   `{"ippoan": 12345678, "ohishi-exp": 23456789, "yhonda-ohishi": 34567890}`
   * Stored as a string secret because Cloudflare worker `vars` don't accept
   * nested objects. Parsed on each call (cheap, < 1 KB).
   */
  GITHUB_APP_INSTALLATIONS: string;
  CI_STATUS: KVNamespace;
}

const TOKEN_CACHE_PREFIX = "gh-app:token:";
// installation token TTL is 1 h; we cache for ~55 min so callers always get a
// token with at least 5 min headroom (avoids "expired mid-request" races on
// long-running handlers).
const TOKEN_CACHE_TTL_SECONDS = 3300;
const TOKEN_REFRESH_BEFORE_EXPIRY_MS = 60_000;

interface CachedInstallationToken {
  token: string;
  expires_at_ms: number;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

/** Parse the org→installation_id map from the env secret. Throws if the JSON
 *  is malformed — that's a deploy-time misconfiguration we want to surface
 *  loudly rather than 401 mysteriously. */
export function parseInstallationsMap(raw: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `GITHUB_APP_INSTALLATIONS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GITHUB_APP_INSTALLATIONS must be a JSON object");
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new Error(
        `GITHUB_APP_INSTALLATIONS["${k}"] must be a positive integer, got ${JSON.stringify(v)}`,
      );
    }
    out[k] = v;
  }
  return out;
}

/** Look up the installation ID for an org, or throw with a clear message. */
export function installationIdForOrg(env: GitHubAppEnv, org: string): number {
  const map = parseInstallationsMap(env.GITHUB_APP_INSTALLATIONS);
  const id = map[org];
  if (!id) {
    throw new Error(
      `No GitHub App installation configured for org "${org}". ` +
      `Configured orgs: ${Object.keys(map).join(", ") || "(none)"}`,
    );
  }
  return id;
}

/** base64url encode a Uint8Array (no padding, URL-safe). */
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlEncodeJSON(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Import a PEM-encoded PKCS#8 RSA private key into a Web Crypto CryptoKey
 *  usable for RS256 signing. */
export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!body) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is empty or missing PEM headers");
  }
  let der: Uint8Array;
  try {
    const binary = atob(body);
    der = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  } catch (err) {
    throw new Error(
      `GITHUB_APP_PRIVATE_KEY is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Sign a 10-minute App-identity JWT (RS256). Used only to exchange for an
 *  installation token — never sent to the regular GitHub REST API. */
export async function signAppJWT(
  appId: string,
  privateKeyPEM: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  // `iat - 60` guards against minor clock skew between the Worker and GitHub.
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 600, iss: appId };
  const headerSeg = base64UrlEncodeJSON(header);
  const payloadSeg = base64UrlEncodeJSON(payload);
  const signingInput = `${headerSeg}.${payloadSeg}`;

  const key = await importAppPrivateKey(privateKeyPEM);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** Exchange an App JWT for an installation token. Network-only — no cache. */
async function fetchInstallationToken(
  appJWT: string,
  installationId: number,
): Promise<InstallationTokenResponse> {
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJWT}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ci-dashboard-mcp",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub installation token exchange failed (${res.status}) for installation ${installationId}: ${text}`,
    );
  }
  return res.json() as Promise<InstallationTokenResponse>;
}

/** Get a valid installation token for `org`. Reads/writes a KV cache so that
 *  repeated calls within ~55 min do not hit GitHub. */
export async function getInstallationToken(
  env: GitHubAppEnv,
  org: string,
): Promise<string> {
  const installationId = installationIdForOrg(env, org);
  const cacheKey = TOKEN_CACHE_PREFIX + installationId;

  const cached = await env.CI_STATUS.get(cacheKey, "json") as CachedInstallationToken | null;
  if (cached && cached.expires_at_ms > Date.now() + TOKEN_REFRESH_BEFORE_EXPIRY_MS) {
    return cached.token;
  }

  const jwt = await signAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const fresh = await fetchInstallationToken(jwt, installationId);
  const entry: CachedInstallationToken = {
    token: fresh.token,
    expires_at_ms: new Date(fresh.expires_at).getTime(),
  };
  await env.CI_STATUS.put(cacheKey, JSON.stringify(entry), {
    expirationTtl: TOKEN_CACHE_TTL_SECONDS,
  });
  return fresh.token;
}
