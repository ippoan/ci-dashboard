/**
 * flip 前 preview E2E (経路 B) の安定 hostname router (Refs #472)。
 *
 * `preview-<app>.ippoan.org` への request を、その app の pending release
 * (no-traffic version) の workers.dev preview URL へ server-side proxy する。
 * 認証は CF Access (`release-wave-preview` app、`preview-*.ippoan.org`
 * wildcard、docs/release-wave.md「Cloudflare Access setup」節) が edge で
 * 開発者限定に gate する前提で、worker 側では検証しない
 * (auth-worker `/cf-flickr-cam-worker-proxy` と同じトラストモデル)。
 *
 * 安定 hostname を挟む理由 (docs/plan-pre-flip-preview-e2e.md):
 *  - auth-worker の origin allowlist (exact match) に静的登録 1 回で済む
 *  - `.ippoan.org` 配下なので `logi_auth_token` cookie (Domain=.ippoan.org)
 *    が届く (`*.workers.dev` は public suffix でセット不可)
 *
 * ガードレール:
 *  - 転送先は pending-release:: record の preview_url のみ (open proxy に
 *    しない)。https + `*.workers.dev` 以外は拒否。
 *  - pending 無し / preview_url 空 / 未知 app は 404 固定文言 (内部 URL /
 *    値を echo しない)。
 *  - backend override cookie の値は https + `*.run.app` のみ受理。
 */

import {
  getPendingRelease,
  type PendingReleaseRecord,
} from "./pending-release";

/** `alc_api_preview_base` cookie 名 (frontend 側 auth-client と共有する契約)。 */
export const PREVIEW_API_BASE_COOKIE = "alc_api_preview_base";

/** preview hostname の suffix。`preview-<app>.ippoan.org` のみ受理する。 */
const PREVIEW_HOST_RE = /^preview-([a-z0-9-]+)\.ippoan\.org$/;

/** PREVIEW_ROUTER_APPS var の 1 app 分の設定。 */
export interface PreviewAppConfig {
  /** frontend の "owner/name"。pending-release:: の lookup key。 */
  repo: string;
  /** monorepo unit worker 名 (単一 worker repo は省略)。Refs #427。 */
  worker?: string;
  /**
   * 組合せる backend の "owner/name" (省略可)。pending release があれば
   * その preview_url (Cloud Run tagged revision URL) を override cookie で
   * frontend に渡す (plan doc Phase 3)。
   */
  backend?: string;
}

/** router が使う Env の部分型 (index.ts の Env が満たす)。 */
export interface PreviewRouterEnv {
  COMPAT_KV: KVNamespace;
  /** JSON: `{"<app>": {"repo": "owner/name", "worker"?: "...", "backend"?: "owner/name"}}` */
  PREVIEW_ROUTER_APPS?: string;
}

/**
 * request が preview hostname 宛なら app 名を返す。それ以外 (ci-dashboard 本体
 * など) は null — 呼び出し側は通常の Hono routing に流す。
 */
export function matchPreviewHost(req: Request): string | null {
  let host: string;
  try {
    host = new URL(req.url).hostname;
  } catch {
    return null;
  }
  return PREVIEW_HOST_RE.exec(host)?.[1] ?? null;
}

function parseApps(raw: string | undefined): Record<string, PreviewAppConfig> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const out: Record<string, PreviewAppConfig> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null) continue;
      const repo = (v as { repo?: unknown }).repo;
      if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) continue;
      const worker = (v as { worker?: unknown }).worker;
      const backend = (v as { backend?: unknown }).backend;
      out[k] = {
        repo,
        ...(typeof worker === "string" && worker ? { worker } : {}),
        ...(typeof backend === "string" && /^[\w.-]+\/[\w.-]+$/.test(backend)
          ? { backend }
          : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 転送先として安全な workers.dev preview origin を返す (それ以外は null)。
 * pending-release webhook 由来の値は trust boundary 越えの input なので、
 * 保存時検証に依存せずここでも再検証する。
 */
export function safeWorkersDevOrigin(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return null;
    if (!parsed.hostname.endsWith(".workers.dev")) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** backend override として安全な Cloud Run URL (https + *.run.app) を返す。 */
export function safeRunAppBase(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return null;
    if (!parsed.hostname.endsWith(".run.app")) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** worker key → repo key の順で pending-release:: を引く。 */
async function lookupPending(
  kv: KVNamespace,
  repo: string,
  worker?: string,
): Promise<PendingReleaseRecord | null> {
  if (worker) {
    const perWorker = await getPendingRelease(kv, repo, worker);
    if (perWorker) return perWorker;
  }
  return getPendingRelease(kv, repo);
}

/** 404 固定文言。内部 URL / repo 名 / 値を echo しない (org 共通規範)。 */
function notFound(): Response {
  return new Response("no pending preview", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * preview hostname 宛 request の本体。app の pending preview へ proxy し、
 * backend pending があれば override cookie を注入する。
 *
 * `fetchImpl` はテスト注入点 (既定は global fetch)。
 */
export async function handlePreviewRouter(
  req: Request,
  env: PreviewRouterEnv,
  appName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const apps = parseApps(env.PREVIEW_ROUTER_APPS);
  const target = apps[appName];
  if (!target) return notFound();

  const rec = await lookupPending(env.COMPAT_KV, target.repo, target.worker);
  const origin = safeWorkersDevOrigin(rec?.preview_url);
  if (!origin) return notFound();

  const inUrl = new URL(req.url);
  const outUrl = new URL(origin);
  outUrl.pathname = inUrl.pathname;
  outUrl.search = inUrl.search;

  // method / headers / body を保ったまま転送先だけ差し替える。Host header は
  // fetch が転送先 URL から設定し直す。redirect は manual で素通し (preview 側
  // の 30x を router が follow すると相対 Location の origin が崩れるため)。
  const res = await fetchImpl(new Request(outUrl.toString(), req), {
    redirect: "manual",
  });

  // backend の pending preview (Cloud Run tagged revision URL) があれば
  // override cookie を注入。無ければ stale override が残らないよう削除する。
  // Domain 指定なし = この preview hostname 限定。frontend 側 (auth-client) は
  // `preview-*.ippoan.org` 上でのみこの cookie を読む契約 (plan doc Phase 3)。
  const headers = new Headers(res.headers);
  const backendBase = target.backend
    ? safeRunAppBase(
        (await lookupPending(env.COMPAT_KV, target.backend))?.preview_url,
      )
    : null;
  if (backendBase) {
    headers.append(
      "Set-Cookie",
      `${PREVIEW_API_BASE_COOKIE}=${encodeURIComponent(backendBase)}; Path=/; Secure; SameSite=Lax`,
    );
  } else {
    headers.append(
      "Set-Cookie",
      `${PREVIEW_API_BASE_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`,
    );
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
