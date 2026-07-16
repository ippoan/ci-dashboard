---
name: ci-dashboard-map
generated-from: ci-dashboard:86459f44fee4650b0321b4d95062157ff20ae8ec
paths: [src/]
description: ippoan/ci-dashboard (Cloudflare Workers + Hono、CI 状況 SSR ダッシュボード + GitHub MCP server + Release Wave 機構) の構造ナビゲーション。webhook 取込 (CI_HUB DO) / cross-org issue・projects SSR / Release Wave (canary flip / compatibility 突合 / ReleaseWaveHub DO) / MCP tool 群の配置と gotcha を 1 枚にまとめる。トリガー:「ci-dashboard」「Release Wave」「release wave」「compatibility 突合」「CIDashboardHub」「ReleaseWaveHub」「tag-release」「close 確認」「GitHub MCP」「webhooks/release-wave」「ci-dashboard.ippoan.org」等。
---

# ci-dashboard-map — ippoan/ci-dashboard 構造ナビゲーション

Cloudflare Workers (Hono) ベース。3 役を 1 worker に同居: **(1) CI 状況 SSR
ダッシュボード + WebSocket live 更新、(2) GitHub MCP server (`/mcp`)、(3) Release
Wave (canary release オーケストレータ)**。`src/index.ts` が全 route を登録、
ロジックは `src/*.ts` / `src/release-wave/` / `src/mcp/` に分散。

> 細部 (関数シグネチャ・正確な行) は repo 側が正。ここは「どこを見るか」の索引。
> frontmatter の `generated-from` が現在の tree-sha とズレたら
> session-start-skill-coverage hook が再生成を促す → その時 tree-sha を更新する。

## 区画

| module | 主要ファイル | 役割 |
|---|---|---|
| **entry** | `src/index.ts` | Hono 全 route + `Env` 型 + 2 DO export |
| **CI hub** | `src/hub.ts` (`CIDashboardHub` DO) | webhook で受けた run status を SQLite 保持 + WS broadcast。`/status` `/snapshot` proxy 先 |
| **webhook 取込** | `src/webhook.ts` | GitHub webhook 検証 (X-Hub-Signature-256) → hub 反映 |
| **SSR ページ** | `src/dashboard.ts` `issues-page.ts` `projects-page.ts` `releases-page.ts` `secret-gen-page.ts` `nav-tabs.ts` `pwa.ts` | 各タブの HTML 生成 |
| **release / close** | `src/release-close*.ts` `release-helpers.ts` `release-cache.ts` `release-alert.ts` `tag-release.ts` `tagless-repos.ts` | tag から `Refs #N` 逆引き → 目視 close UI |
| **キャッシュ** | `src/issue-cache.ts` `project-cache.ts` `issue-prs.ts` `recheck.ts` | KV (CI_STATUS) cache |
| **GitHub API** | `src/github-api.ts` | `AUTH_WORKER_ORIGIN` + `getGitHubToken` (auth-worker delegation) |
| **MCP server** | `src/mcp/server.ts` + `src/mcp/tools/*` | `/mcp` (stateless Streamable HTTP)。下表参照 |
| **Release Wave** | `src/release-wave/*` (`do.ts` = `ReleaseWaveHub`) | canary flip / compatibility 突合 / webhook / page / api。下記参照 |

### MCP tools (`src/mcp/tools/*`, 計 ~48 tool)

| file | tools (件数) |
|---|---|
| `actions.ts` (6) / `pulls.ts` (3) / `releases.ts` (3) | workflow run / PR / release 操作 |
| `issues.ts` (11) / `projects.ts` (8) | cross-org issue / Projects v2 (`list_org_issues` 等。check-issue skill が consume) |
| `logs.ts` (2) / `commits.ts` (2) / `repository.ts` (3) | job log / commit / repo |
| `release-wave.ts` (10) | 現行: `release_wave_pending_state/pending_flip/pending_flip_all` (pending release flip、wave state machine 非経由)。legacy: `release_wave_status/approve/flip/rollback/abort/fail/contract_applied` (`release_wave_start`/`_stage` は stage phase 撤去で削除済み、Refs ippoan/ci-workflows#96①。新規 wave 開始経路が無い、詳細は `docs/release-wave.md`) |

### Release Wave (`src/release-wave/`)

| ファイル | 役割 |
|---|---|
| `do.ts` (`ReleaseWaveHub`) `state.ts` `types.ts` `revision.ts` | legacy wave 状態機械 (SQLite DO)。`start()` を呼ぶ production caller が無く新規 wave を開始する経路は現状ない。auto-flip armed record の SoT (強整合 storage、#490) もここ |
| `webhook.ts` | GitHub Actions step が叩く shared-secret webhook (pending-release / flip-report / contract-applied / *-report / traffic-report)。`stage-report` は撤去済み |
| `compat.ts` `compat-api.ts` | frontend ↔ backend image の compatibility 突合 (COMPAT_KV) |
| `auto-flip.ts` | Tag Release all + Auto Flip (armed 機構、#476/#481/#485/#490)。arm は ReleaseWaveHub DO 置き (KV の ~60s edge cache 窓を回避)、timeout は record の `expires_at` 判定、完了検知は pending-release webhook + queue recheck ループ、flip 対象版は queue message の権威版 |
| `api.ts` `page.ts` `dispatch.ts` `traffic.ts` `pending-release.ts` `tag-release-action.ts` `repo-*.ts` | admin UI action / dispatch / traffic split |

## entrypoint (`src/index.ts` の route)

- **SSR**: `GET /` `/issues` `/projects` `/releases` `/secret-gen` `/release-wave` `/release-wave/:wave_id`
- **live**: `GET /ws` `/status` `/snapshot` `/release-alerts` (すべて `CIDashboardHub` proxy)
- **webhook**: `POST /webhook` `/webhooks` (GitHub)、`/webhooks/release-wave/*` (Actions step, shared secret)
- **action POST**: `/api/release-close[-batch]` `/api/tag-release` `/api/recheck` `/api/dismiss` `/api/release-wave/:wave_id/{approve,rollback,abort,retest}` 他
- **OAuth**: `GET /oauth/login` `/oauth/callback` (`@ippoan/auth-client-worker` delegation, Refs #118)
- **MCP**: `ALL /mcp` (stateless)
- **launch**: `GET /cc` (`launch.ts`、`?i=<owner/repo#N>` から CCoW セッション launch URL にリダイレクト, #214)
- **PWA**: `/manifest.webmanifest` `/sw.js` `/icons/:file`
- **export**: `CIDashboardHub` (`hub.ts`) / `ReleaseWaveHub` (`release-wave/do.ts`)

## gotcha (CLAUDE.md / wrangler 由来)

- **DO 2 個**: `CIDashboardHub` (CI status hub) / `ReleaseWaveHub` (wave 状態)。migration tag v1/v2。
- **KV エイリアス罠**: `CI_STATUS` と `COMPAT_KV` は **同一 namespace id** (`ffb98...`)。key prefix (`frontend::` / `backend::`) で衝突回避 (Refs #157/#158)。
- **`/webhooks` (複数形) は CF Access bypass prefix**。単数 `/webhook` は Access 配下で GitHub 配信が 302 になり到達不能 → 両方 route 登録。handleWebhook は署名自前検証。
- **GitHub token は auth-worker delegation** (`/oauth/login` browser flow → KV に JWT+refresh 保存)。operator が rotate する secret は無い (#118)。`INTERNAL_SHARED_SECRET` binding は `/mcp/introspect` 用 (secret_name は `JWT_FOR_CI_DASHBOARD`)。
- **Release Wave webhook は MCP と機能等価**だが OAuth 不要の shared secret (`RELEASE_WAVE_WEBHOOK_SECRET`) で Actions から curl 1 行で叩ける。
- **prod/staging dual-env**: top-level + `[env.staging]`。staging が custom domain `ci-dashboard.ippoan.org` を持つ (= staging を実運用扱い)。`TAGLESS_REPOS` var で「tag を切らない repo は PR merge を release 扱い」。
- **close キーワード規約**: PR は `Refs #N` のみ (`Closes/Fixes/Resolves` 禁止)。release tag 後にこの dashboard の close 確認 UI / `close_issue` MCP tool で目視 close。

## トラブルシューティング Q&A (運用で踏んだやつ — Refs ci-dashboard#217)

**Q: `/issues` に特定 repo の open issue が出ない (section ごと消える)**
`/issues` は GitHub 直読みでなく KV cache (`issue:*`) を `issue-cache.ts` の
`reconcileIssues` が埋める。現在は **full open snapshot 方式** (毎回 `state:open`
全取得 → GitHub の open 集合に無い KV entry を evict + 現 open を全 upsert)。
旧 warm-delta 方式 (`state:all + updated:>=watermark`) は per_page:100 truncation
や KV write 欠落で一度漏れた open issue を再 update まで復活できず、更新の止まった
repo の section が丸ごと消えた (#218 で full snapshot に修正)。MCP の
`list_org_issues` は GitHub 直叩きなので出る・`/issues` だけ欠ける、が切り分けの目印。

**Q: `/releases` に repo が出ない (一部 repo しか出ない)**
watched = hub(CI run) + direct-push allowlist + **`TAGLESS_REPOS`** の和で、release
候補 (未 close の `Refs #N` を持つ merged PR、または semver tag) がある repo だけ
出す。**tag を切らない repo は `TAGLESS_REPOS` に登録しないと `useSynthetic=false`
で synthetic block を作らず、tag も無いので何も出ない** (`releases-page.ts`
`loadRepoView`)。`TAGLESS_REPOS` は `wrangler.jsonc` の **`env.staging.vars`** 側
(top-level でなく staging が実運用 env)。skill / reusable workflow / hooks 等
tag-less な repo はここに追加する (#217: claude-skills/ci-workflows/ref-files-worker
/claude-hooks を追加)。

**Q: `TAGLESS_REPOS` に repo を追加 + deploy したのに `/releases` に card が出ない**
`/releases` は **事前計算した index blob** (`CIDashboardHub` DO storage、KV v4 backup)
を SWR 配信する。watched set / pr-map は live でも、blob を**再計算するまで新 repo は
出ない**。罠は **full refresh が 1 時間の fresh-window で bail** すること
(`refreshReleasesIndexInner`: `now - storedAt < RELEASES_INDEX_FRESH_SECONDS(3600)`
なら `"fresh"` で即 return)。30+ repo の CI webhook で blob は頻繁に更新され
storedAt がほぼ常に 1h 以内 → **footer の「🔄 force refresh」(parameter 無し =
`/admin/force-refresh-releases`、queue に full refresh を enqueue) を押しても
fresh で no-op**。
**回避**: `/admin/force-refresh-releases?repo=owner/name` (= `recomputeRepoView`)。
**単一 repo だけを同期再計算して blob に patch** し (`releases-page.ts` 290 行:
blob に無ければ末尾 append)、`storedAt` を触らないので fresh-window を貫通する。
返り JSON で切り分け: `outcome:"patched"` → reload で card 出る /
`"view-null"` → synthetic block が空 (`Refs #N` を持つ merged PR が無い/拾えない)。
> これは webhook 取りこぼしでも pr-map gate (#400) でもない。pr-map は org 全体の
> open+merged PR search で、`/issues` の PR chip と `/releases` gate が同じものを
> 共有する (= `/issues` に merged chip が出るなら pr-map は当該 PR を持つ)。
> 事例: ohishi-exp/nuxt-ichibanboshi-seikyu の追加で踏んだ (#438/#439)。

**Q: ci-dashboard の runtime log を MCP で見たい**
Cloudflare observability MCP `query_worker_observability` (`service=ci-dashboard-staging`)。
events view は `$metadata.message` までで、`console.log(JSON.stringify({msg,...}))` の
custom field (`reconcile.fetched`, `cachedRepos.N` 等) は展開されない →
`observability_keys` で key を確認し `observability_values` で値を引く。MCP 接続は
**session 起動時に固定**されるので、認証/endpoint を更新したら再連携 (新 session か
MCP reconnect) しないと `Cloudflare API request failed` のまま。

## CCoW / CI から見た立ち位置

- **org 横断 issue / CI / release のハブ**。`check-issue` skill が `list_org_issues` を、release 系 skill が release-wave tool を consume。
- frontend/backend の各 CI (`frontend-ci.yml` 等) が `/webhooks/release-wave/*` に報告して compatibility 突合・canary flip を駆動。
- GitHub token / OAuth は **auth-worker** に委譲。

## 関連 skill

- `auth-worker-map` — OAuth delegation 先 (`@ippoan/auth-client-worker`)
- `check-issue` — `list_org_issues` tool の consumer
- `tag-release` / `branch-issue-linking` — release / `Refs #N` 規約
- `ippoan-infra-map` / `cross-repo-symbol-index` — 基盤地図 / 鮮度 hook
