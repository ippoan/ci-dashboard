import { githubApi, parseRepo, tokenForOrg } from "./github-api";
import { formatCloseFailureReason } from "./release-close";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { invalidateIssue } from "./release-cache";

// POST /api/release-close-batch
//
// The `/releases` index page renders one form per repo, but inside that form
// the operator picks issues across several tags. The form encodes each
// selection as `pair=<tag>:<issue>`, so this handler groups by tag in order
// to attribute each "Closed by release <tag>" comment to the right tag, then
// closes the issues.
//
// Cross-repo rows (an issue that lives in a DIFFERENT repo but was shipped by a
// PR in this card's repo — e.g. a cdp-relay PR carrying
// `Refs ippoan/mcp-cf-workers#28`) encode the home repo into the pair as
// `pair=<tag>:<owner>/<name>#<issue>`, and we close them against that repo
// instead of the card's repo. Refs ippoan/ci-dashboard#292.
//
// Single-tag close still lives at POST /api/release-close (used by the
// detail page) — that handler's payload shape is the older `tag` + `issue[]`
// form and we keep it for backward compatibility.

// `<tag>:<owner>/<name>#<issue>` — cross-repo. Checked first (more specific).
const CROSS_RE = /^(.+):([\w.-]+\/[\w.-]+)#(\d+)$/;
// `<tag>:<issue>` — same repo as the card.
const PAIR_RE = /^(.+):(\d+)$/;

export async function handleReleaseCloseBatch(
  req: Request,
  env: AuthClientWorkerEnv,
  hub?: DurableObjectStub,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const form = await req.formData();
  const repoParam = String(form.get("repo") ?? "").trim();
  const rawPairs = form.getAll("pair").map((v) => String(v));

  if (!repoParam) {
    return new Response("Missing repo", { status: 400 });
  }

  // Resolve a token once per distinct owner (cross-repo ops may span repos).
  const tokenByOwner = new Map<string, Promise<string>>();
  const tokenFor = (owner: string): Promise<string> => {
    let p = tokenByOwner.get(owner);
    if (!p) {
      p = tokenForOrg(env, owner);
      tokenByOwner.set(owner, p);
    }
    return p;
  };

  // Validate the card repo's org up front: a disallowed / malformed card repo is
  // a 400 (operator-facing config error), not a silent per-issue failure. Also
  // primes the token cache for the common same-repo ops. Cross-repo targets are
  // validated lazily inside the close loop (a single bad cross-repo ref should
  // only fail that one row, not the whole batch).
  try {
    const { owner: cardOwner } = parseRepo(repoParam);
    await tokenFor(cardOwner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Bad repo: ${msg}`, { status: 400 });
  }

  // Parse pairs into operations. Each op carries its target repo: the card's
  // repo by default, or the cross-repo target embedded in the pair. Malformed
  // pairs are silently dropped.
  type Operation = { repo: string; tag: string; issue: number };
  const ops: Operation[] = [];
  for (const raw of rawPairs) {
    const cm = raw.match(CROSS_RE);
    if (cm) {
      const n = Number(cm[3]);
      if (Number.isInteger(n) && n > 0) ops.push({ repo: cm[2]!, tag: cm[1]!, issue: n });
      continue;
    }
    const m = raw.match(PAIR_RE);
    if (!m) continue;
    const n = Number(m[2]);
    if (Number.isInteger(n) && n > 0) ops.push({ repo: repoParam, tag: m[1]!, issue: n });
  }

  // Nothing selected → bounce straight back to /releases without spamming
  // GitHub. This is the "user submitted an empty form" path.
  if (ops.length === 0) {
    return redirect("/releases");
  }

  // Close in parallel; per-issue failures (including a bad repo) don't sink the
  // whole batch — they surface in the `failed` flash.
  const settled = await Promise.allSettled(
    ops.map(async (op) => {
      const { owner, repo: name } = parseRepo(op.repo);
      const token = await tokenFor(owner);
      await githubApi(
        token, "POST",
        `/repos/${owner}/${name}/issues/${op.issue}/comments`,
        { body: `Closed by release ${op.tag}` },
      );
      await githubApi(
        token, "PATCH",
        `/repos/${owner}/${name}/issues/${op.issue}`,
        { state: "closed", state_reason: "completed" },
      );
      return op;
    }),
  );

  const closed: number[] = [];
  const failed: number[] = [];
  const failedReasons: Array<{ n: number; reason: string }> = [];
  // Track successful closes per repo so cache invalidation + hub recompute hit
  // the right repo (the card repo AND any cross-repo targets).
  const closedByRepo = new Map<string, number[]>();
  settled.forEach((r, i) => {
    const op = ops[i]!;
    if (r.status === "fulfilled") {
      closed.push(op.issue);
      const list = closedByRepo.get(op.repo);
      if (list) list.push(op.issue);
      else closedByRepo.set(op.repo, [op.issue]);
    } else {
      failed.push(op.issue);
      failedReasons.push({ n: op.issue, reason: formatCloseFailureReason(r.reason) });
    }
  });

  // Invalidate cached issue snapshots so the next /releases load reflects the
  // newly-closed state instead of the 60s-stale "open" row.
  if (env.CI_STATUS) {
    await Promise.all(
      [...closedByRepo].flatMap(([repo, nums]) => {
        try {
          const { owner, repo: name } = parseRepo(repo);
          return nums.map((n) => invalidateIssue(env.CI_STATUS, owner, name, n));
        } catch {
          return [];
        }
      }),
    );
  }

  // Kick Hub to recompute alert state for each repo that had a successful close.
  // Same waitUntil pattern as release-close.ts so the redirect stays snappy.
  if (hub && closedByRepo.size > 0) {
    for (const repo of closedByRepo.keys()) {
      const recompute = hub.fetch(new Request("http://hub/release-alert-recompute", {
        method: "POST",
        body: JSON.stringify({ repo }),
      }));
      if (ctx) ctx.waitUntil(recompute);
      else { void recompute; }
    }
  }

  const params = new URLSearchParams({ repo: repoParam });
  if (closed.length > 0) params.set("closed", closed.join(","));
  if (failed.length > 0) params.set("failed", failed.join(","));
  if (failedReasons.length > 0) {
    params.set(
      "failed_reasons",
      failedReasons.map((f) => `${f.n}:${encodeURIComponent(f.reason)}`).join(","),
    );
  }
  return redirect(`/releases?${params.toString()}`);
}

function redirect(location: string): Response {
  // 303 so the browser swaps POST → GET on the redirect target.
  return new Response(null, {
    status: 303,
    headers: { Location: location },
  });
}
