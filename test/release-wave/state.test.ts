import { describe, it, expect } from "vitest";
import { createWave, isTerminal, transition } from "../../src/release-wave/state";
import type { WaveEvent, WaveState } from "../../src/release-wave/types";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const T0 = "2026-05-27T10:00:00Z";
const T1 = "2026-05-27T10:05:00Z";
const T2 = "2026-05-27T10:10:00Z";
const T3 = "2026-05-27T10:15:00Z";

function makeWave(
  opts: Partial<{
    wave_id: string;
    flip_policy: "manual-approval" | "auto";
    repos: Array<{ repo: string; target_tag: string; head_sha: string }>;
  }> = {},
): WaveState {
  return createWave({
    wave_id: opts.wave_id ?? "wave_test_01",
    flip_policy: opts.flip_policy ?? "manual-approval",
    note: "test wave",
    repos: opts.repos ?? [
      { repo: "ippoan/rust-alc-api", target_tag: "v1.1.0", head_sha: "sha-a" },
      { repo: "ippoan/auth-worker", target_tag: "v0.5.0", head_sha: "sha-b" },
    ],
    now: T0,
  });
}

function assertOk<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) {
    throw new Error("expected ok=true, got: " + JSON.stringify(r));
  }
  return r as Extract<T, { ok: true }>;
}

// ----------------------------------------------------------------------------
// createWave
// ----------------------------------------------------------------------------

describe("createWave", () => {
  it("creates initial state with all repos pending", () => {
    const w = makeWave();
    expect(w.state).toBe("staging");
    expect(w.wave_id).toBe("wave_test_01");
    expect(w.repos).toHaveLength(2);
    expect(w.repos[0]!.stage_status).toBe("pending");
    expect(w.repos[0]!.flip_status).toBe("pending");
    expect(w.repos[0]!.preview_url).toBeNull();
    expect(w.repos[0]!.flip_from_revision).toBeNull();
    expect(w.repos[0]!.previewed_version_id).toBeNull();
    expect(w.rollback.safe).toBe(true);
    expect(w.rollback.unsafe_reason).toBeNull();
    expect(w.started_at).toBe(T0);
    expect(w.staged_at).toBeNull();
    expect(w.events).toHaveLength(1);
    expect(w.events[0]!.kind).toBe("start");
  });
});

// ----------------------------------------------------------------------------
// isTerminal
// ----------------------------------------------------------------------------

describe("isTerminal", () => {
  it("classifies states correctly (flipped is NOT terminal)", () => {
    // flipped は中間定常 state: rollback / contract_applied を受けるため
    // terminal 扱いしない。完全終了は rolled-back / failed / aborted の 3 つ。
    expect(isTerminal("staging")).toBe(false);
    expect(isTerminal("pending-approval")).toBe(false);
    expect(isTerminal("flipping")).toBe(false);
    expect(isTerminal("flipped")).toBe(false);
    expect(isTerminal("rolled-back")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("aborted")).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// start event (= invalid on existing state)
// ----------------------------------------------------------------------------

describe("transition: start", () => {
  it("rejects start on existing wave (ALREADY_STARTED)", () => {
    const w = makeWave();
    const r = transition(w, { kind: "start", now: T1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("ALREADY_STARTED");
    }
  });
});

// ----------------------------------------------------------------------------
// stage_report
// ----------------------------------------------------------------------------

describe("transition: stage_report", () => {
  it("marks single repo as done, stays in staging until all done", () => {
    const w = makeWave();
    const r = assertOk(
      transition(w, {
        kind: "stage_report",
        now: T1,
        repo: "ippoan/rust-alc-api",
        ok: true,
        preview_url: "https://preview-rust-alc-api.ippoan.org",
        flip_from_revision: "rust-alc-api-00041-zzz",
        previewed_version_id: "11111111-2222-3333-4444-555555555555",
      }),
    );
    expect(r.state.state).toBe("staging");
    expect(r.state.repos[0]!.stage_status).toBe("done");
    expect(r.state.repos[0]!.preview_url).toBe(
      "https://preview-rust-alc-api.ippoan.org",
    );
    expect(r.state.repos[0]!.flip_from_revision).toBe("rust-alc-api-00041-zzz");
    expect(r.state.repos[0]!.previewed_version_id).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(r.state.repos[1]!.stage_status).toBe("pending");
    expect(r.state.staged_at).toBeNull();
  });

  it("transitions to pending-approval when all done (manual policy)", () => {
    let s = makeWave({ flip_policy: "manual-approval" });
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    expect(s.state).toBe("pending-approval");
    expect(s.staged_at).toBe(T2);
  });

  it("transitions to flipping when all done (auto policy)", () => {
    let s = makeWave({ flip_policy: "auto" });
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    expect(s.state).toBe("flipping");
    expect(s.staged_at).toBe(T2);
  });

  it("transitions to failed on any stage fail (does not wait for others)", () => {
    let s = makeWave();
    s = assertOk(
      transition(s, {
        kind: "stage_report",
        now: T1,
        repo: "ippoan/rust-alc-api",
        ok: false,
        error: "build failed",
      }),
    ).state;
    expect(s.state).toBe("failed");
    expect(s.failed_at).toBe(T1);
    expect(s.repos[0]!.stage_status).toBe("failed");
    expect(s.repos[0]!.stage_error).toBe("build failed");
    // The other repo stays pending (= barrier wasn't passed)
    expect(s.repos[1]!.stage_status).toBe("pending");
  });

  it("refuses re-report on already-failed repo (permanent)", () => {
    let s = makeWave();
    s = assertOk(
      transition(s, {
        kind: "stage_report",
        now: T1,
        repo: "ippoan/rust-alc-api",
        ok: false,
        error: "boom",
      }),
    ).state;
    // wave is in failed state now, but even if it weren't, re-reporting failed repo should reject.
    // Let's also test the early-state branch: construct another wave with 1 failed + 1 pending,
    // skipping the wave-level transition to failed.
    // Easier: directly test on the failed state, expecting TERMINAL_STATE.
    const r = transition(s, {
      kind: "stage_report",
      now: T2,
      repo: "ippoan/auth-worker",
      ok: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TERMINAL_STATE");
  });

  it("rejects stage_report outside staging state", () => {
    const s = makeWave({ flip_policy: "manual-approval" });
    let s1 = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s1 = assertOk(
      transition(s1, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    // now pending-approval
    const r = transition(s1, {
      kind: "stage_report",
      now: T3,
      repo: "ippoan/rust-alc-api",
      ok: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
  });

  it("rejects unknown repo (REPO_NOT_IN_WAVE)", () => {
    const s = makeWave();
    const r = transition(s, {
      kind: "stage_report",
      now: T1,
      repo: "ippoan/unrelated",
      ok: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("REPO_NOT_IN_WAVE");
  });

  it("preserves nullable fields when missing optional inputs", () => {
    const s = makeWave();
    const r = assertOk(
      transition(s, {
        kind: "stage_report",
        now: T1,
        repo: "ippoan/rust-alc-api",
        ok: true,
        // omit preview_url / flip_from_revision
      }),
    );
    expect(r.state.repos[0]!.preview_url).toBeNull();
    expect(r.state.repos[0]!.flip_from_revision).toBeNull();
  });

  it("attempts to re-report failed repo before wave-fail propagates (permanent guard)", () => {
    // Manually build a wave where 1 repo is failed but state is still staging — the wave
    // transition normally moves to "failed" immediately, but cover the permanent-guard
    // branch by constructing the intermediate state directly.
    const s = makeWave({
      repos: [
        { repo: "ippoan/a", target_tag: "v1", head_sha: "1" },
        { repo: "ippoan/b", target_tag: "v1", head_sha: "2" },
        { repo: "ippoan/c", target_tag: "v1", head_sha: "3" },
      ],
    });
    // Mutate a copy: mark only "a" failed without propagating to wave state.
    const tweaked: WaveState = {
      ...s,
      repos: s.repos.map((r, i) =>
        i === 0 ? { ...r, stage_status: "failed" as const, stage_error: "x" } : { ...r },
      ),
    };
    const r = transition(tweaked, {
      kind: "stage_report",
      now: T1,
      repo: "ippoan/a",
      ok: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
  });
});

// ----------------------------------------------------------------------------
// approve
// ----------------------------------------------------------------------------

describe("transition: approve", () => {
  function pendingApprovalWave(): WaveState {
    let s = makeWave({ flip_policy: "manual-approval" });
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    return s;
  }

  it("advances pending-approval -> flipping with actor recorded", () => {
    const s = pendingApprovalWave();
    const r = assertOk(
      transition(s, { kind: "approve", now: T3, approved_by: "ops@example.com" }),
    );
    expect(r.state.state).toBe("flipping");
    expect(r.state.approved_at).toBe(T3);
    expect(r.state.approved_by).toBe("ops@example.com");
  });

  it("rejects approve from staging state", () => {
    const s = makeWave();
    const r = transition(s, { kind: "approve", now: T1, approved_by: "ops" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
  });
});

// ----------------------------------------------------------------------------
// flip_report
// ----------------------------------------------------------------------------

describe("transition: flip_report", () => {
  function flippingWave(): WaveState {
    let s = makeWave({ flip_policy: "auto" });
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    return s;
  }

  it("marks single repo done, stays flipping until all done", () => {
    const s = flippingWave();
    const r = assertOk(
      transition(s, {
        kind: "flip_report",
        now: T3,
        repo: "ippoan/rust-alc-api",
        ok: true,
      }),
    );
    expect(r.state.state).toBe("flipping");
    expect(r.state.repos[0]!.flip_status).toBe("done");
    expect(r.state.flipped_at).toBeNull();
  });

  it("transitions to flipped when all done", () => {
    let s = flippingWave();
    s = assertOk(
      transition(s, { kind: "flip_report", now: T3, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "flip_report", now: T3, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    expect(s.state).toBe("flipped");
    expect(s.flipped_at).toBe(T3);
  });

  it("transitions to failed on any flip fail", () => {
    const s = flippingWave();
    const r = assertOk(
      transition(s, {
        kind: "flip_report",
        now: T3,
        repo: "ippoan/rust-alc-api",
        ok: false,
        error: "patch denied",
      }),
    );
    expect(r.state.state).toBe("failed");
    expect(r.state.repos[0]!.flip_status).toBe("failed");
    expect(r.state.repos[0]!.flip_error).toBe("patch denied");
  });

  it("rejects flip_report outside flipping", () => {
    const s = makeWave();
    const r = transition(s, {
      kind: "flip_report",
      now: T1,
      repo: "ippoan/rust-alc-api",
      ok: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
  });

  it("rejects unknown repo in flip_report", () => {
    const s = flippingWave();
    const r = transition(s, {
      kind: "flip_report",
      now: T3,
      repo: "ippoan/unrelated",
      ok: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("REPO_NOT_IN_WAVE");
  });

  it("rejects re-report on permanently failed flip", () => {
    // construct intermediate flipping state with 1 failed repo without propagating to wave state
    const base = flippingWave();
    const tweaked: WaveState = {
      ...base,
      repos: base.repos.map((r, i) =>
        i === 0 ? { ...r, flip_status: "failed" as const, flip_error: "x" } : { ...r },
      ),
    };
    const r = transition(tweaked, {
      kind: "flip_report",
      now: T3,
      repo: "ippoan/rust-alc-api",
      ok: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
  });

  it("uses default error message when ok=false and error missing", () => {
    const s = flippingWave();
    const r = assertOk(
      transition(s, {
        kind: "flip_report",
        now: T3,
        repo: "ippoan/rust-alc-api",
        ok: false,
      }),
    );
    expect(r.state.repos[0]!.flip_error).toBe("flip failed (no detail)");
  });

  it("uses default error message for stage when error missing", () => {
    const s = makeWave();
    const r = assertOk(
      transition(s, {
        kind: "stage_report",
        now: T1,
        repo: "ippoan/rust-alc-api",
        ok: false,
      }),
    );
    expect(r.state.repos[0]!.stage_error).toBe("stage failed (no detail)");
  });
});

// ----------------------------------------------------------------------------
// rollback
// ----------------------------------------------------------------------------

describe("transition: rollback", () => {
  function flippedWave(): WaveState {
    let s = makeWave({ flip_policy: "auto" });
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "flip_report", now: T2, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "flip_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    return s;
  }

  it("rolls back when safe=true", () => {
    const s = flippedWave();
    const r = assertOk(
      transition(s, {
        kind: "rollback",
        now: T3,
        rolled_back_by: "ops@example.com",
      }),
    );
    expect(r.state.state).toBe("rolled-back");
    expect(r.state.rolled_back_at).toBe(T3);
    expect(r.state.rolled_back_by).toBe("ops@example.com");
  });

  it("refuses rollback when unsafe and no force", () => {
    let s = flippedWave();
    s = assertOk(
      transition(s, {
        kind: "contract_applied",
        now: T2,
        repo: "ippoan/rust-alc-api",
        migration_id: "20260601_001_drop",
      }),
    ).state;
    const r = transition(s, {
      kind: "rollback",
      now: T3,
      rolled_back_by: "ops",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ROLLBACK_UNSAFE");
  });

  it("allows rollback when unsafe + force=true", () => {
    let s = flippedWave();
    s = assertOk(
      transition(s, {
        kind: "contract_applied",
        now: T2,
        repo: "ippoan/rust-alc-api",
        migration_id: "20260601_001_drop",
      }),
    ).state;
    const r = assertOk(
      transition(s, {
        kind: "rollback",
        now: T3,
        rolled_back_by: "ops",
        force: true,
      }),
    );
    expect(r.state.state).toBe("rolled-back");
    // event detail should record forced=true and the safety status at the time
    const last = r.state.events[r.state.events.length - 1]!;
    expect(last.kind).toBe("rollback");
    expect(last.detail).toMatchObject({ forced: true, rollback_safe_at_time: false });
  });

  it("rejects rollback from non-flipped state", () => {
    const s = makeWave();
    const r = transition(s, {
      kind: "rollback",
      now: T1,
      rolled_back_by: "ops",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
  });
});

// ----------------------------------------------------------------------------
// abort
// ----------------------------------------------------------------------------

describe("transition: abort", () => {
  it("aborts from staging", () => {
    const s = makeWave();
    const r = assertOk(
      transition(s, {
        kind: "abort",
        now: T1,
        aborted_by: "ops",
        reason: "ci broken",
      }),
    );
    expect(r.state.state).toBe("aborted");
    expect(r.state.aborted_at).toBe(T1);
  });

  it("aborts from pending-approval", () => {
    let s = makeWave({ flip_policy: "manual-approval" });
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    const r = assertOk(
      transition(s, {
        kind: "abort",
        now: T3,
        aborted_by: "ops",
        reason: "preview unhealthy",
      }),
    );
    expect(r.state.state).toBe("aborted");
  });

  it("rejects abort from flipping", () => {
    let s = makeWave({ flip_policy: "auto" });
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    // now flipping
    const r = transition(s, {
      kind: "abort",
      now: T3,
      aborted_by: "ops",
      reason: "too late",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
  });
});

// ----------------------------------------------------------------------------
// fail
// ----------------------------------------------------------------------------

describe("transition: fail", () => {
  it("fails wave from any non-terminal state", () => {
    const s = makeWave();
    const r = assertOk(transition(s, { kind: "fail", now: T1, reason: "boom" }));
    expect(r.state.state).toBe("failed");
    expect(r.state.failed_at).toBe(T1);
  });

  it("rejects fail on already-failed wave (terminal)", () => {
    let s = makeWave();
    s = assertOk(transition(s, { kind: "fail", now: T1, reason: "boom" })).state;
    const r = transition(s, { kind: "fail", now: T2, reason: "again" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TERMINAL_STATE");
  });
});

// ----------------------------------------------------------------------------
// contract_applied
// ----------------------------------------------------------------------------

describe("transition: contract_applied", () => {
  function flippedWave(): WaveState {
    let s = makeWave({ flip_policy: "auto" });
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "flip_report", now: T2, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "flip_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    return s;
  }

  it("flips rollback.safe to false on first contract_applied", () => {
    const s = flippedWave();
    const r = assertOk(
      transition(s, {
        kind: "contract_applied",
        now: T3,
        repo: "ippoan/rust-alc-api",
        migration_id: "20260601_001_drop",
      }),
    );
    expect(r.state.rollback.safe).toBe(false);
    expect(r.state.rollback.unsafe_since).toBe(T3);
    expect(r.state.rollback.unsafe_by_migration).toBe("20260601_001_drop");
    expect(r.state.rollback.unsafe_reason).toContain("20260601_001_drop");
  });

  it("is idempotent on subsequent contract_applied (keeps first migration_id)", () => {
    let s = flippedWave();
    s = assertOk(
      transition(s, {
        kind: "contract_applied",
        now: T2,
        repo: "ippoan/rust-alc-api",
        migration_id: "first",
      }),
    ).state;
    s = assertOk(
      transition(s, {
        kind: "contract_applied",
        now: T3,
        repo: "ippoan/auth-worker",
        migration_id: "second",
      }),
    ).state;
    expect(s.rollback.unsafe_by_migration).toBe("first");
    expect(s.rollback.unsafe_since).toBe(T2);
    // both events recorded
    const contractEvents = s.events.filter((e) => e.kind === "contract_applied");
    expect(contractEvents).toHaveLength(2);
  });

  it("rejects contract_applied outside flipped state", () => {
    const s = makeWave();
    const r = transition(s, {
      kind: "contract_applied",
      now: T1,
      repo: "ippoan/rust-alc-api",
      migration_id: "m",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
  });

  it("rejects unknown repo", () => {
    const s = flippedWave();
    const r = transition(s, {
      kind: "contract_applied",
      now: T3,
      repo: "ippoan/unrelated",
      migration_id: "m",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("REPO_NOT_IN_WAVE");
  });

  it("accepts contract_applied on flipped state (not blanket-blocked)", () => {
    // flipped は中間定常 state なので contract_applied / rollback の両方を受ける。
    // 旧仕様で flipped を terminal 扱いした際に rollback が TERMINAL_STATE で
    // reject される regression があったため、このテストで覆う。
    const s = flippedWave();
    const r1 = assertOk(
      transition(s, {
        kind: "contract_applied",
        now: T3,
        repo: "ippoan/rust-alc-api",
        migration_id: "m",
      }),
    );
    expect(r1.state.rollback.safe).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// fail rejects on flipped (use rollback instead)
// ----------------------------------------------------------------------------

describe("transition: fail (flipped guard)", () => {
  function flippedWave(): WaveState {
    let s = makeWave({ flip_policy: "auto" });
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "flip_report", now: T2, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    s = assertOk(
      transition(s, { kind: "flip_report", now: T2, repo: "ippoan/auth-worker", ok: true }),
    ).state;
    return s;
  }

  it("rejects fail on flipped (use rollback)", () => {
    const s = flippedWave();
    const r = transition(s, { kind: "fail", now: T3, reason: "smoke fail" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("INVALID_TRANSITION");
      expect(r.error).toContain("rollback");
    }
  });
});

// ----------------------------------------------------------------------------
// immutability + events log
// ----------------------------------------------------------------------------

describe("immutability and events", () => {
  it("does not mutate the input state object", () => {
    const s = makeWave();
    const beforeRepos = s.repos[0]!.stage_status;
    const beforeEvents = s.events.length;
    transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true });
    expect(s.repos[0]!.stage_status).toBe(beforeRepos);
    expect(s.events.length).toBe(beforeEvents);
  });

  it("appends an event record per accepted transition", () => {
    let s = makeWave();
    const before = s.events.length;
    s = assertOk(
      transition(s, { kind: "stage_report", now: T1, repo: "ippoan/rust-alc-api", ok: true }),
    ).state;
    expect(s.events.length).toBe(before + 1);
    expect(s.events[s.events.length - 1]!.kind).toBe("stage_report");
  });

  it("does not append events on rejected transitions", () => {
    const s = makeWave();
    const before = s.events.length;
    const r = transition(s, {
      kind: "stage_report",
      now: T1,
      repo: "ippoan/unrelated",
      ok: true,
    });
    expect(r.ok).toBe(false);
    expect(s.events.length).toBe(before);
  });

  it("type-narrows error result", () => {
    const s = makeWave();
    const r = transition(s, { kind: "start", now: T1 } satisfies WaveEvent);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // ensure shape of error result
      expect(typeof r.error).toBe("string");
      expect(typeof r.code).toBe("string");
    }
  });
});
