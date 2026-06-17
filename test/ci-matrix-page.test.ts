/**
 * `/ci-matrix` SSR ページ。Refs ippoan/ci-dashboard#377.
 *
 * - `analyzeMatrix()` pure 関数の cell/deviation 畳み込み
 * - `renderMatrixPage()` の HTML 生成 (tab active / banner / row / 逸脱タブ)
 * - `handleCiMatrixPage()` の fetch error path で 503 + X-CI-Matrix-Source
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  analyzeMatrix,
  renderMatrixPage,
  handleCiMatrixPage,
  _resetMatrixCacheForTest,
  type ScannerPayload,
  COLUMN_ORDER,
} from "../src/ci-matrix-page";

function fixturePayload(): ScannerPayload {
  return {
    schema_version: 1,
    generated_at: "2026-06-17T00:00:00Z",
    scan_source: "scheduled",
    orgs: ["ippoan"],
    reusable_categories: {
      "frontend-ci.yml": "frontend-ci",
      "go-ci.yml": "go-ci",
      "auto-merge.yml": "auto-merge",
      "skills-check.yml": "skills-check",
    },
    repos: [
      {
        owner: "ippoan",
        repo: "auth-worker",
        scanned_at: "2026-06-17T00:00:00Z",
        workflows: [
          {
            file: ".github/workflows/test.yml",
            name: "CI",
            triggers: ["pull_request"],
            permissions: { contents: "write", "pull-requests": "write" },
            job_permissions_union: [],
            reusable_calls: [
              {
                job_id: "ci",
                target_owner: "ippoan",
                target_repo: "ci-workflows",
                target_file: ".github/workflows/frontend-ci.yml",
                reusable_name: "frontend-ci.yml",
                ref: "main",
                pinned_sha: false,
                secrets_inherit: true,
              },
            ],
            self_jobs: [],
            deviations: ["unpinned-ref-main", "missing-id-token-write"],
          },
        ],
        summary: {
          total_workflows: 1,
          reusable_caller_workflows: 1,
          used_reusable_categories: ["frontend-ci"],
          deviation_flags: ["missing-id-token-write", "unpinned-ref-main"],
        },
      },
      {
        owner: "ippoan",
        repo: "rust-flickr",
        scanned_at: "2026-06-17T00:00:00Z",
        workflows: [
          {
            file: ".github/workflows/skills-check.yml",
            name: "skills-check",
            triggers: ["pull_request"],
            permissions: { contents: "read" },
            job_permissions_union: [],
            reusable_calls: [
              {
                job_id: "skills-check",
                target_owner: "ippoan",
                target_repo: "ci-workflows",
                target_file: ".github/workflows/skills-check.yml",
                reusable_name: "skills-check.yml",
                ref: "abcdef0123456789abcdef0123456789abcdef01",
                pinned_sha: true,
                secrets_inherit: false,
              },
            ],
            self_jobs: [],
            deviations: [],
          },
        ],
        summary: {
          total_workflows: 1,
          reusable_caller_workflows: 1,
          used_reusable_categories: ["skills-check"],
          deviation_flags: [],
        },
      },
    ],
  };
}

describe("analyzeMatrix", () => {
  it("rows を owner→repo の安定 sort で返す", () => {
    const payload = fixturePayload();
    payload.repos.reverse();
    const result = analyzeMatrix(payload);
    expect(result.rows.map((r) => r.repo)).toEqual(["auth-worker", "rust-flickr"]);
  });

  it("reusable_name → category mapping を cell に反映する (pinned vs mutable)", () => {
    const result = analyzeMatrix(fixturePayload());
    const authRow = result.rows.find((r) => r.repo === "auth-worker")!;
    expect(authRow.cells["frontend-ci"]).toEqual({
      kind: "reusable",
      ref: "main",
      pinned: false,
      mutable: true,
    });
    const flickrRow = result.rows.find((r) => r.repo === "rust-flickr")!;
    const cell = flickrRow.cells["skills-check"];
    expect(cell.kind).toBe("reusable");
    if (cell.kind === "reusable") {
      expect(cell.pinned).toBe(true);
      expect(cell.mutable).toBe(false);
    }
  });

  it("該当 column が無い repo は none を保つ", () => {
    const result = analyzeMatrix(fixturePayload());
    const flickrRow = result.rows.find((r) => r.repo === "rust-flickr")!;
    expect(flickrRow.cells["frontend-ci"]).toEqual({ kind: "none" });
    expect(flickrRow.cells["go-ci"]).toEqual({ kind: "none" });
  });

  it("workflow.deviations を repo/file/flag triple として展開する", () => {
    const result = analyzeMatrix(fixturePayload());
    expect(result.deviations).toHaveLength(2);
    const flags = result.deviations.map((d) => d.flag).sort();
    expect(flags).toEqual(["missing-id-token-write", "unpinned-ref-main"]);
    const auth = result.deviations.find((d) => d.flag === "unpinned-ref-main")!;
    expect(auth.owner).toBe("ippoan");
    expect(auth.repo).toBe("auth-worker");
    expect(auth.file).toBe(".github/workflows/test.yml");
    expect(auth.ref).toBe("main");
  });

  it("COLUMN_ORDER の全列が rows.cells に key として存在する", () => {
    const result = analyzeMatrix(fixturePayload());
    for (const row of result.rows) {
      for (const col of COLUMN_ORDER) {
        expect(row.cells[col]).toBeDefined();
      }
    }
  });
});

describe("renderMatrixPage", () => {
  it("payload null + error msg なら 警告 banner を出す", () => {
    const html = renderMatrixPage(null, "kv get failed");
    expect(html).toContain("KV からの shape 読み込みに失敗");
    expect(html).toContain("kv get failed");
  });

  it("ci-matrix tab が active", () => {
    const html = renderMatrixPage(fixturePayload());
    expect(html).toContain("🧩 CI Matrix");
    // active class が付くのは tab-active
    expect(html).toMatch(/href="\/ci-matrix" class="tab tab-active"/);
  });

  it("repo 行と reusable cell が出る + summary に adoption %", () => {
    const html = renderMatrixPage(fixturePayload());
    expect(html).toContain("ippoan/auth-worker");
    expect(html).toContain("ippoan/rust-flickr");
    // mutable @main は @main 表示、pinned SHA は @abcdef0 と短縮
    expect(html).toContain("@main");
    expect(html).toContain("@abcdef0");
    // 2 / 2 = 100% adoption
    expect(html).toContain("2 (100%)");
  });

  it("逸脱タブの dev-item に flag が描画される", () => {
    const html = renderMatrixPage(fixturePayload());
    expect(html).toContain("missing-id-token-write");
    expect(html).toContain("unpinned-ref-main");
    // 逸脱 0 件の repo (rust-flickr) は dev-list に出ない
    const devSection = html.split('section data-view="deviations"')[1] ?? "";
    expect(devSection).not.toContain("rust-flickr");
  });
});

/** in-memory KV with two `ci-shape:` entries seeded. */
function envWithShapes(): import("../src/index").Env {
  const store = new Map<string, string>();
  store.set(
    "ci-shape:ippoan/auth-worker",
    JSON.stringify({
      schema_version: 1,
      owner: "ippoan",
      repo: "auth-worker",
      scanned_at: "2026-06-17T00:00:00Z",
      workflows: [
        {
          file: ".github/workflows/test.yml",
          name: "CI",
          triggers: ["pull_request"],
          permissions: { contents: "write", "pull-requests": "write" },
          reusable_calls: [
            {
              job_id: "ci",
              target_owner: "ippoan",
              target_repo: "ci-workflows",
              target_file: ".github/workflows/frontend-ci.yml",
              reusable_name: "frontend-ci.yml",
              ref: "main",
              pinned_sha: false,
              secrets_inherit: true,
            },
          ],
          self_jobs: [],
          deviations: ["unpinned-ref-main"],
        },
      ],
    }),
  );
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async list({ prefix }: { prefix?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace;
  return { CI_STATUS: kv } as unknown as import("../src/index").Env;
}

describe("handleCiMatrixPage", () => {
  beforeEach(() => {
    _resetMatrixCacheForTest();
    vi.restoreAllMocks();
  });

  it("KV から shape を読んで 200 + X-CI-Matrix-Source: live", async () => {
    const env = envWithShapes();
    const res = await handleCiMatrixPage(new Request("https://example.com/ci-matrix"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-CI-Matrix-Source")).toBe("live");
    expect(res.headers.get("Cache-Control")).toContain("public");
    const html = await res.text();
    expect(html).toContain("ippoan/auth-worker");
  });

  it("KV list throw → 503 + X-CI-Matrix-Source: error", async () => {
    const broken = {
      CI_STATUS: {
        async list() {
          throw new Error("kv broken");
        },
      },
    } as unknown as import("../src/index").Env;
    const res = await handleCiMatrixPage(
      new Request("https://example.com/ci-matrix"),
      broken,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("X-CI-Matrix-Source")).toBe("error");
  });

  it("?refresh=1 で memCache を bypass", async () => {
    const env = envWithShapes();
    const spy = vi.spyOn(env.CI_STATUS, "list");
    await handleCiMatrixPage(new Request("https://example.com/ci-matrix"), env);
    await handleCiMatrixPage(new Request("https://example.com/ci-matrix"), env);
    // 2 回目はキャッシュヒットで list 呼ばれない
    expect(spy).toHaveBeenCalledTimes(1);
    // refresh=1 で再 list される
    await handleCiMatrixPage(new Request("https://example.com/ci-matrix?refresh=1"), env);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
