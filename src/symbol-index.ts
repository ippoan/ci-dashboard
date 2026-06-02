// cross-repo symbol index — D1 backend for `search_symbols`.
//
// CI (ci-workflows の symbol-index.yml) が test 後 (依存ビルド済み) に LSP で
// 抽出した symbol を D1 に push し、ここの query 関数が読む。`search_symbols`
// (src/mcp/tools/repository.ts) の backend を、従来の GitHub code-search
// heuristic からこの D1 に差し替えるための薄いロジック層。
//
// 設計: claude-skills の cross-repo-symbol-index skill。schema: migrations/。
//
// D1 への依存は最小の structural interface (D1Like) で受けるので、unit test は
// 実 D1 binding 無しで fake を渡して検証できる。binding 自体は optional
// (Env.SYMBOL_INDEX?) — 未投入の repo / 環境では呼び出し側が GitHub fallback する。

/** 必要な D1 API だけを表す structural type (test で fake を渡せるように)。 */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

export interface SymbolRow {
  repo: string;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

export interface SymbolQuery {
  repo: string;
  name: string;
  kind?: string;
  language?: string;
  perPage?: number;
}

/**
 * D1 の symbols テーブルから symbol 定義を引く。LSP 抽出済みなので name/kind の
 * 完全一致 (大小無視) で正確に当たる。GitHub code-search heuristic と違い
 * 行範囲 (start_line/end_line) を持つ。
 *
 * 戻り値が空のときは「未投入 or ヒット無し」— 呼び出し側で GitHub fallback する。
 */
export async function searchSymbolsInD1(db: D1Like, q: SymbolQuery): Promise<SymbolRow[]> {
  const perPage = clampPerPage(q.perPage);
  const where: string[] = ["repo = ?", "name = ? COLLATE NOCASE"];
  const binds: unknown[] = [q.repo, q.name];
  if (q.kind) {
    where.push("kind = ?");
    binds.push(q.kind);
  }
  binds.push(perPage);
  const sql =
    `SELECT repo, name, kind, file_path, start_line, end_line, signature ` +
    `FROM symbols WHERE ${where.join(" AND ")} ` +
    `ORDER BY file_path, start_line LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...binds).all<SymbolRow>();
  return results ?? [];
}

/** MCP の text 返却用に整形。各 symbol を `repo/file:start-end` で示す。 */
export function formatSymbolResults(rows: SymbolRow[], q: SymbolQuery): string {
  const header = `${rows.length} ${q.kind ?? "symbol"} definition(s) for "${q.name}" in ${q.repo} (D1 index)`;
  const body = rows
    .map((r) => {
      const loc = `${r.repo}/${r.file_path}:${r.start_line}-${r.end_line}`;
      const sig = r.signature ? `\n${r.signature}` : "";
      return `## ${r.kind} ${r.name}\n${loc}${sig}`;
    })
    .join("\n\n");
  return body ? `${header}\n\n${body}` : header;
}

// --- 鮮度比較 (skills/map staleness) ---

/** repos テーブルの行 (鮮度比較に使う最小列)。 */
export interface RepoState {
  repo: string;
  src_hash: string | null;
  updated_at: number | null;
}

/** D1 に index 済みの全 repo の baseline (src_hash) を読む。 */
export async function readRepos(db: D1Like): Promise<RepoState[]> {
  const { results } = await db
    .prepare(`SELECT repo, src_hash, updated_at FROM repos ORDER BY repo`)
    .bind()
    .all<RepoState>();
  return results ?? [];
}

/**
 * baseline (index した時の tree hash) と現在の tree hash を比べて stale 判定。
 * 内容ハッシュ比較なので squash merge / pull 未済をまたいでも壊れない
 * (cross-repo-symbol-index skill の設計参照)。current が不明 (null) のときは
 * 判定不能として false (= stale 扱いしない。「不明」を「あり」に倒さない)。
 */
export function isStale(baseline: string | null, current: string | null): boolean {
  if (!baseline || !current) return false;
  return baseline !== current;
}

/**
 * generator が incremental 差分の基点に使う、前回 index 時の head_sha / src_hash。
 * 未 index (初回) は null を返す → generator はフルスキャンに倒す。
 */
export async function readRepoHead(
  db: D1Like,
  repo: string,
): Promise<{ head_sha: string | null; src_hash: string | null } | null> {
  const { results } = await db
    .prepare(`SELECT head_sha, src_hash FROM repos WHERE repo = ? LIMIT 1`)
    .bind(repo)
    .all<{ head_sha: string | null; src_hash: string | null }>();
  return results?.[0] ?? null;
}

/** 抽出済み symbol を D1 に投入する payload (generator → ingest endpoint)。 */
export interface IngestPayload {
  repo: string;
  src_hash: string;
  head_sha?: string;
  summary?: string;
  lang?: string;
  /**
   * full  = repo 全体を ctags し直した (初回 / baseline 不明 / 大改修)。
   * incremental = 前回 head_sha からの git 差分のみ再 ctags した。
   * 省略時は full (後方互換)。
   */
  mode?: "full" | "incremental";
  /**
   * incremental 時、再 ctags した file path 群 (symbol が 0 になった file も含む)。
   * これらの既存 symbol を file 単位で消してから symbols を入れ直す。
   */
  changed_files?: string[];
  /** incremental 時、git diff で削除された file path 群。symbol を file 単位で消す。 */
  deleted_files?: string[];
  symbols: Array<{
    name: string;
    kind: string;
    file_path: string;
    start_line: number;
    end_line: number;
    signature?: string | null;
    file_hash?: string | null;
  }>;
}

/**
 * generator から受けた payload を D1 に反映する。
 * - full: repo 全 symbol を消してから入れ直す。
 * - incremental: changed_files ∪ deleted_files ∪ symbols の file_path だけを
 *   file 単位で消してから、changed の symbols を入れ直す (初回フル→以後 git 差分)。
 */
export async function ingestSymbols(db: D1Like, p: IngestPayload): Promise<number> {
  if (p.mode === "incremental") {
    const clear = new Set<string>([
      ...(p.changed_files ?? []),
      ...(p.deleted_files ?? []),
      ...p.symbols.map((s) => s.file_path),
    ]);
    for (const fp of clear) {
      await db.prepare(`DELETE FROM symbols WHERE repo = ? AND file_path = ?`).bind(p.repo, fp).run();
    }
  } else {
    await db.prepare(`DELETE FROM symbols WHERE repo = ?`).bind(p.repo).run();
  }
  for (const s of p.symbols) {
    await db
      .prepare(
        `INSERT INTO symbols (repo, name, kind, file_path, start_line, end_line, signature, file_hash) ` +
          `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        p.repo, s.name, s.kind, s.file_path, s.start_line, s.end_line,
        s.signature ?? null, s.file_hash ?? null,
      )
      .run();
  }
  await db
    .prepare(
      `INSERT INTO repos (repo, summary, lang, head_sha, src_hash, updated_at) ` +
        `VALUES (?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT(repo) DO UPDATE SET ` +
        `summary = excluded.summary, lang = excluded.lang, ` +
        `head_sha = excluded.head_sha, src_hash = excluded.src_hash, ` +
        `updated_at = excluded.updated_at`,
    )
    .bind(
      p.repo, p.summary ?? null, p.lang ?? null, p.head_sha ?? null,
      p.src_hash, Math.floor(Date.now() / 1000),
    )
    .run();
  return p.symbols.length;
}

/** payload の最低限の妥当性チェック (ingest endpoint で 400 を返すため)。 */
export function validateIngestPayload(v: unknown): v is IngestPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.repo !== "string" || p.repo === "") return false;
  if (typeof p.src_hash !== "string" || p.src_hash === "") return false;
  if (!Array.isArray(p.symbols)) return false;
  return p.symbols.every((s) => {
    if (typeof s !== "object" || s === null) return false;
    const sym = s as Record<string, unknown>;
    return (
      typeof sym.name === "string" &&
      typeof sym.kind === "string" &&
      typeof sym.file_path === "string" &&
      Number.isInteger(sym.start_line) &&
      Number.isInteger(sym.end_line)
    );
  });
}

function clampPerPage(n: number | undefined): number {
  if (!Number.isFinite(n) || n === undefined) return 10;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

// --- ingest endpoint (generator → POST /internal/symbol-index) ---

export interface SymbolIndexEnv {
  /** cross-repo symbol index (optional)。未投入なら ingest は 503。 */
  SYMBOL_INDEX?: D1Database;
  /** generator 認証用 shared secret (Secrets Store)。未設定なら 503。 */
  SYMBOL_INDEX_INGEST_SECRET?: SecretsStoreSecret;
}

/**
 * CI generator から symbol payload を受けて D1 に反映する HTTP handler。
 * `Authorization: Bearer <SYMBOL_INDEX_INGEST_SECRET>` で認証。
 */
export async function handleSymbolIndexIngest(
  request: Request,
  env: SymbolIndexEnv,
): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "use POST" });
  if (!env.SYMBOL_INDEX) return json(503, { error: "SYMBOL_INDEX (D1) is not bound" });

  const expected = await env.SYMBOL_INDEX_INGEST_SECRET?.get();
  if (!expected) return json(503, { error: "SYMBOL_INDEX_INGEST_SECRET is not configured" });
  const provided = parseBearer(request.headers.get("Authorization"));
  if (!constantTimeEqual(provided, expected)) return json(401, { error: "unauthorized" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "request body is not valid JSON" });
  }
  if (!validateIngestPayload(body)) return json(400, { error: "invalid payload" });

  const ingested = await ingestSymbols(env.SYMBOL_INDEX, body);
  return json(200, { ok: true, repo: body.repo, ingested });
}

function parseBearer(header: string | null): string {
  if (!header) return "";
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m ? m[1]! : "";
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
