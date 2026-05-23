// Shared test helper for the GitHub App auth migration (#112).
//
// Pre-seeds cached installation tokens into KV so production code can call
// `getInstallationToken(env, org)` without firing the JWT-exchange path.
// Replaces the old "give the test a `GITHUB_TOKEN` secret" pattern; every test
// that touches a real githubApi() call now seeds 3 tokens and uses
// `appTestEnv()` to supply the App secrets.

import { env } from "cloudflare:test";

// Same dummy installation IDs across all tests. The actual integer doesn't
// matter — Worker code only ever uses it as a KV key suffix.
export const TEST_INSTALLATIONS = {
  "ippoan": 111,
  "ohishi-exp": 222,
  "yhonda-ohishi": 333,
} as const;

export const TEST_INSTALLATION_TOKEN = "test-token";

/** Env object suitable for handlers that take GitHubAppEnv (or its supersets
 *  like the full Worker Env in src/index.ts). The values are syntactically
 *  valid but never actually drive a JWT exchange because `seedTestTokens()`
 *  pre-populates the per-installation KV cache. */
export function appTestEnv() {
  return {
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
    GITHUB_APP_INSTALLATIONS: JSON.stringify(TEST_INSTALLATIONS),
    CI_STATUS: env.CI_STATUS,
  };
}

/** Pre-populate the KV cache so `getInstallationToken(env, org)` returns
 *  `TEST_INSTALLATION_TOKEN` synchronously without minting a JWT. Call this
 *  in `beforeEach` for any test whose stubbed fetch expects the
 *  Authorization header but doesn't want to stub the App-token endpoint. */
export async function seedTestTokens(): Promise<void> {
  const expires_at_ms = Date.now() + 3600 * 1000;
  for (const id of Object.values(TEST_INSTALLATIONS)) {
    await env.CI_STATUS.put(
      `gh-app:token:${id}`,
      JSON.stringify({ token: TEST_INSTALLATION_TOKEN, expires_at_ms }),
    );
  }
}

/** Clear seeded tokens between tests so a fresh seed always wins. */
export async function clearTestTokens(): Promise<void> {
  for (const id of Object.values(TEST_INSTALLATIONS)) {
    await env.CI_STATUS.delete(`gh-app:token:${id}`);
  }
}
