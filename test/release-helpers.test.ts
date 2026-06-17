import { describe, it, expect } from "vitest";
import {
  extractRefIssues,
  extractPrNumber,
  extractBranchIssue,
  sortSemverDesc,
  isSemverTag,
  previousTag,
  computeWarnings,
  parseStableSemver,
  nextPatchTag,
} from "../src/release-helpers";

describe("extractRefIssues", () => {
  it("picks Refs / Related to / Part of (case-insensitive)", () => {
    const msg = "Refs #12\nRelated to #34\nPart of #56\nrefs #78";
    expect(extractRefIssues(msg).sort()).toEqual([12, 34, 56, 78]);
  });

  it("dedupes repeated numbers", () => {
    expect(extractRefIssues("Refs #1 and Refs #1 again")).toEqual([1]);
  });

  // 旧 pattern は `Refs #400 #411 #415` のような複数列挙の **最初の 1 つ** しか
  // 取らず、PR body の Refs が release page に欠落していた (#419 で確定)。
  // 新 pattern は keyword 直後の連続した `#N` token を全部 sweep する。
  describe("multi-issue enumeration after one Refs keyword (Refs #419)", () => {
    it("picks all space-separated refs (`Refs #400 #411 #415`)", () => {
      expect(extractRefIssues("Refs #400 #411 #415").sort((a, b) => a - b))
        .toEqual([400, 411, 415]);
    });

    it("picks all comma-separated refs (`Refs #400, #411, #415`)", () => {
      expect(extractRefIssues("Refs #400, #411, #415").sort((a, b) => a - b))
        .toEqual([400, 411, 415]);
    });

    it("picks slash-separated refs (`Refs #400 / #411 / #415`)", () => {
      expect(extractRefIssues("Refs #400 / #411 / #415").sort((a, b) => a - b))
        .toEqual([400, 411, 415]);
    });

    it("stops the sweep at a non-issue-like token", () => {
      // `Refs #1 #2 then some prose Refs #3` → first keyword captures #1 #2,
      // "then" stops the sweep, second `Refs` captures #3.
      expect(extractRefIssues("Refs #1 #2 then some prose Refs #3").sort((a, b) => a - b))
        .toEqual([1, 2, 3]);
    });

    it("mixes cross-repo and same-repo tokens correctly", () => {
      const msg = "Refs ippoan/auth-worker#176 #177 #178";
      // currentRepo を ippoan/auth-worker にすれば全部拾う。
      expect(extractRefIssues(msg, { owner: "ippoan", name: "auth-worker" }).sort((a, b) => a - b))
        .toEqual([176, 177, 178]);
    });
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

  // Cross-repo style `Refs <owner>/<name>#N` のサポート。Claude (LLM agent) が
  // PR を生成する際、同 repo の issue でも cross-repo style で書くことがあり
  // (例: 本 commit 内で見られる `Refs ippoan/HealthConnectReaderWorker#60`)、
  // currentRepo を渡せばその repo の ref として正しく拾えるようにする。
  describe("cross-repo style (Refs <owner>/<name>#N)", () => {
    const repo = { owner: "ippoan", name: "HealthConnectReaderWorker" };

    it("picks cross-repo refs that match currentRepo", () => {
      const msg = "Refs ippoan/HealthConnectReaderWorker#60\nRefs #61";
      expect(extractRefIssues(msg, repo).sort()).toEqual([60, 61]);
    });

    it("filters out cross-repo refs to other repos", () => {
      const msg =
        "Refs ippoan/HealthConnectReaderWorker#60\n" +
        "Refs ippoan/other-repo#99";
      expect(extractRefIssues(msg, repo)).toEqual([60]);
    });

    it("is case-insensitive on owner/name", () => {
      const msg = "Refs IPPOAN/healthconnectreaderworker#60";
      expect(extractRefIssues(msg, repo)).toEqual([60]);
    });

    it("without currentRepo skips cross-repo refs (conservative)", () => {
      // currentRepo 未指定なら cross-repo style は全部 skip。bare `Refs #N`
      // のみ拾う。これは別 repo の issue 番号を本 repo の番号と取り違える
      // 事故を防ぐため。
      const msg =
        "Refs ippoan/HealthConnectReaderWorker#60\n" +
        "Refs #42";
      expect(extractRefIssues(msg)).toEqual([42]);
    });
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

describe("isSemverTag", () => {
  it("accepts vX.Y.Z and X.Y.Z release tags", () => {
    expect(isSemverTag("v1.2.3")).toBe(true);
    expect(isSemverTag("1.2.3")).toBe(true);
    expect(isSemverTag("v0.0.1")).toBe(true);
    expect(isSemverTag("v1.2.3-rc.1")).toBe(true); // prefix match, suffix allowed
  });

  it("rejects non-semver stamp / arbitrary tags", () => {
    // The regression that hid claude-md from /releases: install-stamp tags
    // counted as "tags present" and forced the stale tag-compare path. Refs #199.
    expect(isSemverTag("installer-2026.05.15-090249-05848fc")).toBe(false);
    expect(isSemverTag("release-candidate")).toBe(false);
    expect(isSemverTag("dev-0.0.1")).toBe(false); // not anchored at start
    expect(isSemverTag("")).toBe(false);
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

describe("parseStableSemver", () => {
  it("parses v-prefixed and bare stable semver", () => {
    expect(parseStableSemver("v0.0.76")).toEqual({
      hasV: true,
      major: 0,
      minor: 0,
      patch: 76,
    });
    expect(parseStableSemver("1.4.0")).toEqual({
      hasV: false,
      major: 1,
      minor: 4,
      patch: 0,
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseStableSemver("  v2.3.4  ")?.patch).toBe(4);
  });

  it("rejects prerelease / build suffixes", () => {
    expect(parseStableSemver("v0.5.99-wave-test-08")).toBeNull();
    expect(parseStableSemver("v1.2.3-dev")).toBeNull();
    expect(parseStableSemver("v1.2.3-rc.1")).toBeNull();
    expect(parseStableSemver("v1.2.3+build.5")).toBeNull();
  });

  it("rejects incomplete or junk tags", () => {
    expect(parseStableSemver("v1.2")).toBeNull();
    expect(parseStableSemver("v1")).toBeNull();
    expect(parseStableSemver("dev-3")).toBeNull();
    expect(parseStableSemver("")).toBeNull();
  });
});

describe("nextPatchTag", () => {
  it("increments the patch component, preserving the v prefix", () => {
    expect(nextPatchTag("v0.0.76")).toBe("v0.0.77");
    expect(nextPatchTag("v0.2.51")).toBe("v0.2.52");
    expect(nextPatchTag("v1.9.9")).toBe("v1.9.10");
    expect(nextPatchTag("2.0.0")).toBe("2.0.1");
  });

  it("returns null for prerelease tags (no bump → empty prefill)", () => {
    expect(nextPatchTag("v0.5.99-wave-test-08")).toBeNull();
    expect(nextPatchTag("v1.2.3-dev")).toBeNull();
    expect(nextPatchTag("v1.2.3-rc.1")).toBeNull();
  });

  it("returns null for non-semver junk", () => {
    expect(nextPatchTag("latest")).toBeNull();
    expect(nextPatchTag("v1.2")).toBeNull();
    expect(nextPatchTag("")).toBeNull();
  });
});
