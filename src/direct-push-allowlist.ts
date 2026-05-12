// Fetches the direct-push-OK allowlist from `yhonda-ohishi/claude-skills`
// so this repo and the `/wt-direct-push` skill share one source of truth.
//
// SoT file: `yhonda-ohishi/claude-skills/wt-direct-push/config/direct-push-ok.txt`
//   - one `owner/name` per line
//   - `#` comments, blank lines OK
//
// The fetch is cached in KV with a TTL so the release page renders without
// 1 extra GitHub round-trip every load. Failure paths fall back to an empty
// set so the rest of the page still renders — direct-push UI just silently
// won't appear until the fetch recovers.

import { githubApi, GitHubApiError } from "./github-api";

export const ALLOWLIST_REPO = "yhonda-ohishi/claude-skills";
export const ALLOWLIST_PATH = "wt-direct-push/config/direct-push-ok.txt";
const KV_KEY = "direct-push-allowlist:v1";
const TTL_SECONDS = 600; // 10 minutes

interface ContentsResponse {
  content: string;
  encoding: "base64" | string;
}

interface CachedAllowlist {
  fetchedAt: number;
  repos: string[];
}

// Returns the parsed allowlist as a Set so callers do O(1) membership checks.
// `kv` is optional so unit tests can exercise the pure-fetch path without
// stubbing a KV namespace; production passes `env.CI_STATUS`.
export async function loadDirectPushAllowlist(
  token: string,
  kv?: KVNamespace,
): Promise<Set<string>> {
  if (kv) {
    const cached = await kv.get<CachedAllowlist>(KV_KEY, "json");
    if (cached && Array.isArray(cached.repos)) {
      return new Set(cached.repos);
    }
  }

  const repos = await fetchAllowlistFromGitHub(token);

  if (kv && repos.length > 0) {
    // Only cache non-empty results so a transient fetch failure doesn't poison
    // the cache for 10 minutes.
    await kv.put(
      KV_KEY,
      JSON.stringify({ fetchedAt: Date.now(), repos } satisfies CachedAllowlist),
      { expirationTtl: TTL_SECONDS },
    );
  }

  return new Set(repos);
}

async function fetchAllowlistFromGitHub(token: string): Promise<string[]> {
  try {
    const res = await githubApi<ContentsResponse>(
      token,
      "GET",
      `/repos/${ALLOWLIST_REPO}/contents/${ALLOWLIST_PATH}`,
    );
    if (res.encoding !== "base64" || typeof res.content !== "string") {
      return [];
    }
    return parseAllowlist(atobUtf8(res.content));
  } catch (err) {
    if (err instanceof GitHubApiError) {
      // 404 = file moved / not yet pushed; treat as empty list (no direct-push
      // repos configured). Other errors fall back too, but a 5xx would be
      // worth surfacing in logs.
      return [];
    }
    throw err;
  }
}

// Exported for unit tests; converts the txt file body into a flat list of
// `owner/name` entries with whitespace and comments trimmed. Lines that don't
// look like `owner/name` are skipped silently so the SSR page never breaks on
// stray text.
export function parseAllowlist(body: string): string[] {
  const out: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (!/^[\w.-]+\/[\w.-]+$/.test(line)) continue;
    out.push(line);
  }
  return out;
}

// GitHub returns base64 with newlines every 60 chars; standard atob copes,
// but content with non-ASCII chars needs a UTF-8 decode pass. The allowlist
// is ASCII today so plain atob() suffices, but we wrap it for safety.
function atobUtf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
