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
// Single-tag close still lives at POST /api/release-close (used by the
// detail page) — that handler's payload shape is the older `tag` + `issue[]`
// form and we keep it for backward compatibility.

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

  // Parse `tag:issue` pairs; silently drop anything malformed.
  const grouped = new Map<string, number[]>();
  for (const raw of rawPairs) {
    const m = raw.match(PAIR_RE);
    if (!m) continue;
    const tag = m[1]!;
    const n = Number(m[2]);
    if (!Number.isInteger(n) || n <= 0) continue;
    const list = grouped.get(tag);
    if (list) list.push(n);
    else grouped.set(tag, [n]);
  }

  // Nothing selected → bounce straight back to /releases without spamming
  // GitHub. This is the "user submitted an empty form" path.
  if (grouped.size === 0) {
    return redirect("/releases");
  }

  let owner: string, name: string, token: string;
  try {
    ({ owner, repo: name } = parseRepo(repoParam));
    token = await tokenForOrg(env, owner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Bad repo: ${msg}`, { status: 400 });
  }

  // Flatten the grouped map into one operation list so failures per issue
  // can be tracked back to the right number for the flash query.
  type Operation = { tag: string; issue: number };
  const ops: Operation[] = [];
  for (const [tag, issues] of grouped) {
    for (const issue of issues) ops.push({ tag, issue });
  }

  const settled = await Promise.allSettled(
    ops.map(async ({ tag, issue }) => {
      await githubApi(
        token, "POST",
        `/repos/${owner}/${name}/issues/${issue}/comments`,
        { body: `Closed by release ${tag}` },
      );
      await githubApi(
        token, "PATCH",
        `/repos/${owner}/${name}/issues/${issue}`,
        { state: "closed", state_reason: "completed" },
      );
      return issue;
    }),
  );

  const closed: number[] = [];
  const failed: number[] = [];
  const failedReasons: Array<{ n: number; reason: string }> = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") closed.push(r.value);
    else {
      const n = ops[i]!.issue;
      failed.push(n);
      failedReasons.push({ n, reason: formatCloseFailureReason(r.reason) });
    }
  });

  // Invalidate cached issue snapshots so the next /releases load reflects the
  // newly-closed state instead of the 60s-stale "open" row.
  if (env.CI_STATUS) {
    await Promise.all(
      closed.map((n) => invalidateIssue(env.CI_STATUS, owner, name, n)),
    );
  }

  // Kick Hub to recompute alert state for this repo when at least one close
  // succeeded. Same waitUntil pattern as release-close.ts so the redirect
  // stays snappy and the dashboard banner updates asynchronously.
  if (hub && closed.length > 0) {
    const recompute = hub.fetch(new Request("http://hub/release-alert-recompute", {
      method: "POST",
      body: JSON.stringify({ repo: repoParam }),
    }));
    if (ctx) ctx.waitUntil(recompute);
    else { void recompute; }
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
