import { describe, it, expect } from "vitest";
import {
  HUB_STALE_IN_PROGRESS_MS,
  STALE_RECHECK_ALARM_MS,
  pickStaleInProgressRuns,
} from "../src/hub";
import type { CIStatus } from "../src/webhook";

const NOW = new Date("2026-06-17T12:00:00Z").getTime();

function mk(
  run_id: number,
  status: string,
  ageMs: number,
  overrides: Partial<CIStatus> = {},
): CIStatus {
  const updated = new Date(NOW - ageMs).toISOString();
  return {
    repo: "ippoan/example",
    workflow: "CI",
    branch: "main",
    status,
    conclusion: status === "completed" ? "success" : null,
    run_id,
    run_url: `https://github.com/ippoan/example/actions/runs/${run_id}`,
    actor: "yhonda-ohishi",
    updated_at: updated,
    started_at: updated,
    ...overrides,
  };
}

describe("pickStaleInProgressRuns", () => {
  it("1h 以上前の in_progress run を拾う", () => {
    const runs = [mk(1, "in_progress", 2 * 60 * 60 * 1000)];
    const stale = pickStaleInProgressRuns(runs, NOW, HUB_STALE_IN_PROGRESS_MS);
    expect(stale.map((s) => s.run_id)).toEqual([1]);
  });

  it("1h 未満の in_progress run は除外する", () => {
    const runs = [mk(2, "in_progress", 30 * 60 * 1000)];
    const stale = pickStaleInProgressRuns(runs, NOW, HUB_STALE_IN_PROGRESS_MS);
    expect(stale).toEqual([]);
  });

  it("status === completed は age に関係なく除外する", () => {
    const runs = [mk(3, "completed", 30 * 24 * 60 * 60 * 1000)];
    const stale = pickStaleInProgressRuns(runs, NOW, HUB_STALE_IN_PROGRESS_MS);
    expect(stale).toEqual([]);
  });

  it("queued (in_progress 以外の非 completed) も stale 対象に含む", () => {
    // GitHub workflow run の status は in_progress / queued / waiting 等あり、
    // どれも `!== completed` なので picker は等しく拾う。recheck 自体が
    // GitHub の current state で上書きするので overshoot で副作用は無い。
    const runs = [mk(4, "queued", 2 * 60 * 60 * 1000)];
    const stale = pickStaleInProgressRuns(runs, NOW, HUB_STALE_IN_PROGRESS_MS);
    expect(stale.map((s) => s.run_id)).toEqual([4]);
  });

  it("updated_at が parse 不能 (NaN) は除外する", () => {
    const runs = [mk(5, "in_progress", 0, { updated_at: "not-a-date" })];
    const stale = pickStaleInProgressRuns(runs, NOW, HUB_STALE_IN_PROGRESS_MS);
    expect(stale).toEqual([]);
  });

  it("複数 run のうち stale だけを抽出する", () => {
    const runs = [
      mk(10, "in_progress", 30 * 60 * 1000), // fresh
      mk(11, "in_progress", 2 * 60 * 60 * 1000), // stale
      mk(12, "completed", 5 * 60 * 60 * 1000), // completed
      mk(13, "in_progress", 12 * 24 * 60 * 60 * 1000), // very stale
      mk(14, "queued", 90 * 60 * 1000), // stale (queued)
    ];
    const stale = pickStaleInProgressRuns(runs, NOW, HUB_STALE_IN_PROGRESS_MS);
    expect(stale.map((s) => s.run_id).sort()).toEqual([11, 13, 14]);
  });

  it("ちょうど境界 (staleMs ぴったり) は含む (>= 比較ではなく >=staleMs)", () => {
    const runs = [mk(20, "in_progress", HUB_STALE_IN_PROGRESS_MS)];
    const stale = pickStaleInProgressRuns(runs, NOW, HUB_STALE_IN_PROGRESS_MS);
    expect(stale.map((s) => s.run_id)).toEqual([20]);
  });

  it("HUB_STALE_IN_PROGRESS_MS は index.ts と同値の 1h", () => {
    expect(HUB_STALE_IN_PROGRESS_MS).toBe(60 * 60 * 1000);
  });

  it("STALE_RECHECK_ALARM_MS は 10 min", () => {
    expect(STALE_RECHECK_ALARM_MS).toBe(10 * 60 * 1000);
  });
});
