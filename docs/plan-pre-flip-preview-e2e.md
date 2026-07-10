# plan: flip 前 preview E2E (経路 B) の確立

Refs #472 / Part of #137 / Related to #260

tag release 済み・flip 前の **frontend worker version (0%)** をブラウザで開き、
**flip 前の backend Cloud Run revision (prod service の 0% revision)** と組合せて
開発者だけが E2E できる状態を作る。`docs/release-wave.md` の
「経路 B: ブラウザで preview フロントから入る (= 準備が要る)」を実装する計画。

## 決定事項 (2026-07-10、issue #472)

| # | 論点 | 決定 |
|---|---|---|
| 1 | auth-worker は staging か prod か | **prod**。flip 前 GCP は prod service の 0% revision (prod DB / prod `JWT_SECRET`) であり、そこに通る JWT を発行できるのは auth-worker prod のみ。auth-staging は `ALC_API_ORIGIN` が staging Cloud Run 固定で目的に合わない |
| 2 | アクセス制御は CF Access か auth-worker か | **CF Access + 安定 preview hostname**。`preview-<app>.ippoan.org` への薄い router を実装し、`release-wave-preview` Access app (`preview-*.ippoan.org` wildcard、release-wave.md 記載の既存構想) で開発者限定にする |
| 3 | frontend preview が叩く backend | **flip 前 0% revision と組合せる**。ビルド時 vars の prod 固定を runtime override で上書きする機構を足す |

## 現状の壁 (調査確定事項)

1. **auth-worker origin allowlist**: `origins:prod/staging/dev/wt` KV との
   **exact match** (`auth-worker/src/lib/security.ts` `isAllowedRedirectUri`)。
   per-release でハッシュが変わる `*.workers.dev` preview origin は登録できず、
   各 `*-redirect.ts` / `*-callback.ts` で 400 拒否される。
2. **cookie 不成立**: `logi_auth_token` は `Domain=.ippoan.org`。`*.workers.dev` は
   public suffix のためセット不可 (`auth-worker/src/lib/cookies.ts`
   `authCookieReachesHost` が検知して fragment fallback するが、壁 1 の後ろ)。
3. **backend 固定**: frontend の API base (`NUXT_PUBLIC_API_BASE` /
   `NUXT_ALC_API_URL`) はビルド時 vars で prod origin (= 現行 100% revision) に
   固定。flip 前 backend の tagged revision URL
   (`https://v1-42-0---<svc>-<hash>.run.app`) に向ける経路が無い。
4. **preview URL が空の可能性**: 4 frontend (nuxt-trouble / nuxt-dtako-admin /
   nuxt-egov / nuxt-notify) は `preview_urls` 未 opt-in (`workers_dev = false`
   明示の env もある)。`frontend-ci.yml` の preview URL 抽出は best-effort のため、
   pending-release webhook の `preview_url` が空報告になっている可能性が高い。
   opt-in 済みは auth-worker のみ (`auth-worker/wrangler.toml:5-8`)。

**安定 preview hostname 方式は壁 1〜2 を同時に解決する**: hostname が固定なので
KV `origins:prod` への登録は 1 回で済み、`.ippoan.org` 配下なので cookie も届く。
auth-worker の**コード変更は不要** (KV 登録のみ)。

## アーキテクチャ

```
開発者ブラウザ
  │ ① https://preview-trouble.ippoan.org/…
  ▼
CF Access (release-wave-preview app, preview-*.ippoan.org wildcard)
  │ ② Google OAuth + admin email allowlist
  ▼
preview-router (ci-dashboard worker に route 追加)
  │ ③ Host から app を特定 → pending-release::<repo> の preview_url を解決
  │ ④ workers.dev preview version へ server-side proxy
  │ ⑤ 応答に API base override cookie を注入
  │    (backend repo の pending-release から tagged revision URL を解決)
  ▼
flip 前 frontend version (workers.dev, 0%)
  │ ⑥ ブラウザ上で override cookie を読み API base を差し替え
  ▼
flip 前 backend revision (https://v1-42-0---<svc>-<hash>.run.app, 0%)
    prod DB / prod JWT_SECRET / CORS Any / JWT + RLS で認可 (従来方針のまま)

auth-worker prod: ログイン redirect は preview-<app>.ippoan.org origin で完結
    (origins:prod に静的登録、cookie Domain=.ippoan.org で成立)
```

## Phase 分割

### Phase 0: frontend の preview_urls opt-in (前提、各 frontend repo)

- 対象 frontend の wrangler (top-level = prod env) に `preview_urls = true` を追加
  (auth-worker と同型。custom domain の production traffic には影響しない)。
- 効果: `wrangler versions upload` が version 固有 preview URL を出力 →
  `frontend-ci.yml` が抽出して pending-release webhook に載せ、`/release-wave` の
  Pending releases リンクが機能する。
- 初期対象: **nuxt-trouble / nuxt-dtako-admin** (browser-direct app、経路 B の
  主対象)。nuxt-notify / nuxt-egov は Phase 3 の対象判断とあわせて follow-up
  (nuxt-egov は auth-worker 非依存・e-Gov OAuth のため経路 B の壁が異なる)。
- PR: 各 repo に 1 行変更 + tag release 1 回で preview URL 報告を実機確認。

### Phase 1: preview-router + CF Access (ci-dashboard)

- **置き場所**: ci-dashboard worker に `src/release-wave/preview-router.ts` を追加し、
  Worker route `preview-*.ippoan.org/*` を張る。別 worker を作らない理由:
  pending-release 状態 (`pending-release::<repo>`) を持つのが ci-dashboard 自身
  であり、同居なら解決が worker 内で完結する (lib-first / 薄く保つ)。
- **動作**:
  - Host header (`preview-<app>.ippoan.org`) から app → repo を解決
    (対応表は wrangler vars、例 `trouble → ippoan/nuxt-trouble`)。
  - pending-release の `preview_url` (workers.dev) へ path/query/method/body を
    そのまま server-side proxy。**転送先は pending-release に記録済みの URL のみ**
    (open proxy 化しない。`safeHttpUrl` 検証済みの値)。
  - pending が無い / preview_url 空なら **404 固定文言** (値・内部 URL を echo しない)。
- **CF Access**: `release-wave-preview` Access app (`preview-*.ippoan.org` wildcard、
  admin email allowlist) を release-wave.md 記載の手順どおり手動 setup。
  DNS は `preview-*` の wildcard CNAME (proxied) を 1 本追加。
- 注意: CF Access が gate するのは **preview hostname への navigation / 同 origin
  XHR** のみ。backend への cross-origin XHR は従来どおり公開 + JWT/RLS
  (release-wave.md block E の方針を変えない)。

### Phase 2: auth-worker prod への origin 登録 (運用のみ、コード変更なし)

- KV `origins:prod` (namespace `AUTH_CONFIG`) に
  `https://preview-trouble.ippoan.org` / `https://preview-dtako.ippoan.org` を追加
  (`wrangler kv key put --remote`、auth-worker/wrangler.toml 記載の運用コマンド)。
- cookie は `Domain=.ippoan.org` がそのまま届くため fragment 経路は不要。
  SameSite=Lax も top-level navigation のログインフローでは問題にならない。
- 手順を auth-worker 側 docs (または map skill) に追記する PR を出す。

### Phase 3: backend 0% revision への API base override

> **実装メモ (2026-07-10、ippoan/auth-worker#361)**: 対象 2 app (nuxt-trouble /
> nuxt-dtako-admin) は実コード上どちらも方式 B (`/api/proxy` → auth-worker
> `/alc-proxy`) だったため、下記の browser 側 override ではなく **server 側**で
> 実装した。cookie は same-origin `/api/proxy` リクエストに自動付帯するので、
> auth-client `createAuthWorkerProxyHandler` が cookie → `X-Alc-Preview-Api-Base`
> header 変換 (auth-client >= 0.2.79)、auth-worker `/alc-proxy` が
> `ALC_API_PREVIEW_HOST_SUFFIX` に pin 検証して forward 先 + OIDC aud を差し替える
> (不正値は 400 loud fail)。**browser 側 (`@ippoan/auth-client` composable) の
> 変更は不要になった**。以下の記述は当初案として残す。

- **仕組み**: preview-router が応答時に override cookie を注入する:
  - backend repo (rust-alc-api) の pending-release から tagged revision URL を解決
  - `Set-Cookie: alc_api_preview_base=<tagged-url>; Path=/; Secure; SameSite=Lax`
    (Domain 指定なし = preview hostname 限定)
  - backend の pending が無い場合は cookie を**注入しない** (= 現行 prod backend に
    向いたまま。frontend 単独 release の preview はこの状態で正)。
- **frontend 側**: API base 解決箇所で override cookie を読む共通ロジックを
  `@ippoan/auth-client` に追加 (lib-first — 対象 app 全部で必要になるため)。
  受理条件を **`location.hostname` が `preview-*.ippoan.org` に一致する時のみ**に
  限定 (本番 origin では cookie があっても無視 → 悪用防止)。値は
  `https://` + `*.run.app` 形式のみ受理する形式検証を入れる。
- **認証**: browser-direct app は auth-worker JWT を `Authorization`/cookie で
  直接 backend に送る。tagged revision は同一 service (同一 `JWT_SECRET`、CORS Any)
  なので prod ログインの JWT がそのまま通る (経路 A と同じ性質)。OIDC は不要。
- **対象外 (follow-up)**: 方式 B (auth-worker `/alc-proxy` 経由) の app
  (nuxt_dtako_logs 等) は転送先 `ALC_API_ORIGIN` が env 固定のため、この方式では
  届かない。必要になったら `/alc-proxy` に dev-gated な revision-tag override
  header を検討する (別 issue)。

### Phase 4: 運用手順の文書化 + 実 release での検証

- `docs/release-wave.md` の経路 B 節を「準備が要る」から実手順に書き換える:
  1. tag release → frontend + backend の pending が `/release-wave` に出る
  2. `https://preview-<app>.ippoan.org` を開く (CF Access → Google OAuth)
  3. 通常ログイン (auth-worker prod、preview origin で完結)
  4. override cookie により flip 前 backend 0% revision を向いた状態で E2E spot-check
  5. 問題なければ Flip / Flip all (retest compatibility gate は従来どおり有効)
- 実 release 1 回で経路 B を通し、flip まで完走することを確認する。

## セキュリティ考慮

- **preview-router は open proxy にしない**: 転送先は pending-release 記録済み
  URL のみ。任意 URL 指定の入力面を作らない。
- **override cookie は preview hostname 限定 + 形式検証**: 本番 origin では無視。
- **backend preview は従来どおり公開 + JWT/RLS** (release-wave.md block E)。
  CF Access は「到達 (発見経路) の gate」であり、データ保護は JWT + RLS のまま。
- **秘密を増やさない**: preview-router は ci-dashboard 内部状態のみ参照し、
  新しい shared secret / API key を持たない。auth-worker 側もコード変更なし。
- **upstream エラーは固定文言 502/404**: 内部 URL / 値を response に echo しない
  (org 共通規範)。

## PR 分割 (想定)

| Phase | repo | 内容 |
|---|---|---|
| plan | ippoan/ci-dashboard | 本 doc (この PR) |
| 0 | ippoan/nuxt-trouble, ippoan/nuxt-dtako-admin | `preview_urls = true` (各 1 行) |
| 1 | ippoan/ci-dashboard | preview-router + route + vars + テスト |
| 1' | (手動) | CF Access app `release-wave-preview` + DNS wildcard |
| 2 | ippoan/auth-worker | docs のみ (KV 登録手順)。KV put は手動運用 |
| 3 | ippoan/auth-worker (packages/auth-client) → 各 frontend | override 共通ロジック + 適用 |
| 4 | ippoan/ci-dashboard | release-wave.md 経路 B 節の書き換え |

## 未確定 / リスク

- **preview URL の実出力**: Phase 0 の opt-in 後も、`wrangler versions upload` が
  preview URL を出力するかは Cloudflare account 側の設定 (workers.dev subdomain)
  に依存。Phase 0 の実機確認で fail fast する。
- **SSR/asset の proxy 互換性**: Nuxt (Nitro) の SSR 応答・`_nuxt/*` asset が
  Host 差し替え proxy で崩れないか。preview-router は Host 以外のヘッダを素通し
  し、実機で最初に確認する。
- **auth-client の型規範**: `.vue` ソース直 ship のため strict 型注釈必須
  (auth-worker/CLAUDE.md)。override ロジックは `.ts` composable に置く。
- **pending の鮮度**: pending-release は次 release で上書きされる。router は常に
  「最新の pending」に proxy する仕様と割り切る (複数 pending の並行検証は scope 外)。
