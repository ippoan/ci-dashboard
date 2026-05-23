# ci-dashboard

GitHub CI 監視 + リポジトリ操作のための MCP (Model Context Protocol) サーバー。
Cloudflare Workers にデプロイされ、Claude などの MCP クライアントから GitHub Actions ワークフローや issue / PR を操作できる。

## アーキテクチャ

```
src/
├── mcp/
│   ├── server.ts        # MCP server エントリ。registerXxxTools をまとめて呼ぶ
│   └── tools/           # 機能別ツール定義
│       ├── actions.ts   # GitHub Actions ワークフロー操作
│       ├── commits.ts   # コミット情報
│       ├── issues.ts    # issue 読取 + 書込
│       ├── logs.ts      # ジョブログ取得・検索
│       ├── projects.ts  # GitHub Projects v2 (GraphQL)
│       ├── pulls.ts     # PR 読取 + マージ
│       ├── releases.ts  # タグ・リリース
│       └── repository.ts # ファイルツリー・コード検索
└── github-api.ts        # 共通 HTTP / GraphQL ラッパー (validateOrg / githubApi / githubGraphQL / githubApiRaw)
```

各ツールは `server.registerTool(name, schema, handler)` で登録される。新ツール追加時は対応する `src/mcp/tools/*.ts` の `registerXxxTools` 関数内に追記するだけで `server.ts` の変更は不要。

## 提供ツール一覧

| name | category | type | 説明 |
|------|----------|------|------|
| `list_workflow_runs` | actions | read | List recent workflow runs for a repository. |
| `get_workflow_run` | actions | read | Get details of a specific workflow run. |
| `list_workflow_run_jobs` | actions | read | List jobs for a workflow run. |
| `rerun_workflow_run` | actions | write | Re-run all jobs in a workflow run. |
| `rerun_failed_jobs` | actions | write | Re-run only failed jobs in a workflow run. |
| `cancel_workflow_run` | actions | write | Cancel an in-progress workflow run. |
| `list_commits` | commits | read | List commits for a repository. |
| `get_commit` | commits | read | Get commit details including changed files and diff patches. |
| `list_issues` | issues | read | List issues for a repository. |
| `list_org_issues` | issues | read | List issues across multiple orgs in one call (search-backed, PRs excluded). |
| `get_issue` | issues | read | Get issue details including body and comments. |
| `create_issue` | issues | write | Create a new issue in a repository. |
| `update_issue` | issues | write | Update title/body/labels/assignees/milestone of an existing issue. |
| `add_issue_comment` | issues | write | Add a comment to an existing issue or PR. |
| `add_labels` | issues | write | Add labels to an issue or PR. |
| `remove_label` | issues | write | Remove a single label from an issue or PR. |
| `close_issue` | issues | write | Close an issue with optional `state_reason`. |
| `reopen_issue` | issues | write | Reopen a closed issue. |
| `get_job_logs` | logs | read | Get logs for a workflow job (tail or line range). |
| `grep_job_logs` | logs | read | Search job logs with regex pattern. |
| `list_pull_requests` | pulls | read | List pull requests for a repository. |
| `get_pull_request` | pulls | read | Get PR details including CI check status. |
| `merge_pull_request` | pulls | write | Merge a pull request using squash merge. |
| `list_tags` | releases | read | List tags for a repository. |
| `get_latest_release` | releases | read | Get the latest release for a repository. |
| `create_tag_release` | releases | write | Dispatch `tag-release.yml` workflow. |
| `list_org_projects` | projects | read | List Projects v2 across one or more orgs (number/title/url/closed). |
| `get_project` | projects | read | Get a Project's metadata + field definitions (incl. single-select options / iterations). |
| `list_project_items` | projects | read | List items (issues/PRs/draft) attached to a Project with their field values. |
| `add_issue_to_project` | projects | write | Add an issue/PR to a Project (resolves project number + issue number internally). |
| `remove_project_item` | projects | write | Remove an item from a Project (does not delete the issue). |
| `set_project_item_field` | projects | write | Update a field value on a Project item (single_select/iteration resolved by name). |
| `create_project_field` | projects | write | Create a custom field (text/number/date/single_select). |
| `create_project` | projects | write | Create a new Project under an org; optional `short_description` is applied via a follow-up `updateProjectV2`. |
| `get_file_tree` | repository | read | Get the file tree of a repository. |
| `get_file_content` | repository | read | Get file content with optional line range. |
| `search_code` | repository | read | grep-like code search. |
| `search_symbols` | repository | read | LSP-like symbol definition finder. |

`type=write` のツールは MCP 上で `destructiveHint: true` が付与される。

## 認可

- 操作対象は `ALLOWED_ORGS = ["ippoan", "ohishi-exp", "yhonda-ohishi"]` 配下のリポジトリ / Project のみ (`src/github-api.ts`)
- それ以外の owner を指定すると `GitHubApiError(403, "Org not allowed: ...")` で拒否
- リポジトリ指定は `"owner/name"` または `"name"` (後者は `ippoan/` を補完)

## ローカル開発

```bash
npm install
npm run dev          # wrangler dev でローカル起動
npm test             # vitest 実行
npm run test:coverage
npm run typecheck    # tsc --noEmit
```

## 環境構成

**staging が実運用環境**。本番リリースタグ (`v*`) は将来用に予約してあるが、
当面は staging deploy だけを使う (secrets-inventory と同じ運用)。

| env | name | trigger | route |
|---|---|---|---|
| staging (live) | `ci-dashboard-staging` | PR (non-draft) / main push | `ci-dashboard.ippoan.org` (Custom Domain) + `workers.dev` |
| production | `ci-dashboard` | `v*` tag push | (未割当) |

PR を上げると `frontend-ci.yml` 経由で staging に auto-deploy される。

## デプロイ

```bash
npm run deploy                       # production (top-level, 予約) に手動 deploy
npx wrangler deploy --env staging    # staging に手動 deploy
```

### GitHub 認証 (auth-worker delegation — #116)

PAT / GitHub App PEM は廃止。本 Worker は `auth.ippoan.org` (`ippoan/auth-worker`)
MCP OAuth Provider に delegate し、`POST /mcp/introspect` で `github_token` を
取り出して使う。OAuth Client Secret も PEM も本 Worker 上に一切存在しない。

#### 認証フロー

```
[ci-dashboard worker]
      │ POST https://auth.ippoan.org/mcp/introspect
      │   Authorization: <INTERNAL_SHARED_SECRET>
      │   body: { token: <JWT_FOR_CI_DASHBOARD> }
      ↓
[auth-worker (GitHub OAuth App を保有)]
      │ JWT → github_token を返す
      ↓
[ci-dashboard で KV cache (~55 min) → api.github.com に直叩き]
```

#### 必要な secret (Cloudflare Secrets Store)

| binding | 値 |
|---|---|
| `JWT_FOR_CI_DASHBOARD` | auth-worker `/mcp/device_authorization` 経由で取得した access JWT |
| `INTERNAL_SHARED_SECRET` | auth-worker と共有する固定 secret (cc-relay broker と同じ値) |

どちらも < 1 KB で Secrets Store の上限内。

#### 初回セットアップ

1. **auth-worker 側**: yhonda-ohishi を `GITHUB_MCP_USER_ALLOWLIST` に含めることを確認
2. **device flow で JWT 取得** (operator のローカルで 1 回):
   ```bash
   # 認可開始
   curl -s https://auth.ippoan.org/mcp/device_authorization \
     -d "client_id=ci-dashboard&scope=mcp.write mcp.workflow mcp.project" | jq
   # → verification_uri_complete をブラウザで開いて approve
   # poll
   curl -s https://auth.ippoan.org/mcp/token \
     -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
     -d "device_code=<DEVICE_CODE>" -d "client_id=ci-dashboard" \
     | jq -r .access_token
   ```
3. **Secrets Store に登録** (account-level、複数 worker 共有可):
   ```bash
   STORE_ID="<your-secrets-store-id>"
   echo -n "<JWT>" | npx wrangler secrets-store secret create "$STORE_ID" \
     --name JWT_FOR_CI_DASHBOARD --scopes workers
   echo -n "<INTERNAL_SHARED_SECRET>" | npx wrangler secrets-store secret create "$STORE_ID" \
     --name INTERNAL_SHARED_SECRET --scopes workers
   ```
4. `wrangler.jsonc` の `store_id` 2 箇所を実 ID に差し替えて deploy
5. 旧 secret 削除 (`GITHUB_APP_*` / `GITHUB_TOKEN` が残っていれば):
   ```bash
   npx wrangler secret delete GITHUB_APP_ID --env staging
   npx wrangler secret delete GITHUB_APP_PRIVATE_KEY --env staging
   npx wrangler secret delete GITHUB_APP_INSTALLATIONS --env staging
   ```

#### GitHub App セットアップ (旧、廃止済み)

1. **App 作成** (Settings → Developer settings → GitHub Apps → New GitHub App)
   - Homepage URL: `https://ci-dashboard.ippoan.org`
   - Webhook: off (本 App は API client 用、event は github-webhook-worker で受ける)
   - **Permissions** (Repository + Organization):
     - Repository: Contents R / Issues R-W / Pull requests R-W / Metadata R / Actions R / Checks R
     - Organization: Projects R-W (Projects v2 の read + write)
   - Where can this GitHub App be installed?: Any account
2. **Private key を発行** (App 設定ページ下部 → Generate a private key → `.pem` を download)
3. **App を install** (各 org の Settings → GitHub Apps → Install):
   - `ippoan`, `ohishi-exp`, `yhonda-ohishi` の 3 org
   - Repository access: All repositories (or対象を絞る場合は明示)
   - install 後の URL `https://github.com/organizations/<org>/settings/installations/<id>` の `<id>` が installation ID
4. **wrangler secret を登録** (staging / production それぞれ):
   ```bash
   # App ID は App 設定ページ最上部に表示
   echo -n "123456" | npx wrangler secret put GITHUB_APP_ID --env staging

   # Private key (multiline PEM をそのまま貼る)
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging
   # プロンプトで .pem の中身全体 (BEGIN/END 行含む) を貼って Ctrl+D

   # 3 org の installation ID を JSON で 1 secret に
   echo -n '{"ippoan": 11111111, "ohishi-exp": 22222222, "yhonda-ohishi": 33333333}' \
     | npx wrangler secret put GITHUB_APP_INSTALLATIONS --env staging
   ```
5. installation token は worker 内で JWT 経由で交換し、KV (`gh-app:token:<installation_id>`) に
   ~55 min キャッシュされる。手動 rotation 不要。

#### 移行作業の最終ステップ

旧 PAT secret は #112 で全 code path から外したので、デプロイ後に各 worker
(`ci-dashboard-staging` / `ci-dashboard`) から `GITHUB_TOKEN` secret を
削除すること:

```bash
npx wrangler secret delete GITHUB_TOKEN --env staging
npx wrangler secret delete GITHUB_TOKEN
```

## 開発ルール

- branch / worktree 命名: [`CLAUDE.md`](CLAUDE.md)
- PR description / commit message のキーワード規約と release 時の close
  フロー: [`docs/branch-issue-linking.md`](docs/branch-issue-linking.md)
- PR テンプレート: [`.github/pull_request_template.md`](.github/pull_request_template.md)

## ツール追加手順

1. `src/mcp/tools/<category>.ts` の `registerXxxTools` 関数内に `server.registerTool(...)` を追加
2. `parseRepo(repo)` → `validateOrg(owner)` を冒頭で呼ぶ
3. `githubApi<T>(token, method, path, body?, params?)` で GitHub REST を叩く
4. 戻り値は `{ content: [{ type: "text" as const, text: JSON.stringify(...) }] }` 形式
5. `test/mcp/tools.test.ts` に成功 / エラーパスのテストを追加
6. **この README のツール一覧表にも追記する**
