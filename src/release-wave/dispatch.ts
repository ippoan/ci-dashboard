/**
 * Release Wave dispatcher: DO state 遷移 → 各 caller repo への
 * `repository_dispatch` 発火を担当する。
 *
 * 設計の親 issue: ippoan/ci-dashboard#137 Phase 5 pre-req
 *
 * 構造:
 *   `decideDispatches(prev, next)` — 純粋関数。prev_state と next_state から
 *      どの repo にどの event_type で何の client_payload を投げるかを決める。
 *      DO / HTTP に依存しないため state.test.ts と同様に unit test できる。
 *
 *   `dispatchAll(env, dispatches)` — IO。各 Dispatch を GitHub API
 *      `POST /repos/:owner/:repo/dispatches` に並列で送る。失敗は per-repo
 *      ログに留め、wave 全体は止めない (= 1 repo の dispatch fail で他 repo の
 *      着火を阻害しないため)。
 */

import type { Env } from "../index";
import { githubApi, parseRepo, tokenForOrg } from "../github-api";
import type { WaveState } from "./types";
import type { WaveCompatibility } from "./compat";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type DispatchEventType =
  | "release-wave-stage"
  | "release-wave-flip"
  | "release-wave-rollback"
  | "release-wave-retest";

export interface Dispatch {
  /** "owner/name" 形式 */
  readonly repo: string;
  readonly event_type: DispatchEventType;
  readonly client_payload: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// Pure: decideDispatches
// ----------------------------------------------------------------------------

/**
 * prev/next state を比べて発火すべき dispatch を返す。
 *
 * 発火条件:
 *   prev=null            && next.state="staging"   → 全 repo に stage
 *   prev.state="pending-approval" && next.state="flipping" → 全 repo に flip
 *   prev.state="staging" && next.state="flipping"  → 全 repo に flip (auto policy)
 *   prev.state="flipped" && next.state="rolled-back" → 全 repo に rollback
 *
 * それ以外 (failed / aborted / stage_report 完了 / contract_applied 等) は
 * 発火しない。空配列を返す。
 *
 * @param prev 直前の state。`createWave` 直後は null。
 * @param next 遷移後の state。
 */
export function decideDispatches(
  prev: WaveState | null,
  next: WaveState,
): Dispatch[] {
  // start: null → staging
  if (prev === null && next.state === "staging") {
    return next.repos.map((r) => ({
      repo: r.repo,
      event_type: "release-wave-stage" as const,
      client_payload: {
        wave_id: next.wave_id,
        target_tag: r.target_tag,
        head_sha: r.head_sha,
      },
    }));
  }

  // flip: pending-approval → flipping (manual approve)
  //       staging          → flipping (auto policy)
  if (
    prev !== null &&
    next.state === "flipping" &&
    prev.state !== "flipping"
  ) {
    return next.repos.map((r) => ({
      repo: r.repo,
      event_type: "release-wave-flip" as const,
      client_payload: {
        wave_id: next.wave_id,
        target_tag: r.target_tag,
        head_sha: r.head_sha,
      },
    }));
  }

  // rollback: flipped → rolled-back
  if (
    prev !== null &&
    prev.state === "flipped" &&
    next.state === "rolled-back"
  ) {
    return next.repos.map((r) => ({
      repo: r.repo,
      event_type: "release-wave-rollback" as const,
      client_payload: {
        wave_id: next.wave_id,
        target_tag: r.target_tag,
        head_sha: r.head_sha,
        // rollback 戻し先 revision。cloudrun matrix は services 単位、cf-workers
        // は repo 単位なので両者を載せる (handler が選ぶ)。
        flip_from_revision: r.flip_from_revision,
        // cloudrun rollback handler が service ごとに引く想定の map。
        // 現在 schema 上 per-service 表現が無いため、handler 側は空の
        // map で fallback (= TODO Phase 5+ で per-service rollback target を
        // RepoState に持たせる)。
        rollback_target: {},
      },
    }));
  }

  return [];
}

// ----------------------------------------------------------------------------
// Pure: decideRetestDispatches (Refs #157 Phase B)
// ----------------------------------------------------------------------------

/**
 * compatibility matrix の赤 (= 現 backend image を未 test の frontend) に対し
 * `release-wave-retest` dispatch を作る。frontend 側 workflow が
 * `repository_dispatch: types: [release-wave-retest]` を受け、渡された
 * `backend_image` 相手に integration test を回して green なら ci-dashboard の
 * `frontend-test-report` webhook に report する想定。
 *
 * @param onlyFrontend 指定時はその "owner/name" 1 件だけに絞る (per-frontend
 *   "Re-test" ボタン用)。未指定なら全 red を対象 ("Re-test all reds")。
 */
export function decideRetestDispatches(
  wave_id: string,
  compat: WaveCompatibility,
  onlyFrontend?: string,
): Dispatch[] {
  const out: Dispatch[] = [];
  for (const b of compat.backends) {
    for (const m of b.matrix) {
      if (m.tested_against_target) continue; // green は skip
      if (onlyFrontend && m.frontend !== onlyFrontend) continue;
      out.push({
        repo: m.frontend,
        event_type: "release-wave-retest",
        client_payload: {
          wave_id,
          backend_repo: b.backend_repo,
          backend_image: b.current_image,
          prod_version: m.prod_version,
        },
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// IO: dispatchAll
// ----------------------------------------------------------------------------

/**
 * Dispatch[] を GitHub `POST /repos/:owner/:repo/dispatches` に並列送信。
 *
 * 失敗 (= GitHub API non-2xx / token 取得失敗) はログのみ残し、Promise は
 * 個別 settle で集約する。1 件失敗で他の dispatch を止めると wave が部分
 * 着火状態で hang するため、最大 best-effort。
 *
 * @returns 全 dispatch の結果配列 (caller 側で metric / log に使う)。
 */
export async function dispatchAll(
  env: Env,
  dispatches: ReadonlyArray<Dispatch>,
): Promise<
  Array<
    | { ok: true; repo: string; event_type: string }
    | { ok: false; repo: string; event_type: string; error: string }
  >
> {
  if (dispatches.length === 0) return [];
  const settled = await Promise.allSettled(
    dispatches.map((d) => dispatchOne(env, d)),
  );
  return settled.map((s, i) => {
    const d = dispatches[i]!;
    if (s.status === "fulfilled") {
      return { ok: true, repo: d.repo, event_type: d.event_type };
    }
    return {
      ok: false,
      repo: d.repo,
      event_type: d.event_type,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });
}

async function dispatchOne(env: Env, d: Dispatch): Promise<void> {
  const { owner, repo } = parseRepo(d.repo);
  const token = await tokenForOrg(env, owner);
  await githubApi(
    token,
    "POST",
    `/repos/${owner}/${repo}/dispatches`,
    {
      event_type: d.event_type,
      client_payload: d.client_payload,
    },
  );
}
