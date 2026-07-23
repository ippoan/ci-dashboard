// `Authorization: Bearer <binding_jwt>` を auth-worker (`AUTH_WORKER_ORIGIN`) の
// `POST /mcp/introspect` (Mode 1 — Bearer JWT 自己 introspect) に forward して
// 検証する。検証ロジック本体は `@ippoan/mcp-cf-workers` の `./auth` export
// (secrets-inventory#43 で確立、#46 で lib 昇格) をそのまま consume する —
// lib-first 規範 (Refs ippoan/claude-md#76): 独自実装しない。
//
// binding_jwt は auth-worker が `/mcp/pair/grant-via-oat` 等で mint する HS256
// 署名の短命 (24h) JWT。利点: MCP 標準 OAuth 2.1 (WWW-Authenticate での
// auto-discovery) / per-client revoke / worker 側 provisioning ゼロ。
//
// Refs ippoan/ci-dashboard#498: 導入前は `/mcp` が完全匿名で 48 tool 実行可能
// だった。secrets-inventory / gmail-mcp と同じ RFC 9728 パターンで保護する。
import type { MiddlewareHandler } from "hono";
import {
  introspectBindingJwt,
  BindingJwtError,
  DEFAULT_AUTH_WORKER_ORIGIN,
  wwwAuthenticate as libWwwAuthenticate,
  type BindingJwtClaims,
  type IntrospectBindingJwtOptions,
} from "@ippoan/mcp-cf-workers/auth";
import { bindingJwtMiddleware as libBindingJwtMiddleware } from "@ippoan/mcp-cf-workers/auth/binding-jwt-hono";
import type { Env } from "../index";

// auth-worker `/.well-known/oauth-protected-resource/<slug>` の slug は
// allowlist 内 URL (`MCP_RESOURCE_ORIGINS_ALLOWLIST`) の hostname 先頭 label と
// 一致させる規約 (Refs ippoan/auth-worker#195)。`https://ci-dashboard.ippoan.org`
// を追加した上でこの slug を使う (ippoan/auth-worker#498 対応 PR)。
const RESOURCE_METADATA_SLUG = "ci-dashboard";

export { introspectBindingJwt, BindingJwtError, DEFAULT_AUTH_WORKER_ORIGIN };
export type { BindingJwtClaims };
export type BindingJwtMiddlewareOptions = IntrospectBindingJwtOptions;

/** 本 worker の slug を pre-bind した WWW-Authenticate 文字列 (RFC 6750 + 9728)。 */
export function wwwAuthenticate(authOrigin: string, error?: string): string {
  return libWwwAuthenticate(authOrigin, RESOURCE_METADATA_SLUG, error);
}

/**
 * binding_jwt (auth-worker mint) を `/mcp/introspect` 経由で検証する Hono
 * middleware。lib の hono adapter に slug を pre-bind しただけ。
 * 成功時は `c.set("bindingJwt", { sub, github_login, scope, exp })`。
 */
export function bindingJwtMiddleware(
  options: BindingJwtMiddlewareOptions = {},
): MiddlewareHandler<{
  Bindings: Env;
  Variables: { bindingJwt: BindingJwtClaims };
}> {
  return libBindingJwtMiddleware<Env>({
    resourceMetadataSlug: RESOURCE_METADATA_SLUG,
    ...options,
  });
}
