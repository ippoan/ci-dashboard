import { describe, it, expect, vi } from "vitest";
import {
  handleReleaseWaveListPage,
  handleReleaseWaveDetailPage,
} from "../../src/release-wave/page";
import type { Env } from "../../src/index";
import type { ReleaseWaveHub } from "../../src/release-wave/do";
import type { WaveState } from "../../src/release-wave/types";

/** 簡易 in-memory KV。compat section 描画テスト用。 */
function memKv(seed: Record<string, unknown> = {}): KVNamespace {
  const store = new Map<string, string>(
    Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  return {
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

function fakeEnv(opts: {
  listReturn?: WaveState[];
  getReturn?:
    | { ok: true; data: WaveState }
    | { ok: false; code: string; error: string };
  compatKv?: KVNamespace;
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
    COMPAT_KV: opts.compatKv,
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
        require_compatibility: false,
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

  it("shows the Pending releases section placeholder when none (Refs #181 / #237)", async () => {
    const env = fakeEnv({ listReturn: [], compatKv: memKv() });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).toContain("Pending releases (no-traffic)");
    // 単一真実化後 (#237) の placeholder 文言。
    expect(html).toContain("flip 待ちの no-traffic version はありません");
    expect(html).not.toContain("Flip to 100%");
  });

  it("lists a pending release with Flip button + preview link (Refs #181)", async () => {
    const env = fakeEnv({
      listReturn: [],
      compatKv: memKv({
        "pending-release::ippoan/auth-worker": {
          schema_version: 1,
          repo: "ippoan/auth-worker",
          version_id: "530b908c-5385-451c-b163-747caaedafd3",
          tag: "v0.2.38",
          preview_url: "https://abc-auth-worker.example.workers.dev",
          uploaded_at: "2026-05-28T12:00:00Z",
        },
      }),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).toContain("ippoan/auth-worker");
    expect(html).toContain("v0.2.38");
    expect(html).toContain("Flip to 100%");
    expect(html).toContain('action="/api/release-wave/pending-release/flip"');
    expect(html).toContain('name="repo" value="ippoan/auth-worker"');
    // safeHttpUrl は new URL().toString() で末尾スラッシュを正規化する
    expect(html).toContain('href="https://abc-auth-worker.example.workers.dev/"');
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

  it("renders preview URL links per repo in the list", async () => {
    const env = fakeEnv({
      listReturn: [
        makeWave({
          wave_id: "w1",
          state: "pending-approval",
          repos: [
            {
              repo: "ippoan/auth-worker",
              target_tag: "v0.5.0",
              head_sha: "abc",
              require_compatibility: false,
              stage_status: "done",
              preview_url: "https://preview-auth.ippoan.org/",
              stage_error: null,
              flip_status: "pending",
              flip_error: null,
              flip_from_revision: null,
              previewed_version_id: null,
              rolled_back_to_revision: null,
            },
          ],
        }),
      ],
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).toContain('href="https://preview-auth.ippoan.org/"');
  });

  it("rejects javascript: scheme preview_url in the list (XSS regression)", async () => {
    const env = fakeEnv({
      listReturn: [
        makeWave({
          wave_id: "w1",
          repos: [
            {
              repo: "ippoan/auth-worker",
              target_tag: "v0.5.0",
              head_sha: "abc",
              require_compatibility: false,
              stage_status: "done",
              preview_url: "javascript:alert(1)",
              stage_error: null,
              flip_status: "pending",
              flip_error: null,
              flip_from_revision: null,
              previewed_version_id: null,
              rolled_back_to_revision: null,
            },
          ],
        }),
      ],
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).not.toContain("javascript:alert(1)");
  });

  it("enables the per-wave Approve & Flip button only in pending-approval", async () => {
    const env = fakeEnv({
      listReturn: [
        makeWave({ wave_id: "w-pending", state: "pending-approval" }),
        makeWave({ wave_id: "w-staging", state: "staging" }),
      ],
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).toContain("Approve &amp; Flip");
    // pending-approval wave の form は approve endpoint を向く
    expect(html).toContain(
      'action="/api/release-wave/w-pending/approve"',
    );
    // staging wave のボタンは disabled
    const stagingFormIdx = html.indexOf(
      'action="/api/release-wave/w-staging/approve"',
    );
    const stagingButton = html.slice(stagingFormIdx, stagingFormIdx + 200);
    expect(stagingButton).toContain("disabled");
  });

  it("does not pass force=true from the list flip button", async () => {
    const env = fakeEnv({
      listReturn: [makeWave({ wave_id: "w1", state: "pending-approval" })],
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    const formIdx = html.indexOf('action="/api/release-wave/w1/approve"');
    const formChunk = html.slice(formIdx, formIdx + 300);
    expect(formChunk).not.toContain('name="force"');
  });

  it("shows version traffic (100% / 0%) in the compat graph frontend node hover", async () => {
    const env = fakeEnv({
      listReturn: [],
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          current_image: "cur-img",
          deployed_at: "2026-05-27T00:00:00Z",
          deployed_by: "x",
          wave_id: null,
        },
        "frontend::ippoan/auth-worker": {
          schema_version: 1,
          repo: "ippoan/auth-worker",
          prod_version: "v0.2.42",
          prod_deployed_at: "2026-05-29T00:00:00Z",
          tested_against: [
            {
              backend_repo: "ippoan/rust-alc-api",
              backend_image: "cur-img",
              tested_at: "2026-05-29T00:00:00Z",
            },
          ],
        },
        "traffic::ippoan/auth-worker": {
          schema_version: 3,
          repo: "ippoan/auth-worker",
          versions: [
            { version_id: "6403c1dc-full", percentage: 100, created_on: "2026-05-28T11:00:00Z", tag: "v0.2.42" },
            { version_id: "ac6841e4-zero", percentage: 0, created_on: "2026-05-29T07:00:00Z", tag: "v0.2.49" },
            // deployed(05-28 11:00) より古い 0% → promote 候補ではないので数えない。
            { version_id: "old0-zero", percentage: 0, created_on: "2026-05-20T00:00:00Z" },
          ],
          reported_at: "2026-05-29T07:02:00Z",
        },
      }),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    // SVG node の可視ラベル: deployed tag (100% = v0.2.42) と latest tag
    // (最新 created_on = v0.2.49)、traffic %。
    expect(html).toContain("deploy v0.2.42");
    expect(html).toContain("new v0.2.49");
    expect(html).toContain("traffic 100%");
    expect(html).toContain("0%×1");
    // hover (title) には全 version の % / tag / id を列挙。
    expect(html).toContain("traffic:");
    expect(html).toContain("100% v0.2.42 6403c1dc-full");
    expect(html).toContain("0% v0.2.49 ac6841e4-zero");
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

  it("rejects javascript: scheme in preview_url (XSS regression)", async () => {
    const wave = makeWave({
      state: "flipped",
      repos: [
        {
          repo: "ippoan/evil",
          target_tag: "v1",
          head_sha: "x",
          stage_status: "done",
          // attacker-controlled preview_url (= release_wave_stage MCP callback
          // from a compromised handler). safeHttpUrl で reject 必須。
          preview_url: "javascript:alert(1)",
          stage_error: null,
          flip_status: "done",
          flip_error: null,
          flip_from_revision: null,
          rolled_back_to_revision: null,
        },
      ],
    });
    const env = fakeEnv({ getReturn: { ok: true, data: wave } });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    // クリック可能な <a href="javascript:..."> が生えないこと
    expect(html).not.toMatch(/href="javascript:/i);
    // 値自体は (escape された text として) 残って operator が気づける
    expect(html).toContain("javascript:alert(1)");
    // non-http(s) scheme は span (=non-link) 化されていること
    expect(html).toMatch(/<span[^>]*title="non-http\(s\) scheme rejected"/);
  });

  it("rejects data: scheme in preview_url", async () => {
    const wave = makeWave({
      state: "flipped",
      repos: [
        {
          repo: "ippoan/a",
          target_tag: "v1",
          head_sha: "x",
          stage_status: "done",
          preview_url: "data:text/html,<script>alert(1)</script>",
          stage_error: null,
          flip_status: "done",
          flip_error: null,
          flip_from_revision: null,
          rolled_back_to_revision: null,
        },
      ],
    });
    const env = fakeEnv({ getReturn: { ok: true, data: wave } });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    expect(html).not.toMatch(/href="data:/i);
    expect(html).not.toContain("<script>alert");
  });

  it("accepts https: preview_url and renders as link with noreferrer", async () => {
    const wave = makeWave({
      state: "flipped",
      repos: [
        {
          repo: "ippoan/a",
          target_tag: "v1",
          head_sha: "x",
          stage_status: "done",
          preview_url: "https://preview-rust-alc-api.ippoan.org/",
          stage_error: null,
          flip_status: "done",
          flip_error: null,
          flip_from_revision: null,
          rolled_back_to_revision: null,
        },
      ],
    });
    const env = fakeEnv({ getReturn: { ok: true, data: wave } });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    expect(html).toMatch(
      /<a href="https:\/\/preview-rust-alc-api\.ippoan\.org[^"]*"[^>]*rel="noopener noreferrer"/,
    );
  });

  it("sets Content-Security-Policy + nosniff + no-referrer headers", async () => {
    const env = fakeEnv({ listReturn: [] });
    const resp = await handleReleaseWaveListPage(env);
    const csp = resp.headers.get("Content-Security-Policy") ?? "";
    // default-src 'none' で script を含む全 unspecified resource を deny
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(resp.headers.get("Referrer-Policy")).toBe("no-referrer");
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

// ============================================================================
// compatibility matrix section (Refs #157 Phase A)
// ============================================================================

describe("handleReleaseWaveDetailPage compatibility section", () => {
  it("omits the section entirely when COMPAT_KV is unbound", async () => {
    const env = fakeEnv({ getReturn: { ok: true, data: makeWave() } });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    expect(html).not.toContain("Compatibility (frontend");
  });

  it("shows 'no backend deploy records' when KV has none", async () => {
    const env = fakeEnv({
      getReturn: { ok: true, data: makeWave() },
      compatKv: memKv(),
    });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    expect(html).toContain("Compatibility (frontend");
    expect(html).toContain("No backend deploy records");
  });

  it("renders a red row for an untested frontend", async () => {
    const env = fakeEnv({
      getReturn: { ok: true, data: makeWave() },
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          current_image: "cur-img",
          deployed_at: "2026-05-27T00:00:00Z",
          deployed_by: "x",
          wave_id: null,
        },
        "frontend::ippoan/alc-app": {
          schema_version: 1,
          repo: "ippoan/alc-app",
          prod_version: "v1.2.10",
          prod_deployed_at: "2026-05-27T00:00:00Z",
          tested_against: [
            {
              backend_repo: "ippoan/rust-alc-api",
              backend_image: "stale-img",
              tested_at: "2026-05-27T00:00:00Z",
            },
          ],
        },
      }),
    });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    expect(html).toContain("Compatibility (frontend");
    expect(html).toContain("not verified");
    expect(html).toContain("ippoan/alc-app");
    expect(html).toContain("untested");
    expect(html).toContain("stale-img");
  });

  it("renders verified when the frontend tested the current image", async () => {
    const env = fakeEnv({
      getReturn: { ok: true, data: makeWave() },
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          current_image: "cur-img",
          deployed_at: "2026-05-27T00:00:00Z",
          deployed_by: "x",
          wave_id: null,
        },
        "frontend::ippoan/auth-worker": {
          schema_version: 1,
          repo: "ippoan/auth-worker",
          prod_version: "v0.5.32",
          prod_deployed_at: "2026-05-27T00:00:00Z",
          tested_against: [
            {
              backend_repo: "ippoan/rust-alc-api",
              backend_image: "cur-img",
              tested_at: "2026-05-27T00:00:00Z",
            },
          ],
        },
      }),
    });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    expect(html).toContain(">verified<");
    expect(html).toContain("tested");
  });

  it("renders an inline SVG graph with edge + history tooltip", async () => {
    const env = fakeEnv({
      getReturn: { ok: true, data: makeWave() },
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          current_image: "cur-img",
          deployed_at: "2026-05-27T00:00:00Z",
          deployed_by: "x",
          wave_id: null,
        },
        "frontend::ippoan/alc-app": {
          schema_version: 1,
          repo: "ippoan/alc-app",
          prod_version: "v1.2.10",
          prod_deployed_at: "2026-05-27T00:00:00Z",
          tested_against: [
            {
              backend_repo: "ippoan/rust-alc-api",
              backend_image: "stale-img",
              tested_at: "2026-05-20T00:00:00Z",
            },
          ],
        },
      }),
    });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    // inline SVG が出る (img タグではなく <svg>)
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
    // hover 履歴の <title> に過去 image が載る
    expect(html).toContain("<title>");
    expect(html).toContain("stale-img");
    // 凡例
    expect(html).toContain("untested (red)");
  });

  it("shows short SHA on both nodes (full SHA in hover) so the match is visible", async () => {
    const longSha = "3212fa882f9567ad22c661659cbf204ecafe1234";
    const env = fakeEnv({
      getReturn: { ok: true, data: makeWave() },
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          current_image: longSha,
          deployed_at: "2026-05-27T00:00:00Z",
          deployed_by: "x",
          wave_id: null,
        },
        "frontend::ippoan/nuxt-notify": {
          schema_version: 1,
          repo: "ippoan/nuxt-notify",
          prod_version: "main",
          prod_deployed_at: "2026-05-27T00:00:00Z",
          tested_against: [
            {
              backend_repo: "ippoan/rust-alc-api",
              backend_image: longSha,
              tested_at: "2026-05-27T00:00:00Z",
            },
          ],
        },
      }),
    });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    // node ラベルは short SHA (先頭 12 + …)、両ノードに出るので目視照合できる
    expect(html).toContain(`${longSha.slice(0, 12)}…`);
    expect(html).toContain(`vs @${longSha.slice(0, 12)}…`);
    // 完全 SHA は hover (title) に残る
    expect(html).toContain(longSha);
  });

  it("shows compat gate override on approve button when a required backend has reds", async () => {
    const wave = makeWave({
      state: "pending-approval",
      repos: [
        {
          repo: "ippoan/rust-alc-api",
          target_tag: "v2",
          head_sha: "s",
          require_compatibility: true,
          stage_status: "done",
          preview_url: null,
          stage_error: null,
          flip_status: "pending",
          flip_error: null,
          flip_from_revision: null,
          rolled_back_to_revision: null,
        },
      ],
    });
    const env = fakeEnv({
      getReturn: { ok: true, data: wave },
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          current_image: "cur-img",
          deployed_at: "2026-05-27T00:00:00Z",
          deployed_by: "x",
          wave_id: null,
        },
        "frontend::ippoan/alc-app": {
          schema_version: 1,
          repo: "ippoan/alc-app",
          prod_version: "v1",
          prod_deployed_at: "2026-05-27T00:00:00Z",
          tested_against: [
            {
              backend_repo: "ippoan/rust-alc-api",
              backend_image: "stale-img",
              tested_at: "2026-05-20T00:00:00Z",
            },
          ],
        },
      }),
    });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    expect(html).toContain("override compat gate");
    expect(html).toContain("Compatibility gate");
    expect(html).toContain('name="force" value="true"');
  });

  it("renders the backend node (with current image) even when there are no consumer edges", async () => {
    const env = fakeEnv({
      getReturn: { ok: true, data: makeWave() },
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          current_image: "cur-img",
          deployed_at: "2026-05-27T00:00:00Z",
          deployed_by: "x",
          wave_id: null,
        },
      }),
    });
    const resp = await handleReleaseWaveDetailPage(env, "w1");
    const html = await resp.text();
    expect(html).toContain("Compatibility (frontend");
    // backend record があれば consumer edge が 0 でも backend ノードを描画し、
    // 現 image (SHA) を見せる。
    expect(html).toContain("<svg");
    expect(html).toContain("cur-img");
  });

  it("shows the git tag on the backend node when the v2 record has current_tag (Refs #197)", async () => {
    const env = fakeEnv({
      getReturn: { ok: true, data: makeWave() },
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 2,
          repo: "ippoan/rust-alc-api",
          current_image: "rust-alc-api-00042-abc",
          current_tag: "v1.4.2",
          deployed_at: "2026-05-29T00:00:00Z",
          deployed_by: "release-wave-gcp",
          wave_id: null,
        },
      }),
    });
    const html = await (await handleReleaseWaveDetailPage(env, "w1")).text();
    // node line2 は "<tag> · @ <sha>" 形式 (tag を併記)。
    expect(html).toContain("v1.4.2");
  });
});

// ============================================================================
// global compat section overlay: staged previews + flip + node link (Refs #174)
// ============================================================================

describe("handleReleaseWaveListPage global compat overlay", () => {
  const compatSeed = {
    "backend::ippoan/rust-alc-api": {
      schema_version: 1,
      repo: "ippoan/rust-alc-api",
      current_image: "cur-img",
      deployed_at: "2026-05-27T00:00:00Z",
      deployed_by: "x",
      wave_id: null,
    },
    "frontend::ippoan/alc-app": {
      schema_version: 1,
      repo: "ippoan/alc-app",
      prod_version: "v1.2.10",
      prod_deployed_at: "2026-05-27T00:00:00Z",
      tested_against: [
        {
          backend_repo: "ippoan/rust-alc-api",
          backend_image: "cur-img",
          tested_at: "2026-05-27T00:00:00Z",
        },
      ],
    },
  };

  function activeWave(over: Partial<WaveState> = {}): WaveState {
    return makeWave({
      wave_id: "w-active",
      state: "pending-approval",
      repos: [
        {
          repo: "ippoan/alc-app",
          target_tag: "v1.3.0",
          head_sha: "abc",
          require_compatibility: false,
          stage_status: "done",
          preview_url: "https://preview-alc.ippoan.org/",
          stage_error: null,
          flip_status: "pending",
          flip_error: null,
          flip_from_revision: null,
          rolled_back_to_revision: null,
        },
      ],
      ...over,
    });
  }

  it("shows staged preview links + Approve & Flip for active waves", async () => {
    const env = fakeEnv({
      listReturn: [activeWave()],
      compatKv: memKv(compatSeed),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).toContain("Staged previews");
    expect(html).toContain('href="https://preview-alc.ippoan.org/"');
    expect(html).toContain("Approve &amp; Flip: w-active");
    expect(html).toContain('action="/api/release-wave/w-active/approve"');
  });

  it("does not pass force=true from the compat-section flip button", async () => {
    const env = fakeEnv({
      listReturn: [activeWave()],
      compatKv: memKv(compatSeed),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    const idx = html.indexOf('action="/api/release-wave/w-active/approve"');
    expect(html.slice(idx, idx + 300)).not.toContain('name="force"');
  });

  it("links the frontend graph node to its active wave detail page", async () => {
    const env = fakeEnv({
      listReturn: [activeWave()],
      compatKv: memKv(compatSeed),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    // SVG node が active wave の詳細ページへの anchor になっている
    expect(html).toMatch(/<a href="\/release-wave\/w-active"[^>]*>\s*<g>/);
  });

  it("rejects javascript: preview_url in the overlay (XSS regression)", async () => {
    const env = fakeEnv({
      listReturn: [
        activeWave({
          repos: [
            {
              repo: "ippoan/alc-app",
              target_tag: "v1.3.0",
              head_sha: "abc",
              require_compatibility: false,
              stage_status: "done",
              preview_url: "javascript:alert(1)",
              stage_error: null,
              flip_status: "pending",
              flip_error: null,
              flip_from_revision: null,
              rolled_back_to_revision: null,
            },
          ],
        }),
      ],
      compatKv: memKv(compatSeed),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain('href="javascript');
    // heading は常設だが危険 scheme の preview link 自体は出さない
    expect(html).toContain("Staged previews");
  });

  it("always renders the overlay with placeholder + disabled flip when no active waves", async () => {
    const env = fakeEnv({
      listReturn: [makeWave({ wave_id: "w-done", state: "flipped" })],
      compatKv: memKv(compatSeed),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    // block 自体は常に出る
    expect(html).toContain("Staged previews");
    expect(html).toContain("active な wave");
    // 具体的な flip 対象 (wave_id 付きボタン) は無く、disabled ボタンが出る
    expect(html).not.toContain("Approve &amp; Flip: ");
    const idx = html.indexOf("Approve &amp; Flip</button>");
    expect(idx).toBeGreaterThan(-1);
    expect(html.slice(Math.max(0, idx - 120), idx)).toContain("disabled");
  });

  it("renders a per-untested-consumer Re-test button posting to the wave-independent retest-consumer endpoint", async () => {
    const env = fakeEnv({
      listReturn: [],
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          current_image: "cur-img",
          deployed_at: "2026-05-27T00:00:00Z",
          deployed_by: "x",
          wave_id: "w-backend",
        },
        "frontend::ippoan/alc-app": {
          schema_version: 1,
          repo: "ippoan/alc-app",
          prod_version: "v1.2.10",
          prod_deployed_at: "2026-05-27T00:00:00Z",
          tested_against: [
            {
              backend_repo: "ippoan/rust-alc-api",
              backend_image: "stale-img",
              tested_at: "2026-05-27T00:00:00Z",
            },
          ],
        },
      }),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).toContain("Re-test untested consumers");
    // global グラフは wave 非依存なので retest-consumer へ POST する
    expect(html).toContain('action="/api/release-wave/retest-consumer"');
    expect(html).toContain('name="backend_repo" value="ippoan/rust-alc-api"');
    expect(html).toContain('name="frontend" value="ippoan/alc-app"');
    expect(html).toContain("Re-test ippoan/alc-app");
  });

  it("renders an enabled Re-test button even when the backend has no wave_id (single deploy)", async () => {
    const env = fakeEnv({
      listReturn: [],
      compatKv: memKv({
        "backend::ippoan/rust-alc-api": {
          schema_version: 1,
          repo: "ippoan/rust-alc-api",
          current_image: "cur-img",
          deployed_at: "2026-05-27T00:00:00Z",
          deployed_by: "x",
          wave_id: null,
        },
        "frontend::ippoan/alc-app": {
          schema_version: 1,
          repo: "ippoan/alc-app",
          prod_version: "v1.2.10",
          prod_deployed_at: "2026-05-27T00:00:00Z",
          tested_against: [
            {
              backend_repo: "ippoan/rust-alc-api",
              backend_image: "stale-img",
              tested_at: "2026-05-27T00:00:00Z",
            },
          ],
        },
      }),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).toContain("Re-test untested consumers");
    // wave 未紐付けでも wave 非依存 endpoint へ POST できる (disabled にしない)
    expect(html).toContain('action="/api/release-wave/retest-consumer"');
    expect(html).toContain('name="backend_repo" value="ippoan/rust-alc-api"');
    const idx = html.indexOf("Re-test ippoan/alc-app");
    expect(idx).toBeGreaterThan(-1);
    expect(html.slice(Math.max(0, idx - 250), idx)).not.toContain("disabled");
  });

  it("does not render the Re-test grid when all consumers are tested", async () => {
    const env = fakeEnv({
      listReturn: [],
      compatKv: memKv(compatSeed),
    });
    const html = await (await handleReleaseWaveListPage(env)).text();
    expect(html).toContain("all consumers tested");
    expect(html).not.toContain("Re-test untested consumers");
  });
});
