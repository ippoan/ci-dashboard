/**
 * draft PR stock (Refs #470) — webhook-fed KV cache のライフサイクルを gate する:
 *   - opened (draft) / converted_to_draft → 一覧に載る
 *   - edited / synchronize (draft 継続) → title / updated_at が更新される
 *   - ready_for_review / closed → 一覧から消える
 *   - 非 draft の activity / draft 不明の最小 payload → no-op
 *   - 一覧は updated_at 降順
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyDraftPrEvent, listDraftPrs, DRAFT_PRS_KEY } from "../src/draft-prs";

const kv = env.CI_STATUS as KVNamespace;

function payload(
  action: string,
  over: Record<string, unknown> = {},
  repo = "ippoan/example",
) {
  return {
    action,
    pull_request: {
      number: 5,
      title: "feat: something (Refs #1)",
      draft: true,
      html_url: `https://github.com/${repo}/pull/5`,
      updated_at: "2026-07-09T00:00:00Z",
      user: { login: "yhonda-ohishi" },
      ...over,
    },
    repository: { full_name: repo },
  };
}

beforeEach(async () => {
  await kv.delete(DRAFT_PRS_KEY);
});

describe("applyDraftPrEvent / listDraftPrs", () => {
  it("opened (draft) で一覧に載り、metadata が揃う", async () => {
    await applyDraftPrEvent(kv, payload("opened"));
    const { prs, updatedAt } = await listDraftPrs(kv);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      repo: "ippoan/example",
      number: 5,
      title: "feat: something (Refs #1)",
      url: "https://github.com/ippoan/example/pull/5",
      author: "yhonda-ohishi",
      updated_at: "2026-07-09T00:00:00Z",
    });
    expect(updatedAt).not.toBe("");
  });

  it("edited で title / updated_at が更新される", async () => {
    await applyDraftPrEvent(kv, payload("opened"));
    await applyDraftPrEvent(
      kv,
      payload("edited", { title: "renamed", updated_at: "2026-07-09T01:00:00Z" }),
    );
    const { prs } = await listDraftPrs(kv);
    expect(prs).toHaveLength(1);
    expect(prs[0]!.title).toBe("renamed");
    expect(prs[0]!.updated_at).toBe("2026-07-09T01:00:00Z");
  });

  it("ready_for_review / closed で一覧から消える", async () => {
    await applyDraftPrEvent(kv, payload("converted_to_draft"));
    await applyDraftPrEvent(kv, payload("ready_for_review", { draft: false }));
    expect((await listDraftPrs(kv)).prs).toHaveLength(0);

    await applyDraftPrEvent(kv, payload("converted_to_draft"));
    await applyDraftPrEvent(kv, payload("closed", { draft: true }));
    expect((await listDraftPrs(kv)).prs).toHaveLength(0);
  });

  it("非 draft の activity は載せない / draft 不明は no-op", async () => {
    await applyDraftPrEvent(kv, payload("opened", { draft: false }));
    expect((await listDraftPrs(kv)).prs).toHaveLength(0);

    // draft 不明 (最小 payload)。既存 entry も壊さない。
    await applyDraftPrEvent(kv, payload("opened"));
    await applyDraftPrEvent(kv, payload("edited", { draft: undefined }));
    expect((await listDraftPrs(kv)).prs).toHaveLength(1);
  });

  it("複数 repo / PR が updated_at 降順で並ぶ", async () => {
    await applyDraftPrEvent(
      kv,
      payload("opened", { number: 1, updated_at: "2026-07-08T00:00:00Z" }, "ippoan/a"),
    );
    await applyDraftPrEvent(
      kv,
      payload("opened", { number: 2, updated_at: "2026-07-09T02:00:00Z" }, "ippoan/b"),
    );
    const { prs } = await listDraftPrs(kv);
    expect(prs.map((p) => `${p.repo}#${p.number}`)).toEqual([
      "ippoan/b#2",
      "ippoan/a#1",
    ]);
  });

  it("cache 未作成でも listDraftPrs は空で返る", async () => {
    expect(await listDraftPrs(kv)).toEqual({ updatedAt: "", prs: [] });
  });

  it("最小 payload (title / user 無し) は fallback 値で載る", async () => {
    await applyDraftPrEvent(kv, {
      action: "converted_to_draft",
      pull_request: { number: 9, draft: true },
      repository: { full_name: "ippoan/min" },
    });
    const { prs } = await listDraftPrs(kv);
    expect(prs[0]).toMatchObject({
      number: 9,
      title: "PR #9",
      url: "https://github.com/ippoan/min/pull/9",
      author: "unknown",
    });
  });
});
