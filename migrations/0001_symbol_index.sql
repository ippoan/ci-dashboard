-- cross-repo symbol index (D1)
-- query: src/symbol-index.ts / src/mcp/tools/repository.ts (search_symbols)
-- 投入: ci-workflows の symbol-index.yml generator → POST /internal/symbol-index
-- 設計: claude-skills の cross-repo-symbol-index skill。

CREATE TABLE IF NOT EXISTS repos (
  repo        TEXT PRIMARY KEY,   -- 'rust-alc-api'
  summary     TEXT,               -- 1 行説明
  lang        TEXT,               -- 主要言語
  head_sha    TEXT,
  src_hash    TEXT,               -- 鮮度キー (git rev-parse HEAD:src 等)
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS symbols (
  repo        TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,      -- function/class/struct/interface/type/enum/trait/mod
  file_path   TEXT NOT NULL,
  start_line  INTEGER NOT NULL,   -- LSP range.start.line
  end_line    INTEGER NOT NULL,   -- LSP range.end.line
  signature   TEXT,
  file_hash   TEXT                -- incremental 用 (変更 file だけ再抽出)
);
CREATE INDEX IF NOT EXISTS idx_symbols_lookup ON symbols(repo, name, kind);

CREATE TABLE IF NOT EXISTS deps (
  repo     TEXT NOT NULL,
  name     TEXT NOT NULL,
  version  TEXT,
  kind     TEXT
);
CREATE INDEX IF NOT EXISTS idx_deps_repo ON deps(repo);

CREATE TABLE IF NOT EXISTS links (
  from_repo    TEXT NOT NULL,
  from_symbol  TEXT,
  to_repo      TEXT,
  to_symbol    TEXT,
  kind         TEXT              -- import / call / cross-service
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_repo);
