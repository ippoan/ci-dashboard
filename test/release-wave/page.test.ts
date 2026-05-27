import { describe, it, expect, vi } from "vitest";
import {
  handleReleaseWaveListPage,
  handleReleaseWaveDetailPage,
} from "../../src/release-wave/page";
import type { Env } from "../../src/index";
import type { ReleaseWaveHub } from "../../src/release-wave/do";
import type { WaveState } from "../../src/release-wave/types";

function fakeEnv(opts: {
  listReturn?: WaveState[];
  getReturn?:
    | { ok: true; data: WaveState }
    | { ok: false; code: string; error: string };
}): Env {
  const hub = {
    list: vi.fn().mockResolvedValue(opts.listReturn ?? []),
    get: vi.fn().mockResolvedValue(
      opts.getReturn ?? {
        ok: false,
        code: "NOT_FOUND",
        error: "no wave",
      },
    ),
  } as unknown as ReleaseWaveHub;
  return {
    RELEASE_WAVE_HUB: {
      idFromName: () => ({}),
      get: () => hub,
    },
  } as unknown as Env;
}

function makeWave(over: Partial<WaveState> = {}): WaveState {
  const now = "2026-05-27T10:00:00Z";
  return {
    wave_id: "wave_test_01",
    state: "staging",
    flip_policy: "manual-approval",
    note: "test",
    repos: [
      {
        repo: "ippoan/rust-alc-api",
        target_tag: "v1.1.0",
        head_sha: "abc",
        stage_status: "pending",
        preview_url: null,
        stage_error: null,
        flip_status: "pending",
        flip_error: null,
        flip_from_revision: null,
        rolled_back_to_revision: null,
      },
    ],
    rollback: {
      safe: true,
      unsafe_reason: null,
      unsafe_since: null,
      unsafe_by_migration: null,
    },
    started_at: now,
    staged_at: null,
    approved_at: null,
    approved_by: null,
    flipped_at: null,
    rolled_back_at: null,
    rolled_back_by: null,
    failed_at: null,
    aborted_at: null,
    events: [
      {
        at: now,
        kind: "start",
        summary: "wave started",
        detail: { repos: ["ippoan/rust-alc-api"] },
      },
    ],
    ...over,
  };
}

// ============================================================================
// /release-wave list page
// ============================================================================

describe("handleReleaseWaveListPage", () => {
  it("renders empty state when no waves", async () => {
    const env = fakeEnv({ listReturn: [] });
    const resp = await handleReleaseWaveListPage(env);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
    const html = await resp.text();
    expect(html).toContain("Release Waves");
    expect(html).toContain("No release waves yet");
  });

  it("lists each wave with state badge + detail link", async () => {
    const env = fakeEnv({
      listReturn: [
        makeWave({ wave_id: "w1", state: "flipped" }),
        makeWave({ wave_id: "w2", state: "staging" }),
      ],
    });
    const resp = await handleReleaseWaveListPage(env);
    const html = await resp.text();
    expect(html).toContain("w1");
    expect(html).toContain("w2");
    expect(html).toContain("/release-wave/w1");
    expect(html).toContain("/release-wave/w2");
    expect(html).toContain("flipped");
    expect(html).toContain("staging");
  });

  it("escapes HTML special chars in wave_id / repo", async () => {
    const env = fakeEnv({
      listReturn: [makeWave({ wave_id: "evil<script>" })],
    });
    const resp = await handleReleaseWaveListPage(env);
    const html = await resp.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("evil&lt;script&gt;");
  });
});

// ============================================================================
// /release-wave/<wave_id> detail page
// ============================================================================

describe("handleReleaseWaveDetailPage", () => {
  it("renders 404 when wave not found", async () => {
    const env = fakeEnv({
      getReturn: { ok: false, code: "NOT_FOUND", error: "no wave" },
    });
    const resp = await handleReleaseWaveDetailPage(env, "ghost");
    expect(resp.status).toBe(404);
    const html = await resp.text();
    expect(html).toContain("Wave not found");
    expect(html).toContain("ghost");
  });

  it("renders 500 on other RPC errors", async () => {
    const env = fakeEnv({
      getReturn: { ok: false, code: "BOOM", error: "internal" },
    });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    expect(resp.status).toBe(500);
    const html = await resp.text();
    expect(html).toContain("BOOM");
  });

  it("renders full detail page when wave found", async () => {
    const env = fakeEnv({
      getReturn: { ok: true, data: makeWave({ wave_id: "w1" }) },
    });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("w1");
    expect(html).toContain("Actions");
    expect(html).toContain("Rollback Safety");
    expect(html).toContain("Repos");
    expect(html).toContain("Events");
    expect(html).toContain("Raw State");
  });

  it("approve button enabled only in pending-approval", async () => {
    // pending-approval → enabled
    const r1 = await handleReleaseWaveDetailPage(
      fakeEnv({
        getReturn: {
          ok: true,
          data: makeWave({ state: "pending-approval" }),
        },
      }),
      "w1",
    );
    const html1 = await r1.text();
    // 該当 button block を抽出 (form action with /approve)
    const m1 = html1.match(/<form[^>]*\/approve[^>]*>[\s\S]*?<\/form>/);
    expect(m1).toBeTruthy();
    expect(m1![0]).not.toContain("disabled");

    // staging → disabled
    const r2 = await handleReleaseWaveDetailPage(
      fakeEnv({
        getReturn: { ok: true, data: makeWave({ state: "staging" }) },
      }),
      "w1",
    );
    const html2 = await r2.text();
    const m2 = html2.match(/<form[^>]*\/approve[^>]*>[\s\S]*?<\/form>/);
    expect(m2![0]).toContain("disabled");
  });

  it("rollback button enabled only in flipped + warning when unsafe", async () => {
    // flipped + safe → enabled, no force input
    const r1 = await handleReleaseWaveDetailPage(
      fakeEnv({
        getReturn: { ok: true, data: makeWave({ state: "flipped" }) },
      }),
      "w1",
    );
    const html1 = await r1.text();
    const m1 = html1.match(/<form[^>]*\/rollback[^>]*>[\s\S]*?<\/form>/);
    expect(m1).toBeTruthy();
    expect(m1![0]).not.toContain("disabled");
    expect(m1![0]).not.toContain('name="force"');

    // flipped + unsafe → enabled, force input present, warning shown
    const r2 = await handleReleaseWaveDetailPage(
      fakeEnv({
        getReturn: {
          ok: true,
          data: makeWave({
            state: "flipped",
            rollback: {
              safe: false,
              unsafe_reason: "contract applied",
              unsafe_since: "2026-05-27T11:00:00Z",
              unsafe_by_migration: "20260601_001_drop",
            },
          }),
        },
      }),
      "w1",
    );
    const html2 = await r2.text();
    expect(html2).toContain("Rollback is <strong>unsafe</strong>");
    expect(html2).toContain('name="force"');
    expect(html2).toContain('value="true"');
    expect(html2).toContain("contract applied");

    // staging → rollback disabled
    const r3 = await handleReleaseWaveDetailPage(
      fakeEnv({
        getReturn: { ok: true, data: makeWave({ state: "staging" }) },
      }),
      "w1",
    );
    const html3 = await r3.text();
    const m3 = html3.match(/<form[^>]*\/rollback[^>]*>[\s\S]*?<\/form>/);
    expect(m3![0]).toContain("disabled");
  });

  it("abort button enabled in staging / pending-approval, disabled elsewhere", async () => {
    for (const state of ["staging", "pending-approval"] as const) {
      const r = await handleReleaseWaveDetailPage(
        fakeEnv({ getReturn: { ok: true, data: makeWave({ state }) } }),
        "w1",
      );
      const html = await r.text();
      const m = html.match(/<form[^>]*\/abort[^>]*>[\s\S]*?<\/form>/);
      expect(m![0]).not.toContain("disabled");
    }
    for (const state of ["flipping", "flipped", "rolled-back", "failed"] as const) {
      const r = await handleReleaseWaveDetailPage(
        fakeEnv({ getReturn: { ok: true, data: makeWave({ state }) } }),
        "w1",
      );
      const html = await r.text();
      const m = html.match(/<form[^>]*\/abort[^>]*>[\s\S]*?<\/form>/);
      expect(m![0]).toContain("disabled");
    }
  });

  it("renders rollback safety status correctly", async () => {
    // safe=true
    const r1 = await handleReleaseWaveDetailPage(
      fakeEnv({
        getReturn: { ok: true, data: makeWave({ state: "flipped" }) },
      }),
      "w1",
    );
    expect(await r1.text()).toContain("rollback.safe = <strong>true</strong>");

    // safe=false
    const r2 = await handleReleaseWaveDetailPage(
      fakeEnv({
        getReturn: {
          ok: true,
          data: makeWave({
            state: "flipped",
            rollback: {
              safe: false,
              unsafe_reason: "contract migration applied: 20260601_001_drop",
              unsafe_since: "2026-05-27T11:00:00Z",
              unsafe_by_migration: "20260601_001_drop",
            },
          }),
        },
      }),
      "w1",
    );
    const html2 = await r2.text();
    expect(html2).toContain("rollback.safe = <strong>false</strong>");
    expect(html2).toContain("20260601_001_drop");
  });

  it("shows repo stage / flip statuses with color classes", async () => {
    const wave = makeWave({
      state: "flipped",
      repos: [
        {
          repo: "ippoan/a",
          target_tag: "v1",
          head_sha: "x",
          stage_status: "done",
          preview_url: "https://preview-a.ippoan.org",
          stage_error: null,
          flip_status: "done",
          flip_error: null,
          flip_from_revision: "a-old-rev",
          rolled_back_to_revision: null,
        },
        {
          repo: "ippoan/b",
          target_tag: "v1",
          head_sha: "y",
          stage_status: "failed",
          preview_url: null,
          stage_error: "build broke",
          flip_status: "pending",
          flip_error: null,
          flip_from_revision: null,
          rolled_back_to_revision: null,
        },
      ],
    });
    const env = fakeEnv({ getReturn: { ok: true, data: wave } });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    expect(html).toContain("preview-a.ippoan.org");
    expect(html).toContain("a-old-rev");
    expect(html).toContain("build broke");
    expect(html).toContain("ippoan/a");
    expect(html).toContain("ippoan/b");
  });

  it("events timeline lists newest first", async () => {
    const wave = makeWave({
      events: [
        { at: "2026-01-01T00:00:00Z", kind: "start", summary: "first" },
        { at: "2026-01-02T00:00:00Z", kind: "stage_report", summary: "second" },
        { at: "2026-01-03T00:00:00Z", kind: "approve", summary: "third" },
      ],
    });
    const env = fakeEnv({ getReturn: { ok: true, data: wave } });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    // third (newest) は first より前にあるべき
    expect(html.indexOf("third")).toBeLessThan(html.indexOf("first"));
  });

  it("escapes HTML in repo names / wave_id / event summaries", async () => {
    const wave = makeWave({
      wave_id: "evil<wave>",
      repos: [
        {
          repo: "ippoan/<script>alert(1)</script>",
          target_tag: "v1",
          head_sha: "x",
          stage_status: "done",
          preview_url: null,
          stage_error: null,
          flip_status: "done",
          flip_error: null,
          flip_from_revision: null,
          rolled_back_to_revision: null,
        },
      ],
      events: [
        { at: "2026-01-01T00:00:00Z", kind: "start", summary: "<bad>" },
      ],
    });
    const env = fakeEnv({ getReturn: { ok: true, data: wave } });
    const resp = await handleReleaseWaveDetailPage(env, "evil<wave>");
    const html = await resp.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});
