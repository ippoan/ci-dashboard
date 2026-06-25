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
    // traffic:: record を持つ worker なので flip 機構は traffic (= wrangler
    // versions deploy)。version / tag は pending-release:: 由来 (durable, tagged)。
    expect(out[0]).toMatchObject({ repo, version_id: V, source: "traffic", tag: "v0.0.21" });
    // rollback 先 = 現 active (old)。
    expect(out[0]?.rollback_to).toBe("old-v0-0-20");
  });

  // 実害 (Refs #427 monorepo flip): release deploy 後も「未tag — flip不可」のまま
  // だった。原因の合わせ技 ——
  //  (1) report-traffic-split は propagation lag で upload 直後の version を
  //      `wrangler versions list` に含められず、traffic:: の最新 0% は 1 つ前の
  //      untagged version (eb2c721d) になる。
  //  (2) 旧 computeUnifiedPending は traffic:: 由来 (untagged) を優先し、tag を持つ
  //      pending-release:: record (51b72b7f / v0.0.25) を shadow して捨てていた。
  // → tagged な真実 (pending-release::) を採用し、flip 機構は traffic に保つ。
  it("traffic:: の新しい untagged 0% に shadow されず pending-release:: の tagged version を出す", () => {
    const repo = "ippoan/nuxt-notify";
    const worker = "notify-realtime-bus";
    const ACTIVE = "1601602a-6672-4615-bc07-0f3ec0ece237"; // 現 100% (2026-06-03)
    const LAGGED = "eb2c721d-03e7-47f8-8e26-31f326ce8a6f"; // 1 つ前の untagged 0% (lag)
    const TAGGED = "51b72b7f-3522-45f4-8d81-98e51a1b1668"; // 今 release した version
    const trafficRecords: TrafficRecord[] = [
      {
        schema_version: 4,
        repo,
        worker_name: worker,
        versions: [
          { version_id: ACTIVE, percentage: 100, created_on: "2026-06-03T16:20:24.948Z" },
          { version_id: LAGGED, percentage: 0, created_on: "2026-06-24T10:33:33.997Z" },
        ],
        reported_at: "2026-06-24T19:54:30.000Z",
      },
    ];
    const pendingRecords: PendingReleaseRecord[] = [
      {
        schema_version: 1,
        repo,
        worker_name: worker,
        version_id: TAGGED,
        tag: "v0.0.25",
        preview_url: null,
        uploaded_at: "2026-06-24T19:54:28.000Z",
      },
    ];

    const out = computeUnifiedPending(trafficRecords, pendingRecords);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      repo,
      worker_name: worker,
      version_id: TAGGED, // lag した eb2c721d ではなく tagged 51b72b7f
      tag: "v0.0.25",
      source: "traffic", // flip は wrangler versions deploy 51b72b7f@100%
      rollback_to: ACTIVE,
    });
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

  // per-worker 移行 (#428) 後に残った legacy repo-key (worker=null) の古い残骸を
  // version 比較で抑制する (Refs #427)。flip すると空 worker 名で 404 になる厄介者。
  it("legacy repo-key (worker=null) は同 repo の per-worker が新しければ version 比較で抑制", () => {
    const repo = "ippoan/nuxt-notify";
    // legacy: worker=null, v0.0.23 (古い残骸)
    const legacy: PendingReleaseRecord = {
      schema_version: 1,
      repo,
      version_id: "eb2c721d",
      tag: "v0.0.23",
      preview_url: null,
      uploaded_at: "2026-06-24T10:33:33.000Z",
    };
    // per-worker: worker=nuxt-notify, v0.0.25 (新しい真実)
    const perWorker: PendingReleaseRecord = {
      schema_version: 1,
      repo,
      worker_name: "nuxt-notify",
      version_id: "2d363eb3",
      tag: "v0.0.25",
      preview_url: null,
      uploaded_at: "2026-06-24T19:55:30.000Z",
    };
    const out = computeUnifiedPending([], [legacy, perWorker]);
    // legacy (v0.0.23) は抑制され、per-worker (v0.0.25) だけが残る。
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      repo,
      worker_name: "nuxt-notify",
      version_id: "2d363eb3",
      tag: "v0.0.25",
    });
  });

  it("単一 worker repo (per-worker 無し) の worker=null は抑制しない", () => {
    const repo = "ippoan/security-notification-app";
    const legacyOnly: PendingReleaseRecord = {
      schema_version: 1,
      repo,
      version_id: "859e6e82",
      tag: "v0.0.2",
      preview_url: null,
      uploaded_at: "2026-06-15T06:59:17.000Z",
    };
    const out = computeUnifiedPending([], [legacyOnly]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repo, worker_name: null, tag: "v0.0.2" });
  });

  it("cloudrun (traffic:: 無し) は pending-release:: source でそのまま出す", () => {
    const repo = "ippoan/rust-alc-api";
    const pendingRecords = [pending(repo, "pending-v0-0-82", "v0.0.82", "2026-06-03T22:18:19.000Z")];
    const out = computeUnifiedPending([], pendingRecords);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repo, source: "pending", tag: "v0.0.82" });
  });
});
