// Stateless launch-redirect for the `open-multirepo` skill.
//
// The full `claude.ai/code?repositories=...&prompt=...` URL is ~1 KB, and
// GitHub / Claude markdown silently refuse to linkify URLs that long (observed
// failures well under the documented 4 KB limit). Rather than shorten via a
// third party (TinyURL) or a stateful KV shortener — both of which need a
// create round-trip — this endpoint reconstructs the target from a compact,
// semantic query at click time. The skill emits the short
// `https://ci-dashboard.ippoan.org/cc?i=<issue>` form and we 302 to the
// expanded URL. No storage, no create round-trip, no third party.
//
// Open-redirect safe: the Location is always built as a `claude.ai/code` URL.
// `repositories` is restricted to validated `owner/repo` tokens and `prompt`
// is percent-encoded — no user-controlled origin is ever echoed.

const LAUNCH_BASE = "https://claude.ai/code";

// Default "all" preset = the standard full attach set used by open-multirepo
// (= the session's GitHub MCP scope). Keep in sync; update via PR when the
// repo set changes. A request with no `r` (or an `r` keyword without a `/`,
// e.g. `all` / `*` / `全部`) expands to this list.
const ALL_REPOS = [
  "ippoan/release-wave-gcp",
  "ippoan/nuxt-notify",
  "ippoan/rust-alc-api",
  "yhonda-ohishi/claude-hooks",
  "ippoan/claude-md",
  "ippoan/auth-worker",
  "ippoan/ci-dashboard",
  "ippoan/secrets-inventory-gcp",
  "ippoan/cc-relay",
  "ippoan/mcp-relay-rs",
  "ippoan/secrets-inventory",
  "ippoan/nuxt-egov",
  "ippoan/egov-shinsei-sdk",
  "ippoan/ci-workflows",
  "ippoan/nuxt-trouble",
  "ippoan/mcp-cf-workers",
  "ippoan/ref-files-worker",
  "ohishi-exp/nuxt-dtako-admin",
  "ohishi-exp/nuxt_dtako_logs",
  "ippoan/nuxt-pwa-carins",
  "ohishi-exp/dtako-scraper",
  "ohishi-exp/nuxt-ichibanboshi",
  "ippoan/alc-app",
  "ippoan/nuxt-items",
  "ohishi-exp/rust-ichibanboshi",
  "ippoan/HealthConnectReaderWorker",
  "ippoan/HealthConnectReader",
  "ippoan/claude-hooks",
  "ippoan/claude-skills",
  "yhonda-ohishi/freee",
  "ippoan/ui-preview",
  "ippoan/ippoan-drift",
];

const REPO_RE = /^[^/\s,]+\/[^/\s,]+$/;

// `r` is either a preset keyword (no `/` → full set) or a comma-separated
// explicit `owner/repo` list (filtered to valid tokens).
function resolveRepos(r: string | null): string[] {
  if (!r || !r.includes("/")) return ALL_REPOS;
  return r
    .split(",")
    .map((s) => s.trim())
    .filter((s) => REPO_RE.test(s));
}

/**
 * `GET /cc?i=<owner/repo#N>[&r=<preset|owner/repo,...>][&p=<prompt>]`
 * → 302 to the reconstructed `claude.ai/code` launch URL.
 */
export function handleLaunch(req: Request): Response {
  const url = new URL(req.url);
  const issue = url.searchParams.get("i")?.trim();
  if (!issue) {
    return new Response("missing required query param: i (owner/repo#N)", {
      status: 400,
    });
  }

  const repos = resolveRepos(url.searchParams.get("r"));
  if (repos.length === 0) {
    return new Response("no valid owner/repo entries in r=", { status: 400 });
  }

  const prompt =
    url.searchParams.get("p")?.trim() ||
    `${issue} を read してチェックリストを順に処理。全 repo default branch。`;

  // Build the query by hand: commas in `repositories` must stay raw (claude.ai
  // /code expects unescaped `,`), only `prompt` is percent-encoded.
  const target =
    `${LAUNCH_BASE}?repositories=${repos.join(",")}` +
    `&prompt=${encodeURIComponent(prompt)}`;

  return new Response(null, { status: 302, headers: { Location: target } });
}
