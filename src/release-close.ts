import { GitHubApiError, githubApi, parseRepo, tokenForOrg } from "./github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { invalidateIssue } from "./release-cache";

// failure 理由を URL flash param に safely 載せるための整形。
// GitHubApiError は `GitHub API 403: {"message":"Repository was archived so
// is read-only.",...}` のような長い文字列を持つので、典型的な状況だけ短い
// human-readable string にマッピングし、それ以外は素の message を 100 字に
// 切る。export しているのは test から検証するため。
// Refs ippoan/ci-dashboard#152
export function formatCloseFailureReason(err: unknown): string {
  if (err instanceof GitHubApiError) {
    const msg = err.message;
    if (/Repository was archived/i.test(msg)) return "archived (read-only)";
    if (err.status === 403) {
      // 残りの 403 は token 権限不足 / SSO 未承認 / rate limit などが主。
      // message から rate limit / SAML SSO を抜き出して短文化。
      if (/rate limit/i.test(msg)) return "rate limit";
      if (/SAML SSO/i.test(msg)) return "SAML SSO required";
      return "forbidden (403)";
    }
    if (err.status === 404) return "not found (404)";
    if (err.status === 410) return "issues disabled (410)";
    if (err.status === 422) return "validation failed (422)";
    return `${err.status} ${msg.slice(0, 80)}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 100);
}

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
  env: AuthClientWorkerEnv,
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
  const failedReasons: Array<{ n: number; reason: string }> = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") closed.push(r.value);
    else {
      const n = issueNumbers[i]!;
      failed.push(n);
      failedReasons.push({ n, reason: formatCloseFailureReason(r.reason) });
    }
  });

  // Drop the just-closed issues from the release cache so the next /releases
  // load (and the banner recompute below) sees `state: "closed"` instead of
  // the still-open snapshot from the 60s TTL window.
  if (env.CI_STATUS) {
    await Promise.all(
      closed.map((n) => invalidateIssue(env.CI_STATUS, owner, name, n)),
    );
  }

  // /releases index blob を close 経路で同期 patch する (Refs #343)。issues
  // webhook 直接 patch (#339) は per-repo 購読に依存し、未購読 repo では
  // blob が patch されず closed issue が reload で復活する (= #343 の実害)。
  // close handler は確定した closed[] を握っているので、redirect 前に hub
  // 経由で blob を直す。flash 整合だけに頼らず blob 自体を closed にするので
  // 2 回目以降の reload でも復活しない。hub 到達不能は fail-open (flash 整合
  // + 1h 安全網が拾う)。webhook patch と二重に走っても Hub DO 直列化(#342) +
  // last-write-wins で冪等。
  if (hub && closed.length > 0) {
    const closedUrls = closed.map(
      (n) => `https://github.com/${owner}/${name}/issues/${n}`,
    );
    try {
      await hub.fetch(new Request("http://hub/releases-index-apply-close", {
        method: "POST",
        body: JSON.stringify({ repo: repoParam, urls: closedUrls }),
      }));
    } catch { /* fail-open: flash 整合 + 1h 安全網が拾う */ }
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
  if (failedReasons.length > 0) {
    // `failed_reasons=N:reason,N:reason` 形式で flash 経路に乗せる。reason 側に
    // `,` や `:` が出る可能性は低いが、URL safety のため reason は個別に
    // encodeURIComponent し、最外側は URLSearchParams が encode する。
    params.set(
      "failed_reasons",
      failedReasons.map((f) => `${f.n}:${encodeURIComponent(f.reason)}`).join(","),
    );
  }
  return redirect(`/releases?${params.toString()}`);
}

function redirect(location: string): Response {
  // 303 See Other so the browser swaps POST → GET on the redirect target.
  return new Response(null, {
    status: 303,
    headers: { Location: location },
  });
}
