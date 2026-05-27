import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReleaseWaveHub } from "../../src/release-wave/do";

// 各テストで新しい DO ID を使って独立性を確保する。
// (同一 ID を使い回すと前テストの storage が残り flaky になる。)
let idCounter = 0;
function freshHub(): DurableObjectStub<ReleaseWaveHub> {
  idCounter += 1;
  // テストランナー内 namespace: ID は test 内で unique であれば良い。
  const id = env.RELEASE_WAVE_HUB.idFromName(
    `test-wave-hub-${Date.now()}-${idCounter}`,
  );
  return env.RELEASE_WAVE_HUB.get(id) as DurableObjectStub<ReleaseWaveHub>;
}

const REPOS = [
  { repo: "ippoan/rust-alc-api", target_tag: "v1.1.0", head_sha: "sha-a" },
  { repo: "ippoan/auth-worker", target_tag: "v0.5.0", head_sha: "sha-b" },
];

describe("ReleaseWaveHub.start", () => {
  it("creates a new wave", async () => {
    const hub = freshHub();
    const result = await runInDurableObject(hub, async (instance) => {
      return instance.start({
        wave_id: "w1",
        flip_policy: "manual-approval",
        note: "first wave",
        repos: REPOS,
      });
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.wave_id).toBe("w1");
      expect(result.data.state).toBe("staging");
      expect(result.data.repos).toHaveLength(2);
    }
  });

  it("rejects same wave_id (ALREADY_EXISTS)", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      const a = await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      expect(a.ok).toBe(true);
      // 1st wave を flipped に進めて serial enforcement に引っかからないようにしてから
      // 同 id 再 start を試す。
      await i.stageReport({ wave_id: "w1", repo: REPOS[0]!.repo, ok: true });
      await i.stageReport({ wave_id: "w1", repo: REPOS[1]!.repo, ok: true });
      await i.flipReport({ wave_id: "w1", repo: REPOS[0]!.repo, ok: true });
      await i.flipReport({ wave_id: "w1", repo: REPOS[1]!.repo, ok: true });
      const dup = await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.code).toBe("ALREADY_EXISTS");
    });
  });

  it("enforces serial: rejects second start while first is in progress", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      const a = await i.start({ wave_id: "w1", flip_policy: "manual-approval", repos: REPOS });
      expect(a.ok).toBe(true);
      const b = await i.start({ wave_id: "w2", flip_policy: "auto", repos: REPOS });
      expect(b.ok).toBe(false);
      if (!b.ok) {
        expect(b.code).toBe("WAVE_IN_PROGRESS");
        expect(b.error).toContain("w1");
      }
    });
  });

  it("allows new wave once previous is flipped (= done, but kept on record)", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      await i.stageReport({ wave_id: "w1", repo: REPOS[0]!.repo, ok: true });
      await i.stageReport({ wave_id: "w1", repo: REPOS[1]!.repo, ok: true });
      await i.flipReport({ wave_id: "w1", repo: REPOS[0]!.repo, ok: true });
      const finalFlip = await i.flipReport({ wave_id: "w1", repo: REPOS[1]!.repo, ok: true });
      expect(finalFlip.ok).toBe(true);
      if (finalFlip.ok) expect(finalFlip.data.state).toBe("flipped");

      // 2nd wave OK (hotfix シナリオ)
      const w2 = await i.start({ wave_id: "w2", flip_policy: "auto", repos: REPOS });
      expect(w2.ok).toBe(true);
    });
  });

  it("allows new wave once previous is rolled-back / failed / aborted", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      await i.abort({ wave_id: "w1", aborted_by: "ops", reason: "test" });

      const w2 = await i.start({ wave_id: "w2", flip_policy: "auto", repos: REPOS });
      expect(w2.ok).toBe(true);
    });
  });
});

describe("ReleaseWaveHub.stageReport / approve / flipReport", () => {
  it("manual-approval policy: full happy path", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await i.start({ wave_id: "w1", flip_policy: "manual-approval", repos: REPOS });

      let r = await i.stageReport({
        wave_id: "w1",
        repo: REPOS[0]!.repo,
        ok: true,
        preview_url: "https://preview-a.ippoan.org",
        flip_from_revision: "a-old",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.state).toBe("staging");

      r = await i.stageReport({
        wave_id: "w1",
        repo: REPOS[1]!.repo,
        ok: true,
        flip_from_revision: "b-old",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.state).toBe("pending-approval");

      r = await i.approve({ wave_id: "w1", approved_by: "ops@example.com" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.state).toBe("flipping");
        expect(r.data.approved_by).toBe("ops@example.com");
      }

      r = await i.flipReport({ wave_id: "w1", repo: REPOS[0]!.repo, ok: true });
      expect(r.ok).toBe(true);
      r = await i.flipReport({ wave_id: "w1", repo: REPOS[1]!.repo, ok: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.state).toBe("flipped");
    });
  });

  it("auto policy: stage all -> auto flip (no approval)", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      await i.stageReport({ wave_id: "w1", repo: REPOS[0]!.repo, ok: true });
      const r = await i.stageReport({ wave_id: "w1", repo: REPOS[1]!.repo, ok: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.state).toBe("flipping");
    });
  });

  it("stage_report on unknown wave -> NOT_FOUND", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      const r = await i.stageReport({
        wave_id: "ghost",
        repo: REPOS[0]!.repo,
        ok: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("NOT_FOUND");
    });
  });

  it("propagates state-machine errors as RpcError (INVALID_TRANSITION)", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await i.start({ wave_id: "w1", flip_policy: "manual-approval", repos: REPOS });
      // approve は pending-approval 以外 (今は staging) で INVALID_TRANSITION
      const r = await i.approve({ wave_id: "w1", approved_by: "ops" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("INVALID_TRANSITION");
    });
  });
});

describe("ReleaseWaveHub.rollback / contractApplied", () => {
  async function buildFlipped(i: ReleaseWaveHub, wave_id: string): Promise<void> {
    await i.start({ wave_id, flip_policy: "auto", repos: REPOS });
    await i.stageReport({ wave_id, repo: REPOS[0]!.repo, ok: true });
    await i.stageReport({ wave_id, repo: REPOS[1]!.repo, ok: true });
    await i.flipReport({ wave_id, repo: REPOS[0]!.repo, ok: true });
    await i.flipReport({ wave_id, repo: REPOS[1]!.repo, ok: true });
  }

  it("rolls back a flipped wave when safe", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await buildFlipped(i, "w1");
      const r = await i.rollback({ wave_id: "w1", rolled_back_by: "ops" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.state).toBe("rolled-back");
        expect(r.data.rolled_back_by).toBe("ops");
      }
    });
  });

  it("contract_applied flips rollback.safe to false on a flipped wave", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await buildFlipped(i, "w1");
      const c = await i.contractApplied({
        wave_id: "w1",
        repo: REPOS[0]!.repo,
        migration_id: "20260601_001_drop",
      });
      expect(c.ok).toBe(true);
      if (c.ok) {
        expect(c.data.rollback.safe).toBe(false);
        expect(c.data.rollback.unsafe_by_migration).toBe("20260601_001_drop");
      }
    });
  });

  it("refuses rollback when unsafe, allows with force=true", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await buildFlipped(i, "w1");
      await i.contractApplied({
        wave_id: "w1",
        repo: REPOS[0]!.repo,
        migration_id: "m",
      });

      const r1 = await i.rollback({ wave_id: "w1", rolled_back_by: "ops" });
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.code).toBe("ROLLBACK_UNSAFE");

      const r2 = await i.rollback({
        wave_id: "w1",
        rolled_back_by: "ops",
        force: true,
      });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.data.state).toBe("rolled-back");
    });
  });
});

describe("ReleaseWaveHub.abort / fail", () => {
  it("aborts a staging wave", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      const r = await i.abort({
        wave_id: "w1",
        aborted_by: "ops",
        reason: "smoke broken",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.state).toBe("aborted");
    });
  });

  it("fails a staging wave via fail event", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      const r = await i.fail({ wave_id: "w1", reason: "ci crashed" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.state).toBe("failed");
    });
  });
});

describe("ReleaseWaveHub.get / list", () => {
  it("returns NOT_FOUND for missing wave", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      const r = await i.get("ghost");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("NOT_FOUND");
    });
  });

  it("returns wave by id", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      const r = await i.get("w1");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.wave_id).toBe("w1");
    });
  });

  it("list returns waves sorted by started_at descending", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      // 1st を rolled-back に進めて serial を解除し、2nd を時刻差で立てる
      await i.stageReport({ wave_id: "w1", repo: REPOS[0]!.repo, ok: true });
      await i.stageReport({ wave_id: "w1", repo: REPOS[1]!.repo, ok: true });
      await i.flipReport({ wave_id: "w1", repo: REPOS[0]!.repo, ok: true });
      await i.flipReport({ wave_id: "w1", repo: REPOS[1]!.repo, ok: true });

      // 微小に待つ (Date.now() resolution が同 ms なら ordering 不確定なので隔ててから)
      await new Promise((r) => setTimeout(r, 5));
      await i.start({ wave_id: "w2", flip_policy: "auto", repos: REPOS });

      const all = await i.list();
      expect(all.map((w) => w.wave_id)).toEqual(["w2", "w1"]);
    });
  });
});

describe("ReleaseWaveHub.persistence", () => {
  it("persists state across separate DO calls (= storage write went through)", async () => {
    const hub = freshHub();
    // 1 call で start
    await runInDurableObject(hub, async (i) => {
      const r = await i.start({ wave_id: "w1", flip_policy: "auto", repos: REPOS });
      expect(r.ok).toBe(true);
    });
    // 別 call で get
    await runInDurableObject(hub, async (i) => {
      const r = await i.get("w1");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.wave_id).toBe("w1");
        expect(r.data.repos).toHaveLength(2);
      }
    });
  });

  it("each test isolation: a fresh hub sees no waves from other tests", async () => {
    const hub = freshHub();
    await runInDurableObject(hub, async (i) => {
      const all = await i.list();
      expect(all).toEqual([]);
    });
  });
});

// beforeEach: keep no shared state across tests (different DO IDs per test
// is the isolation mechanism; this hook just resets the local counter cache
// so test order is deterministic for debugging).
beforeEach(() => {
  // no-op (idCounter は global、tests 間で increment 続行)
});
