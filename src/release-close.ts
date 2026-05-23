import { githubApi, parseRepo, tokenForOrg } from "./github-api";
import type { GitHubAppEnv } from "./github-app-auth";
import { invalidateIssue } from "./release-cache";

// POST /api/release-close
// Receives the form submitted from /releases?repo=...&tag=... and closes the
// selected issues. For each issue we (1) drop a "Closed by release <tag>"
// comment so the audit trail lives on the issue itself, (2) PATCH the issue
// to closed/state_reason=completed (mirrors the close_issue MCP tool's
// payload at src/mcp/tools/issues.ts).
//
// Auth: relies on Cloudflare Access in front of ci-dashboard (same trust
// model as GET /releases). Server-side auth here would just double-gate the
// same identity.

export async function handleReleaseClose(
  req: Request,
  env: GitHubAppEnv,
  hub?: DurableObjectStub,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const form = await req.formData();
  const repoParam = String(form.get("repo") ?? "").trim();
  const tag = String(form.get("tag") ?? "").trim();
  const issueNumbers = form
    .getAll("issue")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (!repoParam || !tag) {
    return new Response("Missing repo or tag", { status: 400 });
  }

  // No selections: send the user back without spamming GitHub.
  if (issueNumbers.length === 0) {
    return redirect(`/releases?repo=${encodeURIComponent(repoParam)}&tag=${encodeURIComponent(tag)}`);
  }

  let owner: string, name: string, token: string;
  try {
    ({ owner, repo: name } = parseRepo(repoParam));
    token = await tokenForOrg(env, owner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Bad repo: ${msg}`, { status: 400 });
  }

  // Close in parallel; per-issue failures don't sink the whole batch. The
  // result lists are surfaced as flash params on the redirect target.
  const settled = await Promise.allSettled(
    issueNumbers.map(async (n) => {
      await githubApi(
        token, "POST",
        `/repos/${owner}/${name}/issues/${n}/comments`,
        { body: `Closed by release ${tag}` },
      );
      await githubApi(
        token, "PATCH",
        `/repos/${owner}/${name}/issues/${n}`,
        { state: "closed", state_reason: "completed" },
      );
      return n;
    }),
  );

  const closed: number[] = [];
  const failed: number[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") closed.push(r.value);
    else failed.push(issueNumbers[i]!);
  });

  // Drop the just-closed issues from the release cache so the next /releases
  // load (and the banner recompute below) sees `state: "closed"` instead of
  // the still-open snapshot from the 60s TTL window.
  if (env.CI_STATUS) {
    await Promise.all(
      closed.map((n) => invalidateIssue(env.CI_STATUS, owner, name, n)),
    );
  }

  // Kick the Hub to recompute the banner alert state for this repo when at
  // least one issue actually closed. waitUntil keeps the user-facing redirect
  // snappy — the banner update can land asynchronously.
  if (hub && closed.length > 0) {
    const recompute = hub.fetch(new Request("http://hub/release-alert-recompute", {
      method: "POST",
      body: JSON.stringify({ repo: repoParam }),
    }));
    if (ctx) ctx.waitUntil(recompute);
    else { void recompute; }  // tests / cases without ctx: fire-and-forget
  }

  const params = new URLSearchParams({ repo: repoParam, tag });
  if (closed.length > 0) params.set("closed", closed.join(","));
  if (failed.length > 0) params.set("failed", failed.join(","));
  return redirect(`/releases?${params.toString()}`);
}

function redirect(location: string): Response {
  // 303 See Other so the browser swaps POST → GET on the redirect target.
  return new Response(null, {
    status: 303,
    headers: { Location: location },
  });
}
