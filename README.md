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
│       ├── pulls.ts     # PR 読取 + マージ
│       ├── releases.ts  # タグ・リリース
│       └── repository.ts # ファイルツリー・コード検索
└── github-api.ts        # 共通 HTTP ラッパー (validateOrg / githubApi / githubApiRaw)
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
| `get_file_tree` | repository | read | Get the file tree of a repository. |
| `get_file_content` | repository | read | Get file content with optional line range. |
| `search_code` | repository | read | grep-like code search. |
| `search_symbols` | repository | read | LSP-like symbol definition finder. |

`type=write` のツールは MCP 上で `destructiveHint: true` が付与される。

## 認可

- 操作対象は `ALLOWED_ORGS = ["ippoan", "ohishi-exp"]` 配下のリポジトリのみ (`src/github-api.ts`)
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

## デプロイ

```bash
npm run deploy       # wrangler deploy
```

GitHub PAT は wrangler secret に登録:

```bash
wrangler secret put GITHUB_TOKEN
```

`repo` / `workflow` スコープが必要 (issue 書込・PR マージ・workflow dispatch のため)。

## ツール追加手順

1. `src/mcp/tools/<category>.ts` の `registerXxxTools` 関数内に `server.registerTool(...)` を追加
2. `parseRepo(repo)` → `validateOrg(owner)` を冒頭で呼ぶ
3. `githubApi<T>(token, method, path, body?, params?)` で GitHub REST を叩く
4. 戻り値は `{ content: [{ type: "text" as const, text: JSON.stringify(...) }] }` 形式
5. `test/mcp/tools.test.ts` に成功 / エラーパスのテストを追加
6. **この README のツール一覧表にも追記する**
