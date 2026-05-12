// Pure helpers for the release confirmation view. Kept fetch-free so they can
// be unit-tested without stubbing GitHub. The SSR page in `releases-page.ts`
// composes these against githubApi() results.

// `Refs #N` / `Related to #N` / `Part of #N` (case-insensitive). The Refs-style
// convention is documented in CLAUDE.md as the auto-close-safe replacement for
// `Closes #N` / `Fixes #N`.
const REF_PATTERN = /(?:Refs|Related to|Part of)\s+#(\d+)/gi;

export function extractRefIssues(text: string): number[] {
  if (!text) return [];
  const out = new Set<number>();
  for (const m of text.matchAll(REF_PATTERN)) out.add(Number(m[1]));
  return [...out];
}

// Squash-merge commits land on main with their PR number trailing the subject,
// e.g. "feat(x): do thing (#42)". Pull that out so we can re-fetch the PR for
// its `head.ref` (branch name) and body, which carry additional Refs and the
// branch-prefixed issue number.
export function extractPrNumber(commitMessage: string): number | null {
  if (!commitMessage) return null;
  const firstLine = commitMessage.split("\n", 1)[0]!;
  const m = firstLine.match(/\(#(\d+)\)\s*$/);
  return m ? Number(m[1]) : null;
}

// Branch convention is `<issue>-<type>-<desc>` (project CLAUDE.md). Pull the
// leading number off so a release that merged `42-fix-x` is recognized as
// touching issue #42 even if no Refs trailer exists.
export function extractBranchIssue(branchName: string): number | null {
  if (!branchName) return null;
  const m = branchName.match(/^(\d+)-/);
  return m ? Number(m[1]) : null;
}

// Sort semver-shaped tags ("v1.2.3" or "1.2.3") in descending order. Tags that
// don't match the shape fall to the bottom in alphabetical order — they may be
// release candidates or hand-rolled labels and we don't want them shadowing a
// real previous release when we pick "the tag before this one".
export function sortSemverDesc(tags: readonly string[]): string[] {
  return [...tags].sort(compareTagsDesc);
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)/;

function compareTagsDesc(a: string, b: string): number {
  const ma = a.match(SEMVER_RE);
  const mb = b.match(SEMVER_RE);
  if (!ma && !mb) return a.localeCompare(b);
  if (!ma) return 1;
  if (!mb) return -1;
  for (let i = 1; i <= 3; i++) {
    const d = Number(mb[i]) - Number(ma[i]);
    if (d !== 0) return d;
  }
  return 0;
}

// Given tags already sorted descending, return the tag immediately *older*
// than `current`. Returns null when `current` is the oldest (or absent).
export function previousTag(tagsDescending: readonly string[], current: string): string | null {
  const idx = tagsDescending.indexOf(current);
  if (idx < 0 || idx === tagsDescending.length - 1) return null;
  return tagsDescending[idx + 1] ?? null;
}

// Warning flags drive whether a candidate row's checkbox defaults to OFF.
// The list is intentionally narrow for the MVP — comment-after-merge and
// reaction-based heuristics need extra API calls and can come later.
export interface IssueLike {
  state: string;
  labels: ReadonlyArray<string>;
}

const WARN_LABELS = new Set(["bug", "regression"]);

export function computeWarnings(issue: IssueLike): string[] {
  const out: string[] = [];
  if (issue.state === "closed") out.push("already closed");
  for (const l of issue.labels) {
    if (WARN_LABELS.has(l.toLowerCase())) out.push(`${l} label`);
  }
  return out;
}
