/**
 * Release Wave 機構の MCP tools (10 個)。
 *
 * 設計の親 issue: ippoan/ci-dashboard#137
 *
 * 注: stage phase 撤去 (Refs ippoan/ci-workflows#96①) に伴い
 * `release_wave_start` / `release_wave_stage` tool は削除した。wave は Pending
 * releases / flip-all 経路で driven され、本 tool 群は status/approve/flip/
 * rollback/abort/fail/contract_applied の 7 個 +
 * operator が flip を起動する pending_flip / pending_flip_all の 2 個 (Refs #249)
 * = 計 9 個。
 * (`release_wave_fail` = stuck wave を terminal failed に落とす force-clear 経路)
 *
 * 各 tool は ReleaseWaveHub DO の RPC を 1:1 で呼び出す薄い wrapper。
 * 認証は MCP server 側 (auth-worker introspect) で済んでいる前提。
 * scope は全 tool 共通で `mcp.write` (read 系の status だけ `mcp.read` でも
 * 十分だが現状 scope 細分化していないので一律 mcp.write)。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../../index";
import type { ReleaseWaveHub, RpcResult } from "../../release-wave/do";
import type { WaveState } from "../../release-wave/types";
import { computeWaveCompatibility } from "../../release-wave/compat";
import {
  pendingFlipCore,
  pendingFlipAllCore,
  loadUnifiedPending,
} from "../../release-wave/api";
import { listPendingReleases } from "../../release-wave/pending-release";
import { listTrafficForReposPerWorker } from "../../release-wave/traffic";

// ----------------------------------------------------------------------------
// Hub helper
// ----------------------------------------------------------------------------

/** 単一 hub instance を取得 (= 全 wave が同 DO instance に集約)。 */
function hubStub(env: Env): DurableObjectStub<ReleaseWaveHub> {
  const id = env.RELEASE_WAVE_HUB.idFromName("singleton");
  return env.RELEASE_WAVE_HUB.get(id) as DurableObjectStub<ReleaseWaveHub>;
}

/**
 * RpcResult → MCP response 形式に変換する共通ヘルパ。
 *
 * - 成功時: `WaveState` を JSON 整形して content text に乗せる
 * - 失敗時: `isError: true` で `{ code, error }` を返す。MCP client (= operator
 *   や Claude Code) は code を読んで分岐できる
 */
function formatRpcResult(
  result: { ok: true; data: WaveState } | { ok: false; code: string; error: string },
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ code: result.code, error: result.error }, null, 2),
      },
    ],
    isError: true,
  };
}

// ----------------------------------------------------------------------------
// Tool registration
// ----------------------------------------------------------------------------

export function registerReleaseWaveTools(server: McpServer, env: Env): void {
  // ============================================================
  // release_wave_status
  // ============================================================
  server.registerTool(
    "release_wave_status",
    {
      description:
        "Get the current state of a wave (state machine status, repo progress, rollback safety flag, audit events) plus a compatibility matrix of already-deployed frontends vs each backend's current image. Refs ippoan/ci-dashboard#157.",
      inputSchema: {
        wave_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ wave_id }) => {
      const result = (await hubStub(env).get(wave_id)) as RpcResult<WaveState>;
      if (!result.ok) return formatRpcResult(result);

      // compatibility field を付与 (Refs #157 Phase A)。COMPAT_KV 未 bind 時は
      // 省略する。算出失敗時も state は返す。
      let compatibility: unknown;
      if (env.COMPAT_KV) {
        try {
          compatibility = await computeWaveCompatibility(
            env.COMPAT_KV,
            result.data.repos.map((r) => r.repo),
          );
        } catch {
          compatibility = undefined;
        }
      }

      const payload =
        compatibility === undefined
          ? result.data
          : { ...result.data, compatibility };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  // ============================================================
  // release_wave_approve
  // ============================================================
  server.registerTool(
    "release_wave_approve",
    {
      description:
        "Admin approves a pending-approval wave to proceed to flipping. Required for manual-approval policy. Rejected with COMPATIBILITY_GATE if a require_compatibility backend has untested frontends — pass force=true to override.",
      inputSchema: {
        wave_id: z.string().min(1),
        approved_by: z
          .string()
          .min(1)
          .describe(
            "Email or identifier of the admin approving (recorded in audit trail)",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Override the compatibility gate (Refs #157 Phase C). Default false (gate enforced).",
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ wave_id, approved_by, force }) => {
      const result = await hubStub(env).approve({
        wave_id,
        approved_by,
        force: force === true,
      });
      return formatRpcResult(result);
    },
  );

  // ============================================================
  // release_wave_flip
  // ============================================================
  // 注: 親 issue では `release_wave_flip` = "operator override (admin 不在時
  // force flip)" と書かれているが、Phase 3b の DO には override に該当する
  // 状態遷移が無い (= 純粋 state machine の transition list にも含まれない)。
  //
  // 一方で「各 repo handler が flip 完了を ci-dashboard に通知する経路」が
  // tool として欠けていると wave が flipped 状態に進めないので、ここでは
  // **per-repo flip callback** として実装する。operator override は将来別 tool
  // として追加検討。
  server.registerTool(
    "release_wave_flip",
    {
      description:
        "Callback from a repo's release-wave handler reporting flip completion. All repos done -> wave state becomes 'flipped'. Refs ippoan/ci-dashboard#137.",
      inputSchema: {
        wave_id: z.string().min(1),
        repo: z.string().describe("owner/name reporting flip result"),
        ok: z.boolean(),
        error: z.string().optional().describe("Error detail when ok=false"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ wave_id, repo, ok, error }) => {
      const result = await hubStub(env).flipReport({
        wave_id,
        repo,
        ok,
        error: error ?? null,
      });
      return formatRpcResult(result);
    },
  );

  // ============================================================
  // release_wave_rollback
  // ============================================================
  server.registerTool(
    "release_wave_rollback",
    {
      description:
        "Roll back a flipped wave to pre-flip revisions. Default refuses if rollback.safe=false (contract migration applied) — pass force=true to override (operator accepts manual DB recovery).",
      inputSchema: {
        wave_id: z.string().min(1),
        rolled_back_by: z
          .string()
          .min(1)
          .describe("Email or identifier of the operator triggering rollback"),
        force: z
          .boolean()
          .optional()
          .describe(
            "When rollback.safe=false (post-contract), force=true permits rollback at operator's discretion. Default false (refuse).",
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ wave_id, rolled_back_by, force }) => {
      const result = await hubStub(env).rollback({
        wave_id,
        rolled_back_by,
        force: force === true,
      });
      return formatRpcResult(result);
    },
  );

  // ============================================================
  // release_wave_abort
  // ============================================================
  server.registerTool(
    "release_wave_abort",
    {
      description:
        "Abort an in-progress wave before flipping. Valid only in staging / pending-approval states. After flip use rollback instead.",
      inputSchema: {
        wave_id: z.string().min(1),
        aborted_by: z.string().min(1),
        reason: z.string().min(1).describe("Free-form reason recorded in audit"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ wave_id, aborted_by, reason }) => {
      const result = await hubStub(env).abort({ wave_id, aborted_by, reason });
      return formatRpcResult(result);
    },
  );

  // ============================================================
  // release_wave_fail  (force-clear a stuck wave)
  // ============================================================
  server.registerTool(
    "release_wave_fail",
    {
      description:
        "Force-fail an in-progress wave to the terminal 'failed' state. Use to clear a stuck wave (e.g. a 'flipping' wave whose flip-report callback never arrived). Valid in staging / pending-approval / flipping; on a 'flipped' wave use rollback instead.",
      inputSchema: {
        wave_id: z.string().min(1),
        reason: z.string().min(1).describe("Free-form reason recorded in audit"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ wave_id, reason }) => {
      const result = await hubStub(env).fail({ wave_id, reason });
      return formatRpcResult(result);
    },
  );

  // ============================================================
  // release_wave_contract_applied
  // ============================================================
  server.registerTool(
    "release_wave_contract_applied",
    {
      description:
        "Notification from a repo's migration deploy that a 'contract' phase migration was applied. Flips wave.rollback.safe to false (= rollback refused without --force). Called from GitHub Actions step.",
      inputSchema: {
        wave_id: z.string().min(1),
        repo: z
          .string()
          .describe(
            "owner/name of the repo whose contract migration was applied",
          ),
        migration_id: z
          .string()
          .min(1)
          .describe("Migration file ID (e.g. '20260601_001_drop_legacy_token')"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ wave_id, repo, migration_id }) => {
      const result = await hubStub(env).contractApplied({
        wave_id,
        repo,
        migration_id,
      });
      return formatRpcResult(result);
    },
  );

  // ============================================================
  // release_wave_pending_state   (read-only 診断)
  // ============================================================
  // /release-wave の「Pending releases」が なぜ その状態かを CCoW から直接
  // 確認するための read-only tool。CF Access 保護でページを直接見れない環境から
  // 「どの version が active か / pending-release:: が残っているか / unified の
  // source・tag・flippable」を JSON で引く。page.ts の computeUnifiedPending と
  // 同一 source を使うので、画面表示と一致する (Refs #427)。
  server.registerTool(
    "release_wave_pending_state",
    {
      description:
        "Read-only diagnostic for /release-wave 'Pending releases'. Returns the unified pending list (repo, worker_name, version_id, tag, source, flippable, rollback_to) exactly as the page derives it, plus the raw pending-release:: records and per-worker traffic:: records (active/zero versions, deploy_history) for the involved repos. Use to diagnose 'I flipped but the dashboard still shows it / shows 未tag'. Optional repo filter (substring match on owner/name).",
      inputSchema: {
        repo: z
          .string()
          .optional()
          .describe(
            "Optional owner/name substring filter (e.g. 'nuxt-notify'). Omit for all.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo }) => {
      if (!env.COMPAT_KV) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { code: "KV_NOT_CONFIGURED", error: "COMPAT_KV is not bound" },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      const match = (r: string): boolean => !repo || r.includes(repo);
      const unifiedAll = await loadUnifiedPending(env);
      const pendingAll = await listPendingReleases(env.COMPAT_KV);
      // unified / pending に出る repo の生 traffic を per-worker で引く。
      const repos = new Set<string>();
      for (const u of unifiedAll) repos.add(u.repo);
      for (const p of pendingAll) repos.add(p.repo);
      let trafficAll: Awaited<
        ReturnType<typeof listTrafficForReposPerWorker>
      > = [];
      try {
        trafficAll = await listTrafficForReposPerWorker(env.COMPAT_KV, repos);
      } catch {
        trafficAll = [];
      }
      const payload = {
        unified: unifiedAll.filter((u) => match(u.repo)),
        pending: pendingAll.filter((p) => match(p.repo)),
        traffic: trafficAll
          .filter((t) => match(t.repo))
          .map((t) => ({
            repo: t.repo,
            worker_name: t.worker_name ?? null,
            reported_at: t.reported_at,
            active: (t.versions ?? [])
              .filter((v) => v.percentage > 0)
              .map((v) => ({
                version_id: v.version_id,
                percentage: v.percentage,
                created_on: v.created_on ?? null,
                tag: v.tag ?? null,
              })),
            zero: (t.versions ?? [])
              .filter((v) => v.percentage <= 0)
              .slice(0, 8)
              .map((v) => ({
                version_id: v.version_id,
                created_on: v.created_on ?? null,
                tag: v.tag ?? null,
              })),
            deploy_history: (t.deploy_history ?? []).slice(0, 5),
          })),
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
      };
    },
  );

  // ============================================================
  // release_wave_pending_flip   (operator が単一 repo を flip 起動)
  // ============================================================
  // 注: 上の release_wave_flip は per-repo flip "callback" (handler →
  // ci-dashboard) で、operator が flip を起動する口ではない。こちらは
  // /release-wave の「Flip」ボタンと同じ経路を MCP から叩く: pending release
  // (release CI が報告した no-traffic version) を 100% traffic へ promote する。
  // wave state machine は経由しない。
  server.registerTool(
    "release_wave_pending_flip",
    {
      description:
        "Flip a single repo's pending release (the no-traffic version its release CI reported) to 100% traffic, without the wave state machine. Mirrors the /release-wave 'Flip' button. cloudrun promotes the latest-ready revision; workers deploys the previewed version at 100%. The actual flip runs in GitHub Actions (no callback); inspect the run for the result.",
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe("owner/name whose pending release to flip to 100%"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ repo }) => {
      const result = await pendingFlipCore(env, repo);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );

  // ============================================================
  // release_wave_pending_flip_all   (wave 一括 flip 起動)
  // ============================================================
  // /release-wave の「Flip all」ボタンと同じ経路。全 pending release を一括
  // flip し、flip-group を記録する (= 後で一括 rollback できるよう戻し先を確保)。
  server.registerTool(
    "release_wave_pending_flip_all",
    {
      description:
        "Flip ALL pending releases (no-traffic versions across repos) to 100% traffic at once — the /release-wave 'Flip all' button. Records a flip-group so the same set can be rolled back together. Returns the list of flipped repos; no-op (flipped:[]) when nothing is pending.",
      inputSchema: {
        flipped_by: z
          .string()
          .min(1)
          .describe(
            "Email or identifier of the operator (recorded in the flip-group audit trail)",
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ flipped_by }) => {
      const result = await pendingFlipAllCore(env, flipped_by);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
}
