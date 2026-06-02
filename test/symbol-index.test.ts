import { describe, it, expect } from "vitest";
import {
  searchSymbolsInD1,
  formatSymbolResults,
  ingestSymbols,
  validateIngestPayload,
  handleSymbolIndexIngest,
  type D1Like,
  type SymbolRow,
} from "../src/symbol-index";

// 記録用の fake D1 — prepare/bind/all/run の呼び出しを captured に積む。
function fakeD1(allResults: SymbolRow[] = []) {
  const captured: Array<{ sql: string; binds: unknown[] }> = [];
  const db: D1Like = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          captured.push({ sql, binds });
          return {
            async all<T>() {
              return { results: allResults as unknown as T[] };
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

const row = (over: Partial<SymbolRow> = {}): SymbolRow => ({
  repo: "rust-alc-api",
  name: "getUserById",
  kind: "function",
  file_path: "src/handlers/user.rs",
  start_line: 42,
  end_line: 67,
  signature: "fn getUserById(id: i64) -> User",
  ...over,
});

describe("searchSymbolsInD1", () => {
  it("repo + name で引き、kind 指定時は WHERE に足す", async () => {
    const { db, captured } = fakeD1([row()]);
    const rows = await searchSymbolsInD1(db, {
      repo: "rust-alc-api",
      name: "getUserById",
      kind: "function",
      perPage: 5,
    });
    expect(rows).toHaveLength(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain("FROM symbols");
    expect(captured[0]!.sql).toContain("kind = ?");
    // binds: repo, name, kind, limit
    expect(captured[0]!.binds).toEqual(["rust-alc-api", "getUserById", "function", 5]);
  });

  it("kind 未指定なら kind 条件を付けない", async () => {
    const { db, captured } = fakeD1([]);
    await searchSymbolsInD1(db, { repo: "x", name: "y" });
    expect(captured[0]!.sql).not.toContain("kind = ?");
    expect(captured[0]!.binds).toEqual(["x", "y", 10]); // default perPage=10
  });

  it("perPage は 1..50 に clamp", async () => {
    const { db, captured } = fakeD1([]);
    await searchSymbolsInD1(db, { repo: "x", name: "y", perPage: 999 });
    expect(captured[0]!.binds.at(-1)).toBe(50);
  });
});

describe("formatSymbolResults", () => {
  it("repo/file:start-end を含める", () => {
    const text = formatSymbolResults([row()], { repo: "rust-alc-api", name: "getUserById" });
    expect(text).toContain("rust-alc-api/src/handlers/user.rs:42-67");
    expect(text).toContain("fn getUserById(id: i64) -> User");
    expect(text).toContain("1 symbol definition(s)");
  });

  it("空でも header は返す", () => {
    const text = formatSymbolResults([], { repo: "r", name: "n" });
    expect(text).toContain("0 symbol definition(s)");
  });
});

describe("validateIngestPayload", () => {
  const valid = {
    repo: "rust-alc-api",
    src_hash: "abc",
    symbols: [{ name: "f", kind: "function", file_path: "a.rs", start_line: 1, end_line: 2 }],
  };
  it("正常を通す", () => expect(validateIngestPayload(valid)).toBe(true));
  it("repo 欠落を弾く", () =>
    expect(validateIngestPayload({ ...valid, repo: "" })).toBe(false));
  it("src_hash 欠落を弾く", () =>
    expect(validateIngestPayload({ ...valid, src_hash: undefined })).toBe(false));
  it("symbols が配列でないと弾く", () =>
    expect(validateIngestPayload({ ...valid, symbols: {} })).toBe(false));
  it("start_line が非整数だと弾く", () =>
    expect(
      validateIngestPayload({
        ...valid,
        symbols: [{ name: "f", kind: "function", file_path: "a", start_line: 1.5, end_line: 2 }],
      }),
    ).toBe(false));
});

describe("ingestSymbols", () => {
  it("DELETE → INSERT(symbols) → repos upsert を発行", async () => {
    const { db, captured } = fakeD1();
    const n = await ingestSymbols(db, {
      repo: "rust-alc-api",
      src_hash: "deadbeef",
      symbols: [
        { name: "f", kind: "function", file_path: "a.rs", start_line: 1, end_line: 9 },
        { name: "g", kind: "struct", file_path: "b.rs", start_line: 3, end_line: 8 },
      ],
    });
    expect(n).toBe(2);
    expect(captured[0]!.sql).toContain("DELETE FROM symbols");
    expect(captured[0]!.binds).toEqual(["rust-alc-api"]);
    expect(captured.filter((c) => c.sql.includes("INSERT INTO symbols"))).toHaveLength(2);
    expect(captured.at(-1)!.sql).toContain("INSERT INTO repos");
  });
});

describe("handleSymbolIndexIngest", () => {
  const secret = { async get() { return "s3cr3t"; } } as unknown as SecretsStoreSecret;
  const body = {
    repo: "rust-alc-api",
    src_hash: "abc",
    symbols: [{ name: "f", kind: "function", file_path: "a.rs", start_line: 1, end_line: 2 }],
  };
  const req = (auth?: string, payload: unknown = body) =>
    new Request("https://x/internal/symbol-index", {
      method: "POST",
      headers: auth ? { Authorization: auth } : {},
      body: JSON.stringify(payload),
    });

  it("D1 未 bind なら 503", async () => {
    const res = await handleSymbolIndexIngest(req("Bearer s3cr3t"), {});
    expect(res.status).toBe(503);
  });

  it("secret 未設定なら 503", async () => {
    const { db } = fakeD1();
    const res = await handleSymbolIndexIngest(req("Bearer s3cr3t"), {
      SYMBOL_INDEX: db as unknown as D1Database,
    });
    expect(res.status).toBe(503);
  });

  it("Bearer 不一致なら 401", async () => {
    const { db } = fakeD1();
    const res = await handleSymbolIndexIngest(req("Bearer wrong"), {
      SYMBOL_INDEX: db as unknown as D1Database,
      SYMBOL_INDEX_INGEST_SECRET: secret,
    });
    expect(res.status).toBe(401);
  });

  it("payload 不正なら 400", async () => {
    const { db } = fakeD1();
    const res = await handleSymbolIndexIngest(req("Bearer s3cr3t", { repo: "" }), {
      SYMBOL_INDEX: db as unknown as D1Database,
      SYMBOL_INDEX_INGEST_SECRET: secret,
    });
    expect(res.status).toBe(400);
  });

  it("正常なら 200 + ingested 件数", async () => {
    const { db } = fakeD1();
    const res = await handleSymbolIndexIngest(req("Bearer s3cr3t"), {
      SYMBOL_INDEX: db as unknown as D1Database,
      SYMBOL_INDEX_INGEST_SECRET: secret,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, repo: "rust-alc-api", ingested: 1 });
  });
});
