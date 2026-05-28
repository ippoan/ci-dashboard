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
  parseRepo,
  tokenForOrg,
  GitHubApiError,
} from "./github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import {
  extractRefIssues,
  extractPrNumber,
  extractBranchIssue,
  sortSemverDesc,
  previousTag,
} from "./release-helpers";
import {
  cachedTags,
  cachedCompare,
  cachedCommits,
  cachedPullRequest,
  cachedPullRequestCommits,
  cachedIssue,
  type RawIssue,
} from "./release-cache";

export interface ReleaseAlert {
  repo: string;          // "owner/name"
  tag: string;
  prevTag: string | null;
  openIssues: Array<{ number: number; title: string; url: string }>;
  detectedAt: string;    // ISO
  // Set when this alert was created by a PR merge into the default branch
  // (tagless repos). When absent the alert represents a traditional tag
  // release. Banner UI keys off this to render "PR #N" vs "<tag>".
  prNumber?: number;
}

export type { RawIssue };

// Walk the commits introduced by `tag` (using compare against `prevTag` when
// available, otherwise a bounded log walk for the first-ever release) and
// collect every issue number we can attribute to those commits.
export async function collectIssueNumbersForRange(
  token: string,
  owner: string,
  name: string,
  tag: string,
  prevTag: string | null,
  kv?: KVNamespace,
): Promise<{ issueNumbers: Set<number>; commitCount: number }> {
  const commits = prevTag
    ? (await cachedCompare(token, kv, owner, name, prevTag, tag)).commits
    : await cachedCommits(token, kv, owner, name, tag, 50);

  const issueNumbers = new Set<number>();
  const prNumbers = new Set<number>();
  const repoCtx = { owner, name };
  for (const c of commits) {
    const msg = c.commit.message;
    for (const n of extractRefIssues(msg, repoCtx)) issueNumbers.add(n);
    const pr = extractPrNumber(msg);
    if (pr !== null) prNumbers.add(pr);
  }

  // PR follow-up pass: head.ref (branch name) and body carry refs that the
  // squash-merge subject line drops.
  await Promise.all([...prNumbers].map(async (n) => {
    try {
      const pr = await cachedPullRequest(token, kv, owner, name, n);
      const fromBranch = extractBranchIssue(pr.head.ref);
      if (fromBranch !== null) issueNumbers.add(fromBranch);
      if (pr.body) {
        for (const ref of extractRefIssues(pr.body, repoCtx)) issueNumbers.add(ref);
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
  kv?: KVNamespace,
): Promise<RawIssue[]> {
  const results = await Promise.all([...numbers].map(async (n) => {
    try {
      return await cachedIssue(token, kv, owner, name, n);
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
  env: AuthClientWorkerEnv,
  repo: string,
  tagOverride?: string,
  kv?: KVNamespace,
): Promise<ReleaseAlert | null> {
  const { owner, repo: name } = parseRepo(repo);
  const token = await tokenForOrg(env, owner);

  const tags = await cachedTags(token, kv, owner, name, 30);
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
    token, owner, name, tag, prevTag, kv,
  );

  if (issueNumbers.size === 0) return null;

  const issues = await fetchIssuesByNumbers(token, owner, name, issueNumbers, kv);
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
  env: AuthClientWorkerEnv,
  repo: string,
  tag: string,
  kv?: KVNamespace,
): Promise<ReleaseAlert | null> {
  return computeReleaseAlert(env, repo, tag, kv);
}

// PR-merge variant of computeReleaseAlert for tagless repos. A merged PR is
// treated as a mini-release: walk the PR's commits + body + branch name for
// `Refs #N`, hydrate the referenced issues, and return open ones.
//
// `mergeSha` is used only to produce a human-readable tag label
// (`<defaultBranch>@<sha7>`). When absent the label falls back to
// `<defaultBranch>@pr-<n>` — the alert is still functional; the only loss is a
// less-clickable label.
export async function computeReleaseAlertForPr(
  env: AuthClientWorkerEnv,
  repo: string,
  prNumber: number,
  mergeSha: string | null,
  defaultBranch: string,
  kv?: KVNamespace,
): Promise<ReleaseAlert | null> {
  const { owner, repo: name } = parseRepo(repo);
  const token = await tokenForOrg(env, owner);

  const issueNumbers = new Set<number>();
  const repoCtx = { owner, name };

  // PR metadata: body has `Refs #N`, branch name has the issue prefix
  // (CLAUDE.md convention <issue>-<type>-<desc>).
  try {
    const pr = await cachedPullRequest(token, kv, owner, name, prNumber);
    const fromBranch = extractBranchIssue(pr.head.ref);
    if (fromBranch !== null) issueNumbers.add(fromBranch);
    if (pr.body) {
      for (const ref of extractRefIssues(pr.body, repoCtx)) issueNumbers.add(ref);
    }
  } catch { /* PR fetch failure — still try commit walk */ }

  // PR commits: each commit message can carry its own `Refs #N`. Squash merges
  // collapse to one commit (often duplicating the PR body), but rebase / true-
  // merge variants spread the refs across multiple commits.
  try {
    const commits = await cachedPullRequestCommits(token, kv, owner, name, prNumber);
    for (const c of commits) {
      for (const n of extractRefIssues(c.commit.message, repoCtx)) issueNumbers.add(n);
    }
  } catch { /* commits API failure — proceed with what we have */ }

  if (issueNumbers.size === 0) return null;

  const issues = await fetchIssuesByNumbers(token, owner, name, issueNumbers, kv);
  const openIssues = issues
    .filter((i) => !i.pull_request && i.state === "open")
    .map((i) => ({ number: i.number, title: i.title, url: i.html_url }))
    .sort((a, b) => a.number - b.number);

  if (openIssues.length === 0) return null;

  const sha7 = mergeSha?.slice(0, 7) ?? `pr-${prNumber}`;
  return {
    repo: `${owner}/${name}`,
    tag: `${defaultBranch}@${sha7}`,
    prevTag: null,
    openIssues,
    detectedAt: new Date().toISOString(),
    prNumber,
  };
}
