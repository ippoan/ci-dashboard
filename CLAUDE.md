# CLAUDE.md

Claude Code 向けの本リポジトリ作業ルール。

## Worktree / branch 命名規則

形式: `<issue-number>-<type>-<short-description>`

- `issue-number`: 必須。先に issue を立ててから worktree / branch を作る
- `type`: `feat` | `fix` | `refactor` | `infra`
- `short-description`: 半角小文字英数字とハイフン

例:

- `123-fix-onedrive-token`
- `145-feat-line-works-webhook`
- `156-refactor-pdf-generator`

issue 番号を持たない branch (Claude Code が自動採番する `claude/...` 等)
で実装に入る前に、対応する issue を作成し、上記の形式で rename / 再切り出し
すること。

## PR description / commit message のキーワード

- 使用禁止: `Closes #N` / `Fixes #N` / `Resolves #N`
  - PR auto-merge が走った瞬間に issue が自動 close されるため、release 時の
    close 確認 UI と整合しない
- 使用推奨: `Refs #N` / `Related to #N` / `Part of #N`
  - GitHub の Development セクションには紐付くが auto-close されない
  - release tag 後に [ci-dashboard の close 確認 UI 構想] で目視 close する

PR テンプレートは `.github/pull_request_template.md` で `Refs` を強制する。

## release / close フロー

1. PR は `Refs #N` のみで merge する (auto-close させない)
2. release tag は workflow_dispatch (`tag-release.yml`) で発行
3. ci-dashboard 上の release 確認画面で、tag に含まれる commit から
   `Refs #N` を逆引きし、close 候補として一覧表示
4. 目視確認後、ci-dashboard MCP server (`close_issue` tool) で close する

## 関連

- 規約: yhonda-ohishi/claude-skills の対応 issue (本 PR 後に作成)
- 実装: yhonda-ohishi/claude-hooks の PreToolUse hook (本 PR 後に作成)
- 詳細: [`docs/branch-issue-linking.md`](docs/branch-issue-linking.md)
