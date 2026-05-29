/**
 * Release Wave compatibility — frontend ↔ backend image 突合の KV データ層。
 *
 * frontend CI (integration test green) と backend deploy (成功時) が ci-dashboard
 * の webhook 経由で書く KV record の read / write / 突合ロジック。shape の仕様は
 * docs/release-wave-compatibility-kv.md を SoT とする。
 *
 * 設計の親 issue: ippoan/ci-dashboard#157 (Phase A)
 * shape 確定 issue: ippoan/ci-dashboard#158
 */

// ----------------------------------------------------------------------------
// 定数
// ----------------------------------------------------------------------------

/** 現行 schema version (`frontend::*`)。破壊的変更時に bump。 */
export const SCHEMA_VERSION = 1;

/**
 * `backend::*` record の schema version。
 *   v1: { current_image, deployed_at, deployed_by, wave_id }
 *   v2: + current_tag (image に対応する git release tag)
 *       + deploy_history (過去 revision の遷移履歴、新しい順、rollback 先候補)
 * reader (`getBackendCurrent`) は v1/v2 双方を許容する。Refs #197。
 */
export const BACKEND_SCHEMA_VERSION = 2;

/** backend `deploy_history` の保持件数上限 (新しい順に trim)。 */
export const BACKEND_DEPLOY_HISTORY_MAX = 20;

/** `tested_against` の最大保持件数 (sliding window の件数上限)。 */
export const TESTED_AGAINST_MAX = 50;

/** `tested_against` の保持日数 (sliding window の時間上限)。 */
export const WINDOW_DAYS = 90;

/** `frontend::*` entry の KV TTL (秒)。write 毎に renew される。 */
export const FRONTEND_TTL_SECONDS = WINDOW_DAYS * 24 * 60 * 60;

const FRONTEND_PREFIX = "frontend::";
const BACKEND_PREFIX = "backend::";

function frontendKey(repo: string): string {
  return `${FRONTEND_PREFIX}${repo}`;
}

function backendKey(repo: string): string {
  return `${BACKEND_PREFIX}${repo}`;
}

// ----------------------------------------------------------------------------
// Record 型 (docs/release-wave-compatibility-kv.md と一致)
// ----------------------------------------------------------------------------

/** `frontend::<repo>` の `tested_against` 1 entry。 */
export interface TestedAgainstEntry {
  backend_repo: string;
  /** backend image identifier (platform 別、不透明文字列として完全一致比較)。 */
  backend_image: string;
  tested_at: string;
  ci_run_url?: string;
}

/** `frontend::<repo>` value。 */
export interface FrontendCompatRecord {
  schema_version: number;
  repo: string;
  prod_version: string;
  prod_deployed_at: string;
  /** 新しい順 (= index 0 が直近)。window trim 済み。 */
  tested_against: TestedAgainstEntry[];
}

/**
 * 過去に active だった backend revision 1 件分の履歴 entry。
 * rollback 先候補として `deploy_history[]` に新しい順で積む。Refs #197。
 */
export interface BackendDeployHistoryEntry {
  /** Cloud Run revision name 等の image identifier。 */
  image: string;
  /** その image に対応する git release tag (不明なら null)。 */
  tag: string | null;
  /** active になったと検知した UTC ISO。 */
  became_active_at: string;
}

/** `backend::<repo>` value。最新 deploy のみ保持 (upsert)。 */
export interface BackendCompatRecord {
  schema_version: number;
  repo: string;
  current_image: string;
  /** current_image に対応する git release tag (v2+、不明なら null)。Refs #197。 */
  current_tag?: string | null;
  deployed_at: string;
  deployed_by: string;
  /** wave 経由 deploy なら wave_id、単独 deploy なら null。 */
  wave_id: string | null;
  /**
   * 過去 revision の遷移履歴 (新しい順、上限 BACKEND_DEPLOY_HISTORY_MAX)。
   * index 0 = 現在 active、index 1 = 直前の active (= rollback 先候補)。
   * v1 record では undefined。Refs #197。
   */
  deploy_history?: BackendDeployHistoryEntry[];
}

// ----------------------------------------------------------------------------
// Write: frontend test report
// ----------------------------------------------------------------------------

export interface RecordFrontendTestInput {
  repo: string;
  prod_version: string;
  tested: {
    backend_repo: string;
    backend_image: string;
    ci_run_url?: string;
  };
  /** caller が渡す UTC ISO timestamp (テスト容易性のため内部で Date を呼ばない)。 */
  now: string;
}

/**
 * frontend CI green path の report を KV に反映する。
 *
 * read-modify-write:
 *  1. 既存 record を load (schema 不一致 / 無ければ新規)
 *  2. 同 (backend_repo, backend_image) の旧 entry を除去
 *  3. 新 entry を先頭に追加
 *  4. window (90日) で古い entry を落とし、最大 50 件に trim
 *  5. prod_version / prod_deployed_at を更新して put (TTL renew)
 */
export async function recordFrontendTest(
  kv: KVNamespace,
  input: RecordFrontendTestInput,
): Promise<FrontendCompatRecord> {
  const existing = await kv.get<FrontendCompatRecord>(frontendKey(input.repo), "json");

  const prior: TestedAgainstEntry[] =
    existing && existing.schema_version === SCHEMA_VERSION && Array.isArray(existing.tested_against)
      ? existing.tested_against
      : [];

  const newEntry: TestedAgainstEntry = {
    backend_repo: input.tested.backend_repo,
    backend_image: input.tested.backend_image,
    tested_at: input.now,
    ...(input.tested.ci_run_url ? { ci_run_url: input.tested.ci_run_url } : {}),
  };

  const deduped = prior.filter(
    (e) =>
      !(
        e.backend_repo === newEntry.backend_repo &&
        e.backend_image === newEntry.backend_image
      ),
  );

  const merged = [newEntry, ...deduped];
  const trimmed = trimTestedAgainst(merged, input.now);

  const record: FrontendCompatRecord = {
    schema_version: SCHEMA_VERSION,
    repo: input.repo,
    prod_version: input.prod_version,
    prod_deployed_at: input.now,
    tested_against: trimmed,
  };

  await kv.put(frontendKey(input.repo), JSON.stringify(record), {
    expirationTtl: FRONTEND_TTL_SECONDS,
  });
  return record;
}

/** window (件数 + 日数) で `tested_against` を trim。新しい順を維持。 */
function trimTestedAgainst(
  entries: TestedAgainstEntry[],
  now: string,
): TestedAgainstEntry[] {
  const cutoffMs = Date.parse(now) - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const withinWindow = entries.filter((e) => {
    const t = Date.parse(e.tested_at);
    // 不正な tested_at は安全側 (= 残す) に倒す。
    return Number.isNaN(t) || t >= cutoffMs;
  });
  return withinWindow.slice(0, TESTED_AGAINST_MAX);
}

// ----------------------------------------------------------------------------
// Write: backend deploy report
// ----------------------------------------------------------------------------

export interface RecordBackendDeployInput {
  repo: string;
  current_image: string;
  /** image に対応する git release tag (省略 / null 可)。Refs #197。 */
  current_tag?: string | null;
  deployed_by: string;
  wave_id?: string | null;
  now: string;
}

/**
 * backend deploy 成功時の upsert (最新のみ、TTL なし)。
 *
 * current_image が前回 record と変わっていれば `deploy_history` の先頭に
 * 旧→新の遷移として積む (新しい順、上限件数で trim)。同 image の再報告では
 * 履歴を変えない (重複を積まない)。Refs #197。
 */
export async function recordBackendDeploy(
  kv: KVNamespace,
  input: RecordBackendDeployInput,
): Promise<BackendCompatRecord> {
  const prev = await getBackendCurrent(kv, input.repo);
  const deploy_history = nextBackendDeployHistory(
    prev?.deploy_history,
    input.current_image,
    input.current_tag ?? null,
    input.now,
  );
  const record: BackendCompatRecord = {
    schema_version: BACKEND_SCHEMA_VERSION,
    repo: input.repo,
    current_image: input.current_image,
    current_tag: input.current_tag ?? null,
    deployed_at: input.now,
    deployed_by: input.deployed_by,
    wave_id: input.wave_id ?? null,
    ...(deploy_history.length > 0 ? { deploy_history } : {}),
  };
  await kv.put(backendKey(input.repo), JSON.stringify(record));
  return record;
}

/**
 * 新 current_image から backend deploy_history を導出する純粋関数。traffic.ts の
 * `nextDeployHistory` と対称。current_image が履歴先頭と異なれば積み、同じなら
 * 据え置く。再 deploy で履歴が重複しないよう同 image は除去して積み直す。
 */
export function nextBackendDeployHistory(
  prevHistory: BackendDeployHistoryEntry[] | undefined,
  currentImage: string,
  currentTag: string | null,
  now: string,
): BackendDeployHistoryEntry[] {
  const prior = Array.isArray(prevHistory) ? prevHistory : [];
  if (!currentImage) return prior.slice(0, BACKEND_DEPLOY_HISTORY_MAX);
  if (prior[0]?.image === currentImage) {
    return prior.slice(0, BACKEND_DEPLOY_HISTORY_MAX);
  }
  const entry: BackendDeployHistoryEntry = {
    image: currentImage,
    tag: currentTag,
    became_active_at: now,
  };
  const rest = prior.filter((e) => e.image !== currentImage);
  return [entry, ...rest].slice(0, BACKEND_DEPLOY_HISTORY_MAX);
}

// ----------------------------------------------------------------------------
// Read: backend current image
// ----------------------------------------------------------------------------

/** `backend::<repo>` を読む。無ければ null。v1/v2 双方を許容する (Refs #197)。 */
export async function getBackendCurrent(
  kv: KVNamespace,
  repo: string,
): Promise<BackendCompatRecord | null> {
  const v = await kv.get<BackendCompatRecord>(backendKey(repo), "json");
  if (!v || v.schema_version < SCHEMA_VERSION || v.schema_version > BACKEND_SCHEMA_VERSION) {
    return null;
  }
  return v;
}

// ----------------------------------------------------------------------------
// Read: compatibility matrix
// ----------------------------------------------------------------------------

/** 1 frontend について「対象 backend image を test 済みか」の判定結果。 */
export interface CompatMatrixEntry {
  frontend: string;
  prod_version: string | null;
  /** target image を test 済みなら true (= 緑)。 */
  tested_against_target: boolean;
  /** 緑のとき、その test の tested_at。 */
  tested_against_at: string | null;
  /** 赤のとき、同 backend_repo について直近に test した image (参考)。 */
  last_tested_image: string | null;
  /**
   * 当該 backend_repo に対する過去 test 履歴 (新しい順、window 済み)。
   * admin UI の hover ツールチップ等で使う。
   */
  history: TestedAgainstEntry[];
}

export interface CompatibilityResult {
  backend_repo: string;
  backend_target_image: string;
  /**
   * matrix が空でなく、かつ全 frontend が緑なら true。
   * 空 (= この backend を test した frontend が 1 つも無い) の場合は
   * 「検証できない」として false。
   */
  verified: boolean;
  matrix: CompatMatrixEntry[];
}

/**
 * 全 `frontend::*` record を走査し、指定 backend を `backend_target_image` に
 * flip する際の互換性 matrix を構築する。
 *
 * matrix に載るのは「`tested_against` に当該 backend_repo の entry を 1 つ以上
 * 持つ frontend」のみ (= その backend の consumer とみなせる frontend)。
 * Phase A では `consumed_by` 設定を持たないため、test 履歴を consumer の
 * 近似として使う。
 */
export async function computeCompatibility(
  kv: KVNamespace,
  backend_repo: string,
  backend_target_image: string,
): Promise<CompatibilityResult> {
  const records = await listFrontendRecords(kv);
  const matrix: CompatMatrixEntry[] = [];

  for (const rec of records) {
    const relevant = rec.tested_against.filter(
      (e) => e.backend_repo === backend_repo,
    );
    if (relevant.length === 0) continue; // この backend の consumer ではない

    const match = relevant.find((e) => e.backend_image === backend_target_image);
    matrix.push({
      frontend: rec.repo,
      prod_version: rec.prod_version || null,
      tested_against_target: match !== undefined,
      tested_against_at: match ? match.tested_at : null,
      // relevant は元 record の新しい順を維持しているので [0] が直近。
      last_tested_image: match ? null : (relevant[0]?.backend_image ?? null),
      history: relevant,
    });
  }

  matrix.sort((a, b) => (a.frontend < b.frontend ? -1 : 1));

  const verified =
    matrix.length > 0 && matrix.every((m) => m.tested_against_target);

  return { backend_repo, backend_target_image, verified, matrix };
}

// ----------------------------------------------------------------------------
// Read: wave 単位の compatibility (status / precheck / admin UI 用)
// ----------------------------------------------------------------------------

/** wave 内の 1 backend repo についての突合結果。 */
export interface WaveBackendCompat {
  backend_repo: string;
  /** `backend::<repo>` に記録された現 production image (record 無しなら null)。 */
  current_image: string | null;
  /** current_image に対応する git release tag (v2 record のみ、無ければ null)。Refs #197。 */
  current_tag: string | null;
  /** 過去 revision の rollback 先候補 (新しい順、record 無し / v1 なら空)。Refs #197。 */
  deploy_history: BackendDeployHistoryEntry[];
  /** 当該 backend を test 済みの frontend の matrix (consumer 無しなら空)。 */
  matrix: CompatMatrixEntry[];
}

export interface WaveCompatibility {
  /**
   * 認識された backend (= `backend::` record を持つ wave repo) の中に赤が
   * 1 つも無ければ true。consumer matrix が全て空でも (= 何も検証できなくても)
   * vacuously true になる点に注意 (`checked` で区別する)。
   */
  verified: boolean;
  /** 1 つ以上の backend が非空 consumer matrix を持っていれば true。 */
  checked: boolean;
  backends: WaveBackendCompat[];
}

/**
 * wave に含まれる repo 群について compatibility を構築する。
 *
 * Phase A では wave の flip 先 image (= 新 image) を WaveState が持たないため、
 * 各 backend repo の **現 production image** (`backend::<repo>.current_image`)
 * を突合対象にする。これは「wave 起動時点で既 deploy frontend が現 backend と
 * 整合しているか」の precheck として機能する。`backend::` record を持たない
 * repo (= frontend / 未 deploy backend) は対象外。
 */
export async function computeWaveCompatibility(
  kv: KVNamespace,
  repos: string[],
): Promise<WaveCompatibility> {
  const backends: WaveBackendCompat[] = [];
  for (const repo of repos) {
    const rec = await getBackendCurrent(kv, repo);
    if (!rec) continue; // backend deploy record の無い repo は対象外
    const compat = await computeCompatibility(kv, repo, rec.current_image);
    backends.push({
      backend_repo: repo,
      current_image: rec.current_image,
      current_tag: rec.current_tag ?? null,
      deploy_history: Array.isArray(rec.deploy_history) ? rec.deploy_history : [],
      matrix: compat.matrix,
    });
  }
  const checked = backends.some((b) => b.matrix.length > 0);
  const verified = backends.every((b) =>
    b.matrix.every((m) => m.tested_against_target),
  );
  return { verified, checked, backends };
}

/**
 * 全 `backend::*` repo を list する (wave 非依存)。
 */
async function listBackendRepos(kv: KVNamespace): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: BACKEND_PREFIX, cursor });
    for (const key of page.keys) {
      out.push(key.name.slice(BACKEND_PREFIX.length));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/**
 * 全 `backend::` record に対する compatibility を構築する wave 非依存の
 * グローバルビュー。Release Wave 一覧ページの俯瞰グラフ用。
 * backend record が 1 つも無ければ空の WaveCompatibility を返す。
 */
export async function computeGlobalCompatibility(
  kv: KVNamespace,
): Promise<WaveCompatibility> {
  const repos = await listBackendRepos(kv);
  return computeWaveCompatibility(kv, repos);
}

/** `frontend::*` を全件 list して parse する。schema 不一致は除外。 */
async function listFrontendRecords(
  kv: KVNamespace,
): Promise<FrontendCompatRecord[]> {
  const out: FrontendCompatRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: FRONTEND_PREFIX, cursor });
    for (const key of page.keys) {
      const rec = await kv.get<FrontendCompatRecord>(key.name, "json");
      if (rec && rec.schema_version === SCHEMA_VERSION && Array.isArray(rec.tested_against)) {
        out.push(rec);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
