// cap-catalog 「お気に入り」 server-side 永続化 (Refs ippoan/cap-catalog#1)。
//
// localStorage 版 (PR #380) を **CI_STATUS KV** に backing する。CF Access
// (Google OAuth + email allowlist) で edge gate 済みなので、worker は header
// `Cf-Access-Authenticated-User-Email` を信頼して user identity に使う。
//
// KV layout (CI_STATUS namespace 流用、COMPAT_KV と同じ pattern):
//   key:   `cap-catalog:favorites:<email>`
//   value: { keys: string[], favOnly: boolean }
//     - keys: 順序付き array、各 entry は `repo|language|fq_path`
//     - favOnly: ★ つきだけ表示モードの永続 state
//
// 認証されていない (= local dev、API 直叩き) リクエストは 401。client 側は
// 401 を観測したら localStorage fallback に閉じる (= 機能は壊さない)。

import type { Env } from "./index";

const KV_KEY_PREFIX = "cap-catalog:favorites:";

// 同一 user の保存される最大件数。client UI は数件 〜 数十件想定。100 は
// 「想定よりはるかに多い」線で、暴走 PUT (= XSS / bot) から KV を守る上限。
const MAX_KEYS = 100;
// 1 key の長さ上限。`repo|language|fq_path` 形式で repo + crate path 込みでも
// 200 は実用上余裕。
const MAX_KEY_LEN = 200;

interface FavoritesPayload {
  keys: string[];
  favOnly: boolean;
}

function emptyPayload(): FavoritesPayload {
  return { keys: [], favOnly: false };
}

function userEmail(req: Request): string | null {
  const email = req.headers.get("Cf-Access-Authenticated-User-Email");
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  // 軽い sanity check: KV key に使うので CR/LF が混じったら拒否。CF Access が
  // 正規化済みのはずだが defense in depth。
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(trimmed)) return null;
  return trimmed;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function sanitize(payload: unknown): FavoritesPayload {
  if (!payload || typeof payload !== "object") return emptyPayload();
  const obj = payload as Record<string, unknown>;
  const keysRaw = Array.isArray(obj.keys) ? obj.keys : [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const v of keysRaw) {
    if (typeof v !== "string") continue;
    if (v.length === 0 || v.length > MAX_KEY_LEN) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    keys.push(v);
    if (keys.length >= MAX_KEYS) break;
  }
  const favOnly = obj.favOnly === true;
  return { keys, favOnly };
}

export async function handleFavoritesGet(req: Request, env: Env): Promise<Response> {
  const email = userEmail(req);
  if (!email) return jsonResponse(401, { error: "unauthenticated" });
  const raw = await env.CI_STATUS.get(KV_KEY_PREFIX + email);
  if (raw == null) return jsonResponse(200, emptyPayload());
  try {
    const parsed = JSON.parse(raw);
    return jsonResponse(200, sanitize(parsed));
  } catch {
    // 壊れた entry は empty で返す (= client が次の PUT で上書きする)。
    return jsonResponse(200, emptyPayload());
  }
}

export async function handleFavoritesPut(req: Request, env: Env): Promise<Response> {
  const email = userEmail(req);
  if (!email) return jsonResponse(401, { error: "unauthenticated" });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid json" });
  }
  const clean = sanitize(body);
  await env.CI_STATUS.put(KV_KEY_PREFIX + email, JSON.stringify(clean));
  return jsonResponse(200, clean);
}
