import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  handleOAuthLogin,
  handleOAuthCallback,
  type AuthClientWorkerEnv,
} from "@ippoan/auth-client-worker";
import { AUTH_WORKER_ORIGIN } from "./github-api";
import { handleWebhook, consumeWebhookBatch, type QueueMessage } from "./webhook";
import { handleDashboard } from "./dashboard";
import { handleIssuesPage, handleIssuesDecorations } from "./issues-page";
import { handleProjectsPage } from "./projects-page";
import { handleReleasesPage } from "./releases-page";
import { handleReleaseClose } from "./release-close";
import { handleReleaseCloseBatch } from "./release-close-batch";
import { readReleasesIndexBlob } from "./releases-index-cache";
import { recomputeRepoView } from "./releases-page";
import { handleRecheck, recheckRun } from "./recheck";
import { handleSecretGenPage } from "./secret-gen-page";
import { handleCapCatalogPage } from "./cap-catalog-page";
import { handleFavoritesGet, handleFavoritesPut } from "./cap-catalog-favorites";
import { handleCiMatrixPage, handleCiMatrixDeviationsJson } from "./ci-matrix-page";
import { handleCiShapeWebhook } from "./ci-shape-webhook";
import { handleDepGraphFile } from "./dep-graph-page";
import { handleDepGraphPage } from "./dep-graph-page-view";
import { handleLaunch } from "./launch";
import { handleTagRelease } from "./tag-release";
import { handleAutoTagPage, handleAutoTagPagePost } from "./auto-tag-page";
import {
  handleReleaseWaveTagRelease,
  handleReleaseWaveTagReleaseAll,
} from "./release-wave/tag-release-action";
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
import { handleReleaseWaveLiveJs } from "./release-wave/live";
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
  /**
   * GitHub webhook の ingest queue (Refs #318)。受信 handler は enqueue + 即
   * 200 のみ行い、処理は本 worker の queue consumer が担う。binding 未設定の
   * 環境 (wrangler dev / test) は waitUntil fallback で inline 処理される。
   */
  WEBHOOK_QUEUE?: Queue<QueueMessage>;
  /**
   * cap-catalog の R2 bucket (`cap-catalog`)。`catalog-build-upload.yml` が
   * 定期 push する `v1/latest.sqlite` + `v1/latest.jsonl` を /cap-catalog
   * page が read-only fetch する。binding 未設定 (= ローカル dev / test) の
   * 場合は inline sample fallback で動く。Refs ippoan/cap-catalog#1 #10。
   */
  CAP_CATALOG_R2?: R2Bucket;
  /**
   * Discord PR close 通知の self-heal 用 Bot token (Refs #441 PR3)。
   * scope: Manage Channels + Manage Webhooks。404 Unknown Webhook を検知
   * したときに `healChannel()` が新しい channel + webhook を再発行する。
   * 未設定なら heal 不能 (= 通知は黙って disabled になる) なので **optional**。
   * 本格運用時は `wrangler.jsonc` の `secrets_store_secrets` に
   * `binding: "DISCORD_BOT_TOKEN"` を declare し、CF Secrets Store と GCP
   * Secret Manager の両方に同名 entry を投入する (PR4 で結線予定)。
   */
  DISCORD_BOT_TOKEN?: SecretsStoreSecret;
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

// Release Wave は単一 singleton DO に全 wave を集約している (src/release-wave/do.ts)。
// live 更新の WebSocket もこの singleton に張る (Refs #275)。
function getReleaseWaveHub(env: Env): DurableObjectStub {
  const id = env.RELEASE_WAVE_HUB.idFromName("singleton");
  return env.RELEASE_WAVE_HUB.get(id);
}

// `workflow_run.completed` webhook を取りこぼした run が in-memory hub cache に
// in_progress のまま残るのを救う。/snapshot 取得の度に背景で発火し、status が
// completed でなく updated_at が 1h 以上前の run を GitHub API から取り直す
// (recheck と等価)。GitHub API 連打防止のため per-run 10 分 cooldown を持つ。
// dedupe は isolate-local なので跨ぐと重複が起き得るが、recheck は idempotent
// なので許容する。Refs ippoan/ci-dashboard#366
export const STALE_IN_PROGRESS_MS = 60 * 60 * 1000;
export const RECHECK_COOLDOWN_MS = 10 * 60 * 1000;
const lastAutoRecheck = new Map<number, number>();

/** test 用: isolate-local cooldown Map を初期化する。 */
export function _resetAutoRecheckState(): void {
  lastAutoRecheck.clear();
}

export async function autoRecheckStale(
  env: Env,
  hub: DurableObjectStub,
  snapshotBody: string,
  now: number = Date.now(),
): Promise<void> {
  let parsed: {
    statuses?: Array<{
      run_id: number;
      repo: string;
      status: string;
      updated_at: string;
    }>;
  };
  try {
    parsed = JSON.parse(snapshotBody);
  } catch {
    return;
  }
  const statuses = parsed.statuses ?? [];
  for (const s of statuses) {
    if (s.status === "completed") continue;
    const updatedMs = new Date(s.updated_at).getTime();
    if (!Number.isFinite(updatedMs)) continue;
    if (now - updatedMs < STALE_IN_PROGRESS_MS) continue;
    const last = lastAutoRecheck.get(s.run_id) ?? 0;
    if (now - last < RECHECK_COOLDOWN_MS) continue;
    lastAutoRecheck.set(s.run_id, now);
    try {
      await recheckRun(env, hub, s.run_id, s.repo);
    } catch {
      // best-effort: cooldown gates the next retry
    }
  }
}

// Dashboard
app.get("/", () => handleDashboard());

// Open issues (SSR, cross-org)。executionCtx は SWR の background
// reconcile / PR map refresh 用 (Refs #304)。
app.get("/issues", (c) => handleIssuesPage(c.env, c.executionCtx));

// decorations (Project/PR チップ) の部分更新用 JSON (Refs #323)。KV read のみ。
app.get("/issues/decorations", (c) => handleIssuesDecorations(c.env));

// Projects v2 read-only listing (SSR, cross-org). Refs #72.
app.get("/projects", (c) => handleProjectsPage(c.env));

// Cryptographically-strong random value generator (client-side, no server-side
// state). Operators paste the output into Cloudflare Secrets Store / wrangler
// secret put / GitHub Actions secrets.
app.get("/secret-gen", () => handleSecretGenPage());
app.get("/cap-catalog", (c) => handleCapCatalogPage(c.env, c.executionCtx));
// お気に入り server-side 永続 (CF Access email で per-user)。未認証は 401 で
// client は localStorage fallback。Refs ippoan/cap-catalog#1。
app.get("/api/cap-catalog/favorites", (c) => handleFavoritesGet(c.req.raw, c.env));
app.put("/api/cap-catalog/favorites", (c) => handleFavoritesPut(c.req.raw, c.env));
// Reusable workflow 採用状況の 1 ページマトリクス。Refs #377 #378。
app.get("/ci-matrix", (c) => handleCiMatrixPage(c.req.raw, c.env));
// 逸脱一覧 JSON ダウンロード。Refs #395。
app.get("/ci-matrix/deviations.json", (c) => handleCiMatrixDeviationsJson(c.req.raw, c.env));
// 各 repo の CI から ci-shape-report.yml reusable 経由で薄められた shape JSON
// を受ける。X-CI-Shape-Secret = RELEASE_WAVE_WEBHOOK_SECRET。Refs #378。
app.post("/webhooks/ci-shape", (c) => handleCiShapeWebhook(c.req.raw, c.env));

// crate 依存グラフ artifact (dep-graph: deps.svg / deps.dot / meta.json) の
// 個別 file passthrough。生成側は各 repo の `.github/workflows/dep-graph.yml`
// (Refs #443)。view 用 page は `/dep-graph/:owner/:repo` (handleDepGraphPage)。
app.get("/api/dep-graph/:owner/:repo/:file", (c) =>
  handleDepGraphFile(c.env, c.req.param("owner"), c.req.param("repo"), c.req.param("file")),
);
app.get("/dep-graph/:owner/:repo", (c) =>
  handleDepGraphPage(c.env, c.req.param("owner"), c.req.param("repo")),
);

// Launch redirect for the open-multirepo skill. Stateless: reconstructs the
// long claude.ai/code URL from a compact `?i=<issue>` query and 302s to it, so
// the skill can emit a short (render-safe) link without a third-party shortener
// or KV. See src/launch.ts.
app.get("/cc", (c) => handleLaunch(c.req.raw));

// Release confirmation view (SSR + POST close action)
// See issue #35 + CLAUDE.md `release / close フロー`.
app.get("/releases", (c) => handleReleasesPage(c.req.raw, c.env, c.executionCtx));
// Pass hub + executionCtx so the close handlers can fire-and-forget a
// `/release-alert-recompute` to refresh the dashboard banner.
app.post("/api/release-close",
  (c) => handleReleaseClose(c.req.raw, c.env, getHub(c.env), c.executionCtx));
app.post("/api/release-close-batch",
  (c) => handleReleaseCloseBatch(c.req.raw, c.env, getHub(c.env), c.executionCtx));

// Auto-tag on PR merge 設定画面 (Refs #460)。Cloudflare Access (zone-level)
// で gate されている前提なので worker 側で追加の認証は行わない。
app.get("/auto-tag", (c) => handleAutoTagPage(getHub(c.env)));
app.post("/auto-tag", (c) => handleAutoTagPagePost(c.req.raw, getHub(c.env)));

// /releases blob ダンプ (Refs #407 / #409, bug 1 診断用)。CF Access (zone-level)
// で gate。Hub DO (`this.ctx.storage`) を直叩きするため strongly consistent。
// KV backup (v4) ではなく SoT を返す。
app.get("/admin/dump-releases-blob", async (c) => {
  const blob = await readReleasesIndexBlob(c.env);
  return Response.json(blob ?? null, {
    headers: { "cache-control": "no-store" },
  });
});

// /releases blob の強制 refresh (Refs #421)。FRESH window 1h を待たずに即時
// 更新したい時の救済経路。CF Access (zone-level) で gate。
//
//   - `?repo=owner/name`: 単一 repo の view だけを recomputeRepoView で
//     同期再計算して blob に patch (= ~3-15s で完結)。`/issues KV` cache が
//     stale な repo を pinpoint で直したい時に使う。**`storedAt` を触らないので
//     fresh-window を貫通する** → `TAGLESS_REPOS` に新 repo を追加直後など、
//     full refresh が fresh で bail する状況で新 repo を即座に index へ入れる
//     正規ルートはこちら (blob に無ければ末尾 append)。詳細は ci-dashboard-map
//     skill「TAGLESS_REPOS に追加したのに card が出ない」Q&A (#438/#439)。
//   - parameter 無し: WEBHOOK_QUEUE に releases-index-refresh を 1 件 enqueue
//     し全 repo の full refresh を queue consumer 経由で走らせる。重複 enqueue
//     は refresh 側の lock + fresh recheck で無駄撃ち (Refs #337)。**注意: full
//     refresh は 1h fresh-window 内だと no-op** (refreshReleasesIndexInner が
//     "fresh" で bail)。即時反映が要る時は上の `?repo=` を使う。
//
// GET でも accept する (operator が footer link クリックで kick できる UX)。
app.all("/admin/force-refresh-releases", async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const repoParam = new URL(c.req.raw.url).searchParams.get("repo");
  if (repoParam) {
    // `owner/name` 形式の最小 validation。
    if (!/^[\w.-]+\/[\w.-]+$/.test(repoParam)) {
      return Response.json({ ok: false, reason: "invalid repo param" }, { status: 400 });
    }
    const outcome = await recomputeRepoView(c.env, repoParam);
    return Response.json({ ok: outcome === "patched", repo: repoParam, outcome });
  }
  if (!c.env.WEBHOOK_QUEUE) {
    return Response.json({ ok: false, reason: "queue binding unavailable" }, { status: 503 });
  }
  await c.env.WEBHOOK_QUEUE.send({ kind: "releases-index-refresh" });
  return Response.json({ ok: true, enqueued: "releases-index-refresh" });
});

// WebSocket
app.get("/ws", (c) => getHub(c.env).fetch(c.req.raw));

// Webhook
// `/webhooks` (複数) は CF Access の bypass 対象 prefix (Access app は
// `/webhooks` で始まるパスを edge auth から除外) に合わせたエイリアス。
// 単数 `/webhook` は CF Access 配下のため GitHub 配信が 302 で到達できない。
// handleWebhook は X-Hub-Signature-256 を自前検証するので edge auth 不要。
app.post("/webhook", (c) => handleWebhook(c.req.raw, c.env, getHub(c.env), c.executionCtx));
app.post("/webhooks", (c) => handleWebhook(c.req.raw, c.env, getHub(c.env), c.executionCtx));

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
//
// Background: webhook lost で in_progress に居座った run を 1h 超で自動
// recheck する (Refs #366)。レスポンス自体はその場で返し、recheck は
// waitUntil で発火するので latency に乗らない。
app.get("/snapshot", async (c) => {
  const res = await getHub(c.env).fetch(new Request("http://hub/snapshot"));
  const body = await res.text();
  c.executionCtx.waitUntil(
    autoRecheckStale(c.env, getHub(c.env), body),
  );
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Discord self-heal の履歴 (Refs #441 PR5)。dashboard UI が page load の
// bootstrap で叩く。WS で受ける `{type: "discord-heal"}` の live update とは
// 別経路 (cold start で過去履歴を出すため)。Hub `GET /discord-heal-records`
// をそのまま転送する thin proxy。
app.get("/api/discord-heals", async (c) => {
  const res = await getHub(c.env).fetch(
    new Request("http://hub/discord-heal-records"),
  );
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});

// Tag release
app.post("/api/tag-release", (c) => handleTagRelease(c.req.raw, c.env));
// Release Wave ページ (strict CSP / JS 無効) からの form-POST 用。dispatch 後
// 303 で /release-wave へ戻す。
app.post("/api/release-wave/tag-release", (c) =>
  handleReleaseWaveTagRelease(c.req.raw, c.env),
);
// Compatibility グラフの「⚡ Tag Release all」: form field `repos` (カンマ区切り)
// の tag-release.yml をまとめて dispatch する。
app.post("/api/release-wave/tag-release-all", (c) =>
  handleReleaseWaveTagReleaseAll(c.req.raw, c.env),
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
// live 更新 (Refs #275)。下の `:wave_id` 動的 route より **前** に登録して
// "ws" / "live.js" が wave_id として捕捉されるのを防ぐ (Hono は登録順マッチ)。
// WebSocket は RELEASE_WAVE_HUB singleton に proxy。state 変化時に DO 側
// `saveWave` → `broadcast` がシグナルを送り、live.js が location.reload() する。
app.get("/release-wave/ws", (c) => {
  // DO 側 fetch は pathname === "/ws" で受理するので、Upgrade header 等を保った
  // まま URL だけ /ws に書き換えて proxy する。
  const wsUrl = new URL(c.req.url);
  wsUrl.pathname = "/ws";
  return getReleaseWaveHub(c.env).fetch(new Request(wsUrl, c.req.raw));
});
app.get("/release-wave/live.js", () => handleReleaseWaveLiveJs());
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

// Queues consumer を載せるため Hono app を module worker 形に包む。
// `fetch` は従来どおり app に委譲 (tests の worker.fetch も互換)。
export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<QueueMessage>, env: Env) =>
    consumeWebhookBatch(batch, env),
};
