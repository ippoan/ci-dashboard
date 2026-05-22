// Tagless repos: repos that don't cut release tags, so PR merges into the
// default branch act as the "release event" for dashboard banner + /releases
// synthetic-block detection. Sourced from the `TAGLESS_REPOS` wrangler var
// (comma-separated `owner/name`). See wrangler.jsonc.
//
// Kept tiny + pure so webhook + hub + releases-page can call it without taking
// on a circular import on Env.

export function parseTaglessRepos(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}
