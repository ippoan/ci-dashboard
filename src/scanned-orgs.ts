// Org / repo allowlist for cross-org issue + PR scans.
//
// Single source of truth for `/issues` (issues-page.ts) and `/releases`
// (releases-page.ts via pr-map gate, Refs #400) so the two pages always agree
// on which repos are searchable. Same allowlist as github-api.ts (whose
// `ALLOWED_ORGS` isn't exported).
//
// `MAIN_ORGS` are scanned in full; `YHONDA_REPOS` carries only the active
// claude-tooling repo from a personal org that would otherwise drag in lots
// of dormant 2023-2024 noise.
export const MAIN_ORGS = ["ippoan", "ohishi-exp"];
export const YHONDA_REPOS = ["yhonda-ohishi/claude-skills"];
