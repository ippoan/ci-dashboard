// Release alert computation.
//
// Shared between `releases-page.ts` (which renders all referenced issues —
// open + closed — for the operator's confirmation table) and `webhook.ts`
// (which only cares about *open* issues to decide whether the dashboard
// banner should appear after a tag release).
//
// The two halves below split that pipeline:
//   - collectIssueNumbersForRange: walks a tag's compare range, harvests
//     `Refs #N`, PR numbers and branch-prefixed issue numbers into a Set.
//   - fetchIssuesByNumbers: hydrates those numbers into RawIssue records
//     (PRs filtered out at the caller).
//   - computeReleaseAlert: convenience wrapper that picks the latest semver
//     tag for a repo, runs both steps, and returns ReleaseAlert | null.
//
// The split lets the SSR `loadRelease()` reuse the heavy GitHub fan-out
// without forcing the alert path to recompute warnings / labels / assignees
// it doesn't show.

import {
  githubApi,
  parseRepo,
  validateOrg,
  GitHubApiError,
} from "./github-api";
import {
  extractRefIssues,
  extractPrNumber,
  extractBranchIssue,
  sortSemverDesc,
  previousTag,
} from "./release-helpers";

export interface ReleaseAlert {
  repo: string;          // "owner/name"
  tag: string;
  prevTag: string | null;
  openIssues: Array<{ number: number; title: string; url: string }>;
  detectedAt: string;    // ISO
}

interface TagListItem { name: string; commit: { sha: string } }
interface RawCommit { sha: string; commit: { message: string } }
interface CompareResponse { commits: RawCommit[] }
interface PrResponse { head: { ref: string }; body: string | null }
export interface RawIssue {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  html_url: string;
  updated_at: string;
  pull_request?: unknown;
}

// Walk the commits introduced by `tag` (using compare against `prevTag` when
// available, otherwise a bounded log walk for the first-ever release) and
// collect every issue number we can attribute to those commits.
export async function collectIssueNumbersForRange(
  token: string,
  owner: string,
  name: string,
  tag: string,
  prevTag: string | null,
): Promise<{ issueNumbers: Set<number>; commitCount: number }> {
  const commits = prevTag
    ? (await githubApi<CompareResponse>(
        token, "GET", `/repos/${owner}/${name}/compare/${prevTag}...${tag}`,
      )).commits
    : await githubApi<RawCommit[]>(
        token, "GET", `/repos/${owner}/${name}/commits`, undefined,
        { sha: tag, per_page: "50" },
      );

  const issueNumbers = new Set<number>();
  const prNumbers = new Set<number>();
  for (const c of commits) {
    const msg = c.commit.message;
    for (const n of extractRefIssues(msg)) issueNumbers.add(n);
    const pr = extractPrNumber(msg);
    if (pr !== null) prNumbers.add(pr);
  }

  // PR follow-up pass: head.ref (branch name) and body carry refs that the
  // squash-merge subject line drops.
  await Promise.all([...prNumbers].map(async (n) => {
    try {
      const pr = await githubApi<PrResponse>(
        token, "GET", `/repos/${owner}/${name}/pulls/${n}`,
      );
      const fromBranch = extractBranchIssue(pr.head.ref);
      if (fromBranch !== null) issueNumbers.add(fromBranch);
      if (pr.body) {
        for (const ref of extractRefIssues(pr.body)) issueNumbers.add(ref);
      }
    } catch { /* ignore per-PR failure */ }
  }));

  return { issueNumbers, commitCount: commits.length };
}

// Hydrate a set of issue numbers into RawIssue records. PRs are NOT filtered
// here — callers do that with the `pull_request` discriminator so they can
// decide between dropping vs. logging.
export async function fetchIssuesByNumbers(
  token: string,
  owner: string,
  name: string,
  numbers: Iterable<number>,
): Promise<RawIssue[]> {
  const results = await Promise.all([...numbers].map(async (n) => {
    try {
      return await githubApi<RawIssue>(
        token, "GET", `/repos/${owner}/${name}/issues/${n}`,
      );
    } catch {
      return null;
    }
  }));
  return results.filter((i): i is RawIssue => i !== null);
}

// Convenience wrapper: pick the latest semver tag (when not supplied),
// compute the alert payload, return null when no open issues are referenced
// (banner suppressed).
export async function computeReleaseAlert(
  token: string,
  repo: string,
  tagOverride?: string,
): Promise<ReleaseAlert | null> {
  const { owner, repo: name } = parseRepo(repo);
  validateOrg(owner);

  const tags = await githubApi<TagListItem[]>(
    token, "GET", `/repos/${owner}/${name}/tags`, undefined,
    { per_page: "30" },
  );
  const tagNames = tags.map((t) => t.name);
  if (tagNames.length === 0) return null;

  const sorted = sortSemverDesc(tagNames);
  const tag = tagOverride ?? sorted[0]!;

  // If caller passed a tag we don't recognize, surface as 404 — alert
  // computation is best-effort, not a synchronization layer.
  if (!tagNames.includes(tag)) {
    throw new GitHubApiError(
      404,
      `Tag "${tag}" not present in ${owner}/${name} (recent ${tagNames.length} tags scanned)`,
    );
  }

  const prevTag = previousTag(sorted, tag);
  const { issueNumbers } = await collectIssueNumbersForRange(
    token, owner, name, tag, prevTag,
  );

  if (issueNumbers.size === 0) return null;

  const issues = await fetchIssuesByNumbers(token, owner, name, issueNumbers);
  const openIssues = issues
    .filter((i) => !i.pull_request && i.state === "open")
    .map((i) => ({ number: i.number, title: i.title, url: i.html_url }))
    .sort((a, b) => a.number - b.number);

  if (openIssues.length === 0) return null;

  return {
    repo: `${owner}/${name}`,
    tag,
    prevTag,
    openIssues,
    detectedAt: new Date().toISOString(),
  };
}

// Recompute alert against current GitHub state and return null when there
// are no open referenced issues left (banner should clear). Used by the
// release-close path so a successful close immediately drops the banner.
export async function recomputeAlert(
  token: string,
  repo: string,
  tag: string,
): Promise<ReleaseAlert | null> {
  return computeReleaseAlert(token, repo, tag);
}
