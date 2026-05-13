import { describe, it, expect } from "vitest";
import {
  extractRefIssues,
  extractPrNumber,
  extractBranchIssue,
  sortSemverDesc,
  previousTag,
  computeWarnings,
} from "../src/release-helpers";

describe("extractRefIssues", () => {
  it("picks Refs / Related to / Part of (case-insensitive)", () => {
    const msg = "Refs #12\nRelated to #34\nPart of #56\nrefs #78";
    expect(extractRefIssues(msg).sort()).toEqual([12, 34, 56, 78]);
  });

  it("dedupes repeated numbers", () => {
    expect(extractRefIssues("Refs #1 and Refs #1 again")).toEqual([1]);
  });

  it("ignores Closes / Fixes / Resolves (those would auto-close)", () => {
    // CLAUDE.md forbids these keywords; the regex must not match them so the
    // release confirmation flow stays the source of truth.
    expect(extractRefIssues("Closes #5\nFixes #6\nResolves #7")).toEqual([]);
  });

  it("returns [] for empty / undefined-shaped input", () => {
    expect(extractRefIssues("")).toEqual([]);
    expect(extractRefIssues("no references here")).toEqual([]);
  });
});

describe("extractPrNumber", () => {
  it("pulls trailing (#NN) off a squash-merge subject", () => {
    expect(extractPrNumber("feat(x): do thing (#42)")).toBe(42);
  });

  it("uses only the first line of multi-line messages", () => {
    expect(extractPrNumber("subject (#9)\n\nbody mentions (#999)")).toBe(9);
  });

  it("returns null when no trailing (#N)", () => {
    expect(extractPrNumber("plain subject")).toBeNull();
    expect(extractPrNumber("see #42 inline")).toBeNull();
  });
});

describe("extractBranchIssue", () => {
  it("extracts the leading number from `<n>-<type>-<desc>`", () => {
    expect(extractBranchIssue("35-feat-release-ui")).toBe(35);
    expect(extractBranchIssue("123-fix-onedrive-token")).toBe(123);
  });

  it("returns null for branches without the prefix", () => {
    expect(extractBranchIssue("feat/no-issue-number")).toBeNull();
    expect(extractBranchIssue("main")).toBeNull();
    expect(extractBranchIssue("")).toBeNull();
  });
});

describe("sortSemverDesc", () => {
  it("sorts proper semver tags in descending order", () => {
    expect(sortSemverDesc(["v1.0.0", "v1.2.3", "v1.2.10", "v0.9.9"]))
      .toEqual(["v1.2.10", "v1.2.3", "v1.0.0", "v0.9.9"]);
  });

  it("treats versions without the v prefix as semver too", () => {
    expect(sortSemverDesc(["1.2.0", "v1.10.0"])).toEqual(["v1.10.0", "1.2.0"]);
  });

  it("pushes non-semver tags to the bottom", () => {
    const out = sortSemverDesc(["v1.0.0", "release-candidate", "v0.9.0"]);
    expect(out[0]).toBe("v1.0.0");
    expect(out[1]).toBe("v0.9.0");
    expect(out[2]).toBe("release-candidate");
  });
});

describe("previousTag", () => {
  it("returns the tag immediately older than `current`", () => {
    expect(previousTag(["v1.2.0", "v1.1.0", "v1.0.0"], "v1.1.0")).toBe("v1.0.0");
  });

  it("returns null for the oldest tag (no predecessor)", () => {
    expect(previousTag(["v1.2.0", "v1.1.0", "v1.0.0"], "v1.0.0")).toBeNull();
  });

  it("returns null when the tag is not in the list", () => {
    expect(previousTag(["v1.2.0", "v1.0.0"], "v1.1.0")).toBeNull();
  });
});

describe("computeWarnings", () => {
  it("flags closed state", () => {
    expect(computeWarnings({ state: "closed", labels: [] }))
      .toContain("already closed");
  });

  it("does NOT flag bug / regression labels on open issues (dropped in #77)", () => {
    // bug-labeled open issues are the common case for fix-PR-driven closes;
    // warning on them just added manual ticking without catching anything.
    expect(computeWarnings({ state: "open", labels: ["bug"] })).toEqual([]);
    expect(computeWarnings({ state: "open", labels: ["Regression"] })).toEqual([]);
    expect(computeWarnings({ state: "open", labels: ["bug", "regression"] })).toEqual([]);
  });

  it("returns [] for a clean open issue", () => {
    expect(computeWarnings({ state: "open", labels: ["enhancement"] }))
      .toEqual([]);
  });

  it("closed state remains the sole warning regardless of labels", () => {
    const w = computeWarnings({ state: "closed", labels: ["bug", "regression"] });
    expect(w).toEqual(["already closed"]);
  });
});
