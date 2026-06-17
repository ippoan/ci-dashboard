# Session handoff

引き継ぎ issue: https://github.com/ippoan/ci-dashboard/issues/400

## 未コミットの変更

なし (working tree clean、本セッションは調査のみ)。

## 次にやること

1. **bug 2 fix (PR tag 無し close)**: `/issues` page の `loadPrMap()` を `/releases` 側でも gate に使い、`state:"merged"` PR を持たない issue を close 候補から drop する。詳細手順は #400 参照
   - 改修対象: `src/releases-page.ts` の `computeIndexViews` → `loadRepoView` → `loadSyntheticBlock` (line 480-655)
   - 既存定数: `ORGS` / `YHONDA_REPOS` は `src/issues-page.ts:31,38`
2. **bug 1 fix (close が消えない)**: CF Observability API 復活後に `ci-dashboard` worker の `release-close-batch` trigger ログを引いて診断。候補は `src/release-close-batch.ts:157-175` の hub DO `releases-index-apply-close` patch の握り潰し catch

## 注意点

- session branch: `claude/eloquent-faraday-epscrb`
- repo CLAUDE.md: `Closes/Fixes/Resolves #N` 禁止 → `Refs #N` 使用
- PR 作成直後の `enable_pr_auto_merge` 自動呼出禁止 (user 明示指示時のみ)
- bug 2 修正後、direct-push allowlist repo (`claude-md` / `claude-hooks` 等) の直 push `Refs #N` は close 候補から外れる (仕様通り、退化ではない)
