import { githubApi, validateOrg } from "./github-api";

/** Lightweight PR descriptor used by the issues page to render "related PR"
 *  chips. Body is intentionally not retained — it's only used to extract
 *  issue refs and would balloon the KV-cached payload. */
export interface IssuePrRef {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  updated_at: string;
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

/** Single GitHub search call for open PRs. Pass `orgs` for `org:` qualifiers
 *  or `repos` for `repo:` qualifiers (mutually exclusive — GitHub silently
 *  drops `repo:` when combined with `org:`, mirroring fetchOrgIssues). */
export async function fetchOpenPrsByIssue(
  token: string,
  params: { orgs?: string[]; repos?: string[]; per_page?: number },
): Promise<Map<string, IssuePrRef[]>> {
  const { orgs = [], repos = [], per_page = 100 } = params;
  for (const o of orgs) validateOrg(o);
  for (const r of repos) validateOrg(r.split("/")[0]!);

  const parts: string[] = ["is:pr", "state:open", "archived:false"];
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
    };
    for (const key of refs) {
      const existing = map.get(key);
      if (existing) existing.push(ref);
      else map.set(key, [ref]);
    }
  }
  return map;
}

/** Fetch and merge open-PR → issue maps across the two search shapes the
 *  issues page uses (main orgs + yhonda `repo:` filter). Mirrors the parallel
 *  pattern in issues-page.ts so a partial failure aborts the whole call. */
export async function fetchAllOpenPrsByIssue(
  token: string,
  mainOrgs: string[],
  yhondaRepos: string[],
): Promise<Map<string, IssuePrRef[]>> {
  const [main, yhonda] = await Promise.all([
    fetchOpenPrsByIssue(token, { orgs: mainOrgs }),
    yhondaRepos.length > 0
      ? fetchOpenPrsByIssue(token, { repos: yhondaRepos })
      : Promise.resolve(new Map<string, IssuePrRef[]>()),
  ]);
  const merged = new Map<string, IssuePrRef[]>(main);
  for (const [k, prs] of yhonda) {
    const existing = merged.get(k);
    if (existing) existing.push(...prs);
    else merged.set(k, prs);
  }
  // Sort each list by recency so the most-recently-updated PR renders first.
  for (const prs of merged.values()) {
    prs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  return merged;
}
