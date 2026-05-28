# Release Wave compatibility — KV write shape 仕様

設計の親 issue:
[ippoan/ci-dashboard#157](https://github.com/ippoan/ci-dashboard/issues/157)
(Release Wave compatibility gate + auto-retest)

本ドキュメント自体の起票:
[ippoan/ci-dashboard#158](https://github.com/ippoan/ci-dashboard/issues/158)

## 目的

Release Wave で「wave に含まれない既 deploy frontend」と「wave で flip される backend」の
互換性を ci-dashboard で機械的に突合できるよう、frontend CI と backend deploy が書く
KV エントリの shape を **契約として固定** する。これにより:

- frontend / backend 側は決まった shape で write すれば後段の読み手 (ci-dashboard
  `GET /compatibility` endpoint, admin UI matrix, `release_wave_status`) に伝わる
- 後から read 側を増やしても shape が drift しない
- 後から新 frontend / 新 backend を追加する時の手順が docs 1 本で済む

本ドキュメントは **shape の SoT (Source of Truth)**。実装変更は本ドキュメントの更新を
伴う PR で行う。

## namespace と write 経路

`ci-dashboard` worker の既存 KV binding (`COMPAT_KV`、wrangler.jsonc で binding 追加予定)
を流用する。**frontend CI / backend deploy が直接 Cloudflare API を叩くのではなく**、
ci-dashboard worker に shared-secret 認証付きの HTTP endpoint を生やし、そこに POST する。

```
frontend CI (GitHub Actions)
  POST /webhooks/release-wave/frontend-test-report
       X-Release-Wave-Webhook-Secret: ...
            ↓
backend deploy (release-wave-gcp / wrangler deploy step)
  POST /webhooks/release-wave/backend-deploy-report
       X-Release-Wave-Webhook-Secret: ...
            ↓
ci-dashboard worker → COMPAT_KV.put(...)
```

採用理由:

- Cloudflare API credential を 20+ frontend repo に配布せずに済む
  (shared secret 1 つで済む。secret rotation は既存 `secrets-rotate-pipe` skill 経由)
- write log が ci-dashboard worker の Cloudflare logs に残るので audit 可能
- ci-dashboard 側で shape validation (zod 等) を 1 箇所に集約できる
- 既存 `/webhooks/release-wave/{stage,flip,contract}-report` と同じ認証 / 同じ
  `X-Release-Wave-Webhook-Secret` header を使い回せる

## key 命名

| key prefix | 例 | 書き手 |
|---|---|---|
| `frontend::<owner>/<name>` | `frontend::ippoan/auth-worker` | frontend CI green path |
| `backend::<owner>/<name>`  | `backend::ippoan/rust-alc-api` | backend deploy 完了時 |

`<owner>/<name>` は GitHub `owner/name` 表記をそのまま使う (= `github.repository`
context value)。lower-case / hyphen は GitHub 側の正規化に従う。

## value JSON shape

### `frontend::<owner>/<name>`

```jsonc
{
  "schema_version": 1,
  "repo": "ippoan/auth-worker",

  // 現在 production に出ている frontend version
  "prod_version": "v0.5.32",
  "prod_deployed_at": "2026-05-27T01:23:45Z",

  // この frontend が integration test で「相手にしたことがある」backend image の集合。
  // sliding window: 直近 50 件 or 90 日のうち新しい方 (writer 側で trim 必須、
  // reader 側はそのまま信用する)
  "tested_against": [
    {
      "backend_repo": "ippoan/rust-alc-api",
      "backend_image": "rust-alc-api-00042-abc",
      "tested_at": "2026-05-27T02:00:00Z",
      "ci_run_url": "https://github.com/ippoan/auth-worker/actions/runs/12345"
    },
    {
      "backend_repo": "ippoan/cc-relay",
      "backend_image": "cc-relay-v2-1234abcd",
      "tested_at": "2026-05-25T10:00:00Z",
      "ci_run_url": "https://github.com/ippoan/auth-worker/actions/runs/12000"
    }
  ]
}
```

- `tested_against` は **append-with-window**。書き手は新エントリを push → 同
  `(backend_repo, backend_image)` の旧 entry を除去 → 50 件 / 90 日で trim
  (writer 側ヘルパースクリプトを `ci-workflows` に置く想定)
- 複数 backend を相手にする frontend は同 array に別 `backend_repo` entry が並ぶ
- 一度書いた entry を rewriter で改変しない (audit 性のため)

### `backend::<owner>/<name>`

```jsonc
{
  "schema_version": 1,
  "repo": "ippoan/rust-alc-api",

  // 現在 production traffic を受けている backend image identifier
  "current_image": "rust-alc-api-00042-abc",
  "deployed_at": "2026-05-27T01:00:00Z",

  // 直近 deploy を行った主体 (= wave 経由 / 単独 deploy の区別が後で必要なら
  // ここを見る)
  "deployed_by": "release-wave-gcp",

  // 直近 deploy が wave 経由なら wave_id、単独 deploy なら null
  "wave_id": "wave_2026_05_27_01"
}
```

- 履歴は持たず **最新のみ**。deploy 完了 callback で upsert (= 上書き)
- past history が必要な場面は wave events (= ci-dashboard 内に既にある audit log)
  で代用、KV 側を audit log 化しない
- `current_image` の identifier 形式は platform 別:
  - **Cloud Run**: revision name (`rust-alc-api-00042-abc`)
  - **Cloudflare Workers**: version id (uuid)
  - **GHCR (Docker image)**: `sha256:...` digest を `current_image` に直接書く
- platform 横断のため、reader 側は `current_image` を **不透明文字列** として
  完全一致比較のみ行う。意味付けは write 側に任せる

## write trigger

### frontend CI green path

frontend repo の `.github/workflows/test.yml` (= ci-init で生成される雛形) の green
ジョブ末尾に「report-compatibility」step を追加する。

```yaml
report-compatibility:
  needs: [integration-test]
  if: needs.integration-test.result == 'success'
  runs-on: ubuntu-latest
  steps:
    - uses: ippoan/ci-workflows/.github/actions/report-frontend-compat@main
      with:
        backend_repo: ippoan/rust-alc-api
        # workflow_dispatch input 経由で渡された image (Phase B の retest 経路)、
        # default = 現 staging の backend image を ci-dashboard 経由で GET
        backend_image: ${{ inputs.backend_image || '' }}
        prod_version: ${{ github.ref_name }}
        webhook_secret: ${{ secrets.RELEASE_WAVE_WEBHOOK_SECRET }}
```

- integration test が `success` でない時は **no-op** (skip / fail / cancelled の
  どれでも書かない)
- `backend_image` 未指定時は ci-dashboard `GET /backend-current-image?repo=...`
  で staging 現 image を取りに行く (action 内部実装)
- POST body は後述の "endpoint contract" の `frontend-test-report` 参照

### backend deploy success path

backend の deploy 経路は 2 系統あるので、両方に書く:

1. **wave 経由の deploy** (= release-wave-gcp Cloud Run proxy 経由)
   - `/cloudrun/flip-traffic` が成功した直後に release-wave-gcp 側で
     `POST /webhooks/release-wave/backend-deploy-report` を打つ
   - `deployed_by = "release-wave-gcp"`, `wave_id` 入り
2. **wave を経由しない単独 deploy** (= hotfix、手動 `wrangler deploy`、CD 直接 push)
   - 各 backend repo の deploy workflow (`deploy.yml` 等) 末尾に同 endpoint を
     呼ぶ step を追加
   - `deployed_by = "<workflow_name>"`, `wave_id = null`

両経路から書かれるので、reader 側は「wave 経由か単独かに関わらず `current_image`
が最新」とみなせる。

## read path

| 読み手 | 経路 | 何を読むか |
|---|---|---|
| ci-dashboard `GET /compatibility?backend_repo=X&backend_target_image=Y` | direct KV read | 全 `frontend::*` を scan して `tested_against` 内に `(X, Y)` を含む frontend を緑判定、ない frontend を赤判定 |
| `release_wave_status` MCP tool / DO method | direct KV read | wave 内 backend repo について同上 |
| Admin UI `/release-wave/:wave_id` の matrix | 上の 2 経路の結果を SSR | per-frontend に prod_version と最終 tested_at を表示 |

### 緑 / 赤 判定ルール

ある backend repo `B` を image `T` に flip しようとする wave において、frontend `F` が

- **緑**: `frontend::F` の `tested_against` 中に `backend_repo == B && backend_image == T`
  の entry が **1 つ以上ある**
- **赤**: 上記 entry が無い (entry 自体が無い frontend は赤)

「最後に tested された image が古い」「最近 prod 更新されたが test 走っていない」など
細かいケースは Phase A では **赤一律** にして、Phase B (auto-retest) で緑化させる
self-service フローに任せる (= 過剰な細粒化を避ける)。

## endpoint contract

### `POST /webhooks/release-wave/frontend-test-report`

frontend CI が integration test green 時に打つ。

```json
{
  "repo": "ippoan/auth-worker",
  "prod_version": "v0.5.32",
  "tested": {
    "backend_repo": "ippoan/rust-alc-api",
    "backend_image": "rust-alc-api-00042-abc",
    "ci_run_url": "https://github.com/ippoan/auth-worker/actions/runs/12345"
  }
}
```

- ci-dashboard 側で `frontend::<repo>` を read-modify-write、`tested_against` に
  append + window trim、`prod_version` / `prod_deployed_at` を update
- 同時 write の race は当面 last-write-wins で許容 (90 日 window のうち数件被るのは
  運用上問題なし)

### `POST /webhooks/release-wave/backend-deploy-report`

release-wave-gcp / 各 backend deploy workflow が deploy 成功時に打つ。

```json
{
  "repo": "ippoan/rust-alc-api",
  "current_image": "rust-alc-api-00042-abc",
  "deployed_by": "release-wave-gcp",
  "wave_id": "wave_2026_05_27_01"
}
```

- ci-dashboard 側で `backend::<repo>` を upsert
- `wave_id` は wave 経由でなければ omit (server 側で `null` 格納)

### `GET /backend-current-image?repo=ippoan/rust-alc-api`

frontend CI の `report-frontend-compat` action が staging 現 image を取りに行く用
(認証なし、read-only)。

```json
{ "repo": "ippoan/rust-alc-api", "current_image": "rust-alc-api-00042-abc" }
```

- `backend::<repo>` を read してそのまま返す
- 404 時は frontend CI 側で「report skip」扱い (= test green でも KV write しない、
  Phase A の "影響無し" 原則に従う)

## versioning

- `schema_version: 1` を最初から入れる
- 破壊的変更時 (例: `tested_against` の構造を変える) は `schema_version: 2` に上げ、
  reader 側は `schema_version != 1` を warning として扱い当該 entry を無視する
- minor な field 追加 (= optional な field を増やすだけ) は version を上げない
- reader 側で unknown field を読み飛ばす (forward compat)

## TTL / retention

| key | TTL | 理由 |
|---|---|---|
| `frontend::<repo>` | 90 日 (KV expirationTtl) | frontend が 90 日 deploy も test も走っていなければ `tested_against` は古い → 自然減衰 |
| `backend::<repo>`  | なし (upsert)            | 最新のみで運用、deploy 都度上書き |

`frontend::<repo>` は write の度に TTL がリセットされる (= putable で
`expirationTtl: 90 * 24 * 3600` を毎回指定する)。

## Phase B: auto-retest (red → green の self-service)

赤 (= 現 backend image を未 test の frontend) を admin UI / API から再 test に
かけて緑化する経路。

### `POST /api/release-wave/:wave_id/retest` (admin / CF Access gated)

admin UI の "Re-test all reds" / per-frontend "Re-test" ボタンが叩く。
ci-dashboard が wave の compatibility matrix を算出し、赤 frontend に対し
`release-wave-retest` の `repository_dispatch` を fan-out する。

- form field `frontend` (optional): 指定時はその "owner/name" 1 件だけ。無ければ全 red。
- dispatch は best-effort (1 件失敗で他を止めない)。完了後は wave 詳細に 303 redirect。

### `repository_dispatch` (event_type: `release-wave-retest`)

ci-dashboard → frontend repo に送る client_payload:

```json
{
  "wave_id": "wave_2026_05_27_01",
  "backend_repo": "ippoan/rust-alc-api",
  "backend_image": "rust-alc-api-00042-abc",
  "prod_version": "v0.5.32"
}
```

frontend 側 (consumer 契約、別 repo / ci-workflows reusable で実装):

1. `test.yml` に `on: repository_dispatch: types: [release-wave-retest]` を追加
2. `${{ github.event.client_payload.backend_image }}` 相手に integration test を回す
   (= Phase A で計画した `workflow_dispatch.inputs.backend_image` と同経路)
3. green なら **既存の `frontend-test-report` webhook** を打つ
   (`tested.backend_image` に渡された image を入れる)

### retest-report は新設しない (設計判断)

Phase A で `frontend-test-report` が KV write を server 側で担うため、retest 完了
通知も同 endpoint を再利用する。matrix は admin UI / `release_wave_status` が KV を
都度 read して算出するので、KV 更新後の次回表示で**自動 refresh** される
(= 専用 `retest-report` endpoint や matrix push は不要)。

## Phase C: gate 化 (opt-in / 安全 default)

`approve` を compatibility gate にする。opt-in (= default off) なので既存運用は不変。

### `require_compatibility` フラグ

`release-wave-targets.yaml` の registry はまだ無いため、Phase C では **wave 開始時の
per-repo フラグ**として持たせる (`release_wave_start` の `repos[].require_compatibility`、
default false)。backend repo に対して立てる。

```jsonc
// release_wave_start の repos entry
{ "repo": "ippoan/rust-alc-api", "target_tag": "v1.43.0", "head_sha": "...",
  "require_compatibility": true }
```

### approve gate

`release_wave_approve` (MCP) / admin UI の Approve ボタンは、`require_compatibility=true`
な backend に**未 test frontend (= matrix の赤) が 1 つ以上**ある場合に
`COMPATIBILITY_GATE` で reject される。

- `force=true` (MCP) / admin UI の override ボタン (gate blocked 時のみ `force` 付き) で
  人手 override 可。
- gate は **赤がある時だけ** 発火する。consumer が 1 つも居ない backend
  (matrix 空) は「検証対象なし」として通す (= 内部 API backend を誤って block しない)。
- COMPAT_KV 未 bind / 算出失敗時は best-effort で gate を素通り (= approve を妨げない)。

### frontend 単独 wave の gate (未実装 / 保留)

issue #157 Phase C の「frontend 単独 wave も現 production backend image との整合を
gate する」は、frontend → backend の依存マップ (consumed_by) が未整備のため**保留**。
現状は tested_against の履歴から consumer を逆算しているが、frontend 単独 wave では
「どの backend の現 image と照合すべきか」を一意に決められない。consumed_by を
`release-wave-targets.yaml` registry として導入する際に対応する。

## 後続実装 issue

本ドキュメントが approve された後、以下を別 issue / PR として進める:

- [ ] ci-dashboard worker: `COMPAT_KV` binding 追加 + 4 endpoint 実装
  (= #157 Phase A の主部)
- [ ] ci-workflows: `report-frontend-compat` composite action 実装
- [ ] release-wave-gcp: flip-traffic 成功時の `backend-deploy-report` 呼び出し
- [ ] 各 frontend repo の `test.yml` に `report-compatibility` job 追加
- [ ] 各 backend repo の deploy workflow に `backend-deploy-report` 呼び出し追加
- [ ] 各 frontend repo の `test.yml` に `repository_dispatch: [release-wave-retest]`
  トリガー + `backend_image` 相手の integration test 経路追加 (Phase B consumer)

## 関連

- 親 issue: [#157](https://github.com/ippoan/ci-dashboard/issues/157)
- 本 issue: [#158](https://github.com/ippoan/ci-dashboard/issues/158)
- Release Wave 運用ガイド: [`docs/release-wave.md`](release-wave.md)
- 設計の親: [#137](https://github.com/ippoan/ci-dashboard/issues/137)
