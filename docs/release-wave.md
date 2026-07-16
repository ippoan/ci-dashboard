# Release Wave 機構 — 運用ガイド

設計の親 issue: [ippoan/ci-dashboard#137](https://github.com/ippoan/ci-dashboard/issues/137)

ci-dashboard 内に実装した Release Wave 機構の **operator 向け運用ガイド**。
コード設計は issue #137 の本文を参照。本ドキュメントは Phase 3a〜3e 完了後の
日常運用 + ワンタイム setup (CF Access wildcard 等) をカバーする。

frontend ↔ backend image 互換性突合 (#157) の KV write shape 仕様は
[`docs/release-wave-compatibility-kv.md`](release-wave-compatibility-kv.md) を参照。

---

## アーキテクチャ全体図

**現在の主要経路は Pending release flip** (下記)。旧来の wave state machine
(start→stage→approve→flip の wave 単位フロー) は stage phase 撤去
(Refs ippoan/ci-workflows#96①) で `release_wave_start` / `release_wave_stage`
tool ごと削除済みで、**新規 wave を開始する経路が現状存在しない**
(`ReleaseWaveHub` DO の `start()` / `createWave()` を呼ぶ production caller が
ソース中に無い)。`approve` / `rollback` / `abort` / `fail` の tool・Admin UI
ボタン自体は残っているが、対象になる wave が作られないため実質的に稼働してい
ない可能性が高い (要検証、別 issue で判断)。

```
operator (Cloudflare Access edge gate)
    │
    ├─ Admin UI: GET /release-wave
    │   └─ Action buttons:
    │       POST /api/release-wave/pending-release/flip        (1 repo flip)
    │       POST /api/release-wave/pending-release/flip-all    (全 repo 一括 flip)
    │       POST /api/release-wave/pending-release/flip-group-rollback
    │       POST /api/release-wave/traffic-rollback / backend-rollback
    │       (legacy) POST /api/release-wave/:wave_id/{approve|rollback|abort|fail}
    │
    └─ MCP tools (Claude Code, OAuth via auth-worker):
        release_wave_pending_state / _pending_flip / _pending_flip_all
        (+ legacy wave 系: _status / _approve / _flip / _rollback / _abort /
         _fail / _contract_applied — 上記の通り新規 wave 開始経路なし)

GitHub Actions step (release-wave-handler / frontend-ci reusable):
    │
    └─ HTTP webhook (shared secret, X-Release-Wave-Webhook-Secret):
        POST /webhooks/release-wave/pending-release      (tag push 後の
          no-traffic version 報告 = 旧 stage-report 相当)
        POST /webhooks/release-wave/flip-report
        POST /webhooks/release-wave/contract-applied
        POST /webhooks/release-wave/frontend-test-report
        POST /webhooks/release-wave/backend-deploy-report
        POST /webhooks/release-wave/traffic-report / backend-traffic-report

           ↓

      COMPAT_KV: pending-release::<repo> record (pending-release.ts)
      (legacy: ReleaseWaveHub DO の wave:{wave_id} record / state.ts state machine)

           ↓ (flip 時)

      release-wave-gcp (Cloud Run proxy) / wrangler versions deploy (Workers):
        /cloudrun/flip-traffic
        /cloudrun/rollback
```

---

## Cloudflare Access setup (ワンタイム)

Admin UI (`/release-wave`) は ci-dashboard 全体に被さる Cloudflare Access の
edge gate に保護を任せている。`/releases` ページと同じトラストモデル。

### 既存 ci-dashboard.ippoan.org Access policy

ci-dashboard worker の Custom Domain `ci-dashboard.ippoan.org` には既に
Cloudflare Access Application が付いている前提 (= `/issues` `/projects`
`/releases` を operator が見るためのもの)。

policy はおおむね:

| 項目 | 値 |
|---|---|
| Application name | `ci-dashboard` |
| Application domain | `ci-dashboard.ippoan.org` |
| Session duration | 24h |
| Allow policy | `email == m.tama.ramu@gmail.com` (+ 必要なら他 admin email) |
| IdP | Google OAuth (既存 SSO) |

Release Wave 機構導入で **追加 setup は不要**。既存の Access Application が
そのまま `/release-wave` `/api/release-wave/*` も保護する。

### preview-*.ippoan.org wildcard (新規追加が必要)

issue #137 の "Admin Preview Gate" セクションで計画されている、staged
revision にアクセスするための preview hostname 群を gate するための
**別の Access Application** を 1 個追加する。

| 項目 | 値 |
|---|---|
| Application name | `release-wave-preview` |
| Application domain | `preview-*.ippoan.org` (wildcard) |
| Session duration | 24h |
| Allow policy | `email == m.tama.ramu@gmail.com` (admin allowlist) |
| IdP | Google OAuth (既存 SSO) |

実 setup 手順 (Cloudflare dashboard):

1. **Zero Trust** → **Access** → **Applications** → **Add an application**
2. Type: `Self-hosted`
3. Application name: `release-wave-preview`
4. Session duration: `24 hours`
5. Application domain:
   - Subdomain: `preview-*`
   - Domain: `ippoan.org`
   - Path: `(empty)`
6. **Policies** → **Add a policy**
   - Policy name: `admins`
   - Action: `Allow`
   - Include: `Emails` → `m.tama.ramu@gmail.com`
7. Save

これで `preview-rust-alc-api.ippoan.org` `preview-auth.ippoan.org` 等の
hostname に operator がブラウザでアクセスすると Google OAuth に転送 →
allowlist 一致確認 → staged revision に到達、という流れになる。

各 hostname の DNS / Worker route 配線は release-wave-handler (Phase 4 で
ci-workflows reusable として実装) 側で stage 時に動的に作る。

### Terraform module 化 (将来)

issue #137 の open question 9 で挙げた「CF Access policy を Terraform で
管理するか」は **今のところ手動 setup**。CI/CD パイプラインの一部に組み込
みたくなったら `cloudflare_access_application` リソースを使ったモジュール
を ci-workflows 内に作る。

---

## no-traffic preview による flip 前 E2E (Refs #260)

tag release 済みの front + backend を **traffic を振る前 (no-traffic)** に
admin が実環境で E2E 確認してから flip する運用。専用の自動 E2E gate は
**設けない** — flip 前の互換 gate は既存の retest (compatibility) gate を正とし、
preview URL は admin の手動 spot-check に使う、というのが本機構の方針。

### 何が「flip 前 gate」か (= retest compatibility gate)

flip を止める唯一の自動 gate は `approve()` の **compatibility gate**
(`src/release-wave/do.ts` の `compatibilityGateBlockers`)。`require_compatibility=true`
な backend に対して **未 test の frontend が居れば force なしの approve を拒否**する。
ここで言う "test" は各 frontend CI の **retest (integration test)** = `compat_backend_repo`
で宣言した backend の image に対する統合テストで、結果は `frontend-test-report`
webhook → COMPAT_KV に記録される (Refs #157)。

→ **front↔backend のペアリングと互換検証は retest が担う**。live no-traffic E2E を
別の必須 gate として二重化しない (実装・運用コストに見合わないと判断)。

### preview URL の出どころ (block A + C)

| platform | no-traffic revision | preview URL の生成 | ci-dashboard への報告 |
|---|---|---|---|
| Cloud Run (backend) | `deploy.yml` が release tag の 0% revision に **revision tag** (`v1.42.0`→`v1-42-0`) を付与 | `https://<tag>---<svc>-<hash>.run.app` | `report-pending-release` job が gateway の tagged URL を `gcloud run services describe` で解決し `preview_url` に載せて `pending-release` webhook に POST |
| Cloudflare Workers (frontend) | `frontend-ci.yml` が `wrangler versions upload` で 0% version | `https://<hash>.workers.dev` | 同 `pending-release` webhook (frontend は既存経路) |

報告された `preview_url` は `/release-wave` の **Pending releases** に
クリック可能リンクとして出る (`computeUnifiedPending` → `page.ts`)。

> **flip は tag に依存しない**: cloudrun の flip は release-wave-gcp proxy が
> service の `latestReadyRevision` を anchor にする (Refs #248)。preview tag は
> **到達 (E2E) 専用のラベル**で、flip 切替には使わない。

### admin の運用フロー

1. tag release → backend (no-traffic, preview tag 付き) + frontend (no-traffic version) が上がる
2. 両者の `preview_url` が `/release-wave` の Pending releases に出る (= `/release-wave`
   自体が ci-dashboard の Cloudflare Access 配下なので、**preview URL の発見経路が admin 限定**)
3. admin が Pending releases のリンクから preview URL を開いて E2E spot-check
   (frontend preview は backend preview を向くよう手元で確認)
4. 問題なければ Flip (単一) / Flip all (wave) で 100% に切替
   - **retest compatibility gate** が未 test frontend を検出していれば approve/flip は
     `force` なしでは通らない (= 自動の安全網はこちら)

### backend を「本番データ」で E2E する手順

このしくみの主目的は **新 backend を flip 前に本番データで検証する** こと。staging は
別 DB・揮発・auth バイパスで本番を一切反映しないので、この目的では使わない。

**鍵となる事実**: backend preview (preview tag の revision) は **同じ本番 service の 0%
revision**。= **本番 DB (Supabase) に接続**、**本番 `JWT_SECRET` を共有**、CORS は `Any`。
→ **通常の本番ログインで得た JWT がそのまま backend preview に対して有効**で、RLS も
本番テナントで効く。

#### 経路 A: API/curl レベル (preview に redirect しない → 追加準備なし)

新 backend のエンドポイント挙動を本番データで叩く分にはこれで足りる:

1. tag release → backend 0% revision に preview tag → `/release-wave` の Pending releases に
   URL が出る (block A + C)。
2. admin が **本番フロント** (`alc-api.ippoan.org`、auth-worker に既登録の origin) で通常
   ログイン → **本番 JWT** を取得。**OAuth は本番 origin で完結し、preview には一切 redirect
   しない**。
3. その JWT を `Authorization: Bearer <jwt>` で backend preview URL に投げる:
   ```bash
   curl -H "Authorization: Bearer $PROD_JWT" \
     "https://v1-42-0---rust-alc-api-<hash>.run.app/api/<path>"
   ```
4. backend preview は **本番 DB を読む** ので新 backend を本番データで検証できる
   (RLS が admin テナントにスコープ)。問題なければ Flip。

> なぜ準備不要か: 認証は本番 origin で完結し (許可 origin 既存)、発行 JWT は同一
> `JWT_SECRET` の backend preview に通る。CORS は `Any`。redirect_uri が preview を
> 経由しないので auth-worker 側の登録は不要。

#### 経路 B: ブラウザで preview フロントから入る (実装済み、Refs #472)

flip 前 frontend version をブラウザで開き、flip 前 backend (0% tagged revision) と
組合せて full E2E する経路。**preview-router (安定 hostname) 方式で実装済み**
(plan: `docs/plan-pre-flip-preview-e2e.md`)。

**配線 (整備済みの前提)**:

- 各 frontend の wrangler に `preview_urls = true` (0% version の workers.dev
  preview URL が pending-release webhook に載る前提。未 opt-in の repo は
  preview_url が空で router が 404 を返す)
- **preview-router**: `preview-<app>.ippoan.org` → 本 worker
  (`src/release-wave/preview-router.ts`) が `pending-release::<repo>` の
  workers.dev preview URL へ server-side proxy。app → repo 対応は
  `PREVIEW_ROUTER_APPS` var (app 追加時は custom domain route も追加)
- **CF Access**: `release-wave-preview` app (`preview-*.ippoan.org` wildcard、
  admin email allowlist) が edge で開発者限定に gate
- **auth-worker**: KV `origins:prod` に `https://preview-<app>.ippoan.org` を
  静的登録済み (コード変更なし)。`.ippoan.org` 配下なので `logi_auth_token`
  cookie (Domain=.ippoan.org) もそのまま届く
- **backend override**: backend repo の pending release (tagged revision URL) が
  あれば preview-router が `alc_api_preview_base` cookie を注入 → 方式 B app の
  `/api/proxy/*` に自動付帯 → auth-client `createAuthWorkerProxyHandler` が
  `X-Alc-Preview-Api-Base` header に変換 → auth-worker `/alc-proxy` が
  `<tag>---<ALC_API_PREVIEW_HOST_SUFFIX>` (同一 Cloud Run service の tagged
  revision) に pin 検証して forward 先 + OIDC aud を差し替え。不正値は **400
  loud fail** (黙って prod に流さない)

**admin の手順**:

1. tag release → frontend + backend の pending が Pending releases に出る
2. `https://preview-<app>.ippoan.org` を開く (CF Access → Google ログイン)
3. アプリ側で通常ログイン (auth-worker prod、redirect は preview hostname で完結)
4. backend pending があれば API は自動で flip 前 backend (tagged revision) に
   向く (無ければ現行 prod backend のまま = frontend 単独 release の preview)
5. E2E spot-check → 問題なければ Flip / Flip all

**制約**:

- 対象は方式 B (`/api/proxy` → `/alc-proxy`) の app のみ (nuxt-trouble /
  nuxt-dtako-admin)。browser 直 fetch app / 他 proxy 経路の app は対象外 (follow-up)
- backend override は auth-client >= 0.2.79 (`X-Alc-Preview-Api-Base` 変換) を
  bundle した frontend build であること
- router は「最新の pending」に proxy する (複数 release の並行検証は scope 外)

→ **「本番データで backend を検証」だけなら経路 A (準備なし) で完結**。ブラウザで新 front
ごと通す full E2E が要るときは上の手順で経路 B を使う。

### preview を admin だけに見せる (block E)

no-traffic preview は本番トラフィックを受けない検証用だが、**backend (Cloud Run)
preview は hard gate できない**。理由:

- backend gateway は本番 `--allow-unauthenticated` で、frontends (nuxt-trouble /
  alc-app 等) は **ブラウザから backend API を直叩き** する (CORS、server proxy 無し)。
  Cloud Run の invoker IAM は **service 単位** (revision/tag 単位ではない) なので、
  preview tag の revision だけを private にはできない。
- preview tag の前に Cloudflare Access の hard gate を置くと、preview を使う
  E2E の **ブラウザ XHR が Access cookie 不在で 403** になり E2E 自体が壊れる。

→ backend preview は **到達可能なまま (公開)** が正しい。**network endpoint が開いていても
データは漏れない**: データ取得には JWT (`require_jwt`) または tenant scope
(`require_tenant` = JWT / X-Tenant-ID) が必須で、さらに Postgres **RLS**
(`alc_api_app` は NOBYPASSRLS、`app.current_tenant_id` は認証済み JWT/header 由来) が
テナント分離を強制する。= 本番と同じ認可ポスチャ。network gate は被せない。

つまり preview の "admin-only" 懸念は **データ保護ではなく** (それは JWT + RLS が担う)、
「staging endpoint を広めない / 誤トラフィックを避ける」程度の話。よって
**admin-only は「preview URL を CF Access 配下の `/release-wave` からしか発見できない」=
発見経路を絞る** ことで十分 (URL は推測困難 + revision tag は次 release で揮発)。

#### 「preview を email 限定にできないか」(auth-worker 経由)

結論: **作る必要はない。preview は既に app 層で email 限定されている。**

- ログインは auth-worker (Google OAuth) を通り、`src/lib/acl.ts` の email allowlist
  (`USER_ACL` → `checkOrgAccess` / `matchesOrgAllowlist`、`APP_TENANT_ACL.bypass_emails`)
  が **`src/handlers/google-callback.ts` で email を照合してから**アクセスを許可する。
  → **許可 email にだけ JWT が発行**され、未許可 email は JWT を得られない。
- backend は `require_jwt` + RLS なので **JWT 無し = データ取得不可**。つまり preview
  endpoint が公開でも、**許可 email の Google ログインを経た JWT が無ければ何も取れない**
  = 実質 email 限定 (本番と同じ)。

GCP レベルで preview を email 限定にする (Cloud Run invoker IAM を特定 email に絞る /
IAP を被せる) のは **不可かつ不要**:

- invoker IAM は **service 単位**なので 0% preview revision だけを email 限定にできず、
  prod revision まで巻き込む。
- browser-direct frontends は GCP identity token ではなく auth-worker の JWT を送るため、
  IAM/IAP の email gate は **ブラウザ XHR の E2E を壊す** (上と同根)。
- どうしても pre-auth の network surface を絞りたい場合のみ、**別 preview service +
  IAP + server-proxy 経由アクセス** という重い構成になる (browser-direct frontend では
  使えない)。通常は app 層の email allowlist + JWT + RLS で十分。

CF Access wildcard (`preview-*.ippoan.org`、上の「Cloudflare Access setup」節) が
意味を持つのは:

- **`/release-wave` ダッシュボード** — 既に ci-dashboard 全体の Access 配下 (preview URL の発見元)
- **frontend preview の "ページ"** — human admin がブラウザで開く HTML origin は
  gate 可能 (workers preview を `preview-*.ippoan.org` に route する場合)。ただし
  preview URL は per-release で変わるため静的 hostname → preview の route は別途必要
  (= raw preview URL を `/release-wave` から開く運用なら不要)。

将来 headless な自動 E2E runner を足す場合、frontend page を gate する構成にしたなら
同 Access app に **service token** policy を 1 本足して bypass する
(human=Google OAuth / machine=service token)。backend は元から公開なので runner も素通り。

---

## MCP tool 経由の運用 (Claude Code / 他 MCP client)

`https://ci-dashboard.ippoan.org/mcp` に OAuth (auth-worker delegation) で
ログインすると以下 10 tool が叩ける (`src/mcp/tools/release-wave.ts`)。

### 現行の主要経路 (wave state machine を経由しない)

| tool | 用途 |
|---|---|
| `release_wave_pending_state` | Pending releases の診断 (read-only、`/release-wave` の表示と同一 source) |
| `release_wave_pending_flip` | 1 repo の pending release (no-traffic version) を 100% traffic へ flip |
| `release_wave_pending_flip_all` | 全 pending release を一括 flip (`/release-wave` の「Flip all」相当、flip-group を記録し一括 rollback 可能にする) |

### legacy: wave state machine 系 (新規 wave 開始経路なし、上記注記参照)

| tool | 用途 |
|---|---|
| `release_wave_status` | wave の現状取得 (read-only) |
| `release_wave_approve` | admin 承認 (pending-approval → flipping) |
| `release_wave_flip` | repo handler からの flip 完了 callback (operator が直接叩く口ではない) |
| `release_wave_rollback` | 旧 revision 戻し (`--force` で unsafe override) |
| `release_wave_abort` | flip 前の中止 |
| `release_wave_fail` | stuck wave を強制的に failed へ落とす |
| `release_wave_contract_applied` | GitHub Actions step からの contract 通知 |

Admin UI ボタンと MCP tool は同じ実装を呼ぶので **どちらから操作しても
同じ結果**。Admin UI は人間 operator 用 (= 視覚的なステート確認 + ワンクリック
action)、MCP tool は自動化 / IDE 統合用。

---

## GitHub Actions step 経由の運用 (release-wave-handler / frontend-ci reusable + webhook)

GitHub Actions が release-wave 機構と連携する経路は shared secret 認証 HTTP
webhook で統一されている (= MCP OAuth を Actions で動かさない設計)。すべて
`X-Release-Wave-Webhook-Secret` header + JSON body (`src/release-wave/webhook.ts`)。

| endpoint | 用途 |
|---|---|
| `POST /webhooks/release-wave/pending-release` | frontend-ci が tag push を検知して no-traffic version を報告 (= 旧 stage-report 相当。stage phase 撤去後、stage 完了通知はここに一本化された) |
| `POST /webhooks/release-wave/flip-report` | (legacy wave 系) flip 完了 callback |
| `POST /webhooks/release-wave/contract-applied` | contract migration deploy 後の通知 |
| `POST /webhooks/release-wave/frontend-test-report` | frontend CI green 時の compatibility 記録 (KV write) |
| `POST /webhooks/release-wave/backend-deploy-report` | backend deploy 成功時の compatibility 記録 (KV write) |
| `POST /webhooks/release-wave/traffic-report` | Cloudflare Workers の version traffic split 報告 |
| `POST /webhooks/release-wave/backend-traffic-report` | Cloud Run の traffic split 報告 |
| `GET /webhooks/release-wave/backend-current-image` | 現 production backend image の解決 (CF Access を経由しない機械可読 read) |

compatibility 系 2 endpoint の body / KV shape は
[`docs/release-wave-compatibility-kv.md`](release-wave-compatibility-kv.md) を参照。
突合結果の read は CF Access edge gate 配下の read-only endpoint
`GET /compatibility?backend_repo=&backend_target_image=` /
`GET /backend-current-image?repo=` で取得する。

### pending-release body

```json
{
  "repo": "ippoan/nuxt-trouble",
  "worker_name": "nuxt-trouble",
  "version_id": "0d3f2b7e-....-uuid",
  "tag": "v1.2.3",
  "preview_url": "https://preview-trouble.ippoan.org"
}
```

`worker_name` は monorepo unit のみ指定 (単一 worker repo は省略)。
`version_id` は cloudflare-workers なら `wrangler versions upload` の UUID、
cloudrun なら revision tag (例 `pending-v0-0-79`)。`preview_url` は省略可。
backend (cloudrun) の場合はさらに `staged_image` (flip 前 no-traffic image の
git SHA) を渡すと、未 test の consumer への flip 前 retest が自動 fan-out
される (Refs #427)。

### flip-report body (legacy wave 系)

```json
{
  "wave_id": "wave_2026_05_27_01",
  "repo": "ippoan/rust-alc-api",
  "ok": true
}
```

`ok=false` 時は `error` 必要。

### contract-applied 通知 step (caller repo 側)

caller repo (e.g. `rust-alc-api`) の migration deploy workflow に以下 step を
追加:

```yaml
- name: notify ci-dashboard on contract migration
  if: contains(steps.migrate.outputs.applied_phases, 'contract')
  env:
    WEBHOOK_SECRET: ${{ secrets.RELEASE_WAVE_WEBHOOK_SECRET }}
  run: |
    curl -fsS -X POST https://ci-dashboard.ippoan.org/webhooks/release-wave/contract-applied \
      -H "X-Release-Wave-Webhook-Secret: $WEBHOOK_SECRET" \
      -H "Content-Type: application/json" \
      -d '{
        "wave_id":      "${{ github.event.client_payload.wave_id }}",
        "repo":         "${{ github.repository }}",
        "migration_id": "${{ steps.migrate.outputs.contract_migration_id }}"
      }'
```

- `RELEASE_WAVE_WEBHOOK_SECRET` (SCREAMING_SNAKE_CASE) は GitHub org secret
  として投入済。値の source of truth は GCP Secret Manager
  `release-wave-webhook-secret` (kebab-case)
- 通知失敗 (= 4xx/5xx) は step fail にしてあえて deploy を止める設計
  (= rollback safety flag が flip しない状態で contract が走るのを防ぐ)

---

## 日常運用フロー

### 通常のリリース (= 失敗なし、現行の pending release flip 経路)

1. operator が対象 repo の tag を打つ (`/release-wave` の「Repo リリース状況」
   セクションの **Tag Release** ボタン、または各 repo で `tag-release.yml` を
   手動 `workflow_dispatch`)
2. tag push を検知した release CI (frontend-ci / go-ci 等) が no-traffic
   version を deploy し、`POST /webhooks/release-wave/pending-release` で
   ci-dashboard に報告 → `/release-wave` の「Pending releases」に一覧表示
   される
3. operator が preview URL (`preview-*.ippoan.org`、CF Access 経由の Google
   OAuth) でブラウザ確認
4. Admin UI の **Flip** (1 repo) / **Flip all** (全 repo 一括。MCP
   `release_wave_pending_flip` / `release_wave_pending_flip_all`) ボタン押下
5. 各 repo の release-wave-handler が実際の flip
   (`wrangler versions deploy <id>@100%` / cloudrun flip-traffic) を
   GitHub Actions 上で実行する。**callback は無い**ため、結果は Actions run
   を直接確認する
6. flip-all の場合は flip-group が記録され、後でまとめて rollback できる

補足 (auto-flip, Refs #476/#481): `POST /api/release-wave/auto-flip/arm` で
repo 群を armed にしておくと、指定した全 repo が pending release に載った
時点で flip-all が自動発火する。

### 失敗 / rollback (pending release flip 経路)

- frontend 単独 rollback: `POST /api/release-wave/traffic-rollback`
- backend 単独 rollback: `POST /api/release-wave/backend-rollback`
- flip-all で作った flip-group をまとめて戻す:
  `POST /api/release-wave/pending-release/flip-group-rollback`

### legacy: wave state machine (新規開始経路なし)

以下は `ReleaseWaveHub` DO の `wave_id` 単位 state machine を経由する旧
フロー。`release_wave_start` tool 削除 (stage phase 撤去、Refs
ippoan/ci-workflows#96①) 後、**`createWave()` を呼ぶ production caller が
無く新規 wave を作る経路が存在しない**ため、`approve`/`rollback`/`abort`/
`fail` 系の tool・Admin UI ボタン自体は残っているものの実質使う機会が無いと
考えられる (dead code かどうかは未検証。削除する場合は別 issue で判断する)。

- **flip 前 (pending-approval)**: **Abort** ボタン (or MCP
  `release_wave_abort`) で中止
- **flip 後 (rollback.safe=true)**: **Rollback** ボタン (or MCP
  `release_wave_rollback`) で旧 revision に戻す
- **flip 後 (rollback.safe=false)**: rollback はデフォルト refuse。Admin UI
  には警告と `(force)` ラベル付きボタンが出るので、operator が DB を手動
  復旧する覚悟があれば押す (= force=true を裏で渡す)
- serial enforcement: 1 wave が `staging` / `pending-approval` / `flipping`
  のうちに 2 つ目の wave を `start` しようとすると `WAVE_IN_PROGRESS` で
  reject される設計だが、上記の通り `start` 自体を呼ぶ経路が無い

---

## トラブルシューティング

| 症状 | 原因の可能性 | 対応 |
|---|---|---|
| Pending releases にいつまでも出てこない | release CI が `pending-release` webhook を打てていない (secret 不一致等) | 対象 repo の release CI run log を確認 |
| flip ボタンを押しても反映されない | flip は callback 無しの fire-and-forget | 対象 repo の GitHub Actions run を直接確認 |
| Admin UI で button が disabled | 現 state でその操作が無効 | hover の title 説明を確認、別 button を使う |
| 通知 webhook が 401 | secret 不一致 / 古い rotation 値 | secrets-rotate-pipe で 3 所同期再投入 |
| preview-*.ippoan.org が 403 | CF Access policy 未追加 / email allowlist 外 | 本ドキュメントの "preview-* wildcard" セクション参照 |
| (legacy) MCP tool が `WAVE_IN_PROGRESS` を返す | 別 wave が in-progress | `release_wave_status` で確認、必要なら abort/rollback |
| (legacy) flip 後 rollback が refuse | contract migration 適用済 | Admin UI の警告を確認、必要なら force 押下 (DB 手動復旧前提) |

## Repo リリース状況 / 直接 Tag Release (Refs #137)

`/release-wave` ページの **Compatibility (all consumers) セクションの下**に
「Repo リリース状況」セクションがあり、監視対象 repo の tag 状況を一覧する。

- **tag あり / なしを明示**: 最新 tag を緑 badge、未tag (= main しか無い repo) を
  赤 badge で表示。行頭の左帯色でも状態が分かる (緑 = 最新 / 黄 = 要リリース /
  赤 = 未tag / 灰 = 取得失敗)。
- 上部サマリに「未tag N / 要リリース N / 最新 N」を表示。
- **直接 Tag Release**: 未tag、または tag が default branch から離れている
  (commits 未リリース) repo には `Tag Release` ボタンが出る。押すと
  `POST /api/release-wave/tag-release` 経由で各 repo の `tag-release.yml`
  workflow を `main` で `workflow_dispatch` する (tag 採番 + GitHub Release 作成は
  workflow 側に委譲)。`/release-wave` は strict CSP (JS 無効) のため、素の
  `<form method="post">` + Post/Redirect/Get (303 → `/release-wave`) で動く。
- `TAGLESS_REPOS` 指定 repo は **一覧から除外する** (merge into default branch が
  release event 扱いで、そもそもリリース対象ではないため)。
- **Compatibility グラフ内 repo の Tag Release**: Compatibility (all consumers)
  グラフの直下に、グラフに出ている repo (backend + 既 deploy frontend) の
  `Tag Release: <repo>` ボタンを並べる。グラフを見ながらその場でリリースを発火
  できる (tagless repo は除外)。発火経路は上記 Tag Release と同じ。「最新」
  (tag あり & main と差分なし) の repo はボタンを `disabled` (inactive) にする。

## Traffic (version split) — Compatibility グラフ下 (Refs #137)

Compatibility グラフの直下に「Traffic (version split)」テーブルを出す。各 repo の
worker version を `percentage / tag・version_id / deploy(100%)・upload(0%) 日時` で
並べ、**「どの version が 100% (active) で、次の promote 候補 (0%) は何か」**を
一目で確認できる (緑 = 100% / 灰 = 0% / 黄 = その他)。

- **git release tag**: 各 version が upload された時点の git tag (例 `v0.2.42`) を
  version id の前に太字で出す。100% (deployed) と 0% (uploaded) で **別 tag**に
  なり得る。tag は deploy CI (`v*` push) が「その回 upload した version」分だけ
  報告するため、ci-dashboard は version_id 単位に tag を **merge 蓄積** する
  (過去 version の tag を保持)。報告前の version は tag 無し (id のみ)。
- version id は先頭 12 文字短縮 (full は hover)、日時は UTC `MM-DD HH:mm`。

行は created_on 降順 (新しい順) で並べ、**最新 0% が active(100%) より上**に出る。
0% (no-traffic) version は時間経過でいくらでも増える (= ノイズ) ため、表示を絞る:

- traffic を受けている version (100% / canary 等、`percentage > 0`) は全行表示。
- **active (100%) version より古い** deploy/upload の 0% version は非表示
  (= もう用済みの過去履歴で promote 候補ではない)。
- active より新しい 0% のうち **最新 1 件だけ**行表示 (= 次の flip 候補)。
  残り件数は最新 0% 行の % セルに「(他N件)」で併記する。

並び順は percentage 降順 → 同率は created_on 降順 (新しい version が上)。

加えて Compatibility グラフの **frontend ノード**にも traffic を出す (要望: グラフにも):
- 2 行目: `deploy <deployed tag>`。直近 upload version が別なら `· new <latest tag>` も。
  tag が無い version は short version id で代替。
- 3 行目: `traffic <100% 等の %> · 0%×<件数>`。
- hover (title): 全 version の `% tag version_id` を列挙。

(traffic 報告が無い repo のノードは従来どおり `prod version · vs @<tested image sha>`。)

データソースは frontend CI からの webhook 報告:

### POST /webhooks/release-wave/traffic-report

frontend CI が deploy 時に **`wrangler deployments list`** (version_id → percentage)
と **`wrangler versions list`** (version の created_on) をマージして報告し、
`traffic::<repo>` (COMPAT_KV, schema v2) に upsert する。shared secret
(`RELEASE_WAVE_WEBHOOK_SECRET`) 認証。

deployments list は active deployment (通常 100% の 1 件) しか返さないため、
versions list の全 version に percentage を join (無ければ 0%) + created_on を付ける。
これで **0% (no-traffic / promote 待ち) の version も日時付きで** 報告できる。

```jsonc
// body (created_on / tag は任意)。tag は「今 upload した version」にだけ付く。
{
  "repo": "ippoan/auth-worker",
  "versions": [
    { "version_id": "6403c1dc-...", "percentage": 100, "created_on": "2026-05-28T11:37:33Z" },
    { "version_id": "ac6841e4-...", "percentage": 0,   "created_on": "2026-05-29T07:02:27Z", "tag": "v0.2.43" }
  ]
}
```

報告が無い repo は traffic 行が出ないだけ (graceful)。schema v1 (created_on 無し)
record も後方互換で読める (日時は `—` 表示)。報告を流すには各 frontend の CI
(ci-workflows の frontend-ci) に traffic-report step が必要。

repo 一覧の出所は `/releases` と同じ 3 ソース (Hub status / direct-push
allowlist / `TAGLESS_REPOS`)。tag / compare / repo-meta の GitHub 呼び出しは
release-cache の KV キャッシュ層を共用する。
