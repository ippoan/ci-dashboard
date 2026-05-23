// Shared test helper for the auth-client-worker integration (#118).
//
// Production code resolves `github_token` via `getGitHubToken(env)` from the
// `@ippoan/auth-client-worker` package, which reads from KV cache key
// `auth-client-worker:gh-token` (the package-managed key, not the legacy
// `auth-worker:gh-token` from the inline pre-#118 implementation).
//
// To keep tests offline-friendly, `seedTestTokens()` pre-populates the KV
// cache with a long-lived fake token before each test. Production code reads
// the cache first, so the introspect endpoint is never hit during normal
// tests. Tests that explicitly exercise the introspect path stub fetch
// themselves and call `clearTestTokens()` first.

import { env } from "cloudflare:test";

export const TEST_GITHUB_TOKEN = "ghs_test_token_via_auth_worker";
export const TEST_INTERNAL_SECRET = "test-internal-shared-secret";

// Matches the cache key used by `@ippoan/auth-client-worker`'s introspect
// helper (see packages/auth-client-worker/src/introspect.ts).
const TOKEN_CACHE_KEY = "auth-client-worker:gh-token";

/** Returns a `SecretsStoreSecret`-shaped fake whose `.get()` resolves to
 *  `value`. Mirrors the binding surface that `wrangler.jsonc`
 *  `secrets_store_secrets` exposes at runtime. */
function fakeStoreSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

/** Env object satisfying `AuthClientWorkerEnv` from `@ippoan/auth-client-worker`.
 *  Pre-seed the KV with `seedTestTokens()` before each test so the production
 *  code path never hits `/mcp/introspect`. */
export function appTestEnv() {
  return {
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
