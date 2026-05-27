/**
 * Release Wave 機構の Durable Object 層。
 *
 * Phase 3a で実装した純粋 state machine (`state.ts` + `types.ts`) の
 * DO wrapper。1 DO instance (singleton) に全 wave を records として持ち、
 * storage key prefix `wave:` で iterate する。
 *
 * 1 DO に集約する理由 (vs 1 wave 1 instance):
 * - listing/UI で全 wave を 1 storage.list で取れる
 * - alarm() で全 in-progress wave を一括 poll できる (= barrier 監視)
 * - serial enforcement (= 同時 in-progress は 1 wave のみ) を start 時に
 *   全 records を見て判定できる
 *
 * 設計の親 issue: ippoan/ci-dashboard#137
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import {
  createWave,
  isTerminal,
  transition,
} from "./state";
import type {
  FlipPolicy,
  TransitionErrorCode,
  WaveEvent,
  WaveState,
} from "./types";

// ----------------------------------------------------------------------------
// Storage keys
// ----------------------------------------------------------------------------

/** storage key prefix。1 wave 1 record。 */
const WAVE_KEY_PREFIX = "wave:";

function waveKey(wave_id: string): string {
  return `${WAVE_KEY_PREFIX}${wave_id}`;
}

// ----------------------------------------------------------------------------
// RPC input / output shapes
// ----------------------------------------------------------------------------

export interface StartInput {
  wave_id: string;
  flip_policy: FlipPolicy;
  note?: string;
  repos: Array<{ repo: string; target_tag: string; head_sha: string }>;
}

export interface StageReportInput {
  wave_id: string;
  repo: string;
  ok: boolean;
  preview_url?: string | null;
  flip_from_revision?: string | null;
  error?: string | null;
}

export interface ApproveInput {
  wave_id: string;
  approved_by: string;
}

export interface FlipReportInput {
  wave_id: string;
  repo: string;
  ok: boolean;
  error?: string | null;
}

export interface RollbackInput {
  wave_id: string;
  rolled_back_by: string;
  force?: boolean;
}

export interface AbortInput {
  wave_id: string;
  aborted_by: string;
  reason: string;
}

export interface FailInput {
  wave_id: string;
  reason: string;
}

export interface ContractAppliedInput {
  /** wave_id は明示せず repo + 最新 flipped wave を逆引きする経路もあるが、
   *  まず明示 API で実装。後で逆引きヘルパを足す。 */
  wave_id: string;
  repo: string;
  migration_id: string;
}

/** RPC で返す統一エラー型。HTTP / MCP 層でそのまま status code に map できる。 */
export interface RpcError {
  code: TransitionErrorCode | "NOT_FOUND" | "ALREADY_EXISTS" | "WAVE_IN_PROGRESS";
  error: string;
}

export type RpcResult<T> = { ok: true; data: T } | { ok: false } & RpcError;

// ----------------------------------------------------------------------------
// DO 本体
// ----------------------------------------------------------------------------

export class ReleaseWaveHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // ============ life-cycle =========================================

  /**
   * 新規 wave を開始する。serial enforcement:
   * - 同 wave_id が既存 → ALREADY_EXISTS
   * - 他の in-progress wave (= 非 terminal かつ 非 flipped) が存在 → WAVE_IN_PROGRESS
   *   flipped は安定状態 (= 並行 hotfix wave 受容) として除外する。
   */
  async start(input: StartInput): Promise<RpcResult<WaveState>> {
    const existing = await this.loadWave(input.wave_id);
    if (existing) {
      return { ok: false, code: "ALREADY_EXISTS", error: `wave ${input.wave_id} already exists` };
    }

    // serial enforcement
    const all = await this.listInternal();
    const blocking = all.find(
      (w) => !isTerminal(w.state) && w.state !== "flipped",
    );
    if (blocking) {
      return {
        ok: false,
        code: "WAVE_IN_PROGRESS",
        error: `another wave is in progress: ${blocking.wave_id} (state=${blocking.state})`,
      };
    }

    const now = new Date().toISOString();
    const state = createWave({
      wave_id: input.wave_id,
      flip_policy: input.flip_policy,
      note: input.note ?? "",
      repos: input.repos,
      now,
    });
    await this.saveWave(state);
    return { ok: true, data: state };
  }

  // ============ per-event handlers =================================

  async stageReport(input: StageReportInput): Promise<RpcResult<WaveState>> {
    return this.applyEvent(input.wave_id, {
      kind: "stage_report",
      now: new Date().toISOString(),
      repo: input.repo,
      ok: input.ok,
      preview_url: input.preview_url ?? null,
      flip_from_revision: input.flip_from_revision ?? null,
      error: input.error ?? null,
    });
  }

  async approve(input: ApproveInput): Promise<RpcResult<WaveState>> {
    return this.applyEvent(input.wave_id, {
      kind: "approve",
      now: new Date().toISOString(),
      approved_by: input.approved_by,
    });
  }

  async flipReport(input: FlipReportInput): Promise<RpcResult<WaveState>> {
    return this.applyEvent(input.wave_id, {
      kind: "flip_report",
      now: new Date().toISOString(),
      repo: input.repo,
      ok: input.ok,
      error: input.error ?? null,
    });
  }

  async rollback(input: RollbackInput): Promise<RpcResult<WaveState>> {
    return this.applyEvent(input.wave_id, {
      kind: "rollback",
      now: new Date().toISOString(),
      rolled_back_by: input.rolled_back_by,
      force: input.force === true,
    });
  }

  async abort(input: AbortInput): Promise<RpcResult<WaveState>> {
    return this.applyEvent(input.wave_id, {
      kind: "abort",
      now: new Date().toISOString(),
      aborted_by: input.aborted_by,
      reason: input.reason,
    });
  }

  async fail(input: FailInput): Promise<RpcResult<WaveState>> {
    return this.applyEvent(input.wave_id, {
      kind: "fail",
      now: new Date().toISOString(),
      reason: input.reason,
    });
  }

  async contractApplied(input: ContractAppliedInput): Promise<RpcResult<WaveState>> {
    return this.applyEvent(input.wave_id, {
      kind: "contract_applied",
      now: new Date().toISOString(),
      repo: input.repo,
      migration_id: input.migration_id,
    });
  }

  // ============ readers =============================================

  /** wave を 1 件取得。存在しなければ NOT_FOUND。 */
  async get(wave_id: string): Promise<RpcResult<WaveState>> {
    const w = await this.loadWave(wave_id);
    if (!w) {
      return { ok: false, code: "NOT_FOUND", error: `wave ${wave_id} not found` };
    }
    return { ok: true, data: w };
  }

  /** 全 wave を started_at 降順で返す (新しい順)。 */
  async list(): Promise<WaveState[]> {
    const all = await this.listInternal();
    return all.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  }

  // ============ private helpers ====================================

  /**
   * apply 共通: load → transition → save。state machine 側 INVALID_TRANSITION 等は
   * そのまま RpcError として穴抜けで返す。
   */
  private async applyEvent(
    wave_id: string,
    event: WaveEvent,
  ): Promise<RpcResult<WaveState>> {
    const state = await this.loadWave(wave_id);
    if (!state) {
      return { ok: false, code: "NOT_FOUND", error: `wave ${wave_id} not found` };
    }
    const result = transition(state, event);
    if (!result.ok) {
      return { ok: false, code: result.code, error: result.error };
    }
    await this.saveWave(result.state);
    return { ok: true, data: result.state };
  }

  private async loadWave(wave_id: string): Promise<WaveState | null> {
    const v = await this.ctx.storage.get<WaveState>(waveKey(wave_id));
    return v ?? null;
  }

  private async saveWave(state: WaveState): Promise<void> {
    await this.ctx.storage.put(waveKey(state.wave_id), state);
  }

  /** 全 wave を storage から取り出す (内部 helper)。listing 順は呼び出し側で sort。 */
  private async listInternal(): Promise<WaveState[]> {
    const map = await this.ctx.storage.list<WaveState>({
      prefix: WAVE_KEY_PREFIX,
    });
    return Array.from(map.values());
  }
}
