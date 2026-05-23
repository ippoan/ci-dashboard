// Shared test helper for the auth-worker delegation auth migration (#116).
//
// Production code resolves `github_token` via:
//   1. `getGitHubToken(env)` → KV cache check (`auth-worker:gh-token`)
//   2. On miss: `POST https://auth.ippoan.org/mcp/introspect` with the JWT
//      from `env.JWT_FOR_CI_DASHBOARD.get()` + shared-secret auth from
//      `env.INTERNAL_SHARED_SECRET.get()`.
//
// To keep tests offline-friendly, we **pre-seed the KV cache** with a
// long-lived fake token in `beforeEach`. Production code reads the cache
// first, so the introspect endpoint is never hit. Tests that explicitly
// exercise the introspect path (test/auth-worker-client.test.ts) clear the
// cache and stub fetch.

import { env } from "cloudflare:test";

export const TEST_GITHUB_TOKEN = "ghs_test_token_via_auth_worker";
export const TEST_JWT = "eyJ.test.jwt";
export const TEST_INTERNAL_SECRET = "test-internal-shared-secret";

const TOKEN_CACHE_KEY = "auth-worker:gh-token";

/** Returns a `SecretsStoreSecret`-shaped fake whose `.get()` resolves to
 *  `value`. Mirrors the binding surface that `wrangler.jsonc`
 *  `secrets_store_secrets` exposes at runtime. */
function fakeStoreSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

/** Env object suitable for handlers that take `AuthWorkerEnv` (or its
 *  supersets like the full Worker Env in src/index.ts). Pre-seed the KV with
 *  `seedTestTokens()` before each test so the production code path never
 *  hits `/mcp/introspect`. */
export function appTestEnv() {
  return {
    JWT_FOR_CI_DASHBOARD: fakeStoreSecret(TEST_JWT),
    INTERNAL_SHARED_SECRET: fakeStoreSecret(TEST_INTERNAL_SECRET),
    CI_STATUS: env.CI_STATUS,
  };
}

/** Pre-populate the KV cache so `getGitHubToken(env)` returns
 *  `TEST_GITHUB_TOKEN` synchronously without an HTTP call. */
export async function seedTestTokens(): Promise<void> {
  await env.CI_STATUS.put(
    TOKEN_CACHE_KEY,
    JSON.stringify({
      token: TEST_GITHUB_TOKEN,
      expires_at_ms: Date.now() + 3600 * 1000,
    }),
  );
}

/** Clear the seeded token between tests so a fresh seed always wins. */
export async function clearTestTokens(): Promise<void> {
  await env.CI_STATUS.delete(TOKEN_CACHE_KEY);
}
