import { describe, it, expect } from "vitest";
import { parseProgressChecklist } from "../src/progress-checklist";

const OPEN = (n: number) => `<!-- progress-checklist:${n} -->`;
const CLOSE = (n: number) => `<!-- /progress-checklist:${n} -->`;

describe("parseProgressChecklist", () => {
  it("アンカー無し body は null", () => {
    expect(parseProgressChecklist("just a regular issue body", 442)).toBeNull();
  });

  it("開きアンカーだけで閉じが無ければ null (誤爆防止)", () => {
    const body = `prologue\n${OPEN(442)}\n- [ ] orphan\nepilogue`;
    expect(parseProgressChecklist(body, 442)).toBeNull();
  });

  it("別 issue 番号のアンカーには反応しない (1 issue 1 節)", () => {
    const body = `${OPEN(441)}\n- [ ] a\n${CLOSE(441)}`;
    expect(parseProgressChecklist(body, 442)).toBeNull();
    const r = parseProgressChecklist(body, 441);
    expect(r?.total).toBe(1);
  });

  it("基本: `[ ]` / `[x]` / `[X]` を全部 task として拾う", () => {
    const body = [
      "プロローグ (報告本文 — 触らない)",
      OPEN(442),
      "## 📋 進捗チェックリスト",
      "",
      "- [ ] todo a",
      "- [x] done b",
      "- [X] done c (大文字)",
      "",
      CLOSE(442),
      "エピローグ",
    ].join("\n");
    const r = parseProgressChecklist(body, 442);
    expect(r).not.toBeNull();
    expect(r!.total).toBe(3);
    expect(r!.done).toBe(2);
    expect(r!.tasks.map((t) => t.label)).toEqual(["todo a", "done b", "done c (大文字)"]);
    expect(r!.tasks.map((t) => t.checked)).toEqual([false, true, true]);
  });

  it("ネストの depth を 2 空白 = 1 段で保持 / tab も 2 空白として扱う", () => {
    const body = [
      OPEN(1),
      "- [ ] root",
      "  - [x] child",
      "    - [ ] grand",
      "\t- [x] tab-child",
      CLOSE(1),
    ].join("\n");
    const r = parseProgressChecklist(body, 1);
    expect(r!.tasks.map((t) => t.depth)).toEqual([0, 1, 2, 1]);
  });

  it("fenced code block (```) 内の `- [ ]` は拾わない", () => {
    const body = [
      OPEN(2),
      "- [x] real",
      "```",
      "- [ ] not a task (in fence)",
      "- [x] also fenced",
      "```",
      "- [ ] real 2",
      CLOSE(2),
    ].join("\n");
    const r = parseProgressChecklist(body, 2);
    expect(r!.total).toBe(2);
    expect(r!.done).toBe(1);
    expect(r!.tasks.map((t) => t.label)).toEqual(["real", "real 2"]);
  });

  it("fenced code block (~~~) も同様に除外", () => {
    const body = [
      OPEN(3),
      "- [ ] outside",
      "~~~",
      "- [x] inside",
      "~~~",
      CLOSE(3),
    ].join("\n");
    const r = parseProgressChecklist(body, 3);
    expect(r!.total).toBe(1);
    expect(r!.tasks[0]!.label).toBe("outside");
  });

  it("非 task 行 (見出し / プレーン箇条書き / 空行) は無視する", () => {
    const body = [
      OPEN(4),
      "### step 1 — bootstrap ✅",
      "- not a checkbox",
      "    just prose",
      "- [ ] actual task",
      "",
      "- [x] another",
      CLOSE(4),
    ].join("\n");
    const r = parseProgressChecklist(body, 4);
    expect(r!.total).toBe(2);
    expect(r!.done).toBe(1);
  });

  it("空の節 (アンカー間に task 0 件) → { tasks: [], done: 0, total: 0 }", () => {
    const body = `${OPEN(5)}\n## 📋 進捗\n\n_未着手_\n${CLOSE(5)}`;
    const r = parseProgressChecklist(body, 5);
    expect(r).not.toBeNull();
    expect(r!.total).toBe(0);
    expect(r!.done).toBe(0);
    expect(r!.tasks).toEqual([]);
  });

  it("label の前後 whitespace を trim する", () => {
    const body = `${OPEN(6)}\n- [ ]   spaced label   \n${CLOSE(6)}`;
    const r = parseProgressChecklist(body, 6);
    expect(r!.tasks[0]!.label).toBe("spaced label");
  });

  it("閉じアンカーより後ろに置かれた `- [ ]` は拾わない (節境界の保証)", () => {
    const body = [
      OPEN(7),
      "- [x] inside",
      CLOSE(7),
      "- [ ] outside — レポート本文の例文",
    ].join("\n");
    const r = parseProgressChecklist(body, 7);
    expect(r!.total).toBe(1);
  });

  it("開きアンカーより前に置かれた `- [ ]` は拾わない (節境界の保証)", () => {
    const body = [
      "- [ ] before opening anchor",
      OPEN(8),
      "- [x] inside",
      CLOSE(8),
    ].join("\n");
    const r = parseProgressChecklist(body, 8);
    expect(r!.total).toBe(1);
    expect(r!.tasks[0]!.label).toBe("inside");
  });

  it("行頭の `- [ ]` 風だが whitespace 後ろがない `-[ ]` 等の異形は拾わない", () => {
    const body = [
      OPEN(9),
      "-[ ] no space after hyphen",
      "-  [x]  too few spaces?",
      "- [ ] real",
      CLOSE(9),
    ].join("\n");
    const r = parseProgressChecklist(body, 9);
    // `-[ ]` は dash 直後 space 必須なので不該当。`-  [x]` (dash + 2 space + box)
    // は `-\s+\[...\]` の正規表現が `\s+` で複数 space を許容するので OK。
    expect(r!.total).toBe(2);
    expect(r!.tasks.map((t) => t.label)).toEqual(["too few spaces?", "real"]);
  });
});
