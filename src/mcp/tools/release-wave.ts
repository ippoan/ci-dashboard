/**
 * Release Wave 機構の MCP tools (8 個)。
 *
 * 設計の親 issue: ippoan/ci-dashboard#137
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
  // release_wave_start
  // ============================================================
  server.registerTool(
    "release_wave_start",
    {
      description:
        "Start a new release wave coordinating multiple repos. Stages each repo, optionally gates on admin approval, then flips traffic atomically. Refs ippoan/ci-dashboard#137.",
      inputSchema: {
        wave_id: z
          .string()
          .min(1)
          .describe("Unique wave identifier (e.g. 'wave_2026_05_27_01')"),
        flip_policy: z
          .enum(["manual-approval", "auto"])
          .describe(
            "manual-approval: wait for admin approval after stage; auto: flip as soon as all stage complete",
          ),
        note: z.string().optional().describe("Free-form note (e.g. release theme)"),
        repos: z
          .array(
            z.object({
              repo: z.string().describe("owner/name (e.g. 'ippoan/rust-alc-api')"),
              target_tag: z
                .string()
                .describe("Tag to be cut for this wave (e.g. 'v1.42.0')"),
              head_sha: z.string().describe("HEAD SHA at wave start"),
              require_compatibility: z
                .boolean()
                .optional()
                .describe(
                  "When true (backend repos), approve is rejected while any consuming frontend is untested against this backend's current image. Default false. Refs #157 Phase C.",
                ),
            }),
          )
          .min(1)
          .describe("Repos participating in this wave"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ wave_id, flip_policy, note, repos }) => {
      const result = await hubStub(env).start({
        wave_id,
        flip_policy,
        note: note ?? "",
        repos,
      });
      return formatRpcResult(result);
    },
  );

  // ============================================================
  // release_wave_stage
  // ============================================================
  server.registerTool(
    "release_wave_stage",
    {
      description:
        "Callback from a repo's release-wave handler reporting stage completion. ok=true means staged successfully (with preview_url & flip_from_revision); ok=false fails the whole wave. Refs ippoan/ci-dashboard#137.",
      inputSchema: {
        wave_id: z.string().min(1),
        repo: z.string().describe("owner/name reporting the stage result"),
        ok: z.boolean(),
        preview_url: z
          .string()
          .url()
          .optional()
          .describe("Admin-only preview URL (CF Access gated). Set when ok=true."),
        flip_from_revision: z
          .string()
          .optional()
          .describe(
            "Pre-flip latest revision (= rollback target). Set when ok=true.",
          ),
        previewed_version_id: z
          .string()
          .optional()
          .describe(
            "CF Workers no-traffic version id that was previewed (= flip target). Set when ok=true.",
          ),
        error: z.string().optional().describe("Error detail when ok=false."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ wave_id, repo, ok, preview_url, flip_from_revision, previewed_version_id, error }) => {
      const result = await hubStub(env).stageReport({
        wave_id,
        repo,
        ok,
        preview_url: preview_url ?? null,
        flip_from_revision: flip_from_revision ?? null,
        previewed_version_id: previewed_version_id ?? null,
        error: error ?? null,
      });
      return formatRpcResult(result);
    },
  );

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
  // **per-repo flip callback** として実装する (`release_wave_stage` の flip
  // 版)。operator override は将来別 tool として追加検討。
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
}
