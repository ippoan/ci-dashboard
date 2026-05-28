/**
 * Release Wave 機構の型定義。
 *
 * 設計の親 issue: ippoan/ci-dashboard#137
 *
 * Wave の lifecycle:
 *
 *   start → staging → (pending-approval) → flipping → flipped
 *                                                       │
 *                                                       ├─ contract_applied (flag だけ flip)
 *                                                       │
 *                                                       └─ rollback → rolled-back
 *
 *   abort: staging / pending-approval から → aborted
 *   fail:  staging / flipping から → failed
 *
 * 本ファイルは type のみで実行コードは持たない。state machine の遷移ロジックは
 * `state.ts` の純粋関数 `transition()` 経由で行う。
 */

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

/** Wave 全体の高レベル state。state.ts の `transition()` が更新する。 */
export type WaveStateName =
  | "staging"
  | "pending-approval"
  | "flipping"
  | "flipped"
  | "rolled-back"
  | "failed"
  | "aborted";

/** `flip_policy = manual-approval` か `auto` か。 */
export type FlipPolicy = "manual-approval" | "auto";

/**
 * Per-repo の stage / flip 進捗。`pending` → `done` への単調遷移を期待するが、
 * `failed` への遷移は permanent (= 同 wave 内で復活させない)。
 */
export type RepoPhaseStatus = "pending" | "done" | "failed";

/** Wave に参加する 1 repo の状態。 */
export interface RepoState {
  /** "owner/name"。 */
  readonly repo: string;
  /** 本 wave 内で打つ予定の tag (`v1.42.0` 等)。 */
  readonly target_tag: string;
  /** 本 wave 開始時点の HEAD SHA。stage handler 起動先 commit。 */
  readonly head_sha: string;

  /** stage handler 完了 callback の進捗。 */
  stage_status: RepoPhaseStatus;
  /** stage 完了時に handler が返した preview URL。 */
  preview_url: string | null;
  /** stage 失敗時の reason。 */
  stage_error: string | null;

  /** flip handler 進捗。flip_started=true 以降のみ意味あり。 */
  flip_status: RepoPhaseStatus;
  /** flip 失敗時の reason。 */
  flip_error: string | null;

  /**
   * flip 前の latest revision (ie. rollback 時に戻す先)。stage callback が
   * platform から取って報告する。CF Workers: version id、Cloud Run: revision name。
   */
  flip_from_revision: string | null;

  /** rollback 実行時、戻した先 revision。 */
  rolled_back_to_revision: string | null;
}

/**
 * rollback safety flag。`contract_applied` event で false 化する。
 *
 * `safe == false` 時、`release_wave_rollback` MCP tool はデフォルト refuse。
 * `--force` で override 可だが、issue #137 の Migration linkage 節参照。
 */
export interface RollbackSafety {
  safe: boolean;
  unsafe_reason: string | null;
  /** false 化された UTC ISO timestamp。 */
  unsafe_since: string | null;
  /** どの migration が unsafe に倒したか (`20260601_001_drop_legacy_token` 等)。 */
  unsafe_by_migration: string | null;
}

/**
 * Wave の完全な状態。DO storage に JSON で永続化する単一 record。
 *
 * 履歴 (events[]) も同 record に append-only で持つ。volume が増えたら
 * R2 archive へ flush するが、初期実装では DO storage 1 record に集約して
 * シンプルに保つ。
 */
export interface WaveState {
  /** UUID-like、operator が指定 or 自動採番。 */
  readonly wave_id: string;
  /** 高レベル state。 */
  state: WaveStateName;
  /** Wave 開始時に operator が選択した policy。 */
  readonly flip_policy: FlipPolicy;
  /** 開始時の note (自由文)。 */
  readonly note: string;
  /** 参加 repo 順序固定 list。 */
  readonly repos: RepoState[];

  /** rollback 可否フラグ。 */
  rollback: RollbackSafety;

  /** 開始時 UTC ISO。 */
  readonly started_at: string;
  /** 各 phase 進入 timestamp (audit 用)。 */
  staged_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  flipped_at: string | null;
  rolled_back_at: string | null;
  rolled_back_by: string | null;
  failed_at: string | null;
  aborted_at: string | null;

  /** 監査用イベントログ (append-only)。 */
  events: WaveEventRecord[];
}

// ----------------------------------------------------------------------------
// Events / Transitions
// ----------------------------------------------------------------------------

/**
 * `transition()` に渡す入力イベント。すべて discriminated union。
 *
 * `now` は state.ts 側ではなく caller (DO) が `new Date().toISOString()` を
 * 1 度だけ取って渡す。これで時刻依存をテスト可能にする。
 */
export type WaveEvent =
  | { kind: "start"; now: string }
  | {
      kind: "stage_report";
      now: string;
      repo: string;
      ok: boolean;
      preview_url?: string | null;
      flip_from_revision?: string | null;
      error?: string | null;
    }
  | { kind: "approve"; now: string; approved_by: string }
  | {
      kind: "flip_report";
      now: string;
      repo: string;
      ok: boolean;
      error?: string | null;
    }
  | { kind: "rollback"; now: string; rolled_back_by: string; force?: boolean }
  | { kind: "abort"; now: string; aborted_by: string; reason: string }
  | {
      kind: "fail";
      now: string;
      reason: string;
    }
  | {
      kind: "contract_applied";
      now: string;
      repo: string;
      migration_id: string;
    };

/** events[] に積む 1 entry。`WaveEvent` の subset に actor / outcome 付与。 */
export interface WaveEventRecord {
  /** UTC ISO。 */
  readonly at: string;
  /**
   * kind は WaveEvent の kind を踏襲。加えて、状態遷移を伴わない監査専用の
   * `compatibility_warning` (Refs #157 Phase A) を許容する。
   */
  readonly kind: WaveEvent["kind"] | "compatibility_warning";
  /** transition で変わった結果の 1 行 summary。 */
  readonly summary: string;
  /** 自由 detail (e.g. repo 名 / actor)。 */
  readonly detail?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// Transition result
// ----------------------------------------------------------------------------

/**
 * `transition()` の戻り値。pure / immutable: 失敗時は元 state を返さず error を
 * 返すだけ。caller (DO) が前 state を保持して必要なら復元する。
 */
export type TransitionResult =
  | { ok: true; state: WaveState }
  | { ok: false; error: string; code: TransitionErrorCode };

/** Transition 失敗時の機械可読 code。MCP tool から HTTP status に map する。 */
export type TransitionErrorCode =
  /** 既に終了 state なので操作不可。 */
  | "TERMINAL_STATE"
  /** 現 state からこの event は遷移不可。 */
  | "INVALID_TRANSITION"
  /** event.repo が wave.repos に含まれていない。 */
  | "REPO_NOT_IN_WAVE"
  /** rollback.safe = false で force=false。 */
  | "ROLLBACK_UNSAFE"
  /** start event だが既存 state 非 null (= 同 wave 重複開始)。 */
  | "ALREADY_STARTED";
