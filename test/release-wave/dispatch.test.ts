import { describe, it, expect } from "vitest";
import {
  decideDispatches,
  decideRetestDispatches,
} from "../../src/release-wave/dispatch";
import { createWave, transition } from "../../src/release-wave/state";
import type { WaveState } from "../../src/release-wave/types";
import type {
  WaveCompatibility,
  CompatMatrixEntry,
} from "../../src/release-wave/compat";

const T0 = "2026-05-28T00:00:00Z";
const T1 = "2026-05-28T00:05:00Z";
const T2 = "2026-05-28T00:10:00Z";

function makeWave(opts: { flip_policy?: "manual-approval" | "auto" } = {}): WaveState {
  return createWave({
    wave_id: "w1",
    flip_policy: opts.flip_policy ?? "manual-approval",
    note: "test",
    repos: [
      { repo: "ippoan/rust-alc-api", target_tag: "v1.1.0", head_sha: "sha-a" },
      { repo: "ippoan/auth-worker", target_tag: "v0.5.0", head_sha: "sha-b" },
    ],
    now: T0,
  });
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

// ============================================================================
// start (null → staging) → release-wave-stage to all repos
// ============================================================================

describe("decideDispatches: start", () => {
  it("emits release-wave-stage to all repos when wave starts", () => {
    const next = makeWave();
    const ds = decideDispatches(null, next);
    expect(ds).toHaveLength(2);
    expect(ds[0]).toMatchObject({
      repo: "ippoan/rust-alc-api",
      event_type: "release-wave-stage",
      client_payload: {
        wave_id: "w1",
        target_tag: "v1.1.0",
        head_sha: "sha-a",
      },
    });
    expect(ds[1]).toMatchObject({
      repo: "ippoan/auth-worker",
      event_type: "release-wave-stage",
      client_payload: {
        wave_id: "w1",
        target_tag: "v0.5.0",
        head_sha: "sha-b",
      },
    });
  });
});

// ============================================================================
// stage_report → no dispatch unless state moved to flipping
// ============================================================================

describe("decideDispatches: stage_report (mid-staging)", () => {
  it("does not dispatch when state stays staging (partial stage)", () => {
    const prev = makeWave();
    const next = ok(
      transition(prev, {
        kind: "stage_report",
        now: T1,
        repo: "ippoan/rust-alc-api",
        ok: true,
      }),
    ).state;
    expect(decideDispatches(prev, next)).toEqual([]);
  });

  it("does not dispatch when state moves to pending-approval (manual policy)", () => {
    let s = makeWave({ flip_policy: "manual-approval" });
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true })).state;
    const prev = s;
    const next = ok(
      transition(prev, {
        kind: "stage_report",
        now: T2,
        repo: "ippoan/auth-worker",
        ok: true,
      }),
    ).state;
    expect(next.state).toBe("pending-approval");
    expect(decideDispatches(prev, next)).toEqual([]);
  });

  it("emits release-wave-flip to all repos when auto policy stage completes", () => {
    let s = makeWave({ flip_policy: "auto" });
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true })).state;
    const prev = s;
    const next = ok(
      transition(prev, {
        kind: "stage_report",
        now: T2,
        repo: "ippoan/auth-worker",
        ok: true,
      }),
    ).state;
    expect(next.state).toBe("flipping");
    const ds = decideDispatches(prev, next);
    expect(ds).toHaveLength(2);
    expect(ds.every((d) => d.event_type === "release-wave-flip")).toBe(true);
  });

  it("does not dispatch when state moves to failed", () => {
    const prev = makeWave();
    const next = ok(
      transition(prev, {
        kind: "stage_report",
        now: T1,
        repo: "ippoan/rust-alc-api",
        ok: false,
        error: "build broke",
      }),
    ).state;
    expect(next.state).toBe("failed");
    expect(decideDispatches(prev, next)).toEqual([]);
  });
});

// ============================================================================
// approve → release-wave-flip
// ============================================================================

describe("decideDispatches: approve", () => {
  function pendingApprovalWave(): WaveState {
    let s = makeWave({ flip_policy: "manual-approval" });
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true })).state;
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/auth-worker", ok: true })).state;
    return s;
  }

  it("emits release-wave-flip to all repos when approved", () => {
    const prev = pendingApprovalWave();
    const next = ok(
      transition(prev, { kind: "approve", now: T2, approved_by: "ops@example.com" }),
    ).state;
    expect(next.state).toBe("flipping");
    const ds = decideDispatches(prev, next);
    expect(ds).toHaveLength(2);
    expect(ds[0]!.event_type).toBe("release-wave-flip");
    expect(ds[0]!.client_payload.wave_id).toBe("w1");
  });
});

// ============================================================================
// flip_report → no dispatch
// ============================================================================

describe("decideDispatches: flip_report", () => {
  function flippingWave(): WaveState {
    let s = makeWave({ flip_policy: "auto" });
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true })).state;
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/auth-worker", ok: true })).state;
    return s;
  }

  it("does not dispatch on partial flip", () => {
    const prev = flippingWave();
    const next = ok(
      transition(prev, { kind: "flip_report", now: T2, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    expect(decideDispatches(prev, next)).toEqual([]);
  });

  it("does not dispatch when flipped completes", () => {
    let s = flippingWave();
    s = ok(transition(s, { kind: "flip_report", now: T2, repo: "ippoan/rust-alc-api", ok: true })).state;
    const prev = s;
    const next = ok(
      transition(prev, { kind: "flip_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    expect(next.state).toBe("flipped");
    expect(decideDispatches(prev, next)).toEqual([]);
  });
});

// ============================================================================
// rollback → release-wave-rollback
// ============================================================================

describe("decideDispatches: rollback", () => {
  function flippedWave(): WaveState {
    let s = makeWave({ flip_policy: "auto" });
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true })).state;
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/auth-worker", ok: true })).state;
    s = ok(transition(s, { kind: "flip_report", now: T2, repo: "ippoan/rust-alc-api", ok: true })).state;
    s = ok(transition(s, { kind: "flip_report", now: T2, repo: "ippoan/auth-worker", ok: true })).state;
    return s;
  }

  it("emits release-wave-rollback to all repos", () => {
    const prev = flippedWave();
    const next = ok(
      transition(prev, { kind: "rollback", now: T2, rolled_back_by: "ops" }),
    ).state;
    expect(next.state).toBe("rolled-back");
    const ds = decideDispatches(prev, next);
    expect(ds).toHaveLength(2);
    expect(ds[0]!.event_type).toBe("release-wave-rollback");
    expect(ds[0]!.client_payload).toHaveProperty("flip_from_revision");
    expect(ds[0]!.client_payload).toHaveProperty("rollback_target");
  });

  it("includes flip_from_revision per repo when available", () => {
    let s = makeWave({ flip_policy: "auto" });
    s = ok(
      transition(s, {
        kind: "stage_report",
        now: T1,
        repo: "ippoan/rust-alc-api",
        ok: true,
        flip_from_revision: "rust-alc-api-old-rev",
      }),
    ).state;
    s = ok(
      transition(s, {
        kind: "stage_report",
        now: T1,
        repo: "ippoan/auth-worker",
        ok: true,
        flip_from_revision: "auth-worker-old-rev",
      }),
    ).state;
    s = ok(transition(s, { kind: "flip_report", now: T2, repo: "ippoan/rust-alc-api", ok: true })).state;
    s = ok(transition(s, { kind: "flip_report", now: T2, repo: "ippoan/auth-worker", ok: true })).state;
    const prev = s;
    const next = ok(
      transition(prev, { kind: "rollback", now: T2, rolled_back_by: "ops" }),
    ).state;
    const ds = decideDispatches(prev, next);
    expect(ds[0]!.client_payload.flip_from_revision).toBe("rust-alc-api-old-rev");
    expect(ds[1]!.client_payload.flip_from_revision).toBe("auth-worker-old-rev");
  });
});

// ============================================================================
// abort / fail / contract_applied → no dispatch
// ============================================================================

describe("decideDispatches: silent transitions", () => {
  it("does not dispatch on abort", () => {
    const prev = makeWave();
    const next = ok(
      transition(prev, {
        kind: "abort",
        now: T1,
        aborted_by: "ops",
        reason: "test",
      }),
    ).state;
    expect(decideDispatches(prev, next)).toEqual([]);
  });

  it("does not dispatch on fail", () => {
    const prev = makeWave();
    const next = ok(
      transition(prev, { kind: "fail", now: T1, reason: "boom" }),
    ).state;
    expect(decideDispatches(prev, next)).toEqual([]);
  });

  it("does not dispatch on contract_applied", () => {
    let s = makeWave({ flip_policy: "auto" });
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true })).state;
    s = ok(transition(s, { kind: "stage_report", now: T1, repo: "ippoan/auth-worker", ok: true })).state;
    s = ok(transition(s, { kind: "flip_report", now: T2, repo: "ippoan/rust-alc-api", ok: true })).state;
    s = ok(transition(s, { kind: "flip_report", now: T2, repo: "ippoan/auth-worker", ok: true })).state;
    const prev = s;
    const next = ok(
      transition(prev, {
        kind: "contract_applied",
        now: T2,
        repo: "ippoan/rust-alc-api",
        migration_id: "20260601_001_drop",
      }),
    ).state;
    expect(decideDispatches(prev, next)).toEqual([]);
  });
});

// ============================================================================
// decideRetestDispatches (Refs #157 Phase B)
// ============================================================================

function entry(over: Partial<CompatMatrixEntry>): CompatMatrixEntry {
  return {
    frontend: "ippoan/alc-app",
    prod_version: "v1",
    tested_against_target: false,
    tested_against_at: null,
    last_tested_image: "stale",
    history: [],
    ...over,
  };
}

function compat(over: Partial<WaveCompatibility> = {}): WaveCompatibility {
  return { verified: false, checked: true, backends: [], ...over };
}

describe("decideRetestDispatches", () => {
  it("returns empty when there are no reds", () => {
    const c = compat({
      backends: [
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "cur",
          matrix: [entry({ frontend: "ippoan/auth-worker", tested_against_target: true })],
        },
      ],
    });
    expect(decideRetestDispatches("w1", c)).toEqual([]);
  });

  it("dispatches release-wave-retest to each red frontend with payload", () => {
    const c = compat({
      backends: [
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "cur-img",
          matrix: [
            entry({ frontend: "ippoan/alc-app", prod_version: "v1.2.10" }),
            entry({ frontend: "ippoan/auth-worker", tested_against_target: true }),
          ],
        },
      ],
    });
    const ds = decideRetestDispatches("w1", c);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      repo: "ippoan/alc-app",
      event_type: "release-wave-retest",
      client_payload: {
        wave_id: "w1",
        backend_repo: "ippoan/rust-alc-api",
        backend_image: "cur-img",
        prod_version: "v1.2.10",
      },
    });
  });

  it("filters to a single frontend when onlyFrontend is given", () => {
    const c = compat({
      backends: [
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "cur",
          matrix: [
            entry({ frontend: "ippoan/alc-app" }),
            entry({ frontend: "ippoan/nuxt-items" }),
          ],
        },
      ],
    });
    const ds = decideRetestDispatches("w1", c, "ippoan/nuxt-items");
    expect(ds).toHaveLength(1);
    expect(ds[0]!.repo).toBe("ippoan/nuxt-items");
  });

  it("emits one dispatch per (frontend, backend) red across multiple backends", () => {
    const c = compat({
      backends: [
        {
          backend_repo: "ippoan/rust-alc-api",
          current_image: "img-a",
          matrix: [entry({ frontend: "ippoan/alc-app" })],
        },
        {
          backend_repo: "ippoan/cc-relay",
          current_image: "img-b",
          matrix: [entry({ frontend: "ippoan/alc-app" })],
        },
      ],
    });
    const ds = decideRetestDispatches("w1", c);
    expect(ds).toHaveLength(2);
    expect(ds.map((d) => d.client_payload.backend_repo)).toEqual([
      "ippoan/rust-alc-api",
      "ippoan/cc-relay",
    ]);
  });
});
