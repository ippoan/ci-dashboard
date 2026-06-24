import { describe, expect, it } from "vitest";

import {
  computeUnifiedPending,
  type PendingReleaseRecord,
} from "../../src/release-wave/pending-release";
import type { TrafficRecord, TrafficVersion } from "../../src/release-wave/traffic";

function traffic(repo: string, versions: TrafficVersion[]): TrafficRecord {
  return {
    schema_version: 4,
    repo,
    versions,
    reported_at: "2026-06-03T23:52:00.000Z",
  };
}

function pending(
  repo: string,
  version_id: string,
  tag: string,
  uploaded_at: string,
): PendingReleaseRecord {
  return {
    schema_version: 1,
    repo,
    version_id,
    tag,
    preview_url: null,
    uploaded_at,
  };
}

describe("computeUnifiedPending — flip 済みの stale pending-release:: を出さない (Refs #248)", () => {
  // 実害: workers を flip すると traffic:: は 100% に更新されるが、deploy 時に
  // frontend-ci が作った pending-release:: は traffic-report で clear されない。
  // flip 済み version が pending-release:: source として漏れ「flip 済みなのに
  // Pending に残る」状態になっていた。
  it("flip 済み (traffic:: で当該 version が active) なら Pending に出さない", () => {
    const repo = "ippoan/nuxt-notify";
    const V = "1601602a-6672-4615-bc07-0f3ec0ece237";
    const trafficRecords = [
      traffic(repo, [
        { version_id: V, percentage: 100, created_on: "2026-06-03T16:20:24.948Z" },
        { version_id: "old-v0-0-20", percentage: 0, created_on: "2026-06-03T13:04:11.020Z" },
      ]),
    ];
    const pendingRecords = [pending(repo, V, "v0.0.21", "2026-06-03T16:20:26.432Z")];

    const out = computeUnifiedPending(trafficRecords, pendingRecords);
    expect(out).toEqual([]);
  });

  it("未 flip (deploy 直後で traffic:: にまだ当該 version が無い) なら Pending に出す", () => {
    const repo = "ippoan/nuxt-notify";
    const V = "1601602a-6672-4615-bc07-0f3ec0ece237";
    // traffic:: は前回 flip した古い version しか知らない (deploy では traffic-report
    // が来ないため)。新 version V は pending-release:: にだけ存在する。
    const trafficRecords = [
      traffic(repo, [
        { version_id: "old-v0-0-20", percentage: 100, created_on: "2026-06-03T13:04:11.020Z" },
      ]),
    ];
    const pendingRecords = [pending(repo, V, "v0.0.21", "2026-06-03T16:20:26.432Z")];

    const out = computeUnifiedPending(trafficRecords, pendingRecords);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repo, version_id: V, source: "pending", tag: "v0.0.21" });
    // rollback 先 = 現 active (old)。
    expect(out[0]?.rollback_to).toBe("old-v0-0-20");
  });

  it("traffic:: source: active より新しい 0% promotable は traffic source で出す", () => {
    const repo = "ippoan/auth-worker";
    const Z = "newer-0pct";
    const trafficRecords = [
      traffic(repo, [
        { version_id: "active", percentage: 100, created_on: "2026-06-03T10:00:00.000Z" },
        { version_id: Z, percentage: 0, created_on: "2026-06-03T12:00:00.000Z" },
      ]),
    ];
    const out = computeUnifiedPending(trafficRecords, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repo, version_id: Z, source: "traffic" });
  });

  it("cloudrun (traffic:: 無し) は pending-release:: source でそのまま出す", () => {
    const repo = "ippoan/rust-alc-api";
    const pendingRecords = [pending(repo, "pending-v0-0-82", "v0.0.82", "2026-06-03T22:18:19.000Z")];
    const out = computeUnifiedPending([], pendingRecords);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repo, source: "pending", tag: "v0.0.82" });
  });
});
