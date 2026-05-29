# Release Wave 機構 — 運用ガイド

設計の親 issue: [ippoan/ci-dashboard#137](https://github.com/ippoan/ci-dashboard/issues/137)

ci-dashboard 内に実装した Release Wave 機構の **operator 向け運用ガイド**。
コード設計は issue #137 の本文を参照。本ドキュメントは Phase 3a〜3e 完了後の
日常運用 + ワンタイム setup (CF Access wildcard 等) をカバーする。

frontend ↔ backend image 互換性突合 (#157) の KV write shape 仕様は
[`docs/release-wave-compatibility-kv.md`](release-wave-compatibility-kv.md) を参照。

---

## アーキテクチャ全体図

```
operator (Cloudflare Access edge gate)
    │
    ├─ Admin UI: GET /release-wave, /release-wave/:wave_id
    │   └─ Action buttons: POST /api/release-wave/:wave_id/{approve|rollback|abort}
    │
    └─ MCP tools (Claude Code, OAuth via auth-worker):
        release_wave_start / _stage / _status / _approve / _flip /
        _rollback / _abort / _contract_applied

GitHub Actions step (= release-wave-handler reusable):
    │
    └─ HTTP webhook (shared secret):
        POST /webhooks/release-wave/contract-applied

           ↓ (どちらの経路も)

      ReleaseWaveHub DO (1 singleton)
      ├─ storage: wave:{wave_id} JSON records
      └─ pure state machine (state.ts) で transition

           ↓ (state=flipping / rollback 時)

      release-wave-gcp (Cloud Run proxy):
        /cloudrun/flip-traffic
        /cloudrun/rollback
        /cloudrun/stage-check
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

## MCP tool 経由の運用 (Claude Code / 他 MCP client)

`https://ci-dashboard.ippoan.org/mcp` に OAuth (auth-worker delegation) で
ログインすると以下 8 tool が叩ける:

| tool | 用途 |
|---|---|
| `release_wave_start` | 新規 wave 開始 |
| `release_wave_stage` | repo handler からの stage 完了 callback |
| `release_wave_status` | 現状取得 (read-only) |
| `release_wave_approve` | admin 承認 (pending-approval → flipping) |
| `release_wave_flip` | repo handler からの flip 完了 callback |
| `release_wave_rollback` | 旧 revision 戻し (`--force` で unsafe override) |
| `release_wave_abort` | flip 前の中止 |
| `release_wave_contract_applied` | GitHub Actions step からの contract 通知 |

Admin UI ボタンと MCP tool は同じ DO RPC を呼ぶので **どちらから操作しても
同じ結果**。Admin UI は人間 operator 用 (= 視覚的なステート確認 + ワンクリック
action)、MCP tool は自動化 / IDE 統合用。

---

## GitHub Actions step 経由の運用 (release-wave-handler reusable + 3 webhook)

GitHub Actions が release-wave 機構と連携する経路は以下 3 endpoint の shared
secret 認証 HTTP webhook で統一されている (= MCP OAuth を Actions で動かさ
ない設計)。すべて `X-Release-Wave-Webhook-Secret` header + JSON body。

| endpoint | 用途 | DO method |
|---|---|---|
| `POST /webhooks/release-wave/stage-report` | release-wave-handler の stage 完了 callback | `stageReport` |
| `POST /webhooks/release-wave/flip-report`  | flip 完了 callback                          | `flipReport` |
| `POST /webhooks/release-wave/contract-applied` | contract migration deploy 後の通知       | `contractApplied` |
| `POST /webhooks/release-wave/frontend-test-report` | frontend CI green 時の compatibility 記録 (KV write) | — (COMPAT_KV) |
| `POST /webhooks/release-wave/backend-deploy-report` | backend deploy 成功時の compatibility 記録 (KV write) | — (COMPAT_KV) |

compatibility 系 2 endpoint の body / KV shape は
[`docs/release-wave-compatibility-kv.md`](release-wave-compatibility-kv.md) を参照。
突合結果の read は CF Access edge gate 配下の read-only endpoint
`GET /compatibility?backend_repo=&backend_target_image=` /
`GET /backend-current-image?repo=` で取得する。

### stage-report body

```json
{
  "wave_id": "wave_2026_05_27_01",
  "repo": "ippoan/rust-alc-api",
  "ok": true,
  "preview_url": "https://preview-rust-alc-api.ippoan.org",
  "flip_from_revision": "rust-alc-api-00041-zzz"
}
```

`ok=false` 時は `error` フィールドで失敗詳細を渡し、`preview_url` /
`flip_from_revision` は省略可。

### flip-report body

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

### 通常の wave (= 失敗なし)

1. operator が `release_wave_start` MCP tool で wave 開始 (`flip_policy:
   "manual-approval"` 推奨)
2. 各 repo の release-wave-handler が tag を打ち、stage deploy を実行 →
   `release_wave_stage` で callback (preview_url + flip_from_revision)
3. 全 repo staged → wave が `pending-approval` 遷移
4. operator が preview URL を `preview-*.ippoan.org` でブラウザ確認 (CF Access
   経由で Google OAuth)
5. Admin UI で **Approve & Flip** ボタン押下 (or MCP `release_wave_approve`)
6. 各 repo handler が flip 実行 → `release_wave_flip` callback
7. 全 repo flipped → wave が `flipped` 遷移
8. operator が contract migration を別 PR で deploy → migration step が
   `/webhooks/release-wave/contract-applied` に通知 → `rollback.safe` が
   `false` に flip

### 失敗 / rollback

- **flip 前 (staging / pending-approval)**: **Abort** ボタン (or MCP
  `release_wave_abort`) で中止
- **flip 後 (rollback.safe=true)**: **Rollback** ボタン (or MCP
  `release_wave_rollback`) で旧 revision に戻す
- **flip 後 (rollback.safe=false)**: rollback はデフォルト refuse。Admin UI
  には警告と `(force)` ラベル付きボタンが出るので、operator が DB を手動
  復旧する覚悟があれば押す (= force=true を裏で渡す)

### Wave 進行中の serial enforcement

- 1 wave が `staging` / `pending-approval` / `flipping` のうちに 2 つ目の
  wave を `start` しようとすると `WAVE_IN_PROGRESS` で reject される
- 1 wave が `flipped` 以降は新 wave 可 (= hotfix wave をすぐ走らせるパターン)

---

## トラブルシューティング

| 症状 | 原因の可能性 | 対応 |
|---|---|---|
| MCP tool が `WAVE_IN_PROGRESS` を返す | 別 wave が in-progress | `release_wave_status` で確認、必要なら abort/rollback |
| Admin UI で button が disabled | 現 state でその操作が無効 | hover の title 説明を確認、別 button を使う |
| 通知 webhook が 401 | secret 不一致 / 古い rotation 値 | secrets-rotate-pipe で 3 所同期再投入 |
| preview-*.ippoan.org が 403 | CF Access policy 未追加 / email allowlist 外 | 本ドキュメントの "preview-* wildcard" セクション参照 |
| flip 後 rollback が refuse | contract migration 適用済 | Admin UI の警告を確認、必要なら force 押下 (DB 手動復旧前提) |

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
  できる (tagless repo は除外)。発火経路は上記 Tag Release と同じ。

repo 一覧の出所は `/releases` と同じ 3 ソース (Hub status / direct-push
allowlist / `TAGLESS_REPOS`)。tag / compare / repo-meta の GitHub 呼び出しは
release-cache の KV キャッシュ層を共用する。
