import { describe, it, expect } from "vitest";
import { renderProgressChecklist } from "../src/issues-page";
import type { OrgIssue } from "../src/mcp/tools/issues";

function makeIssue(overrides: Partial<OrgIssue> = {}): OrgIssue {
  return {
    repo: "ippoan/ci-dashboard",
    number: 442,
    title: "Render progress-checklist",
    state: "open",
    author: "yhonda-ohishi",
    labels: [],
    assignees: [],
    comments: 0,
    created_at: "2026-06-30T00:00:00Z",
    updated_at: "2026-06-30T00:00:00Z",
    url: "https://github.com/ippoan/ci-dashboard/issues/442",
    body: null,
    ...overrides,
  };
}

const OPEN = (n: number) => `<!-- progress-checklist:${n} -->`;
const CLOSE = (n: number) => `<!-- /progress-checklist:${n} -->`;

describe("renderProgressChecklist", () => {
  it("body 無し → 空文字 (描画しない)", () => {
    expect(renderProgressChecklist(makeIssue({ body: null }))).toBe("");
    expect(renderProgressChecklist(makeIssue({ body: undefined }))).toBe("");
  });

  it("アンカー無い body → 空文字", () => {
    expect(renderProgressChecklist(makeIssue({ body: "just text" }))).toBe("");
  });

  it("別 N のアンカーには反応しない (1 issue 1 節)", () => {
    const body = `${OPEN(441)}\n- [ ] a\n${CLOSE(441)}`;
    expect(renderProgressChecklist(makeIssue({ number: 442, body }))).toBe("");
  });

  it("merged + closed の進捗バー (50%) を含む details/summary を描画", () => {
    const body = [
      OPEN(442),
      "- [x] step 1",
      "- [ ] step 2",
      CLOSE(442),
    ].join("\n");
    const html = renderProgressChecklist(makeIssue({ number: 442, body }));
    expect(html).toContain('<details class="progress-checklist">');
    expect(html).toContain("進捗 1/2");
    // 進捗バーの幅 (50%)
    expect(html).toContain('style="width:50%"');
    // checkbox は disabled
    expect(html).toMatch(/<input type="checkbox" disabled[ >]/);
    // checked は checked 属性付き
    expect(html).toMatch(/<input type="checkbox" disabled checked>\s+step 1/);
    // 未チェックは checked 無し
    expect(html).toMatch(/<input type="checkbox" disabled>\s+step 2/);
    // 完了行は .done class
    expect(html).toMatch(/<li class="done"[^>]*>.*step 1/);
  });

  it("空節 → '進捗 0/0 (未着手)' を summary に出す", () => {
    const body = `${OPEN(1)}\n## 📋 まだ書いていない\n${CLOSE(1)}`;
    const html = renderProgressChecklist(makeIssue({ number: 1, body }));
    expect(html).toContain("進捗 0/0");
    expect(html).toContain("未着手");
    // body (ul) は出さない (空節は折り畳む対象が無い)
    expect(html).not.toContain("<ul class=\"pc-tasks\"");
  });

  it("100% 完了の進捗バー幅は 100%", () => {
    const body = [OPEN(2), "- [x] a", "- [x] b", CLOSE(2)].join("\n");
    const html = renderProgressChecklist(makeIssue({ number: 2, body }));
    expect(html).toContain("進捗 2/2");
    expect(html).toContain('style="width:100%"');
  });

  it("0% 完了の進捗バー幅は 0%", () => {
    const body = [OPEN(3), "- [ ] a", "- [ ] b", CLOSE(3)].join("\n");
    const html = renderProgressChecklist(makeIssue({ number: 3, body }));
    expect(html).toContain("進捗 0/2");
    expect(html).toContain('style="width:0%"');
  });

  it("label の HTML 特殊文字は escape する (XSS)", () => {
    const body = [OPEN(4), "- [ ] <script>alert(1)</script> & x", CLOSE(4)].join("\n");
    const html = renderProgressChecklist(makeIssue({ number: 4, body }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("ネスト depth に応じて margin-left がスケールする", () => {
    const body = [
      OPEN(5),
      "- [ ] root",
      "  - [ ] child",
      "    - [ ] grand",
      CLOSE(5),
    ].join("\n");
    const html = renderProgressChecklist(makeIssue({ number: 5, body }));
    expect(html).toContain('style="margin-left:0px"');
    expect(html).toContain('style="margin-left:16px"');
    expect(html).toContain('style="margin-left:32px"');
  });

  it("fenced code 内の - [ ] は task として描画しない (parser の責務、回帰防止)", () => {
    const body = [
      OPEN(6),
      "- [x] real",
      "```",
      "- [ ] fenced",
      "```",
      CLOSE(6),
    ].join("\n");
    const html = renderProgressChecklist(makeIssue({ number: 6, body }));
    expect(html).toContain("進捗 1/1");
    expect(html).toContain("real");
    expect(html).not.toContain("fenced");
  });
});
