import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { applyCloseToReleasesIndex } from "../src/releases-index-patch";
import {
  RELEASES_INDEX_KEY,
  readReleasesIndexBlob,
  writeReleasesIndexBlob,
} from "../src/releases-index-cache";
import type { RepoView } from "../src/releases-page";

function row(number: number, url: string, state = "open") {
  return {
    number,
    title: `issue ${number}`,
    state,
    labels: [] as string[],
    assignees: [] as string[],
    url,
    updated_at: "2026-06-11T00:00:00Z",
    warnings: [] as string[],
  };
}

function seedBlob(views: RepoView[]): Promise<void> {
  return writeReleasesIndexBlob(env.CI_STATUS, views);
}

describe("applyCloseToReleasesIndex", () => {
  beforeEach(async () => {
    await env.CI_STATUS.delete(RELEASES_INDEX_KEY);
  });

  it("flips a matched same-repo row to closed and recomputes warnings", async () => {
    await seedBlob([
      {
        repo: "ippoan/claude-skills",
        tagless: false,
        tagBlocks: [
          {
            tag: "v1.0.0",
            prevTag: null,
            issues: [
              row(68, "https://github.com/ippoan/claude-skills/issues/68"),
              row(70, "https://github.com/ippoan/claude-skills/issues/70"),
            ],
          },
        ],
      },
    ]);

    const patched = await applyCloseToReleasesIndex(env.CI_STATUS, [
      "https://github.com/ippoan/claude-skills/issues/68",
    ]);
    expect(patched).toBe(true);

    const blob = await readReleasesIndexBlob<RepoView[]>(env.CI_STATUS);
    const issues = blob!.views[0]!.tagBlocks[0]!.issues;
    expect(issues.find((r) => r.number === 68)!.state).toBe("closed");
    expect(issues.find((r) => r.number === 68)!.warnings).toContain("already closed");
    // 非対象行は不変。
    expect(issues.find((r) => r.number === 70)!.state).toBe("open");
  });

  it("matches a cross-repo row by url (Refs #292 cross-repo close target)", async () => {
    await seedBlob([
      {
        repo: "ippoan/cdp-relay",
        tagless: true,
        tagBlocks: [
          {
            tag: "main@abc1234",
            prevTag: null,
            synthetic: true,
            issues: [
              // cross-repo 行: card は cdp-relay だが issue は mcp-cf-workers。
              {
                ...row(28, "https://github.com/ippoan/mcp-cf-workers/issues/28"),
                repo: "ippoan/mcp-cf-workers",
              },
            ],
          },
        ],
      },
    ]);

    const patched = await applyCloseToReleasesIndex(env.CI_STATUS, [
      "https://github.com/ippoan/mcp-cf-workers/issues/28",
    ]);
    expect(patched).toBe(true);

    const blob = await readReleasesIndexBlob<RepoView[]>(env.CI_STATUS);
    expect(blob!.views[0]!.tagBlocks[0]!.issues[0]!.state).toBe("closed");
  });

  it("returns false (no write) when no row matches", async () => {
    await seedBlob([
      {
        repo: "ippoan/claude-skills",
        tagless: false,
        tagBlocks: [
          { tag: "v1.0.0", prevTag: null, issues: [row(70, "https://github.com/ippoan/claude-skills/issues/70")] },
        ],
      },
    ]);

    const patched = await applyCloseToReleasesIndex(env.CI_STATUS, [
      "https://github.com/ippoan/claude-skills/issues/68",
    ]);
    expect(patched).toBe(false);
  });

  it("returns false when the issue row is already closed (idempotent re-close)", async () => {
    await seedBlob([
      {
        repo: "ippoan/claude-skills",
        tagless: false,
        tagBlocks: [
          {
            tag: "v1.0.0",
            prevTag: null,
            issues: [row(68, "https://github.com/ippoan/claude-skills/issues/68", "closed")],
          },
        ],
      },
    ]);

    const patched = await applyCloseToReleasesIndex(env.CI_STATUS, [
      "https://github.com/ippoan/claude-skills/issues/68",
    ]);
    expect(patched).toBe(false);
  });

  it("returns false on empty input and when no blob exists", async () => {
    expect(await applyCloseToReleasesIndex(env.CI_STATUS, [])).toBe(false);
    expect(
      await applyCloseToReleasesIndex(env.CI_STATUS, [
        "https://github.com/ippoan/claude-skills/issues/68",
      ]),
    ).toBe(false);
  });

  it("preserves storedAt (patch must not masquerade as a fresh full snapshot)", async () => {
    await seedBlob([
      {
        repo: "ippoan/claude-skills",
        tagless: false,
        tagBlocks: [
          { tag: "v1.0.0", prevTag: null, issues: [row(68, "https://github.com/ippoan/claude-skills/issues/68")] },
        ],
      },
    ]);
    const before = await readReleasesIndexBlob<RepoView[]>(env.CI_STATUS);
    await applyCloseToReleasesIndex(env.CI_STATUS, [
      "https://github.com/ippoan/claude-skills/issues/68",
    ]);
    const after = await readReleasesIndexBlob<RepoView[]>(env.CI_STATUS);
    expect(after!.storedAt).toBe(before!.storedAt);
  });
});
