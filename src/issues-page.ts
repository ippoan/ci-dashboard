import { type OrgIssue } from "./mcp/tools/issues";
import { type ProjectRef } from "./mcp/tools/projects";
import { type IssuePrRef } from "./issue-prs";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";
import {
  listCachedOpenIssues,
  reconcileIssues,
  getIssuesWatermark,
  FRESH_THRESHOLD_MS,
  type ReconcileResult,
} from "./issue-cache";
import { loadPrMap, type PrMapResult } from "./pr-map-cache";
import {
  getRateLimitBackoff,
  isAuthError,
  noteGitHubAuthBroken,
  getGitHubAuthBroken,
} from "./github-backoff";
import {
  loadProjectIssueMapSwr,
  readProjectIssueMapBlob,
  type ProjectIssueMapSwrResult,
} from "./project-cache";
import { readPrMapCache } from "./pr-map-cache";
import { parseTaglessRepos } from "./tagless-repos";
import { MAIN_ORGS as ORGS, YHONDA_REPOS } from "./scanned-orgs";

// Orgs scanned for Projects v2 (used by `fetchProjectIssueMap`). yhonda-ohishi
// is included so the user's claude-tooling repos can still be pinned to a
// board, even though only a subset of their repos surface as issues here.
const PROJECT_ORGS = ["ippoan", "ohishi-exp", "yhonda-ohishi"];

// Repos pre-attached when launching a Claude Code on Web session from an
// issue row's 🚀 button. Mirrors the GitHub MCP scope a typical web session
// runs with (cross-repo tasks routinely need consumers / shared hooks beyond
// the issue's own repo — see open-multirepo skill "Default repo set").
// Update in sync with the session install template if the scope changes.
export const CLAUDE_CODE_LAUNCH_REPOS = [
  "ippoan/auth-worker",
  "ippoan/mcp-relay-rs",
  "ippoan/ref-files-worker",
  "ippoan/cc-relay",
  "ippoan/ci-workflows",
  "ippoan/claude-md",
  "ippoan/ci-dashboard",
  "ippoan/secrets-inventory",
  "ippoan/secrets-inventory-gcp",
  "yhonda-ohishi/claude-skills",
  "ippoan/claude-hooks",
];

// Build a claude.ai/code launch URL pre-attached with the standard repo set
// and a minimal `<owner>/<repo>#<N> を read して処理` prompt. Spec lives in
// the issue body — the prompt only carries the ref (open-multirepo "prompt
// body MUST stay minimal" rule).
export function buildClaudeCodeLaunchUrl(repo: string, issueNumber: number): string {
  const prompt = `${repo}#${issueNumber} を read して処理`;
  // encodeURIComponent leaves `!*'()` per RFC3986. They're harmless inside
  // an HTML href attribute, but encoding them keeps the URL safe if it's
  // ever copy-pasted into Markdown (where `)` would terminate a link).
  const encoded = encodeURIComponent(prompt)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  // claude.ai/code accepts raw `,` between repos — do NOT URL-encode commas.
  return `https://claude.ai/code?repositories=${CLAUDE_CODE_LAUNCH_REPOS.join(",")}&prompt=${encoded}`;
}

// Cross-org Project v2 → issue map は `/projects` page と共通の KV cache
// (project-cache.ts) を経由して取得する (Refs #135)。`/projects` を先に開いて
// あれば warm cache を共有して即返、`projects_v2_item` webhook が来ると
// project-cache.applyProjectsV2ItemEvent が KV を flush する。

// PR map cache は src/pr-map-cache.ts に移設 (Refs #304)。webhook.ts の
// pull_request patch と本 page の SSR read が両方 import するため、page
// module から独立させて循環 import を避けている。

// `@ippoan/auth-client-worker` SDK が auth-worker delegation 中に投げる error
// は `Error.message` に常に診断文字列を入れる (introspect.ts / tokens.ts /
// dcr.ts 参照)。message に以下のどれかが含まれたら「再ログインで解決可能」と
// 判定して `/oauth/login` にリダイレクトする (= ユーザーは 502 ページではなく
// GitHub 同意画面に飛ぶ)。それ以外 (GitHub rate limit など) は従来通り 502 を
// 表示する。
// isAuthError は github-backoff.ts に共通化 (Refs #334 — background の auth
// 失効 marker 判定と同一規約にするため。invalid_grant も拾う)。

// KV には過去設定の repo が残っている可能性があるので allowlist で filter。
// mainOrgs 配下は全 repo 許可、yhonda-ohishi は YHONDA_REPOS のみ。
function filterAllowed(cached: OrgIssue[]): OrgIssue[] {
  const mainOrgSet = new Set(ORGS);
  const yhondaRepoSet = new Set(YHONDA_REPOS);
  return cached.filter((i) => {
    const owner = i.repo.split("/")[0] ?? "";
    if (mainOrgSet.has(owner)) return true;
    return yhondaRepoSet.has(i.repo);
  });
}

/** バナー描画に使う鮮度情報 (Refs #304)。 */
interface Freshness {
  /** 最後に full snapshot が成功してからの秒数。watermark 無しは null。 */
  reconcileAgeSec: number | null;
  /** warm path で background reconcile を waitUntil に投げた。 */
  issuesRefreshing: boolean;
  /** PR map / project map が stale を即返しして background refresh 中。 */
  prRefreshing: boolean;
  /** decorations (Project/PR チップ) の cache が無く背景 fetch 中 (cold
   *  start)。loading バナー + /issues/decorations poll で部分更新 (Refs #323)。 */
  decoLoading: boolean;
  /** rate-limit backoff 中。値は再開予定時刻 (epoch ms)。 */
  backoffUntil: number | null;
  /** GitHub 認証失効 (auth-worker delegation の invalid_grant 等)。再ログイン
   *  banner を出す (Refs #334)。 */
  authBroken: boolean;
  /** cold start で同期 reconcile が失敗した時のみ生エラーを表示する。 */
  coldError: string | null;
}

export async function handleIssuesPage(
  env: AuthClientWorkerEnv & { TAGLESS_REPOS?: string },
  ctx?: ExecutionContext,
): Promise<Response> {
  // SWR (Refs #304): KV を先に読み、warm なら GitHub を一切待たずに render
  // して reconcile は ctx.waitUntil で裏実行する。rate limit / 一時障害が
  // ページ表示を壊す経路は cold start (cache 空) だけに限定される。
  // 鮮度は webhook (issues / issue_comment / pull_request) の即時 patch が
  // 担保し、reconcile は安全網。
  const kv = env.CI_STATUS;
  let reconcileError: string | null = null;
  let reconcileResult: ReconcileResult | null = null;
  let issuesRefreshing = false;

  let cached = await listCachedOpenIssues(kv);
  let filtered = filterAllowed(cached);

  if (filtered.length > 0) {
    // Warm path: 背景 reconcile (reconcileIssues 自身が fresh window /
    // backoff / lock で no-op 判定する)。auth error は background では
    // 302 できないので log のみ — cache が温かい限り表示は継続し、cold
    // start 時に従来どおり /oauth/login へ誘導される。
    // 未 catch の reject は waitUntil 経由で例外になる (テストでは
    // waitOnExecutionContext が fail する) ため必ず pre-catch する。
    issuesRefreshing = true;
    const p = reconcileIssues(env, { mainOrgs: ORGS, yhondaRepos: YHONDA_REPOS })
      .then((r) => {
        console.log(JSON.stringify({ msg: "issues-page-bg-reconcile", reconcile: r }));
      })
      .catch(async (err) => {
        // 認証失効は background では 302 できないため marker を立てて
        // banner で operator に知らせる (Refs #334)。
        await noteGitHubAuthBroken(kv, err);
        console.log(JSON.stringify({
          msg: "issues-page-bg-reconcile-failed",
          isAuth: isAuthError(err),
          error: err instanceof Error ? err.message : String(err),
        }));
      });
    if (ctx) ctx.waitUntil(p);
    else void p;
  } else {
    // Cold path: 従来どおり同期 reconcile。302 / 502 の挙動を保全する。
    try {
      reconcileResult = await reconcileIssues(env, { mainOrgs: ORGS, yhondaRepos: YHONDA_REPOS });
    } catch (err) {
      if (isAuthError(err)) {
        // 認証失効: GitHub 同意画面 → /oauth/callback → return_to で /issues に戻る
        return new Response(null, {
          status: 302,
          headers: { Location: "/oauth/login?return_to=/issues" },
        });
      }
      reconcileError = err instanceof Error ? err.message : String(err);
    }
    cached = await listCachedOpenIssues(kv);
    filtered = filterAllowed(cached);
  }

  // observability: reconcile が GitHub を引いたか (fetched) / 何件 upsert・
  // evict したか (patched/removed) と KV cache 件数。/issues の表示が古い時に
  // reconcile が走っているかを wrangler tail で確認できる (Refs #217)。
  console.log(JSON.stringify({
    msg: "issues-page",
    reconcile: reconcileResult,
    reconcileError,
    issuesRefreshing,
    cachedCount: cached.length,
  }));

  // Cache が空かつ reconcile も fail → 完全に表示不能なので 502。
  if (filtered.length === 0 && reconcileError) {
    return new Response(renderError(reconcileError), {
      status: 502,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Cold start で backoff により fetch できず cache も空 → 「issue ゼロ 🎉」
  // と誤表示せず cooldown を明示する (Refs #304)。
  if (filtered.length === 0 && reconcileResult && !reconcileResult.fetched) {
    const coldBackoff = await getRateLimitBackoff(kv);
    if (coldBackoff) {
      const resume = new Date(coldBackoff.until).toISOString().slice(11, 16);
      return new Response(
        renderError(`GitHub rate-limit cooldown — auto-refresh resumes by ${resume} UTC`),
        {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": String(Math.max(1, Math.ceil((coldBackoff.until - Date.now()) / 1000))),
          },
        },
      );
    }
  }

  const merged = {
    total_count: filtered.length,
    incomplete: false,
    items: filtered,
  };

  const [project, prs, watermark, backoff, authBroken] = await Promise.all([
    loadProjectIssueMapSwr(env, PROJECT_ORGS, ctx),
    loadPrMap(env, ORGS, YHONDA_REPOS, ctx),
    getIssuesWatermark(kv),
    getRateLimitBackoff(kv),
    getGitHubAuthBroken(kv),
  ]);

  const reconcileAgeSec = watermark
    ? Math.max(0, Math.round((Date.now() - Date.parse(watermark)) / 1000))
    : null;
  const freshness: Freshness = {
    reconcileAgeSec,
    // 「裏で更新中」表示は実際に stale だった時だけ (fresh window 内の
    // no-op reconcile でバナーを出すとノイズになる)。
    issuesRefreshing: issuesRefreshing &&
      (reconcileAgeSec === null || reconcileAgeSec * 1000 >= FRESH_THRESHOLD_MS),
    prRefreshing: prs.refreshing || project.refreshing,
    decoLoading: project.loading || prs.loading,
    backoffUntil: backoff?.until ?? null,
    authBroken: authBroken !== null,
    coldError: reconcileError,
  };
  const projectMap = project.map;
  const prMap = prs.map;

  // Split issues into "Project-tagged" (top aggregate section) and
  // "ungrouped per-repo" (bottom sections). An issue belongs to the project
  // section iff `projectMap` has at least one ProjectRef for `repo#number`.
  const projectTagged: Array<{ issue: OrgIssue; projects: ProjectRef[] }> = [];
  const ungrouped: OrgIssue[] = [];
  for (const item of merged.items) {
    const key = `${item.repo}#${item.number}`;
    const refs = projectMap.get(key);
    if (refs && refs.length > 0) projectTagged.push({ issue: item, projects: refs });
    else ungrouped.push(item);
  }
  // Top section is one flat list ordered by recency across repos.
  projectTagged.sort((a, b) => b.issue.updated_at.localeCompare(a.issue.updated_at));

  // Per-repo grouping (existing behavior) for the ungrouped half.
  const grouped = new Map<string, OrgIssue[]>();
  for (const item of ungrouped) {
    if (!grouped.has(item.repo)) grouped.set(item.repo, []);
    grouped.get(item.repo)!.push(item);
  }
  const repos = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, items]) => [
      repo,
      [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    ] as const);

  // Repo の release 運用 badge 用 (Refs #312)。判定は TAGLESS_REPOS wrangler
  // var のみ (I/O 追加なし)。direct-push allowlist は GitHub fetch が要るので
  // 本 page では見ない — allowlist のみの repo は「要 tag」表示になるが、
  // 当該 repo はほぼ issue を持たないため許容 (/releases 側は allowlist も加味)。
  const taglessSet = parseTaglessRepos(env.TAGLESS_REPOS);

  return new Response(
    renderHtml(merged.total_count, merged.incomplete, projectTagged, repos, project, prs, freshness, taglessSet),
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function renderHtml(
  total: number,
  incomplete: boolean,
  projectTagged: ReadonlyArray<{ issue: OrgIssue; projects: ProjectRef[] }>,
  repos: ReadonlyArray<readonly [string, OrgIssue[]]>,
  project: ProjectIssueMapSwrResult,
  prs: PrMapResult,
  freshness: Freshness,
  taglessSet: ReadonlySet<string>,
): string {
  const repoSections = repos
    .map(([repo, items]) => renderRepoSection(repo, items, prs.map, taglessSet))
    .join("\n");

  const projectSection = projectTagged.length > 0
    ? renderProjectSection(projectTagged, prs.map, taglessSet)
    : "";

  const incompleteBanner = incomplete
    ? `<div class="banner">⚠️ Result was truncated by GitHub search. Showing ${total} issues but more may exist.</div>`
    : "";
  // Rate-limit cooldown 中: 生の GitHub エラーは出さず、cache 表示 + 再開
  // 予定だけを穏当に伝える (Refs #304)。
  // GitHub 認証失効 (Refs #334): background refresh は 302 できないので、
  // banner で再ログインに誘導する。token 再取得が成功した経路が marker を
  // 消すので、ログイン後は自動で消える。
  const authBrokenBanner = freshness.authBroken
    ? `<div class="banner">🔑 GitHub 認証が失効しています — <a href="/oauth/login?return_to=/issues" style="color:#ffa198;text-decoration:underline">/oauth/login</a> で再ログインすると自動復旧します (それまで background 更新は停止、webhook 反映は継続)</div>`
    : "";
  // 文言注意 (Refs #329): cooldown で止まるのは「検索ベースの安全網 reconcile」
  // だけ。webhook → KV → WS reload の経路は GitHub API を呼ばないため、issue の
  // 作成/close は cooldown 中も反映され続ける — そう読める文言にする。
  const backoffBanner = freshness.backoffUntil
    ? `<div class="banner banner-info">⏳ GitHub rate-limit cooldown — webhook による更新は継続中です (検索ベースの安全網 reconcile のみ ${new Date(freshness.backoffUntil).toISOString().slice(11, 16)} UTC 頃まで休止)</div>`
    : "";
  // Cold start で同期 reconcile が fail したが cache はあった時のみ生エラー。
  const issueStaleBanner = freshness.coldError
    ? `<div class="banner banner-info">📋 Issue list shown is from KV cache — fresh reconcile failed (${escapeHtml(freshness.coldError)})</div>`
    : "";
  // Warm path の SWR 表示。backoff バナーが出ている時は冗長なので省略。
  const refreshingBanner = !freshness.backoffUntil && !freshness.coldError &&
    (freshness.issuesRefreshing || freshness.prRefreshing)
    ? `<div class="banner banner-info">🔄 Refreshing in background${
        freshness.reconcileAgeSec !== null
          ? ` (issues last reconciled ${freshness.reconcileAgeSec}s ago)`
          : ""
      }</div>`
    : "";
  // decorations (Project/PR チップ) cold start: loading バナー + poll script で
  // 部分更新する (Refs #323)。project map の stale/error は SWR blob 化に伴い
  // refreshing 表示に集約 (層別 cache の stale fallback は blob 生成側が吸収)。
  const decoLoadingBanner = freshness.decoLoading
    ? `<div class="banner banner-info" id="deco-loading">🔄 Project / PR チップを読み込み中… (一覧は表示済み、チップは取得でき次第この場で反映されます)</div>`
    : "";
  const prBanner = prs.stale
    ? `<div class="banner banner-info">🔗 Related-PR links shown are from the last successful sync — fresh fetch failed (${escapeHtml(prs.error ?? "")})</div>`
    : prs.error
    ? `<div class="banner">⚠️ Related-PR links unavailable: ${escapeHtml(prs.error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Open Issues — CI Dashboard</title>${PWA_HEAD_TAGS}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      padding: 24px;
      max-width: 1200px;
      margin: 0 auto;
    }
    header { margin-bottom: 24px; }
    ${TAB_STYLES}
    h1 { font-size: 20px; color: #58a6ff; }
    .summary { font-size: 13px; color: #8b949e; margin-top: 4px; }
    .banner {
      background: #341a1f;
      border: 1px solid #f85149;
      color: #ffa198;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .banner-info {
      background: #1c2433;
      border-color: #1f6feb88;
      color: #a5d6ff;
    }
    section.repo, section.projects {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    section.repo h2, section.projects h2 {
      font-size: 14px;
      font-weight: 600;
      padding: 10px 14px;
      background: #1f2630;
      border-bottom: 1px solid #30363d;
    }
    section.projects h2 {
      /* Distinguish the aggregate section from per-repo blocks below */
      background: #1c2433;
      border-bottom-color: #1f6feb55;
    }
    section.repo h2 .count, section.projects h2 .count {
      color: #8b949e;
      font-weight: 400;
      margin-left: 6px;
    }
    section.repo h2 a { color: #c9d1d9; text-decoration: none; }
    section.repo h2 a:hover { color: #58a6ff; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    tbody tr { border-top: 1px solid #21262d; }
    tbody tr:hover { background: #1c2129; }
    th, td {
      padding: 8px 14px;
      text-align: left;
      vertical-align: top;
    }
    th {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #8b949e;
      background: #0d1117;
    }
    td.num { width: 60px; color: #8b949e; font-variant-numeric: tabular-nums; }
    td.num a { color: #58a6ff; text-decoration: none; }
    td.num a:hover { text-decoration: underline; }
    td.repo {
      width: 200px;
      color: #8b949e;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap;
    }
    td.repo a { color: #8b949e; text-decoration: none; }
    td.repo a:hover { color: #58a6ff; }
    td.title a { color: #c9d1d9; text-decoration: none; font-weight: 500; }
    td.title a:hover { color: #58a6ff; text-decoration: underline; }
    td.author { width: 130px; color: #8b949e; }
    td.updated {
      width: 110px;
      color: #8b949e;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    td.launch { width: 44px; text-align: center; }
    .cc-launch {
      display: inline-block;
      text-decoration: none;
      font-size: 15px;
      line-height: 1;
      padding: 4px 6px;
      border-radius: 6px;
      opacity: 0.55;
      transition: opacity 0.15s, background 0.15s;
    }
    .cc-launch:hover { opacity: 1; background: #1f6feb33; }
    /* CI fixture rows: amber "do-not-touch" affordance. The 🔒 badge + dimmed
       row + static lock in the launch cell signal that closing/deleting the
       issue breaks worktree-naming-guard tests (see isFixtureIssue). */
    .fixture-badge {
      display: inline-block;
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 10px;
      background: #d2992222;
      color: #e3b341;
      border: 1px solid #d2992288;
      margin-right: 6px;
      white-space: nowrap;
      vertical-align: middle;
    }
    tr.fixture { background: #1b1813; }
    tr.fixture:hover { background: #221d14; }
    tr.fixture td.title a { color: #8b949e; }
    .cc-launch-disabled {
      display: inline-block;
      font-size: 14px;
      line-height: 1;
      padding: 4px 6px;
      opacity: 0.5;
      cursor: default;
    }
    .labels { margin-top: 4px; }
    .label {
      display: inline-block;
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 10px;
      background: #1f6feb22;
      color: #79c0ff;
      margin-right: 4px;
      margin-bottom: 2px;
    }
    /* Project chips: brighter than label chips so the board affiliation pops */
    .project-chip {
      display: inline-block;
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 10px;
      background: #1f6feb44;
      color: #a5d6ff;
      border: 1px solid #1f6feb88;
      margin-right: 4px;
      margin-bottom: 2px;
      text-decoration: none;
    }
    .project-chip:hover { background: #1f6feb66; }
    /* Related-PR chips: green palette so they read as "in-flight work" vs.
       the blue project-chip's "belongs to a board" affordance. Draft PRs
       desaturate to gray so the reader can tell at a glance whether the PR
       is review-ready. */
    .pr-chips { margin-top: 4px; }
    .pr-chip {
      display: inline-block;
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 10px;
      background: #2ea04322;
      color: #7ee787;
      border: 1px solid #2ea04388;
      margin-right: 4px;
      margin-bottom: 2px;
      text-decoration: none;
      font-variant-numeric: tabular-nums;
    }
    .pr-chip:hover { background: #2ea04344; }
    .pr-chip.draft {
      background: #6e768122;
      color: #8b949e;
      border-color: #6e768188;
    }
    .pr-chip.draft:hover { background: #6e768144; }
    /* Merged PRs: purple — "work done, release-close pending". Distinguishes
       from green open PRs (in-flight) at a glance. */
    .pr-chip.merged {
      background: #8957e522;
      color: #d2a8ff;
      border-color: #8957e588;
    }
    .pr-chip.merged:hover { background: #8957e544; }
    .empty {
      padding: 32px;
      text-align: center;
      color: #8b949e;
      font-size: 14px;
    }
    /* Release 運用 badge (Refs #312): tagless = merge がそのまま release で
       /releases から即 close 可、要 tag = release tag を打つまで close 候補に
       出ない。issue を片付ける時にどちらの手順かを一目で判別する。 */
    .release-mode {
      display: inline-block;
      font-size: 11px;
      font-weight: 400;
      padding: 1px 8px;
      border-radius: 10px;
      margin-left: 8px;
      vertical-align: middle;
      white-space: nowrap;
      text-decoration: none;
    }
    .mode-tagless {
      background: #2ea04322;
      color: #7ee787;
      border: 1px solid #2ea04388;
    }
    .mode-tagless:hover { background: #2ea04344; }
    .mode-needs-tag {
      background: #d2992222;
      color: #e3b341;
      border: 1px solid #d2992288;
    }
    .mode-needs-tag:hover { background: #d2992244; }
  </style>
</head>
<body>
  <header>
    ${renderTabs("issues")}
    <h1>📋 Open Issues</h1>
    <div class="summary">
      ${escapeHtml(String(total))} issue${total === 1 ? "" : "s"} across
      ${escapeHtml(String(repos.length + (projectTagged.length > 0 ? 1 : 0)))} section${repos.length === 0 && projectTagged.length <= 1 ? "" : "s"}
      (orgs: ${ORGS.map((o) => escapeHtml(o)).join(", ")}
      + ${YHONDA_REPOS.map((r) => escapeHtml(r)).join(", ")})
    </div>
  </header>
  ${incompleteBanner}
  ${authBrokenBanner}
  ${backoffBanner}
  ${refreshingBanner}
  ${issueStaleBanner}
  ${decoLoadingBanner}
  ${prBanner}
  ${projectSection}
  ${repos.length === 0 && projectTagged.length === 0
    ? `<div class="empty">🎉 No open issues. Nice work.</div>`
    : repoSections}
  ${PWA_REGISTER_SCRIPT}
  ${LIVE_RELOAD_SCRIPT}
  ${freshness.decoLoading ? DECORATIONS_POLL_SCRIPT : ""}
</body>
</html>`;
}

// decorations (Project/PR チップ) の部分更新 (Refs #323)。cold start で SSR が
// チップ無しで返った時だけ埋め込まれる。/issues/decorations (KV read のみ) を
// poll し、両 cache が揃ったら data-ik 行の title cell にチップを DOM 注入する。
// XSS 安全のため innerHTML は使わず createElement + textContent のみ。
const DECORATIONS_POLL_SCRIPT = `
  <script>
    (() => {
      const apply = (data) => {
        document.querySelectorAll("tr[data-ik]").forEach((tr) => {
          const ik = tr.getAttribute("data-ik");
          const td = tr.querySelector("td.title");
          if (!td) return;
          const projects = data.projects[ik] || [];
          if (projects.length > 0 && !td.querySelector(".project-chip")) {
            const div = document.createElement("div");
            div.className = "labels";
            for (const p of projects) {
              const a = document.createElement("a");
              a.className = "project-chip";
              a.href = p.url; a.target = "_blank"; a.rel = "noopener";
              a.textContent = p.title;
              div.appendChild(a);
            }
            td.appendChild(div);
          }
          const prs = data.prs[ik] || [];
          if (prs.length > 0 && !td.querySelector(".pr-chips")) {
            const div = document.createElement("div");
            div.className = "pr-chips";
            for (const p of prs) {
              const a = document.createElement("a");
              a.className = "pr-chip" + (p.state === "merged" ? " merged" : p.draft ? " draft" : "");
              a.href = p.url; a.target = "_blank"; a.rel = "noopener";
              a.title = "#" + p.number + ": " + p.title;
              a.textContent = (p.state === "merged" ? "\u2705 " : "\ud83d\udd17 ") + "#" + p.number +
                (p.state === "merged" ? " (merged)" : p.draft ? " (draft)" : "");
              div.appendChild(a);
            }
            td.appendChild(div);
          }
        });
      };
      let tries = 0;
      const poll = async () => {
        tries++;
        try {
          const r = await fetch("/issues/decorations");
          if (r.ok) {
            const d = await r.json();
            // 揃っている分だけ先に注入する (Refs #330 — project map が rate
            // limit で組めない間も PR チップは出す)。apply は idempotent。
            apply(d);
            if (d.ready) {
              const banner = document.getElementById("deco-loading");
              if (banner) banner.remove();
              return;
            }
          }
        } catch { /* transient — retry */ }
        if (tries < 16) setTimeout(poll, 2500);
        else {
          const banner = document.getElementById("deco-loading");
          if (banner) banner.textContent = "\u26a0\ufe0f チップの取得に時間がかかっています — 後でリロードしてください";
        }
      };
      setTimeout(poll, 2000);
    })();
  </script>`;

/** GET /issues/decorations — 部分更新用の軽量 JSON (KV read 2 回のみ、GitHub
 *  fetch なし)。両 cache (project map blob + pr map) が揃ったら ready:true。 */
export async function handleIssuesDecorations(
  env: AuthClientWorkerEnv,
): Promise<Response> {
  const kv = env.CI_STATUS;
  const [projects, prs] = await Promise.all([
    readProjectIssueMapBlob(kv),
    readPrMapCache(kv),
  ]);
  return Response.json(
    {
      ready: projects !== null && prs !== null,
      projects: projects ?? {},
      prs: prs ?? {},
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

// /issues の live 更新 (Refs #321)。Hub DO の /ws に接続し、webhook の issues
// event 処理後に broadcast される `issues-updated` envelope を受けたら debounce
// 付きで reload する。SSR + KV read は高速なので DOM patch ではなく reload で
// 十分。dashboard と同じ ping/pong keepalive + 3s reconnect。タブが非表示の間
// は reload を保留し、再表示時にまとめて 1 回 reload する (バックグラウンド
// タブの無駄な再描画防止)。
const LIVE_RELOAD_SCRIPT = `
  <script>
    (() => {
      let pending = false;
      let timer = null;
      const doReload = () => {
        if (document.visibilityState !== "visible") { pending = true; return; }
        location.reload();
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && pending) { pending = false; doReload(); }
      });
      const connect = () => {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(proto + "//" + location.host + "/ws");
        let ping = null;
        ws.onopen = () => {
          ping = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send("ping");
          }, 30000);
        };
        ws.onmessage = (e) => {
          if (e.data === "pong") return;
          try {
            const msg = JSON.parse(e.data);
            if (msg && msg.type === "issues-updated") {
              // burst (連続 close 等) を 1 回の reload にまとめる
              if (timer) clearTimeout(timer);
              timer = setTimeout(doReload, 1500);
            }
          } catch { /* ignore */ }
        };
        ws.onclose = () => {
          if (ping) clearInterval(ping);
          setTimeout(connect, 3000);
        };
        ws.onerror = () => { ws.close(); };
      };
      connect();
    })();
  </script>`;

function renderProjectSection(
  items: ReadonlyArray<{ issue: OrgIssue; projects: ProjectRef[] }>,
  prMap: ReadonlyMap<string, IssuePrRef[]>,
  taglessSet: ReadonlySet<string>,
): string {
  const rows = items.map(({ issue, projects }) =>
    renderProjectRow(issue, projects, prMap, taglessSet)).join("\n");
  return `<section class="projects">
  <h2>📋 Project 付き<span class="count">(${items.length})</span></h2>
  <table>
    <thead><tr><th>#</th><th>Repo</th><th>Title</th><th>Author</th><th>Updated</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderProjectRow(
  i: OrgIssue,
  projects: ReadonlyArray<ProjectRef>,
  prMap: ReadonlyMap<string, IssuePrRef[]>,
  taglessSet: ReadonlySet<string>,
): string {
  const chips = projects.map((p) =>
    `<a class="project-chip" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>`,
  ).join("");
  const labelChips = i.labels.length > 0
    ? `<div class="labels">${i.labels.map((l) =>
        `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "";
  const trClass = isFixtureIssue(i) ? ' class="fixture"' : "";
  return `<tr${trClass} data-ik="${escapeHtml(`${i.repo}#${i.number}`)}">
    <td class="num"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">#${i.number}</a></td>
    <td class="repo"><a href="https://github.com/${escapeHtml(i.repo)}/issues" target="_blank" rel="noopener">${escapeHtml(i.repo)}</a>${renderReleaseModeBadge(i.repo, taglessSet)}</td>
    <td class="title">${renderFixtureBadge(i)}<a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a><div class="labels">${chips}</div>${labelChips}${renderPrChips(i, prMap)}</td>
    <td class="author">@${escapeHtml(i.author)}</td>
    <td class="updated">${escapeHtml(i.updated_at.slice(0, 10))}</td>
    ${renderLaunchCell(i)}
  </tr>`;
}

function renderRepoSection(
  repo: string,
  items: OrgIssue[],
  prMap: ReadonlyMap<string, IssuePrRef[]>,
  taglessSet: ReadonlySet<string>,
): string {
  const rows = items.map((i) => renderRow(i, prMap)).join("\n");
  const repoUrl = `https://github.com/${repo}/issues`;
  return `<section class="repo">
  <h2><a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener">${escapeHtml(repo)}</a><span class="count">(${items.length})</span>${renderReleaseModeBadge(repo, taglessSet)}</h2>
  <table>
    <thead><tr><th>#</th><th>Title</th><th>Author</th><th>Updated</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderRow(
  i: OrgIssue,
  prMap: ReadonlyMap<string, IssuePrRef[]>,
): string {
  const labelChips = i.labels.length > 0
    ? `<div class="labels">${i.labels.map((l) =>
        `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "";
  const trClass = isFixtureIssue(i) ? ' class="fixture"' : "";
  return `<tr${trClass} data-ik="${escapeHtml(`${i.repo}#${i.number}`)}">
    <td class="num"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">#${i.number}</a></td>
    <td class="title">${renderFixtureBadge(i)}<a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a>${labelChips}${renderPrChips(i, prMap)}</td>
    <td class="author">@${escapeHtml(i.author)}</td>
    <td class="updated">${escapeHtml(i.updated_at.slice(0, 10))}</td>
    ${renderLaunchCell(i)}
  </tr>`;
}

function renderPrChips(
  i: OrgIssue,
  prMap: ReadonlyMap<string, IssuePrRef[]>,
): string {
  const refs = prMap.get(`${i.repo}#${i.number}`);
  if (!refs || refs.length === 0) return "";
  const chips = refs.map((p) => {
    // Merged PRs take precedence over draft styling — a merged PR can't
    // be draft anymore, but if GitHub ever flipped them simultaneously the
    // purple "done" signal is more useful than the gray "draft" one.
    const cls = p.state === "merged" ? " merged" : p.draft ? " draft" : "";
    const icon = p.state === "merged" ? "✅" : "🔗";
    const label = p.state === "merged"
      ? "Merged PR"
      : p.draft ? "Draft PR" : "PR";
    const title = `${label} #${p.number}: ${p.title}${p.repo === i.repo ? "" : ` (${p.repo})`}`;
    const suffix = p.state === "merged"
      ? " (merged)"
      : p.draft ? " (draft)" : "";
    return `<a class="pr-chip${cls}" href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="${escapeHtml(title)}">${icon} #${p.number}${suffix}</a>`;
  }).join("");
  return `<div class="pr-chips">${chips}</div>`;
}

// Repo の release 運用 badge (Refs #312)。issue を release-close フローで
// close するのに tag を打つ必要があるか (要 tag) / merge がそのまま release か
// (tagless) を /issues 上で即読みできるようにする。判定は TAGLESS_REPOS
// wrangler var のみ (direct-push allowlist は GitHub fetch が要るため見ない)。
// export しているのは test から直接検証するため。
export function renderReleaseModeBadge(
  repo: string,
  taglessSet: ReadonlySet<string>,
): string {
  return taglessSet.has(repo)
    ? `<a class="release-mode mode-tagless" href="/releases" title="tagless 運用 — merge がそのまま release。tag を打たずに /releases から close できる">tagless</a>`
    : `<a class="release-mode mode-needs-tag" href="/releases" title="tag-release 運用 — close 候補を出すには release tag を打つ (/tag-release)">🏷️ 要 tag</a>`;
}

// CI fixture issues (e.g. ippoan/claude-hooks#1, #2) exist only to satisfy
// worktree-naming-guard test assertions — their body literally says "Do not
// close. Do not delete." and the test breaks if they're closed/deleted/reopened.
// They are NOT work items, so the dashboard must make that obvious: flag the
// row with a 🔒 badge and suppress the 🚀 launch button (launching a Claude
// session on a fixture risks acting on — i.e. closing — it). Detection is by
// the `[CI fixture]` title prefix, which both fixtures already carry, so no
// GitHub-side label change is required. `OrgIssue` doesn't cache the body, so
// the title prefix is the only marker available at render time anyway.
export function isFixtureIssue(i: { title: string }): boolean {
  return /^\s*\[CI fixture\]/i.test(i.title);
}

function renderFixtureBadge(i: OrgIssue): string {
  if (!isFixtureIssue(i)) return "";
  return `<span class="fixture-badge" title="CI fixture — close / delete / reopen しないこと (テストの前提)">🔒 保全</span>`;
}

function renderLaunchCell(i: OrgIssue): string {
  // Fixtures aren't actionable — replace the launch button with a static lock
  // so nobody fires a session that might close the issue.
  if (isFixtureIssue(i)) {
    return `<td class="launch"><span class="cc-launch-disabled" title="CI fixture — Claude Code 起動の対象外">🔒</span></td>`;
  }
  const url = buildClaudeCodeLaunchUrl(i.repo, i.number);
  return `<td class="launch"><a class="cc-launch" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Claude Code で起動 (${escapeHtml(i.repo)}#${i.number})">🚀</a></td>`;
}

function renderError(msg: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Open Issues — Error</title>
<style>body { font-family: sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
.err { background: #341a1f; border: 1px solid #f85149; color: #ffa198;
       padding: 12px 16px; border-radius: 6px; max-width: 720px; }</style>
</head><body>
<h1>📋 Open Issues</h1>
<div class="err">Failed to fetch issues: ${escapeHtml(msg)}</div>
<p style="margin-top: 12px;"><a href="/" style="color:#58a6ff">← CI Dashboard</a></p>
</body></html>`;
}

// Minimal HTML entity escape. Covers attribute and text contexts.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
