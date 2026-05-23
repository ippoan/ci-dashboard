import { githubApi, validateOrg, AUTH_WORKER_ORIGIN } from "./github-api";
import { getGitHubToken, type AuthClientWorkerEnv } from "@ippoan/auth-client-worker";

/** Lightweight PR descriptor used by the issues page to render "related PR"
 *  chips. Body is intentionally not retained — it's only used to extract
 *  issue refs and would balloon the KV-cached payload.
 *
 *  `state: 'merged'` covers PRs that have already merged but whose `Refs #N`
 *  target issue is still open (the standard "release-pending" zone for this
 *  repo's CLAUDE.md flow). They're searched separately from open PRs and
 *  rendered with a distinct chip color (purple) so the reader can tell at a
 *  glance that the work is done — only the release tag / manual close is
 *  outstanding. */
export interface IssuePrRef {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updated_at: string;
  state: "open" | "merged";
}

// Matches "<keyword> [owner/repo]#N" where <keyword> is one of the GitHub
// linking keywords. We also accept the non-closing forms from this repo's
// CLAUDE.md convention (Refs / Related to / Part of). The optional
// `owner/repo` prefix lets PR bodies reference issues in *other* repos.
const ISSUE_REF_PATTERN =
  /\b(?:refs?|closes?|closed|close[sd]?|fix(?:es|ed)?|resolves?|resolved|related\s+to|part\s+of)\b[:\s]+([\w.-]+\/[\w.-]+)?#(\d+)/gi;

// Bare GitHub issue URL — matches "https://github.com/owner/repo/issues/N"
// embedded anywhere in the PR body / title.
const ISSUE_URL_PATTERN =
  /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/gi;

/** Extract every `owner/repo#N` issue ref mentioned in `text`. `prRepo` is the
 *  repository the PR itself lives in — used to qualify bare `#N` refs (which
 *  GitHub interprets as same-repo). */
export function extractIssueRefs(prRepo: string, text: string): Set<string> {
  const refs = new Set<string>();
  for (const m of text.matchAll(ISSUE_REF_PATTERN)) {
    const ownerRepo = m[1] || prRepo;
    refs.add(`${ownerRepo}#${m[2]}`);
  }
  for (const m of text.matchAll(ISSUE_URL_PATTERN)) {
    refs.add(`${m[1]}#${m[2]}`);
  }
  return refs;
}

interface SearchPrItem {
  number: number;
  title: string;
  state: string;
  body: string | null;
  html_url: string;
  repository_url: string;
  draft?: boolean;
  updated_at: string;
  pull_request?: unknown;
}

interface SearchPrsResponse {
  total_count: number;
  incomplete_results: boolean;
  items: SearchPrItem[];
}

/** Window for `is:merged` PR lookups, in days. Repo's release-close flow
 *  (CLAUDE.md) keeps an issue open until the release tag covering the
 *  merged PR is cut and confirmed; in practice that gap is < 30 days. 60
 *  days is a generous upper bound that still keeps GitHub Search result
 *  size well under the 100-item per_page cap. */
const MERGED_PR_WINDOW_DAYS = 60;

/** Single GitHub search call for PRs. `orgs` (`org:` qualifiers) and
 *  `repos` (`repo:` qualifiers) are mutually exclusive — GitHub Search drops
 *  `repo:` when combined with `org:`. With auth-worker delegation (#116) the
 *  resolved token is user-scope and spans all orgs the operator belongs to,
 *  so cross-org `org:ippoan org:ohishi-exp` fits in one call (no fan-out
 *  needed, unlike the App-installation era).
 *
 *  `state: 'merged'` adds `is:merged` and an `updated:>=<date>` window so the
 *  result stays bounded. */
export async function fetchOpenPrsByIssue(
  env: AuthClientWorkerEnv,
  params: {
    orgs?: string[];
    repos?: string[];
    per_page?: number;
    state?: "open" | "merged";
  },
): Promise<Map<string, IssuePrRef[]>> {
  const { orgs = [], repos = [], per_page = 100, state = "open" } = params;
  for (const o of orgs) validateOrg(o);
  for (const r of repos) validateOrg(r.split("/")[0]!);

  const token = await getGitHubToken(env, { authWorkerOrigin: AUTH_WORKER_ORIGIN });

  const parts: string[] = ["is:pr", "archived:false"];
  if (state === "merged") {
    parts.push("is:merged");
    const cutoff = new Date(Date.now() - MERGED_PR_WINDOW_DAYS * 86400 * 1000)
      .toISOString().slice(0, 10);
    parts.push(`updated:>=${cutoff}`);
  } else {
    parts.push("state:open");
  }
  if (repos.length > 0) {
    for (const r of repos) parts.push(`repo:${r}`);
  } else {
    for (const o of orgs) parts.push(`org:${o}`);
  }
  const q = parts.join(" ");

  const data = await githubApi<SearchPrsResponse>(
    token, "GET", "/search/issues", undefined,
    { q, per_page: String(per_page) },
  );

  const map = new Map<string, IssuePrRef[]>();
  for (const pr of data.items) {
    const repo = pr.repository_url.split("/").slice(-2).join("/");
    const text = `${pr.title}\n${pr.body ?? ""}`;
    const refs = extractIssueRefs(repo, text);
    if (refs.size === 0) continue;
    const ref: IssuePrRef = {
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      draft: pr.draft ?? false,
      updated_at: pr.updated_at,
      state,
    };
    for (const key of refs) {
      const existing = map.get(key);
      if (existing) existing.push(ref);
      else map.set(key, [ref]);
    }
  }
  return map;
}

/** Fetch and merge PR → issue maps across the two search shapes the issues
 *  page uses (main orgs + yhonda `repo:` filter) AND the two states we care
 *  about (open + merged). 4 calls in parallel because the two repo shapes
 *  can't be combined in one GitHub search (`repo:` is dropped when `org:` is
 *  also present), and the two states can't be `OR`-ed inside a single
 *  search query either. Merged PRs surface issues whose `Refs #N` work is
 *  done but whose release-close hasn't happened yet (CLAUDE.md flow). */
export async function fetchAllOpenPrsByIssue(
  env: AuthClientWorkerEnv,
  mainOrgs: string[],
  yhondaRepos: string[],
): Promise<Map<string, IssuePrRef[]>> {
  const calls: Array<Promise<Map<string, IssuePrRef[]>>> = [
    fetchOpenPrsByIssue(env, { orgs: mainOrgs, state: "open" }),
    fetchOpenPrsByIssue(env, { orgs: mainOrgs, state: "merged" }),
  ];
  if (yhondaRepos.length > 0) {
    calls.push(fetchOpenPrsByIssue(env, { repos: yhondaRepos, state: "open" }));
    calls.push(fetchOpenPrsByIssue(env, { repos: yhondaRepos, state: "merged" }));
  }
  const results = await Promise.all(calls);
  const merged = new Map<string, IssuePrRef[]>();
  for (const m of results) {
    for (const [k, prs] of m) {
      const existing = merged.get(k);
      if (existing) existing.push(...prs);
      else merged.set(k, [...prs]);
    }
  }
  // Sort each list: open first (work still in flight), then merged; within
  // each group by recency so the most-recently-updated PR renders first.
  for (const prs of merged.values()) {
    prs.sort((a, b) => {
      if (a.state !== b.state) return a.state === "open" ? -1 : 1;
      return b.updated_at.localeCompare(a.updated_at);
    });
  }
  return merged;
}
