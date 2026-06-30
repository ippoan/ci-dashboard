// Progress checklist parser (Refs #442 PR1 — depends on規約正本 ippoan/claude-skills#82).
//
// GitHub issue 本文に置かれた「progress-checklist 節」を read-only に拾うため
// のパーサ。/issues SSR (PR2) と CCoW セッションの検査経路 (claude-skills#82
// `resume-session`) の双方が import する想定。本ファイルは pure (KV / DOM /
// network 非依存) — ブラウザでも node でも同じ結果を返す。
//
// 節のフォーマット (規約正本: claude-skills#82):
//
//   <!-- progress-checklist:N -->
//   ## 📋 進捗チェックリスト
//
//   ### step 1 — ... ✅
//   - [x] ... (#441)
//   - [ ] ... cleanup
//
//   <!-- /progress-checklist:N -->
//
// N = issue number (1 issue 1 節)。閉じアンカーはレポート本文への侵食を防ぐ
// hard boundary なので、無い時は **節の終わりまで読まず null を返す**
// (= 節を持たない issue として扱う、誤爆防止)。

export interface ProgressTask {
  /** `[x]` (大小無視) なら true、`[ ]` なら false。 */
  checked: boolean;
  /** チェックボックスの後ろの label 文字列 (前後 whitespace trim 済み)。 */
  label: string;
  /** 行頭インデント半角 2 スペースを 1 段として計算した nest level (0-based)。 */
  depth: number;
}

export interface ProgressChecklist {
  tasks: ProgressTask[];
  /** `[x]` の数。 */
  done: number;
  /** task 行の総数 (= `tasks.length`)。 */
  total: number;
}

/** issue body から `<!-- progress-checklist:N -->` 〜 `<!-- /progress-checklist:N -->`
 *  の中身を抽出し、task list を返す。節が無ければ null (= 描画しない)。
 *  閉じアンカーが無い時も誤爆防止のため null。 */
export function parseProgressChecklist(
  body: string,
  n: number,
): ProgressChecklist | null {
  const open = `<!-- progress-checklist:${n} -->`;
  const close = `<!-- /progress-checklist:${n} -->`;
  const s = body.indexOf(open);
  if (s < 0) return null;
  const e = body.indexOf(close, s + open.length);
  if (e < 0) return null;
  const block = body.slice(s + open.length, e);

  const tasks: ProgressTask[] = [];
  let inFence = false;
  for (const rawLine of block.split("\n")) {
    // fenced code block (``` or ~~~) を toggle で追跡。fence 開始/終了行
    // 自体は task として拾わない (上の行末 newline で別行になっている)。
    if (/^\s*(?:```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // `   - [x] label` / `- [ ] label` / `  - [X] ...` を許容。
    // tab 1 = 半角 2 スペース換算で depth を算出 (markdown 慣習)。
    const m = rawLine.match(/^([ \t]*)-\s+\[([ xX])\]\s+(.*)$/);
    if (!m) continue;
    const indent = m[1] ?? "";
    const checked = m[2]?.toLowerCase() === "x";
    const label = (m[3] ?? "").trim();
    const indentWidth = indent.replace(/\t/g, "  ").length;
    tasks.push({
      checked,
      label,
      depth: Math.floor(indentWidth / 2),
    });
  }
  const done = tasks.reduce((n, t) => n + (t.checked ? 1 : 0), 0);
  return { tasks, done, total: tasks.length };
}
