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
  WaveEventRecord,
  WaveState,
} from "./types";
import { decideDispatches, dispatchAll } from "./dispatch";
import { computeWaveCompatibility } from "./compat";

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
  repos: Array<{
    repo: string;
    target_tag: string;
    head_sha: string;
    require_compatibility?: boolean;
  }>;
}

export interface ApproveInput {
  wave_id: string;
  approved_by: string;
  /** compatibility gate を override する (Refs #157 Phase C)。default false。 */
  force?: boolean;
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

// 注: StageReportInput / stageReport は stage phase 撤去 (Refs ippoan/ci-workflows#96①)
// に伴い削除済み。wave は start 時点で flippable な state (auto → flipping /
// manual → pending-approval) になり、stage 完了 callback は存在しない。

/** RPC で返す統一エラー型。HTTP / MCP 層でそのまま status code に map できる。 */
export type RpcErrorCode =
  | TransitionErrorCode
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "WAVE_IN_PROGRESS"
  | "COMPATIBILITY_GATE";

export interface RpcError {
  code: RpcErrorCode;
  error: string;
}

/**
 * 全 RPC method 共通の結果型。
 *
 * 注意: `| ({ ok: false } & RpcError)` と書くと operator precedence で
 * narrowing が壊れる (= caller 側 `if (result.ok)` の後で result.data に
 * アクセスしても TS が false 分岐に詰まる)。明示的 object literal で
 * 両分岐を書く形に統一する。
 */
export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: RpcErrorCode; error: string };

// ----------------------------------------------------------------------------
// DO 本体
// ----------------------------------------------------------------------------

export class ReleaseWaveHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Hibernatable WebSocket の keep-alive。CIDashboardHub (`src/hub.ts`) と
    // 同じく ping → pong を runtime 内で自動応答させる (= wake させずに済む)。
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  // ============ live update (Hibernatable WebSocket) ===============

  /**
   * `/release-wave` ページの live 更新用 endpoint (Refs #275)。
   *
   *   GET /ws → WebSocketPair を accept して 101 を返す。以後この DO の
   *   state が変わる (= `saveWave` が走る) たびに `broadcast()` が「変わった
   *   よ」シグナルを送り、ブラウザ側 `live.js` が `location.reload()` する。
   *
   * Hibernatable WebSocket なのでアイドル中は hibernate され DO 課金ゼロ。
   * 表示は既存 SSR をそのまま使うため、ここでは差分 payload を作らず固定
   * 文字列 (`"reload"`) を流すだけにしている (XSS 面を増やさない)。
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not Found", { status: 404 });
  }

  /** 接続中の全 WebSocket に「変わった」シグナルを送る。 */
  broadcast(data = "reload"): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // client が既に切断済み — 無視する。
      }
    }
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
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
    // compatibility precheck (Refs #157 Phase A): 既 deploy frontend が wave 内
    // backend の現 image と整合しているかを突合し、赤があれば warning event を
    // 記録する。**block はしない**。
    await this.maybeRecordCompatWarning(state);
    // stage phase 撤去後 (Refs ippoan/ci-workflows#96①):
    //   auto policy   → createWave が直接 flipping を作る → flip dispatch を発火
    //   manual-approval → pending-approval で開始 → dispatch は無し (approve 待ち)
    // 失敗は best-effort で log/result に残す (dispatchAll は throw しない)。
    await this.maybeDispatch(null, state);
    return { ok: true, data: state };
  }

  // ============ per-event handlers =================================

  async approve(input: ApproveInput): Promise<RpcResult<WaveState>> {
    // compatibility gate (Refs #157 Phase C): require_compatibility=true な
    // backend に未 test frontend が居る場合、force でなければ approve を拒否。
    if (input.force !== true) {
      const wave = await this.loadWave(input.wave_id);
      if (!wave) {
        return { ok: false, code: "NOT_FOUND", error: `wave ${input.wave_id} not found` };
      }
      const blockers = await this.compatibilityGateBlockers(wave);
      if (blockers.length > 0) {
        return {
          ok: false,
          code: "COMPATIBILITY_GATE",
          error: `compatibility gate blocked approve: ${blockers.join("; ")} (pass force=true to override)`,
        };
      }
    }
    return this.applyEvent(input.wave_id, {
      kind: "approve",
      now: new Date().toISOString(),
      approved_by: input.approved_by,
    });
  }

  /**
   * `require_compatibility=true` な backend のうち、未 test frontend を持つものの
   * 説明文字列配列を返す (空 = gate 通過)。COMPAT_KV 未 bind / 算出失敗時は
   * best-effort で空 (= gate を素通り) にする。
   */
  private async compatibilityGateBlockers(wave: WaveState): Promise<string[]> {
    const required = wave.repos
      .filter((r) => r.require_compatibility)
      .map((r) => r.repo);
    if (required.length === 0 || !this.env.COMPAT_KV) return [];

    let compat;
    try {
      compat = await computeWaveCompatibility(
        this.env.COMPAT_KV,
        wave.repos.map((r) => r.repo),
      );
    } catch (e) {
      console.warn(`[release-wave] compat gate eval failed: ${String(e)}`);
      return [];
    }

    const blockers: string[] = [];
    for (const b of compat.backends) {
      if (!required.includes(b.backend_repo)) continue;
      const reds = b.matrix
        .filter((m) => !m.tested_against_target)
        .map((m) => m.frontend);
      if (reds.length > 0) {
        blockers.push(
          `${b.backend_repo}@${b.current_image ?? "?"}: untested frontend(s) ${reds.join(", ")}`,
        );
      }
    }
    return blockers;
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
    // 副作用: state 遷移に応じて caller repo へ repository_dispatch を発火。
    // approve → flipping (flip dispatch), rollback → rolled-back (rollback dispatch)
    // のいずれかで dispatchAll が走る。contract_applied / fail 等は
    // decideDispatches が空配列を返すので no-op。
    await this.maybeDispatch(state, result.state);
    return { ok: true, data: result.state };
  }

  /**
   * state 遷移 (prev → next) を受けて発火すべき dispatch を計算し、GitHub
   * `POST /repos/:owner/:repo/dispatches` で fan-out する。失敗は best-effort。
   *
   * 本来は ctx.waitUntil() で非同期に投げて DO method を即時 return したい
   * ところだが、テスト容易性 + state machine と dispatch の対応関係の透明性
   * を優先して同期的に await する。release wave の N=10 程度の参加 repo に
   * 並列 POST する HTTP 程度なら数秒で済むので許容範囲。
   */
  private async maybeDispatch(
    prev: WaveState | null,
    next: WaveState,
  ): Promise<void> {
    const dispatches = decideDispatches(prev, next);
    if (dispatches.length === 0) return;
    const results = await dispatchAll(this.env, dispatches);
    for (const r of results) {
      if (!r.ok) {
        console.warn(
          `[release-wave] dispatch failed: repo=${r.repo} event=${r.event_type}: ${r.error}`,
        );
      }
    }
  }

  /**
   * wave 内 backend の現 image に対し既 deploy frontend が test 済みかを突合し、
   * 赤があれば `compatibility_warning` event を append + save する。
   *
   * read-only な precheck (block しない)。COMPAT_KV 未 bind / KV エラー時は
   * best-effort で skip する (= wave start を失敗させない)。
   */
  private async maybeRecordCompatWarning(state: WaveState): Promise<void> {
    if (!this.env.COMPAT_KV) return;
    let compat;
    try {
      compat = await computeWaveCompatibility(
        this.env.COMPAT_KV,
        state.repos.map((r) => r.repo),
      );
    } catch (e) {
      console.warn(`[release-wave] compat precheck failed: ${String(e)}`);
      return;
    }
    if (!compat.checked || compat.verified) return;

    const reds = compat.backends.flatMap((b) =>
      b.matrix
        .filter((m) => !m.tested_against_target)
        .map((m) => `${m.frontend} (vs ${b.backend_repo}@${b.current_image})`),
    );
    const record: WaveEventRecord = {
      at: new Date().toISOString(),
      kind: "compatibility_warning",
      summary: `compatibility precheck: ${reds.length} frontend(s) not tested against current backend image`,
      detail: { reds },
    };
    state.events = [...state.events, record];
    await this.saveWave(state);
  }

  private async loadWave(wave_id: string): Promise<WaveState | null> {
    const v = await this.ctx.storage.get<WaveState>(waveKey(wave_id));
    return v ?? null;
  }

  private async saveWave(state: WaveState): Promise<void> {
    await this.ctx.storage.put(waveKey(state.wave_id), state);
    // 全 state 更新 (start/approve/flipReport/rollback/abort/fail/
    // contractApplied + compat warning) は saveWave を必ず通るので、ここ一点で
    // 全イベントを拾って live ページに「変わった」シグナルを送る (Refs #275)。
    this.broadcast();
  }

  /** 全 wave を storage から取り出す (内部 helper)。listing 順は呼び出し側で sort。 */
  private async listInternal(): Promise<WaveState[]> {
    const map = await this.ctx.storage.list<WaveState>({
      prefix: WAVE_KEY_PREFIX,
    });
    return Array.from(map.values());
  }
}
