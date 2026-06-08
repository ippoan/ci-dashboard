// Pure helpers for the release confirmation view. Kept fetch-free so they can
// be unit-tested without stubbing GitHub. The SSR page in `releases-page.ts`
// composes these against githubApi() results.

// `Refs #N` / `Related to #N` / `Part of #N` (case-insensitive). The Refs-style
// convention is documented in CLAUDE.md as the auto-close-safe replacement for
// `Closes #N` / `Fixes #N`.
//
// Cross-repo style `Refs <owner>/<name>#N` も許容する。Claude (LLM agent) が
// PR を生成する際、同 repo の issue でも cross-repo style で書く場合があり
// (Refs ippoan/secrets-inventory#57, ippoan/HealthConnectReaderWorker#60 等)、
// これを capture するため owner/name 部分を optional として match する。
// caller が `currentRepo` を渡すと、その repo に属する ref のみ返す
// (= 真の cross-repo ref を誤って同 repo issue として混入させない)。
const REF_PATTERN = /(?:Refs|Related to|Part of)\s+([\w.-]+\/[\w.-]+)?#(\d+)/gi;

export function extractRefIssues(
  text: string,
  currentRepo?: { owner: string; name: string },
): number[] {
  if (!text) return [];
  const out = new Set<number>();
  const wantOwner = currentRepo?.owner.toLowerCase();
  const wantName = currentRepo?.name.toLowerCase();
  for (const m of text.matchAll(REF_PATTERN)) {
    const crossRepo = m[1]; // optional `<owner>/<name>`
    const num = Number(m[2]);
    if (crossRepo) {
      // currentRepo 未指定なら cross-repo ref は除外 (= 別 repo の issue
      // 番号を本 repo のものと誤って混ぜないよう conservative に skip)。
      if (!wantOwner || !wantName) continue;
      const slash = crossRepo.indexOf("/");
      const o = crossRepo.slice(0, slash).toLowerCase();
      const n = crossRepo.slice(slash + 1).toLowerCase();
      if (o !== wantOwner || n !== wantName) continue;
    }
    out.add(num);
  }
  return [...out];
}

// Cross-repo refs: `Refs <owner>/<name>#N` where `<owner>/<name>` is a DIFFERENT
// repo than `currentRepo`. extractRefIssues drops these (to avoid mixing another
// repo's issue numbers into the current card); this returns exactly those dropped
// refs so the /releases index can surface an issue under the repo whose PR shipped
// the work even though the issue lives elsewhere (e.g. a cdp-relay PR carrying
// `Refs ippoan/mcp-cf-workers#28`). Refs ippoan/ci-dashboard#292.
export function extractCrossRepoRefs(
  text: string,
  currentRepo: { owner: string; name: string },
): Array<{ owner: string; name: string; number: number }> {
  if (!text) return [];
  const wantOwner = currentRepo.owner.toLowerCase();
  const wantName = currentRepo.name.toLowerCase();
  const seen = new Set<string>();
  const out: Array<{ owner: string; name: string; number: number }> = [];
  for (const m of text.matchAll(REF_PATTERN)) {
    const crossRepo = m[1]; // optional `<owner>/<name>`
    if (!crossRepo) continue; // bare `#N` = same repo, not a cross-repo ref
    const slash = crossRepo.indexOf("/");
    const owner = crossRepo.slice(0, slash);
    const name = crossRepo.slice(slash + 1);
    if (owner.toLowerCase() === wantOwner && name.toLowerCase() === wantName) {
      continue; // owner/name spelled out but it IS the current repo
    }
    const number = Number(m[2]);
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, name, number });
  }
  return out;
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

// True for release-shaped tags ("v1.2.3" / "1.2.3"). Non-semver tags
// (e.g. `installer-2026.05.15-…` install stamps) return false so callers can
// drop them before treating a repo as "has release tags" — otherwise a
// tag-less repo carrying a non-semver stamp tag is wrongly routed into the
// tag-compare path instead of the synthetic (direct-push) path, and its open
// Refs never surface on /releases. Refs #199.
export function isSemverTag(tag: string): boolean {
  return SEMVER_RE.test(tag);
}

// A *stable* release tag: `v?MAJOR.MINOR.PATCH` with no prerelease/build
// suffix. Anchored at end so `v0.5.99-wave-test-08`, `v1.2.3-dev`, `v1.2.3-rc.1`
// etc. are rejected — those must never be treated as the latest stable release
// when prefilling the next target tag (a `-wave-test-NN` tag slipping through
// here is exactly what polluted the npm `latest` dist-tag before). Returns the
// parsed components (and whether the tag carried a leading `v`), or null for
// non-stable / non-semver input.
const STABLE_SEMVER_RE = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

export interface ParsedSemver {
  hasV: boolean;
  major: number;
  minor: number;
  patch: number;
}

export function parseStableSemver(tag: string): ParsedSemver | null {
  const m = tag.trim().match(STABLE_SEMVER_RE);
  if (!m) return null;
  return {
    hasV: m[1] === "v",
    major: Number(m[2]),
    minor: Number(m[3]),
    patch: Number(m[4]),
  };
}

// Given a stable semver tag, return the same tag with patch incremented by one
// (preserving the `v` prefix), e.g. `v0.0.76 -> v0.0.77`, `v0.2.51 -> v0.2.52`,
// `1.4.0 -> 1.4.1`. Returns null when `tag` is not a stable semver (prerelease
// suffix, missing component, or junk) — callers fall back to an empty prefill.
export function nextPatchTag(tag: string): string | null {
  const p = parseStableSemver(tag);
  if (!p) return null;
  return `${p.hasV ? "v" : ""}${p.major}.${p.minor}.${p.patch + 1}`;
}

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
// Currently the sole flag is `state === "closed"` — that one is a sanity
// net so the operator notices an issue that was already manually closed
// before the release went out (re-closing is harmless but the row should
// not look like a fresh action).
//
// We previously also warned on `bug` / `regression` labels under the
// "have a human re-check fix issues at release time" rationale, but in
// practice every fix PR touches a bug-labeled issue so the warning fired
// on the rows the operator most needed to tick — adding manual work
// without catching anything. Dropped in #77.
export interface IssueLike {
  state: string;
  labels: ReadonlyArray<string>;
}

export function computeWarnings(issue: IssueLike): string[] {
  const out: string[] = [];
  if (issue.state === "closed") out.push("already closed");
  return out;
}
