// Global Vitest setup: seed GitHub App installation tokens into KV before
// every test runs. Production code calls `getInstallationToken(env, org)`
// which reads from KV `gh-app:token:<installation_id>`; by pre-seeding a
// long-lived fake token we let tests stub `globalThis.fetch` without ever
// firing the App-JWT exchange path.
//
// Tests that explicitly exercise the App-auth path (test/github-app-auth.test.ts)
// clear and re-seed on their own — `beforeEach` here gets out of their way
// because `clearTestTokens` in those tests runs after our seed.

import { beforeEach } from "vitest";
import { seedTestTokens } from "./app-env";

beforeEach(async () => {
  await seedTestTokens();
});
