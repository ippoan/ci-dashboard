/**
 * Release Wave の純粋 state machine。
 *
 * DO や HTTP に依存しない: 入力 (state, event) → 出力 (next state | error) の
 * 関数だけを export する。テストは pure function として書ける。
 *
 * 設計の親 issue: ippoan/ci-dashboard#137
 */

import type {
  FlipPolicy,
  RepoState,
  RollbackSafety,
  TransitionErrorCode,
  TransitionResult,
  WaveEvent,
  WaveEventRecord,
  WaveState,
  WaveStateName,
} from "./types";

// ----------------------------------------------------------------------------
// Public: 初期 state 構築
// ----------------------------------------------------------------------------

/**
 * 新規 wave の初期 state を構築する (`start` event の効果)。state machine 入口。
 *
 * 1 wave = 1 DO instance に 1 record の前提なので、caller (DO) は本関数で
 * 作った state を storage に put し、以後の transition 結果も同 key で
 * 上書きする。再 start は許さない (DO 側で `ALREADY_STARTED` を返す)。
 */
export function createWave(input: {
  wave_id: string;
  flip_policy: FlipPolicy;
  note: string;
  repos: Array<{
    repo: string;
    target_tag: string;
    head_sha: string;
    require_compatibility?: boolean;
  }>;
  now: string;
}): WaveState {
  const repos: RepoState[] = input.repos.map((r) => ({
    repo: r.repo,
    target_tag: r.target_tag,
    head_sha: r.head_sha,
    require_compatibility: r.require_compatibility ?? false,
    stage_status: "pending",
    preview_url: null,
    stage_error: null,
    flip_status: "pending",
    flip_error: null,
    flip_from_revision: null,
    rolled_back_to_revision: null,
  }));

  const rollback: RollbackSafety = {
    safe: true,
    unsafe_reason: null,
    unsafe_since: null,
    unsafe_by_migration: null,
  };

  const start_record: WaveEventRecord = {
    at: input.now,
    kind: "start",
    summary: `wave started with ${repos.length} repo(s), policy=${input.flip_policy}`,
    detail: {
      repos: repos.map((r) => r.repo),
      flip_policy: input.flip_policy,
      note: input.note,
    },
  };

  return {
    wave_id: input.wave_id,
    state: "staging",
    flip_policy: input.flip_policy,
    note: input.note,
    repos,
    rollback,
    started_at: input.now,
    staged_at: null,
    approved_at: null,
    approved_by: null,
    flipped_at: null,
    rolled_back_at: null,
    rolled_back_by: null,
    failed_at: null,
    aborted_at: null,
    events: [start_record],
  };
}

// ----------------------------------------------------------------------------
// Public: 状態遷移
// ----------------------------------------------------------------------------

/**
 * `state` に `event` を適用して次 state を返す純粋関数。
 *
 * - 入力 state は immutable (本関数は cloning して新 state を返す)
 * - 不正遷移は `{ ok: false, code }` を返す。caller は前 state を保持して再 issue する
 * - 時刻は `event.now` を使う (= 内部で `Date.now()` を呼ばない)
 */
export function transition(state: WaveState, event: WaveEvent): TransitionResult {
  // すでに終了 state なら何も受け付けない
  if (isTerminal(state.state) && event.kind !== "contract_applied") {
    return fail(
      "TERMINAL_STATE",
      `wave is in terminal state ${state.state}, cannot apply ${event.kind}`,
    );
  }

  switch (event.kind) {
    case "start":
      // createWave 経由で作るべき; 既存 state に対する start は重複扱い
      return fail("ALREADY_STARTED", "wave already started, use createWave() instead");

    case "stage_report":
      return applyStageReport(state, event);

    case "approve":
      return applyApprove(state, event);

    case "flip_report":
      return applyFlipReport(state, event);

    case "rollback":
      return applyRollback(state, event);

    case "abort":
      return applyAbort(state, event);

    case "fail":
      return applyFail(state, event);

    case "contract_applied":
      return applyContractApplied(state, event);
  }
}

// ----------------------------------------------------------------------------
// Per-event handlers
// ----------------------------------------------------------------------------

function applyStageReport(
  state: WaveState,
  event: Extract<WaveEvent, { kind: "stage_report" }>,
): TransitionResult {
  if (state.state !== "staging") {
    return fail(
      "INVALID_TRANSITION",
      `stage_report only valid in 'staging', current=${state.state}`,
    );
  }

  const repoIdx = state.repos.findIndex((r) => r.repo === event.repo);
  if (repoIdx === -1) {
    return fail("REPO_NOT_IN_WAVE", `repo ${event.repo} is not in this wave`);
  }
  const repoBefore = state.repos[repoIdx]!;

  // permanent な failed をひっくり返さない: failed → done 等は受け付けない
  if (repoBefore.stage_status === "failed") {
    return fail(
      "INVALID_TRANSITION",
      `repo ${event.repo} stage already failed (permanent)`,
    );
  }

  const next = cloneWaveForUpdate(state);
  const repoNext = next.repos[repoIdx]!;
  if (event.ok) {
    repoNext.stage_status = "done";
    repoNext.preview_url = event.preview_url ?? null;
    repoNext.flip_from_revision = event.flip_from_revision ?? null;
    repoNext.stage_error = null;
  } else {
    repoNext.stage_status = "failed";
    repoNext.stage_error = event.error ?? "stage failed (no detail)";
  }

  // 全 stage 完了? - failed が 1 つでもあれば failed transition
  const anyFailed = next.repos.some((r) => r.stage_status === "failed");
  const allDone = next.repos.every((r) => r.stage_status === "done");

  let summary = `stage ${event.ok ? "ok" : "failed"}: ${event.repo}`;

  if (anyFailed) {
    next.state = "failed";
    next.failed_at = event.now;
    summary = `stage failed (${event.repo}); wave -> failed`;
  } else if (allDone) {
    next.staged_at = event.now;
    if (state.flip_policy === "auto") {
      next.state = "flipping";
      summary = `all repos staged; auto policy -> flipping`;
    } else {
      next.state = "pending-approval";
      summary = `all repos staged; awaiting approval`;
    }
  }

  next.events = appendEvent(state.events, {
    at: event.now,
    kind: "stage_report",
    summary,
    detail: { repo: event.repo, ok: event.ok },
  });
  return { ok: true, state: next };
}

function applyApprove(
  state: WaveState,
  event: Extract<WaveEvent, { kind: "approve" }>,
): TransitionResult {
  // approve は pending-approval (manual-approval policy) からのみ
  if (state.state !== "pending-approval") {
    return fail(
      "INVALID_TRANSITION",
      `approve only valid in 'pending-approval', current=${state.state}`,
    );
  }

  const next = cloneWaveForUpdate(state);
  next.state = "flipping";
  next.approved_at = event.now;
  next.approved_by = event.approved_by;
  next.events = appendEvent(state.events, {
    at: event.now,
    kind: "approve",
    summary: `approved by ${event.approved_by}; -> flipping`,
    detail: { approved_by: event.approved_by },
  });
  return { ok: true, state: next };
}

function applyFlipReport(
  state: WaveState,
  event: Extract<WaveEvent, { kind: "flip_report" }>,
): TransitionResult {
  if (state.state !== "flipping") {
    return fail(
      "INVALID_TRANSITION",
      `flip_report only valid in 'flipping', current=${state.state}`,
    );
  }

  const repoIdx = state.repos.findIndex((r) => r.repo === event.repo);
  if (repoIdx === -1) {
    return fail("REPO_NOT_IN_WAVE", `repo ${event.repo} is not in this wave`);
  }
  const repoBefore = state.repos[repoIdx]!;
  if (repoBefore.flip_status === "failed") {
    return fail(
      "INVALID_TRANSITION",
      `repo ${event.repo} flip already failed (permanent)`,
    );
  }

  const next = cloneWaveForUpdate(state);
  const repoNext = next.repos[repoIdx]!;
  if (event.ok) {
    repoNext.flip_status = "done";
    repoNext.flip_error = null;
  } else {
    repoNext.flip_status = "failed";
    repoNext.flip_error = event.error ?? "flip failed (no detail)";
  }

  const anyFailed = next.repos.some((r) => r.flip_status === "failed");
  const allDone = next.repos.every((r) => r.flip_status === "done");

  let summary = `flip ${event.ok ? "ok" : "failed"}: ${event.repo}`;

  if (anyFailed) {
    next.state = "failed";
    next.failed_at = event.now;
    summary = `flip failed (${event.repo}); wave -> failed`;
  } else if (allDone) {
    next.state = "flipped";
    next.flipped_at = event.now;
    summary = `all repos flipped`;
  }

  next.events = appendEvent(state.events, {
    at: event.now,
    kind: "flip_report",
    summary,
    detail: { repo: event.repo, ok: event.ok },
  });
  return { ok: true, state: next };
}

function applyRollback(
  state: WaveState,
  event: Extract<WaveEvent, { kind: "rollback" }>,
): TransitionResult {
  if (state.state !== "flipped") {
    return fail(
      "INVALID_TRANSITION",
      `rollback only valid in 'flipped', current=${state.state}`,
    );
  }
  if (!state.rollback.safe && !event.force) {
    return fail(
      "ROLLBACK_UNSAFE",
      `rollback refused: ${state.rollback.unsafe_reason ?? "unsafe"} (use --force to override)`,
    );
  }

  const next = cloneWaveForUpdate(state);
  next.state = "rolled-back";
  next.rolled_back_at = event.now;
  next.rolled_back_by = event.rolled_back_by;
  // 各 repo の rolled_back_to_revision は caller (DO) が flip_from_revision を
  // 確認した上で別途 set する想定。本 transition では state 遷移のみ。
  next.events = appendEvent(state.events, {
    at: event.now,
    kind: "rollback",
    summary: `rollback by ${event.rolled_back_by}${event.force ? " (forced)" : ""}`,
    detail: {
      rolled_back_by: event.rolled_back_by,
      forced: event.force === true,
      rollback_safe_at_time: state.rollback.safe,
    },
  });
  return { ok: true, state: next };
}

function applyAbort(
  state: WaveState,
  event: Extract<WaveEvent, { kind: "abort" }>,
): TransitionResult {
  // abort は flip 前 (staging / pending-approval) のみ。flipping/flipped 後は rollback を使う。
  if (state.state !== "staging" && state.state !== "pending-approval") {
    return fail(
      "INVALID_TRANSITION",
      `abort only valid before flip, current=${state.state}`,
    );
  }

  const next = cloneWaveForUpdate(state);
  next.state = "aborted";
  next.aborted_at = event.now;
  next.events = appendEvent(state.events, {
    at: event.now,
    kind: "abort",
    summary: `aborted by ${event.aborted_by}: ${event.reason}`,
    detail: { aborted_by: event.aborted_by, reason: event.reason },
  });
  return { ok: true, state: next };
}

function applyFail(
  state: WaveState,
  event: Extract<WaveEvent, { kind: "fail" }>,
): TransitionResult {
  // fail は in-progress (= staging / pending-approval / flipping) でのみ受ける。
  // 終了 state は TERMINAL_STATE で reject (= 重複 fail / `flipped` から逆走する fail を阻止)。
  // `flipped` も非 terminal だが「成功側」に進んだ wave なので、問題が出た場合は
  // fail ではなく rollback を使う設計 (issue #137 diagram 参照)。
  if (isTerminal(state.state)) {
    return fail(
      "TERMINAL_STATE",
      `wave already in terminal state ${state.state}`,
    );
  }
  if (state.state === "flipped") {
    return fail(
      "INVALID_TRANSITION",
      `fail invalid on 'flipped' state, use rollback instead`,
    );
  }
  const next = cloneWaveForUpdate(state);
  next.state = "failed";
  next.failed_at = event.now;
  next.events = appendEvent(state.events, {
    at: event.now,
    kind: "fail",
    summary: `failed: ${event.reason}`,
    detail: { reason: event.reason },
  });
  return { ok: true, state: next };
}

function applyContractApplied(
  state: WaveState,
  event: Extract<WaveEvent, { kind: "contract_applied" }>,
): TransitionResult {
  // contract_applied は flipped wave のみで意味あり (= rollback safety を倒す)。
  // それ以外の state でも 200 で受け入れて event だけ記録する設計でも良いが、
  // safety flag を倒す副作用が無い (= rollback 不可化が起きない) のは紛らわしい
  // ので、現状は wave が flipped でない場合は INVALID_TRANSITION で reject。
  if (state.state !== "flipped") {
    return fail(
      "INVALID_TRANSITION",
      `contract_applied only meaningful in 'flipped', current=${state.state}`,
    );
  }
  // 同 repo が wave に含まれているかは validation する (= 他 wave 向けの通知が
  // 誤って入らないようにする)。
  const repoIdx = state.repos.findIndex((r) => r.repo === event.repo);
  if (repoIdx === -1) {
    return fail("REPO_NOT_IN_WAVE", `repo ${event.repo} is not in this wave`);
  }

  // 既に unsafe なら idempotent: 何もしないが event だけ記録する。
  // unsafe_by_migration の最初の 1 件を採用 (= 最も早く unsafe にした migration)。
  const next = cloneWaveForUpdate(state);
  if (next.rollback.safe) {
    next.rollback = {
      safe: false,
      unsafe_reason: `contract migration applied: ${event.migration_id}`,
      unsafe_since: event.now,
      unsafe_by_migration: event.migration_id,
    };
  }
  next.events = appendEvent(state.events, {
    at: event.now,
    kind: "contract_applied",
    summary: `contract migration applied: ${event.repo}/${event.migration_id}`,
    detail: { repo: event.repo, migration_id: event.migration_id },
  });
  return { ok: true, state: next };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * state が「以降の遷移を受け付けない」終了 state か。
 *
 * `flipped` は **terminal ではない**: rollback と contract_applied を受ける
 * 中間定常 state。本関数の対象は rolled-back / failed / aborted の 3 つ。
 */
export function isTerminal(state: WaveStateName): boolean {
  return state === "rolled-back" || state === "failed" || state === "aborted";
}

function fail(code: TransitionErrorCode, error: string): TransitionResult {
  return { ok: false, code, error };
}

/**
 * 浅い clone (= 配列 / RepoState / RollbackSafety / events は新 instance) を返す。
 * pure transition の immutability を担保する。
 */
function cloneWaveForUpdate(s: WaveState): WaveState {
  return {
    ...s,
    repos: s.repos.map((r) => ({ ...r })),
    rollback: { ...s.rollback },
    events: s.events.slice(),
  };
}

function appendEvent(
  events: readonly WaveEventRecord[],
  record: WaveEventRecord,
): WaveEventRecord[] {
  return [...events, record];
}
