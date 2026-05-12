# branch ↔ issue 紐付け規約

worktree / branch と GitHub issue を機械的に紐付け、PR auto-merge による
意図しない issue auto-close を防ぐための運用規則。

## 背景

- 既存の `feat-/fix-/refactor-/infra-` 命名規則には issue 番号がなく、
  branch から対応 issue を機械的に逆引きできない
- `Closes #N` / `Fixes #N` / `Resolves #N` を使うと PR auto-merge で
  issue が自動 close される。release tag 発行は workflow_dispatch で
  非同期に行うため、merge 時 close と release タイミングが噛み合わない
- ci-dashboard 側で release ごとに「この tag に含まれる close 候補」を
  目視確認してから close するフローを実現したい

## 規約

### 1. branch 命名

形式: `<issue-number>-<type>-<short-description>`

- `type`: `feat` | `fix` | `refactor` | `infra`
- `issue-number`: 必須。先に issue を立てる
- 正規表現: `^[0-9]+-(feat|fix|refactor|infra)-[a-z0-9-]+$`

### 2. 連携キーワード

| キーワード                        | 用途                       | auto-close |
| --------------------------------- | -------------------------- | ---------- |
| `Closes` / `Fixes` / `Resolves`   | **禁止**                   | する       |
| `Refs` / `Related to` / `Part of` | 推奨。Development に紐付く | しない     |

### 3. PR テンプレート

`.github/pull_request_template.md` で `Refs #` を雛形に入れて強制する。

### 4. release / close

1. PR merge: `Refs #N` のみで auto-close させない
2. tag 発行: `tag-release.yml` (workflow_dispatch)
3. ci-dashboard の release 確認画面で tag に含まれる commit から
   `Refs #N` を抽出し close 候補として一覧表示
4. 目視確認 → `close_issue` MCP tool で明示 close

## 機械的に守らせる仕組み

### ローカル (Claude Code hook)

`yhonda-ohishi/claude-hooks` の PreToolUse hook が `git worktree add` /
`git checkout -b` / `git switch -c` をフックし、branch 名の正規表現一致と
issue 番号の実在を検証する (詳細は claude-hooks の対応 issue 参照)。

### サーバサイド (GitHub Actions)

ローカル hook はバイパス可能なため、各プロジェクトに以下のような workflow
を併設する:

```yaml
on:
  pull_request:
    types: [opened, edited, synchronize]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: validate branch name
        run: |
          BRANCH="${{ github.head_ref }}"
          if [[ ! "$BRANCH" =~ ^[0-9]+-(feat|fix|refactor|infra)-[a-z0-9-]+$ ]]; then
            echo "::error::Branch name '$BRANCH' violates policy"
            exit 1
          fi
```

PR description 側の禁止キーワード検出も同 workflow に追加できる:

```bash
if grep -Ei '(closes|fixes|resolves)[[:space:]]+#[0-9]+' <<< "$PR_BODY"; then
  echo "::error::Use 'Refs #N' instead of Closes/Fixes/Resolves"
  exit 1
fi
```

## 既存プロジェクトへの移行手順

1. `.github/pull_request_template.md` を本リポジトリの内容で配置
2. `CLAUDE.md` (or 既存 CLAUDE.md の更新) に worktree 命名規則を追記
3. 走行中の branch は無理に rename せず、新規 branch から本規則を適用
4. CHANGELOG 生成を行っているリポジトリでは `Refs` を拾う設定に変更
   (例は次節)

## CHANGELOG 生成設定の例

### git-cliff (`cliff.toml`)

```toml
[git]
commit_parsers = [
  { message = "^feat",     group = "Features" },
  { message = "^fix",      group = "Fixes" },
  { message = "^refactor", group = "Refactor" },
  { message = "^infra",    group = "Infra" },
]
# body 中の "Refs #N" / "Related to #N" / "Part of #N" を link 化
link_parsers = [
  { pattern = "Refs #(\\d+)",       href = "https://github.com/$REPO/issues/$1" },
  { pattern = "Related to #(\\d+)", href = "https://github.com/$REPO/issues/$1" },
  { pattern = "Part of #(\\d+)",    href = "https://github.com/$REPO/issues/$1" },
]
```

### release-please

`release-please` 自体は `Closes` / `Fixes` を強制しない。`Refs #N` は
そのまま CHANGELOG に転記されるため、設定変更なしで運用可能。
release-please による自動 close を抑止したい場合は `release-as` PR の
body から auto-close キーワードが入らないテンプレートを使う。

## 関連

- 実装: `yhonda-ohishi/claude-hooks` の対応 issue (作業4 で作成)
- 規約 (本ドキュメントの origin): `yhonda-ohishi/claude-skills` の対応 issue
  (作業3 で作成)
