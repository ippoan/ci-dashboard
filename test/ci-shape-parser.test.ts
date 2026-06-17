import { describe, it, expect } from "vitest";
import {
  analyzeWorkflowYaml,
  buildShapePayload,
  detectDeviations,
  isPinnedSha,
  parsePermissions,
  parseTriggers,
  parseUses,
} from "../src/ci-shape-parser";

describe("ci-shape-parser (port of ci-shape-report.py)", () => {
  describe("parseTriggers", () => {
    it("string trigger", () => {
      expect(parseTriggers("push")).toEqual(["push"]);
    });
    it("array trigger", () => {
      expect(parseTriggers(["push", "pull_request"])).toEqual(["push", "pull_request"]);
    });
    it("object trigger with branches", () => {
      const out = parseTriggers({ push: { branches: ["main"] }, pull_request: { branches: ["main"] } });
      expect(out).toContain("push:branch(main)");
      expect(out).toContain("pull_request:branch(main)");
    });
    it("object trigger with tags", () => {
      expect(parseTriggers({ push: { tags: ["v*"] } })).toContain("push:tag(v*)");
    });
    it("object trigger with empty value", () => {
      expect(parseTriggers({ workflow_dispatch: null })).toEqual(["workflow_dispatch"]);
    });
    it("null returns empty", () => {
      expect(parseTriggers(null)).toEqual([]);
      expect(parseTriggers(undefined)).toEqual([]);
    });
  });

  describe("parsePermissions", () => {
    it("string", () => {
      expect(parsePermissions("read-all")).toEqual({ _all: "read-all" });
    });
    it("object", () => {
      expect(parsePermissions({ contents: "read", "id-token": "write" })).toEqual({
        contents: "read",
        "id-token": "write",
      });
    });
    it("null", () => {
      expect(parsePermissions(null)).toEqual({});
    });
  });

  describe("parseUses + isPinnedSha", () => {
    it("reusable from another repo with ref=main", () => {
      const got = parseUses("ippoan/ci-workflows/.github/workflows/frontend-ci.yml@main");
      expect(got).toEqual({
        owner: "ippoan",
        repo: "ci-workflows",
        file: ".github/workflows/frontend-ci.yml",
        ref: "main",
        reusable_name: "frontend-ci.yml",
      });
      expect(isPinnedSha("main")).toBe(false);
    });
    it("pinned sha", () => {
      expect(isPinnedSha("a".repeat(40))).toBe(true);
      expect(isPinnedSha("a".repeat(39))).toBe(false);
      expect(isPinnedSha("z".repeat(40))).toBe(false);
    });
    it("local reusable (./)", () => {
      expect(parseUses("./.github/workflows/foo.yml")).toBeNull();
    });
    it("non-reusable action", () => {
      expect(parseUses("actions/checkout@v4")).toBeNull();
    });
  });

  describe("analyzeWorkflowYaml", () => {
    it("frontend-ci caller with id-token deviation", () => {
      const yamlText = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
permissions:
  contents: write
  pull-requests: write
jobs:
  ci:
    uses: ippoan/ci-workflows/.github/workflows/frontend-ci.yml@main
    secrets: inherit
`;
      const wf = analyzeWorkflowYaml(yamlText, ".github/workflows/ci.yml");
      expect(wf).not.toBeNull();
      expect(wf!.name).toBe("CI");
      expect(wf!.triggers).toContain("push:branch(main)");
      expect(wf!.reusable_calls).toHaveLength(1);
      expect(wf!.reusable_calls![0]!.reusable_name).toBe("frontend-ci.yml");
      expect(wf!.reusable_calls![0]!.secrets_inherit).toBe(true);
      expect(wf!.reusable_calls![0]!.pinned_sha).toBe(false);
      const flags = detectDeviations(wf!);
      // frontend-ci.yml caller without id-token → loud
      expect(flags).toContain("missing-id-token-write");
      // unpinned ref main
      expect(flags).toContain("unpinned-ref-main");
    });

    it("workflow with self-job collects permissions union", () => {
      const yamlText = `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - run: echo
`;
      const wf = analyzeWorkflowYaml(yamlText, ".github/workflows/deploy.yml");
      expect(wf).not.toBeNull();
      expect(wf!.self_jobs).toEqual(["deploy"]);
      expect(wf!.job_permissions_union).toEqual(["contents", "id-token"]);
    });

    it("yaml parse error returns parse_error entry", () => {
      const wf = analyzeWorkflowYaml(":: not valid: yaml: [", ".github/workflows/broken.yml");
      expect(wf).not.toBeNull();
      expect(wf!.parse_error).toBeTruthy();
      expect(wf!.deviations).toContain("yaml-parse-error");
    });

    it("auto-merge.yml + secrets:inherit triggers cross-org flag", () => {
      const yamlText = `name: ci
on: pull_request
jobs:
  auto-merge:
    uses: ippoan/ci-workflows/.github/workflows/auto-merge.yml@main
    secrets: inherit
`;
      const wf = analyzeWorkflowYaml(yamlText, ".github/workflows/ci.yml");
      expect(detectDeviations(wf!)).toContain("auto-merge-secrets-inherit");
    });
  });

  describe("buildShapePayload", () => {
    it("sorts files and merges deviations", () => {
      const files = [
        {
          path: ".github/workflows/b.yml",
          content: "name: b\non: push\njobs: {}\n",
        },
        {
          path: ".github/workflows/a.yml",
          content: "name: a\non: push\njobs: {}\n",
        },
      ];
      const payload = buildShapePayload("ippoan", "x", undefined, files, "2026-06-17T00:00:00Z");
      expect(payload.repo).toBe("x");
      expect(payload.workflows.map((w) => w.file)).toEqual([
        ".github/workflows/a.yml",
        ".github/workflows/b.yml",
      ]);
    });
  });
});
