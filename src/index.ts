import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  handleOAuthLogin,
  handleOAuthCallback,
  type AuthClientWorkerEnv,
} from "@ippoan/auth-client-worker";
import { AUTH_WORKER_ORIGIN } from "./github-api";
import { handleWebhook } from "./webhook";
import { handleDashboard } from "./dashboard";
import { handleIssuesPage } from "./issues-page";
import { handleProjectsPage } from "./projects-page";
import { handleReleasesPage } from "./releases-page";
import { handleReleaseClose } from "./release-close";
import { handleReleaseCloseBatch } from "./release-close-batch";
import { handleRecheck } from "./recheck";
import { handleSecretGenPage } from "./secret-gen-page";
import { handleLaunch } from "./launch";
import { handleTagRelease } from "./tag-release";
import { handleReleaseWaveTagRelease } from "./release-wave/tag-release-action";
import { handleReleaseWaveListPageWithRepoStatus } from "./release-wave/repo-status-section";
import { handleMcpRequest } from "./mcp/server";
import {
  handleContractAppliedWebhook,
  handleFlipReportWebhook,
  handleFrontendTestReportWebhook,
  handleBackendDeployReportWebhook,
  handleBackendCurrentImageWebhook,
  handlePendingReleaseWebhook,
  handleTrafficReportWebhook,
  handleBackendTrafficReportWebhook,
} from "./release-wave/webhook";
import {
  handleCompatibility,
  handleBackendCurrentImage,
} from "./release-wave/compat-api";
import {
  handleReleaseWaveDetailPage,
} from "./release-wave/page";
import {
  handleReleaseWaveApprove,
  handleReleaseWaveRollback,
  handleReleaseWaveAbort,
  handleReleaseWaveForceFail,
  handleReleaseWaveRetest,
  handleReleaseWaveRetestConsumer,
  handleReleaseWavePendingReleaseFlip,
  handleReleaseWavePendingReleaseFlipAll,
  handleReleaseWaveFlipGroupRollback,
  handleReleaseWaveTrafficRollback,
  handleReleaseWaveBackendRollback,
} from "./release-wave/api";
import {
  handlePwaManifest,
  handlePwaServiceWorker,
  handlePwaIcon,
} from "./pwa";

export { CIDashboardHub } from "./hub";
export { ReleaseWaveHub } from "./release-wave/do";

// auth-worker MCP OAuth Provider delegation via `@ippoan/auth-client-worker`.
// `INTERNAL_SHARED_SECRET` (Secrets Store) is shared with auth-worker for
// `/mcp/introspect`. Long-lived JWT + refresh_token are stored in KV
// (`auth-client-worker:oauth-tokens`) by the SDK after `/oauth/login`
// browser flow — there is no operator-facing secret to rotate. Refs #118.
export interface Env extends AuthClientWorkerEnv {
  WEBHOOK_SECRET: SecretsStoreSecret;
  CI_HUB: DurableObjectNamespace;
  /** Release Wave 機構の hub DO。Refs #137。 */
  RELEASE_WAVE_HUB: DurableObjectNamespace;
  /**
   * GitHub Actions step が `/webhooks/release-wave/contract-applied` を叩く
   * 際の shared secret (Secrets Store)。Refs #137 Phase 3d。
   */
  RELEASE_WAVE_WEBHOOK_SECRET: SecretsStoreSecret;
  // Comma-separated `owner/name` list of repos that don't cut tags. PR merges
  // into the default branch are treated as releases for these. See
  // wrangler.jsonc and src/tagless-repos.ts.
  TAGLESS_REPOS?: string;
  /**
   * Release Wave compatibility 突合用 KV (`frontend::*` / `backend::*` records)。
   * 既存 CI_STATUS namespace を別 binding で流用する (key prefix で衝突回避)。
   * Refs #157 / #158、shape は docs/release-wave-compatibility-kv.md。
   */
  COMPAT_KV: KVNamespace;
}

// OAuth flow config — shared between /oauth/login, /oauth/callback, and the
// runtime `tokenForOrg()` -> `getGitHubToken()` calls. `AUTH_WORKER_ORIGIN`
// lives in github-api.ts to avoid a circular import.
const OAUTH_OPTS = {
  authWorkerOrigin: AUTH_WORKER_ORIGIN,
  redirectUri: "https://ci-dashboard.ippoan.org/oauth/callback",
  scope: "mcp.write mcp.workflow mcp.project",
  clientName: "ci-dashboard",
};

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

function getHub(env: Env): DurableObjectStub {
  const id = env.CI_HUB.idFromName("singleton");
  return env.CI_HUB.get(id);
}

// Dashboard
app.get("/", () => handleDashboard());

// Open issues (SSR, cross-org)
app.get("/issues", (c) => handleIssuesPage(c.env));

// Projects v2 read-only listing (SSR, cross-org). Refs #72.
app.get("/projects", (c) => handleProjectsPage(c.env));

// Cryptographically-strong random value generator (client-side, no server-side
// state). Operators paste the output into Cloudflare Secrets Store / wrangler
// secret put / GitHub Actions secrets.
app.get("/secret-gen", () => handleSecretGenPage());

// Launch redirect for the open-multirepo skill. Stateless: reconstructs the
// long claude.ai/code URL from a compact `?i=<issue>` query and 302s to it, so
// the skill can emit a short (render-safe) link without a third-party shortener
// or KV. See src/launch.ts.
app.get("/cc", (c) => handleLaunch(c.req.raw));

// Release confirmation view (SSR + POST close action)
// See issue #35 + CLAUDE.md `release / close フロー`.
app.get("/releases", (c) => handleReleasesPage(c.req.raw, c.env));
// Pass hub + executionCtx so the close handlers can fire-and-forget a
// `/release-alert-recompute` to refresh the dashboard banner.
app.post("/api/release-close",
  (c) => handleReleaseClose(c.req.raw, c.env, getHub(c.env), c.executionCtx));
app.post("/api/release-close-batch",
  (c) => handleReleaseCloseBatch(c.req.raw, c.env, getHub(c.env), c.executionCtx));

// WebSocket
app.get("/ws", (c) => getHub(c.env).fetch(c.req.raw));

// Webhook
// `/webhooks` (複数) は CF Access の bypass 対象 prefix (Access app は
// `/webhooks` で始まるパスを edge auth から除外) に合わせたエイリアス。
// 単数 `/webhook` は CF Access 配下のため GitHub 配信が 302 で到達できない。
// handleWebhook は X-Hub-Signature-256 を自前検証するので edge auth 不要。
app.post("/webhook", (c) => handleWebhook(c.req.raw, c.env, getHub(c.env)));
app.post("/webhooks", (c) => handleWebhook(c.req.raw, c.env, getHub(c.env)));

// Status
app.get("/status", async (c) => {
  const res = await getHub(c.env).fetch(new Request("http://hub/statuses"));
  const body = await res.text();
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Release banner alerts (consumed by dashboard JS for the post-tag-release
// banner). Same proxy pattern as /status — Hub holds the in-memory cache.
app.get("/release-alerts", async (c) => {
  const res = await getHub(c.env).fetch(new Request("http://hub/release-alerts"));
  const body = await res.text();
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Unified snapshot: { statuses, alerts } in a single Worker request.
// Dashboard UI fetches this on WS connect / reconnect (1 Worker request
// per page load + reconnect), eliminating the previous 30s polling of
// /status + /release-alerts (2 req/30s × visible tab). Refs #64.
app.get("/snapshot", async (c) => {
  const res = await getHub(c.env).fetch(new Request("http://hub/snapshot"));
  const body = await res.text();
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Tag release
app.post("/api/tag-release", (c) => handleTagRelease(c.req.raw, c.env));
// Release Wave ページ (strict CSP / JS 無効) からの form-POST 用。dispatch 後
// 303 で /release-wave へ戻す。
app.post("/api/release-wave/tag-release", (c) =>
  handleReleaseWaveTagRelease(c.req.raw, c.env),
);

// Recheck
app.post("/api/recheck", (c) => handleRecheck(c.req.raw, c.env, getHub(c.env)));

// Dismiss run
app.post("/api/dismiss", async (c) => {
  const { run_id } = await c.req.json<{ run_id: number }>();
  await getHub(c.env).fetch(
    new Request("http://hub/delete-run", {
      method: "POST",
      body: JSON.stringify({ run_id }),
    }),
  );
  return c.json({ ok: true });
});

// PWA assets — manifest, service worker, icons. Served from the same origin
// so the SW can claim scope "/".
app.get("/manifest.webmanifest", () => handlePwaManifest());
app.get("/sw.js", () => handlePwaServiceWorker());
app.get("/icons/:file", (c) => handlePwaIcon("/icons/" + c.req.param("file")));

// OAuth — auth-worker MCP OAuth Provider delegation (Refs #118).
// `/oauth/login` triggers Auth Code + PKCE redirect to auth.ippoan.org/mcp/authorize.
// `/oauth/callback` exchanges the auth code for tokens and stores them in
// CI_STATUS KV. After first run, `getGitHubToken(env)` resolves automatically;
// re-auth is needed only when the refresh_token (30 d TTL) expires.
app.get("/oauth/login", (c) => handleOAuthLogin(c.req.raw, c.env, OAUTH_OPTS));
app.get("/oauth/callback", (c) => handleOAuthCallback(c.req.raw, c.env, OAUTH_OPTS));

// MCP endpoint (Streamable HTTP)
app.all("/mcp", (c) => handleMcpRequest(c.req.raw, c.env));

// Release Wave: GitHub Actions step が叩く HTTP webhook 3 本 (Refs #137
// Phase 3d + Phase 4)。MCP 経路と機能等価だが OAuth 不要の shared secret
// (`RELEASE_WAVE_WEBHOOK_SECRET`) で済むため、release-wave-handler reusable
// から curl 1 行で呼べる。
app.post("/webhooks/release-wave/contract-applied", (c) =>
  handleContractAppliedWebhook(c.req.raw, c.env),
);
app.post("/webhooks/release-wave/flip-report", (c) =>
  handleFlipReportWebhook(c.req.raw, c.env),
);
// Compatibility 突合 (frontend ↔ backend image)。frontend CI / backend deploy が
// shared secret 付きで write する 2 endpoint。Refs #157 (Phase A) / #158。
app.post("/webhooks/release-wave/frontend-test-report", (c) =>
  handleFrontendTestReportWebhook(c.req.raw, c.env),
);
app.post("/webhooks/release-wave/backend-deploy-report", (c) =>
  handleBackendDeployReportWebhook(c.req.raw, c.env),
);
// frontend-ci の release deploy が `wrangler versions upload` (no-traffic) 後に
// version_id / tag / preview_url を報告する (Refs #181 / #174)。
app.post("/webhooks/release-wave/pending-release", (c) =>
  handlePendingReleaseWebhook(c.req.raw, c.env),
);
// frontend CI が deploy 時に worker の version traffic split (version_id →
// percentage) を報告する。Compatibility グラフ下に 100%/0% version を出す用。
app.post("/webhooks/release-wave/traffic-report", (c) =>
  handleTrafficReportWebhook(c.req.raw, c.env),
);
// release-wave-handler の cloudrun flip/rollback 後に Cloud Run の実 traffic
// split (status.traffic[]) を service 単位で報告する。backend 表示を GCP の
// 実態 (Flip 前の 旧100%+新pending0% 含む) に追従させる。Refs #256。
app.post("/webhooks/release-wave/backend-traffic-report", (c) =>
  handleBackendTrafficReportWebhook(c.req.raw, c.env),
);
// 認証付き read (CF Access が bypass する /webhooks/* 配下)。frontend CI が
// 現 prod backend image を解決する用 — CF Access 下の /backend-current-image は
// GitHub Actions runner から 302 で到達不能なため。Refs #157。
app.get("/webhooks/release-wave/backend-current-image", (c) =>
  handleBackendCurrentImageWebhook(c.req.raw, c.env),
);

// Compatibility read endpoints (CF Access edge gate に認証を委譲、read-only)。
app.get("/compatibility", (c) => handleCompatibility(c.req.raw, c.env));
app.get("/backend-current-image", (c) =>
  handleBackendCurrentImage(c.req.raw, c.env),
);

// Release Wave admin UI (Refs #137 Phase 3e)。
// Auth は ci-dashboard 全体に被さる Cloudflare Access (Google OAuth + email
// allowlist) edge gate に委譲。/releases ページと同じトラストモデル。
app.get("/release-wave", (c) => handleReleaseWaveListPageWithRepoStatus(c.env));
app.get("/release-wave/:wave_id", (c) =>
  handleReleaseWaveDetailPage(c.env, c.req.param("wave_id")),
);
// Action buttons (state 遷移を起こす side-effectful POST)。完了後は
// 303 で詳細ページに redirect する。
app.post("/api/release-wave/:wave_id/approve", (c) =>
  handleReleaseWaveApprove(c.req.raw, c.env, c.req.param("wave_id")),
);
app.post("/api/release-wave/:wave_id/rollback", (c) =>
  handleReleaseWaveRollback(c.req.raw, c.env, c.req.param("wave_id")),
);
app.post("/api/release-wave/:wave_id/abort", (c) =>
  handleReleaseWaveAbort(c.req.raw, c.env, c.req.param("wave_id")),
);
// stuck wave (flipping のまま hang 等) を terminal failed に落とす force-clear。
app.post("/api/release-wave/:wave_id/fail", (c) =>
  handleReleaseWaveForceFail(c.req.raw, c.env, c.req.param("wave_id")),
);
// compatibility matrix の赤 frontend に release-wave-retest を fan-out
// (Refs #157 Phase B)。form field `frontend` で 1 件指定可、無ければ全 red。
app.post("/api/release-wave/:wave_id/retest", (c) =>
  handleReleaseWaveRetest(c.req.raw, c.env, c.req.param("wave_id")),
);
// wave 非依存の単発 retest (Refs #157 / #137)。global Compatibility グラフの
// 「no wave」backend consumer から retest できるよう、wave_id を取らず
// form field `backend_repo` + `frontend` (+ 任意 `backend_image`) で
// release-wave-retest を 1 件 dispatch する。
// 静的セグメント `retest-consumer` は上の `:wave_id/retest` (2 セグメント) と
// セグメント数が違うため衝突しない。
app.post("/api/release-wave/retest-consumer", (c) =>
  handleReleaseWaveRetestConsumer(c.req.raw, c.env),
);
// 単独 v* リリースの no-traffic version を 100% へ flip (Refs #181 / #174)。
// wave を起こさず form field `repo` の pending-release record を promote する。
// `:wave_id` を取る上の route とは action segment (`flip` vs approve/.../retest)
// で区別されるため衝突しない。
app.post("/api/release-wave/pending-release/flip", (c) =>
  handleReleaseWavePendingReleaseFlip(c.req.raw, c.env),
);
// wave = 複数 repo の pending release を一括 flip (Refs #237)。flip 直前の
// active version を flip-group に控え、下の flip-group-rollback で一括復旧可能。
app.post("/api/release-wave/pending-release/flip-all", (c) =>
  handleReleaseWavePendingReleaseFlipAll(c.req.raw, c.env),
);
// 直近の一括 flip (flip-group) を一括 rollback (Refs #237)。各 repo を flip
// 直前の active version へ release-wave-traffic-rollback で戻す。
app.post("/api/release-wave/pending-release/flip-group-rollback", (c) =>
  handleReleaseWaveFlipGroupRollback(c.req.raw, c.env),
);
// frontend worker の traffic を任意の過去 version に即 100% で戻す (Refs #196)。
// form field `repo` + `version_id`。release-wave-traffic-rollback を dispatch。
app.post("/api/release-wave/traffic-rollback", (c) =>
  handleReleaseWaveTrafficRollback(c.req.raw, c.env),
);
// backend (Cloud Run) の traffic を任意の過去 revision に即 100% で戻す (Refs #197)。
// form field `repo` + `image`。release-wave-backend-rollback を dispatch。
app.post("/api/release-wave/backend-rollback", (c) =>
  handleReleaseWaveBackendRollback(c.req.raw, c.env),
);

export default app;
