import { describe, it, expect } from "vitest";
import {
  ingestSymbols,
  isStale,
  readRepos,
  readRepoHead,
  type D1Like,
  type IngestPayload,
} from "../src/symbol-index";
import { computeFreshness } from "../src/symbol-freshness";

// prepare/bind の呼び出しを captured に積み、.all() は allRows を返す fake D1。
function fakeD1(allRows: unknown[] = []) {
  const captured: Array<{ sql: string; binds: unknown[] }> = [];
  const db: D1Like = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          captured.push({ sql, binds });
          return {
            async all<T>() {
              return { results: allRows as unknown as T[] };
            },
            async run() {
              return {};
            },
          };
        },
      };
    },
  };
  return { db, captured };
}

describe("ingestSymbols incremental", () => {
  const base: IngestPayload = {
    repo: "rust-alc-api",
    src_hash: "tree2",
    head_sha: "sha2",
    mode: "incremental",
    changed_files: ["src/a.rs", "src/empty.rs"],
    deleted_files: ["src/gone.rs"],
    symbols: [
      { name: "f", kind: "function", file_path: "src/a.rs", start_line: 1, end_line: 9 },
    ],
  };

  it("repo 全消しでなく file 単位 DELETE を発行する", async () => {
    const { db, captured } = fakeD1();
    await ingestSymbols(db, base);
    const repoWide = captured.filter(
      (c) => c.sql.includes("DELETE FROM symbols") && !c.sql.includes("file_path"),
    );
    expect(repoWide).toHaveLength(0); // 全消しは無い

    const fileDeletes = captured.filter((c) => c.sql.includes("DELETE FROM symbols WHERE repo = ? AND file_path = ?"));
    const deletedPaths = fileDeletes.map((c) => c.binds[1]);
    // changed_files ∪ deleted_files ∪ symbols の file_path = a.rs, empty.rs, gone.rs
    expect(new Set(deletedPaths)).toEqual(new Set(["src/a.rs", "src/empty.rs", "src/gone.rs"]));
  });

  it("changed の symbols を insert し repos を upsert", async () => {
    const { db, captured } = fakeD1();
    const n = await ingestSymbols(db, base);
    expect(n).toBe(1);
    expect(captured.some((c) => c.sql.includes("INSERT INTO symbols"))).toBe(true);
    expect(captured.at(-1)!.sql).toContain("INSERT INTO repos");
  });

  it("mode 省略 (full) は従来通り repo 全消し", async () => {
    const { db, captured } = fakeD1();
    await ingestSymbols(db, { repo: "r", src_hash: "h", symbols: [] });
    expect(captured[0]!.sql).toContain("DELETE FROM symbols WHERE repo = ?");
    expect(captured[0]!.sql).not.toContain("file_path");
  });
});

describe("isStale", () => {
  it("内容ハッシュが違えば stale", () => expect(isStale("a", "b")).toBe(true));
  it("一致なら fresh", () => expect(isStale("a", "a")).toBe(false));
  it("どちらか不明 (null) なら stale 扱いしない", () => {
    expect(isStale(null, "a")).toBe(false);
    expect(isStale("a", null)).toBe(false);
  });
});

describe("readRepos / readRepoHead", () => {
  it("readRepos は repos 行を返す", async () => {
    const { db } = fakeD1([{ repo: "x", src_hash: "h", updated_at: 1 }]);
    const rows = await readRepos(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repo).toBe("x");
  });
  it("readRepoHead は未 index で null", async () => {
    const { db } = fakeD1([]);
    expect(await readRepoHead(db, "x")).toBeNull();
  });
  it("readRepoHead は head_sha/src_hash を返す", async () => {
    const { db } = fakeD1([{ head_sha: "s", src_hash: "t" }]);
    expect(await readRepoHead(db, "x")).toEqual({ head_sha: "s", src_hash: "t" });
  });
});

describe("computeFreshness", () => {
  it("baseline と current を比較し stale フラグを立てる", async () => {
    const { db } = fakeD1([
      { repo: "a", src_hash: "t1", updated_at: 1 },
      { repo: "b", src_hash: "t2", updated_at: 2 },
    ]);
    const current: Record<string, string> = { a: "t1", b: "tX" }; // b が変わった
    const rows = await computeFreshness(db, async (repo) => current[repo] ?? null);
    expect(rows.find((r) => r.repo === "a")!.stale).toBe(false);
    expect(rows.find((r) => r.repo === "b")!.stale).toBe(true);
  });

  it("current 取得失敗 (throw) は current=null・stale=false", async () => {
    const { db } = fakeD1([{ repo: "a", src_hash: "t1", updated_at: 1 }]);
    const rows = await computeFreshness(db, async () => {
      throw new Error("boom");
    });
    expect(rows[0]!.current_tree_sha).toBeNull();
    expect(rows[0]!.stale).toBe(false);
  });
});
