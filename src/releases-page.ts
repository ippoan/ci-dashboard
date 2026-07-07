import { parseRepo, tokenForOrg, GitHubApiError } from "./github-api";
import type { AuthClientWorkerEnv } from "@ippoan/auth-client-worker";
import {
  extractRefIssues,
  extractPrNumber,
  extractBranchIssue,
  sortSemverDesc,
  isSemverTag,
  previousTag,
  computeWarnings,
} from "./release-helpers";
import {
  collectIssueNumbersForRange,
  fetchIssuesByNumbers,
} from "./release-alert";
import {
  cachedTags,
  cachedCompare,
  cachedCommits,
  cachedRepoMeta,
  cachedPullRequest,
  cachedIssue,
  TTL_MOVING_COMPARE,
} from "./release-cache";
import { loadDirectPushAllowlist } from "./direct-push-allowlist";
import { parseTaglessRepos } from "./tagless-repos";
import { loadPrMap, type PrMapResult } from "./pr-map-cache";
import { MAIN_ORGS, YHONDA_REPOS } from "./scanned-orgs";
import {
  getRateLimitBackoff,
  noteGitHubAuthBroken,
  getGitHubAuthBroken,
  clearGitHubAuthBroken,
} from "./github-backoff";
import {
  readReleasesIndexBlob,
  writeReleasesIndexBlob,
  writePatchedReleasesIndexBlob,
  RELEASES_INDEX_FRESH_SECONDS,
  RELEASES_INDEX_REFRESH_LOCK,
  RELEASES_INDEX_REFRESH_LOCK_TTL,
} from "./releases-index-cache";
import { renderTabs, TAB_STYLES } from "./nav-tabs";
import { PWA_HEAD_TAGS, PWA_REGISTER_SCRIPT } from "./pwa";

// `/releases` (no params) renders a list of "recent releases" — every watched
// repo (from Hub `/statuses`) with its latest semver-sorted tags, each linking
// to the detailed candidate view. The lookup form is appended below as a
// fallback for older / arbitrary tags.
//
// `/releases?repo=owner/name&tag=vX.Y.Z` renders the release confirmation
// view: every issue touched by commits in this tag's range, with a checkbox
// per row so the operator can close them in one POST after eyeballing the
// list. See issue #35 and CLAUDE.md (Refs convention, manual-close flow).
//
// We do NOT persist anything yet — the page recomputes from GitHub each load.
// Persistence + dashboard "unconfirmed release" badge are deferred to a later
// PR (issue #35 calls those out as recommended but not required for MVP).

export async function handleReleasesPage(
  req: Request,
  env: ReleasesIndexEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const repoParam = url.searchParams.get("repo");
  const tag = url.searchParams.get("tag");

  // Flash params populated by POST /api/release-close{,-batch} redirects.
  const closedFlash = numericList(url.searchParams.get("closed"));
  const failedFlash = numericList(url.searchParams.get("failed"));
  // `failed_reasons=N:reason,N:reason` 形式。reason は URL-encoded。
  // Refs ippoan/ci-dashboard#152 (close 失敗時の原因表示)
  const failedReasons = parseFailedReasons(url.searchParams.get("failed_reasons"));

  // Only the fully-specified pair opens the detail page; every other shape
  // (no params / partial / post-close redirect) falls through to the index so
  // the operator never lands on an empty form by accident (issue #45).
  // Flash redirects must not be cached by the browser — they encode one-shot
  // banner state. Same logic for empty post-close redirects (no flash params
  // but the operator expects to see a fresh table).
  const hasFlash = closedFlash.length > 0 || failedFlash.length > 0;

  if (repoParam && tag) {
    let result: ReleasePayload;
    try {
      result = await loadRelease(env, repoParam, tag, env.CI_STATUS);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        return html(renderError(`Not found: ${err.message}`), 404);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return html(renderError(msg), 502);
    }
    return html(
      renderHtml(result, closedFlash, failedFlash, failedReasons),
      200,
      cacheControlFor(hasFlash, /* detail */ true),
    );
  }

  // Index page; `repoParam` (when set without tag, e.g. from the batch-close
  // redirect) tags along so flash links can point at the right GitHub repo.
  return await handleIndexPage(env, closedFlash, failedFlash, failedReasons, repoParam, hasFlash, ctx);
}

// Cache-Control policy:
//   - 全 page を `no-store` に倒す。SSR は blob KV read だけで cheap (<50ms)、
//     対して browser cache (旧 max-age=15 / swr=60) は close 直後の
//     `?closed=N` flash が消えた後の reload で **stale な open 行を表示し続ける**
//     害悪のほうが大きい (close 反応無し問題、Refs ippoan/ci-dashboard PR #364)。
//   - 旧設計の swr は revalidate 中も古い HTML を返すため、apply-close で blob を
//     即 patch しても browser 側で見えるのは古い view という非対称が常時発生していた。
function cacheControlFor(_hasFlash: boolean, _detail: boolean): string {
  return "private, no-store";
}

// --------------------------------------------------------------------------
// "Recent releases" landing page (no params)
// --------------------------------------------------------------------------

export interface RepoView {
  repo: string;
  tagBlocks: TagBlock[];
  olderTags: string[];   // tags beyond the displayed top N
  // tagless 運用 (TAGLESS_REPOS / direct-push allowlist) なら true。
  // close するのに release tag が要るか (= 要 tag) を card 見出しの badge で
  // 表示する (Refs #312)。
  tagless: boolean;
}

export interface TagBlock {
  tag: string;
  prevTag: string | null;
  issues: IssueRow[];    // already-fetched and warning-annotated
  // `synthetic` blocks are constructed from default-branch commits when a
  // direct-push-OK repo has no semver tags (#57). They drop the "→ detail"
  // link because there's no compare-range view to point at, and they hide
  // already-closed issues entirely instead of nesting them in <details>.
  synthetic?: boolean;
}

// Top tags shown inline per repo (each fans out compare + per-issue fetches).
// Older tags collapse to a link strip pointing at the detail page.
const TOP_TAGS_INLINE = 5;

// /releases index 用の env 形 (Refs #325 で WEBHOOK_QUEUE を追加 —
// 背景 refresh を queue consumer に流すための optional binding)。
interface ReleasesIndexEnv {
  INTERNAL_SHARED_SECRET: SecretsStoreSecret;
  CI_HUB: DurableObjectNamespace;
  CI_STATUS: KVNamespace;
  TAGLESS_REPOS?: string;
  WEBHOOK_QUEUE?: Queue<{ kind: "releases-index-refresh" }>;
}

async function handleIndexPage(
  env: ReleasesIndexEnv,
  closedFlash: number[],
  failedFlash: number[],
  failedReasons: Map<number, string>,
  flashRepo: string | null,
  hasFlash: boolean,
  ctx?: ExecutionContext,
): Promise<Response> {
  // SWR (Refs #325): 生成済み views の blob を即 render する。index の同期
  // 生成は監視 repo (~30) の GitHub fan-out で実測 平均 16s / p90 35s かかる
  // ため、stale は背景 refresh (queue consumer 経由 — waitUntil の 30s 上限
  // では fan-out が切られ得る)、cold start (blob 無し = deploy 直後のみ) だけ
  // 従来どおり同期生成する。
  const kv = env.CI_STATUS;
  const [blob, authBroken] = await Promise.all([
    readReleasesIndexBlob<RepoView[]>(env),
    getGitHubAuthBroken(kv),
  ]);
  let views: RepoView[];
  let refreshing = false;
  let staleRepos: string[] = [];
  if (blob) {
    views = blob.views;
    const fresh = Date.now() - blob.storedAt < RELEASES_INDEX_FRESH_SECONDS * 1000;
    if (!fresh) {
      refreshing = true;
      staleRepos = blob.staleRepos ?? [];
      await kickReleasesIndexRefresh(env, ctx);
    }
  } else {
    views = await computeIndexViews(env);
    await writeReleasesIndexBlob(env, views);
  }

  // Flash 整合 (Refs #325): close 直後の redirect は blob がまだ古い可能性が
  // あるので、closed= の issue を view 上 closed 扱いに変換して表示を一致させる
  // (renderTagBlock の visible filter が拾って closed-details 側に落ちる)。
  if (flashRepo && closedFlash.length > 0) {
    for (const v of views) {
      if (v.repo !== flashRepo) continue;
      for (const b of v.tagBlocks) {
        for (const r of b.issues) {
          if (closedFlash.includes(r.number)) r.state = "closed";
        }
      }
    }
  }

  return html(
    renderIndex(
      views, closedFlash, failedFlash, failedReasons, flashRepo,
      refreshing, staleRepos, authBroken !== null,
    ),
    200,
    cacheControlFor(hasFlash, /* detail */ false),
  );
}

/** 背景 refresh を投げる。queue binding があれば consumer (15 分上限) へ、
 *  無い環境 (wrangler dev / test) は waitUntil fallback。lock は
 *  refreshReleasesIndex 側で取るので二重投函しても無駄撃ちで済む。 */
async function kickReleasesIndexRefresh(
  env: ReleasesIndexEnv,
  ctx?: ExecutionContext,
): Promise<void> {
  if (env.WEBHOOK_QUEUE) {
    try {
      await env.WEBHOOK_QUEUE.send({ kind: "releases-index-refresh" });
      return;
    } catch (err) {
      console.log(JSON.stringify({
        msg: "releases-index-enqueue-failed",
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  const p = refreshReleasesIndex(env).catch(async (err) => {
    await noteGitHubAuthBroken(env.CI_STATUS, err);
    console.log(JSON.stringify({
      msg: "releases-index-bg-refresh-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  });
  if (ctx) ctx.waitUntil(p);
  else void p;
}

/** index views を取り直して blob に書く (背景実行前提、queue consumer から
 *  も呼ばれる)。lock / fresh 再確認で重複 fan-out を排除。 */
/** refresh attempt の結末 (Refs #337)。"done" = 集計して blob を書いた
 *  (= WS reload を発火して良い)。"fresh" = blob が既に新しい (停止して良い)。
 *  それ以外は「blob はまだ stale なのに集計できなかった」= caller (queue
 *  consumer) が self-reschedule して liveness を保つ。 */
export type ReleasesIndexRefreshOutcome =
  | "done" | "fresh" | "backoff" | "lock" | "empty-skip";

/** 単一 repo の view を再計算し、blob の該当 view を差し替える (Refs #421)。
 *  /admin/force-refresh-releases?repo=owner/name endpoint から呼ばれる。
 *  full refresh (~16-35s for ~30 repo) を待たずに特定 repo だけ即時更新したい
 *  時の救済経路。useSynthetic は computeIndexViews と同じロジックで判定。
 *  @returns "patched" = view を差し替え blob を書いた
 *           "view-null" = loadRepoView が null (archived / fetch fail)
 *           "no-blob" = blob 不在 (cold start 中) — 通常 full refresh に倒す */
export async function recomputeRepoView(
  env: ReleasesIndexEnv,
  repo: string,
  // true なら pr-map の 1時間 fresh-window を無視し、実 Search を同期実行
  // してから view を計算する (Refs #466 追補)。?forcePrMap=true の診断用途。
  forcePrMap = false,
): Promise<"patched" | "view-null" | "no-blob"> {
  const blob = await readReleasesIndexBlob<RepoView[]>(env);
  if (!blob) return "no-blob";

  const tagless = parseTaglessRepos(env.TAGLESS_REPOS);
  let allowlist = new Set<string>();
  try {
    allowlist = await loadDirectPushAllowlist(env, env.CI_STATUS);
  } catch { /* keep empty — allowlist は best-effort */ }

  let prMap: PrMapResult;
  try {
    // TAGLESS_REPOS の merged 補完 (Refs #466) を pr-map fetch に通す。
    prMap = await loadPrMap(env, MAIN_ORGS, YHONDA_REPOS, undefined, [...tagless], forcePrMap);
  } catch {
    prMap = { map: new Map(), stale: false, refreshing: false, loading: true, error: null };
  }

  const useSynthetic = allowlist.has(repo) || tagless.has(repo);
  const view = await loadRepoView(env, repo, useSynthetic, env.CI_STATUS, prMap);
  if (!view) return "view-null";

  // blob の views[] 内の該当 entry を差し替え (存在しなければ末尾に追加)。
  // storedAt は触らない (= 全集計とは別経路、patch の意味を維持、#339 と同じ
  // invariant)。
  const idx = blob.views.findIndex((v) => v.repo === repo);
  if (idx >= 0) blob.views[idx] = view;
  else blob.views.push(view);
  await writePatchedReleasesIndexBlob(env, blob);
  return "patched";
}

export async function refreshReleasesIndex(
  env: ReleasesIndexEnv,
): Promise<ReleasesIndexRefreshOutcome> {
  const started = Date.now();
  const outcome = await refreshReleasesIndexInner(env);
  // bail 経路が無 log だと「🔄 更新中」のまま無言で停止した時に観測不能に
  // なる (2026-06-11 実害、Refs #337)。attempt ごとに必ず 1 行出す。
  console.log(JSON.stringify({
    msg: "releases-index-refresh-attempt",
    outcome,
    ms: Date.now() - started,
  }));
  return outcome;
}

async function refreshReleasesIndexInner(
  env: ReleasesIndexEnv,
): Promise<ReleasesIndexRefreshOutcome> {
  const kv = env.CI_STATUS;
  // Rate-limit cooldown 中は fan-out しない (Refs #329 — reconcile / pr-map /
  // project-map と同じガード)。stale blob + staleRepos は維持され、cooldown
  // 明けの reschedule で追い付く。
  if (await getRateLimitBackoff(kv)) return "backoff";
  if (await kv.get(RELEASES_INDEX_REFRESH_LOCK)) return "lock";
  await kv.put(RELEASES_INDEX_REFRESH_LOCK, "1", {
    expirationTtl: RELEASES_INDEX_REFRESH_LOCK_TTL,
  });
  try {
    const recheck = await readReleasesIndexBlob<RepoView[]>(env);
    if (recheck && Date.now() - recheck.storedAt < RELEASES_INDEX_FRESH_SECONDS * 1000) {
      // fresh-window 内は full refresh を no-op にする (= refresh の最短間隔)。
      // この bail のせいで「TAGLESS_REPOS に追加 → parameter 無し force-refresh」
      // が反映されない罠がある (busy org は blob がほぼ常に <1h fresh)。新 repo を
      // 即時 index へ入れたい時は storedAt を触らない recomputeRepoView
      // (`/admin/force-refresh-releases?repo=owner/name`) で貫通する。
      // 詳細: ci-dashboard-map skill の Q&A (#438/#439)。
      return "fresh";
    }
    const views = await computeIndexViews(env);
    // 全 repo の loadRepoView が落ちた (rate limit / 障害) 時に正常な blob を
    // 空で上書きしない invariant (Refs #329)。空 index が正しいのは「監視 repo
    // が本当にゼロ」の時だけで、その場合 recheck も空のはず。
    if (views.length === 0 && recheck && (recheck.views?.length ?? 0) > 0) {
      return "empty-skip";
    }
    // Close 復活レース対策 (Refs #343 後継)。`refresh` は ~16-35s かかり、
    // その間に close handler (`/releases-index-apply-close`) や issues webhook
    // (`/releases-index-apply-issue`) が blob を closed に patch しても、
    // refresh の computeIndexViews は **fetch 開始時点の cachedIssue (TTL 60s)**
    // から views を組むため #N=open のまま固まり、ここで write すると patch が
    // 上書きされて closed issue が reload で「復活」する。close 経路 (#343) と
    // webhook 経路 (#339) は KV lock 圏外 (DO の serializeReleasesPatch のみ)
    // なので refresh とは元から無関係に race する設計。
    //
    // 修正: write 直前に最新 blob を読み直し、「最新 blob で closed の行」を
    // 新 views でも強制 closed に保つ。GitHub 上で closed の事実は blob patch が
    // 既に確定させているので、computeIndexViews の stale open を上書きするのは
    // 一方向 (closed → open には戻さない) なら安全。逆方向 (refresh fresh fetch が
    // closed と判定 / blob が open) は patch 漏れケースで refresh の結果が正なので
    // そのまま使う。
    const latest = await readReleasesIndexBlob<RepoView[]>(env);
    let preserved = 0;
    if (latest) {
      const closedUrls = new Set<string>();
      for (const v of latest.views) {
        for (const b of v.tagBlocks) {
          for (const r of b.issues) if (r.state === "closed") closedUrls.add(r.url);
        }
      }
      if (closedUrls.size > 0) {
        for (const v of views) {
          for (const b of v.tagBlocks) {
            for (const r of b.issues) {
              if (r.state !== "closed" && closedUrls.has(r.url)) {
                r.state = "closed";
                r.warnings = computeWarnings({ state: "closed", labels: r.labels });
                preserved++;
              }
            }
          }
        }
      }
    }
    // race fix が実際に火を吹いたか後追いするため、blob 書込み直前で
    // preserved 件数を必ず 1 行出す (= 0 でも記録、race ヒット率の指標)。
    console.log(JSON.stringify({
      msg: "releases-index-refresh-preserved-closed",
      preserved,
      latestExists: latest !== null,
    }));
    await writeReleasesIndexBlob(env, views);
    // token 取得が成功した = 認証は生きている。失効 banner を自動回復 (Refs #334)。
    await clearGitHubAuthBroken(kv);
    return "done";
  } finally {
    // Lock は「compute 実行中」だけを守る。TTL 任せにすると完了/bail 後も
    // 最大 120s 残り、その間の refresh job が全部 bail → ack 捨てされて
    // 「stale のまま停止」する liveness 穴になっていた (Refs #337)。
    await kv.delete(RELEASES_INDEX_REFRESH_LOCK);
  }
}

async function computeIndexViews(env: ReleasesIndexEnv): Promise<RepoView[]> {
  // 1. Watched repos come from three sources:
  //   (a) Hub status cache — every repo that has ever fired a CI run.
  //   (b) Direct-push-OK allowlist — repos that never auto-merge a PR and
  //       therefore won't show up in (a) until they happen to push a tag.
  //       Fetched from `yhonda-ohishi/claude-skills` (same SoT as
  //       `/wt-direct-push`); see direct-push-allowlist.ts.
  //   (c) `TAGLESS_REPOS` wrangler var — opt-in list for repos that PR-merge
  //       through CI but don't cut release tags. These get the same synthetic-
  //       block treatment as (b), built from default-branch commits, so the
  //       operator can see open Refs without ever tagging.
  const watched = new Set<string>();
  try {
    const hubId = env.CI_HUB.idFromName("singleton");
    const hub = env.CI_HUB.get(hubId);
    const res = await hub.fetch(new Request("http://hub/statuses"));
    if (res.ok) {
      const statuses = await res.json<Array<{ repo: string }>>();
      for (const s of statuses) watched.add(s.repo);
    }
  } catch { /* empty list → falls through; allowlist may still add repos */ }

  let allowlist = new Set<string>();
  try {
    allowlist = await loadDirectPushAllowlist(env, env.CI_STATUS);
    for (const r of allowlist) watched.add(r);
  } catch { /* graceful: allowlist stays empty, existing tag-flow unaffected */ }

  const tagless = parseTaglessRepos(env.TAGLESS_REPOS);
  for (const r of tagless) watched.add(r);

  const repos = [...watched].sort();

  // 2. Shared pr-map: `/issues` page の KV cache をそのまま reuse して、合致する
  //    merged PR を持たない `Refs #N` を close 候補から落とす gate (Refs #400)。
  //    tag-release commit / 直 push commit など PR 経由を持たない Refs が
  //    synthetic block に紛れ込む bug の修正。loading 中 (cold start) は
  //    filter を skip して fail-open (= 空 index を blob にキャッシュしない
  //    invariant を維持しつつ、warm 後に正しく絞られる)。
  let prMap: PrMapResult;
  try {
    // TAGLESS_REPOS の merged 補完 (Refs #466) を pr-map fetch に通す。
    prMap = await loadPrMap(env, MAIN_ORGS, YHONDA_REPOS, undefined, [...tagless]);
  } catch {
    // pr-map fetch 失敗 (rate limit 等) は fail-open: 既存挙動 (gate 無し) に
    // degrade して空表示を避ける。次の warm 時に filter が効き始める。
    prMap = { map: new Map(), stale: false, refreshing: false, loading: true, error: null };
  }

  // 3. Per-repo data load in parallel; whole-repo failures get a null view
  //    we drop in the renderer. Allowlisted or TAGLESS_REPOS-listed repos
  //    take the synthetic path inside loadRepoView when they have no semver
  //    tags.
  const views = await Promise.all(repos.map(async (repo) => {
    try {
      const useSynthetic = allowlist.has(repo) || tagless.has(repo);
      return await loadRepoView(env, repo, useSynthetic, env.CI_STATUS, prMap);
    } catch {
      return null;
    }
  }));

  return views.filter((v): v is RepoView => v !== null);
}

export async function loadRepoView(
  env: AuthClientWorkerEnv,
  repo: string,
  useSynthetic: boolean,
  kv?: KVNamespace,
  prMap?: PrMapResult,
): Promise<RepoView | null> {
  const { owner, repo: name } = parseRepo(repo);
  const token = await tokenForOrg(env, owner);

  // 0. Drop archived repos early. GitHub API は archived repo の issue PATCH
  //    で 403 "Repository was archived so is read-only." を返すため、
  //    operator が release UI から close しようとして必ず失敗する。
  //    そもそも archived repo は将来の release tag も cut されない前提なので
  //    一覧から外す。Refs ippoan/ci-dashboard#155 (ippoan/github-mcp-server-rs
  //    が monorepo 化で archive されたが /releases に残っていた問題)。
  //
  //    meta fetch 自体が失敗 (private / 削除 / token 権限喪失 / network) した
  //    場合は best-effort で握り潰し、既存の tag fetch 失敗 → null 経路に
  //    判断を委ねる (= 「archived と確認できた時だけ」drop)。
  try {
    const meta = await cachedRepoMeta(token, kv, owner, name);
    if (meta.archived === true) return null;
  } catch {
    /* archived 判定不能 — 続行 */
  }

  // /releases index は **常に PR-driven (synthetic-only)** に倒す。
  //
  // 旧設計: tag (v*) を持つ repo は per-tag compare で Refs harvest、tag を
  //         持たない repo だけ synthetic 経路 (default branch の recent commits +
  //         PR body Refs harvest)。
  // 問題: 「issue は PR と紐づき、tag とは紐づかない」。tag は release packaging で
  //       あって issue ↔ commit/PR 関係には無関係。tag-compare 経路は本質を
  //       表現しておらず、新 tag を切るまで merge 済みの Refs が card に出ない
  //       (= operator が close 候補を見落とす)。さらに「🏷️ 要 tag」badge は
  //       roster opt-in 漏れの空 card を生んでいた (#360〜 で個別追加していた)。
  // 新設計: tag の有無を見ず、全 repo を synthetic block 1 つで表現する。
  //         tag は detail page (`?repo=X&tag=Y`) からは引けるが、index 上の
  //         主役ではなくなる (= 古い tag への older strip も廃止)。
  //         consumer-facing badge は全て tagless (= "🏷️ 要 tag" badge 廃止)。
  //
  // `useSynthetic` param は呼出側互換のため signature に残しているが、
  // 振る舞いは入力に依らず常に synthetic。直接読まないので unused 警告を
  // 回避するためだけに参照する。
  void useSynthetic;

  const block = await loadSyntheticBlock(env, token, owner, name, kv, undefined, prMap);
  return {
    repo: `${owner}/${name}`,
    tagBlocks: block ? [block] : [],
    olderTags: [],
    tagless: true,
  };
}

// Build a synthetic block for tag-less direct-push-OK repos (#57).
//
// We scan the most recent SYNTHETIC_COMMIT_WINDOW commits on the default
// branch for `Refs #N` and hydrate the referenced issues. Both open and
// closed issues are kept (Refs #224): the operator wants tag-less / direct-
// push repos to keep showing their card even after every ref is closed.
// renderTagBlock collapses the closed rows into a <details>, mirroring the
// tag-compare path, so the card stays low-noise.
//
// The "tag" identity is `<branch>@<sha7>` so the post-close comment
// ("Closed by release main@e8e90a4") stays traceable even though the synthetic
// block has no compare range. The detail page (`?repo=X&tag=Y`) is *not*
// supported for these tags — `renderTagBlock` skips the link.
const SYNTHETIC_COMMIT_WINDOW = 100;

// Cap on how many `(#PR)` follow-up fetches the synthetic block does per repo.
// The PR pass recovers issues whose `Refs #N` only live in the PR body (squash
// drops them from the merge subject), but a 100-commit window across ~13 tagless
// repos would otherwise fan out a PR fetch per commit and blow the Worker
// subrequest budget. We keep the most-recent N (issues merged recently are the
// ones still likely open / actionable); PRs are cached so warm loads are cheap.
const MAX_PR_FOLLOWUP = 20;

interface RepoMeta {
  default_branch: string;
  archived?: boolean;
}

async function loadSyntheticBlock(
  env: AuthClientWorkerEnv,
  token: string,
  owner: string,
  name: string,
  kv?: KVNamespace,
  // `sinceTag` 指定時は latestTag..defaultBranch の compare で commits を取り、
  // `<branch>@<sha7> (since <sinceTag>)` という "Unreleased" 風の block にする。
  // 指定無しなら従来通り default branch の最近 SYNTHETIC_COMMIT_WINDOW commits。
  // Refs ippoan/ci-dashboard#147 (cross-repo Refs 修正) と #145 の延長:
  // TAGLESS_REPOS 指定の repo が tag を持つ場合に「latest tag → HEAD で merge
  // されたが未 release な PR」を表示するための「unreleased zone」用途。
  sinceTag?: string,
  // `/issues` page の pr-map を share した gate (Refs #400)。同 issue を
  // `state:"merged"` で指す PR が無い `Refs #N` を close 候補から落とす
  // (tag-release commit / direct-push commit が拾われる bug の修正)。
  // `loading === true` (cold start) または undefined は filter を skip して
  // fail-open (既存挙動に degrade)。
  prMap?: PrMapResult,
): Promise<TagBlock | null> {
  let defaultBranch: string;
  try {
    const meta = await cachedRepoMeta(token, kv, owner, name);
    defaultBranch = meta.default_branch;
  } catch {
    return null;
  }
  if (!defaultBranch) return null;

  let commits: RawCommit[] = [];
  try {
    if (sinceTag) {
      // `sinceTag...defaultBranch` is a moving range — HEAD advances on every
      // merge — so cap the compare cache at the short moving-head TTL. The
      // default 24h would hide just-merged Refs (e.g. open issues referenced by
      // a PR merged minutes ago), making the repo look "all closed". Refs #228.
      const cmp = await cachedCompare(
        token, kv, owner, name, sinceTag, defaultBranch, TTL_MOVING_COMPARE,
      );
      commits = cmp.commits;
    } else {
      commits = await cachedCommits(token, kv, owner, name, defaultBranch, SYNTHETIC_COMMIT_WINDOW);
    }
  } catch {
    return null;
  }
  if (commits.length === 0) return null;

  const repoCtx = { owner, name };
  const refs = new Set<number>();
  // 以前 (#292) は cross-repo refs (`Refs <otherOwner>/<otherName>#N`) を集めて
  // 同じ card に並べていたが、別 repo の release context から close できる UX が
  // 誤操作を招くため #417 で **同 repo refs のみ surface** に変更。cross-repo
  // dependency は home repo 自身の card で確認する。
  for (const c of commits) {
    for (const n of extractRefIssues(c.commit.message, repoCtx)) refs.add(n);
  }

  // PR follow-up pass. A squash-merge subject keeps only the `(#PR)` suffix and
  // drops the PR body's `Refs #N` trailer — e.g. ci-dashboard#272 merged as
  // "…統合 (#272)" with `Refs #271` only in the body, or claude-hooks#13 merged
  // as "… (#13)" with `Refs #12` only in the body. The commit-message scan above
  // then harvests the PR number (a pull_request, filtered out) but never the
  // underlying issue, so the card collapses to "no referenced issues". The
  // tag-compare detail path already recovers these via collectIssueNumbersForRange;
  // mirror it here for BOTH synthetic paths — the Unreleased zone (sinceTag) and
  // the pure-tagless window (no tags at all, e.g. claude-hooks / mcp-cf-workers,
  // which only carry `dev-*` tags). Capped to the most-recent MAX_PR_FOLLOWUP so
  // the 100-commit window doesn't fan out a fetch per commit. Refs #290, #291.
  //
  // Ordering: cachedCommits (no sinceTag) is newest-first; cachedCompare
  // (sinceTag) is oldest-first. Normalize to newest-first so the cap keeps the
  // freshest PRs (the ones whose issues are most likely still open).
  const recentFirst = sinceTag ? [...commits].reverse() : commits;
  const prNumbers: number[] = [];
  const seenPr = new Set<number>();
  for (const c of recentFirst) {
    const pr = extractPrNumber(c.commit.message);
    if (pr !== null && !seenPr.has(pr)) {
      seenPr.add(pr);
      prNumbers.push(pr);
    }
  }
  await Promise.all(prNumbers.slice(0, MAX_PR_FOLLOWUP).map(async (n) => {
    try {
      const pr = await cachedPullRequest(token, kv, owner, name, n);
      const fromBranch = extractBranchIssue(pr.head.ref);
      if (fromBranch !== null) refs.add(fromBranch);
      if (pr.body) {
        for (const ref of extractRefIssues(pr.body, repoCtx)) refs.add(ref);
        // #292 で cross-repo refs を PR body から拾っていたが #417 で廃止。
      }
    } catch { /* ignore per-PR failure — best-effort enrichment */ }
  }));

  // pr-map gate (Refs #400): `Refs #N` を含む commit/PR は集めたが、その issue
  // を実際に解決する `state:"merged"` な PR が無いものは close 候補から落とす。
  // commit message 直 scan 経路で拾われる tag-release commit や direct-push
  // commit が「PR 不在の checked 候補」として並ぶ bug の修正。同じ pr-map は
  // `/issues` page の chip でも使われており SSR で 2 重 fetch にはならない。
  //
  // cold start (loading) や fetch 失敗 (gate 未提供) は filter skip = 既存挙動。
  if (prMap && !prMap.loading) {
    const hasMergedPr = (ownerRepo: string, n: number): boolean => {
      const refsList = prMap.map.get(`${ownerRepo}#${n}`);
      return Array.isArray(refsList) && refsList.some((r) => r.state === "merged");
    };
    const sameRepoOwnerRepo = `${owner}/${name}`;
    for (const n of [...refs]) {
      if (!hasMergedPr(sameRepoOwnerRepo, n)) refs.delete(n);
    }
  }

  if (refs.size === 0) {
    // No referenced issues in the recent window — nothing to confirm. Skipping
    // the block (vs. returning an empty one) keeps the repo off the landing
    // page entirely, matching the tag path's behavior.
    return null;
  }

  const issues = await fetchIssuesByNumbers(token, owner, name, refs, kv);
  // Keep both open and closed referenced issues (was open-only): a tag-less /
  // direct-push repo whose refs are all closed should still surface its card
  // with the closed history collapsed into a <details>. Refs #224.
  const rows: IssueRow[] = issues
    .filter((i) => !i.pull_request)
    .map((i) => {
      const labels = i.labels.map((l) => l.name);
      return {
        number: i.number,
        title: i.title,
        state: i.state,
        labels,
        assignees: i.assignees.map((a) => a.login),
        url: i.html_url,
        updated_at: i.updated_at,
        warnings: computeWarnings({ state: i.state, labels }),
      };
    })
    .sort((a, b) => a.number - b.number);

  if (rows.length === 0) return null;

  // commits の並び順:
  //   - 通常 (sinceTag 無し): cachedCommits は最新 first (GitHub /commits API 既定)
  //   - sinceTag 有り:        cachedCompare は古い first (GitHub /compare API)
  // どちらでも HEAD (= 最も新しい) sha を tag 名に含めたいので分岐させる。
  const headCommit = sinceTag ? commits[commits.length - 1]! : commits[0]!;
  const headSha7 = headCommit.sha.slice(0, 7);
  const tagLabel = sinceTag
    ? `Unreleased (${defaultBranch}@${headSha7})`
    : `${defaultBranch}@${headSha7}`;
  return {
    tag: tagLabel,
    prevTag: sinceTag ?? null,
    issues: rows,
    synthetic: true,
  };
}

// --------------------------------------------------------------------------
// Data loader
// --------------------------------------------------------------------------

interface ReleasePayload {
  repo: string;        // "owner/name"
  tag: string;
  previousTag: string | null;
  commits: number;     // count, for the summary line
  rows: IssueRow[];
}

export interface IssueRow {
  number: number;
  title: string;
  state: string;
  labels: string[];
  assignees: string[];
  url: string;
  updated_at: string;
  warnings: string[];
  // Set only for cross-repo rows: the `owner/name` of the repo the issue lives
  // in, when it differs from the card's repo (e.g. a cdp-relay PR's
  // `Refs ippoan/mcp-cf-workers#28` surfaces mcp-cf-workers#28 on cdp-relay's
  // card). Drives the cross-repo checkbox encoding + close target. Refs #292.
  repo?: string;
}

async function loadRelease(
  env: AuthClientWorkerEnv,
  repoParam: string,
  tag: string,
  kv?: KVNamespace,
): Promise<ReleasePayload> {
  const { owner, repo: name } = parseRepo(repoParam);
  const token = await tokenForOrg(env, owner);

  // 1. Pull recent tags so we can pick the immediate predecessor for the
  //    compare endpoint. 30 is plenty given typical release cadence; for
  //    older tags the operator can pass the URL anyway and we fall back to a
  //    bounded commit list below.
  const tags = await cachedTags(token, kv, owner, name, 30);
  const tagNames = tags.map((t) => t.name);
  if (!tagNames.includes(tag)) {
    throw new GitHubApiError(
      404,
      `Tag "${tag}" not present in ${owner}/${name} (recent ${tagNames.length} tags scanned)`,
    );
  }
  const prev = previousTag(sortSemverDesc(tagNames), tag);

  // 2. Walk the tag's compare range to harvest every issue number we can
  //    attribute (Refs in commit message, PR body, branch prefix). Shared
  //    with the dashboard banner path so the two views stay in lockstep.
  const { issueNumbers, commitCount } = await collectIssueNumbersForRange(
    token, owner, name, tag, prev, kv,
  );

  // 3. Hydrate candidates. The /issues/:n endpoint also returns PRs, so we
  //    filter those out below (PRs carry a `pull_request` discriminator).
  const issues = await fetchIssuesByNumbers(token, owner, name, issueNumbers, kv);

  const rows: IssueRow[] = issues
    .filter((i) => !i.pull_request)
    .map((i) => {
      const labels = i.labels.map((l) => l.name);
      return {
        number: i.number,
        title: i.title,
        state: i.state,
        labels,
        assignees: i.assignees.map((a) => a.login),
        url: i.html_url,
        updated_at: i.updated_at,
        warnings: computeWarnings({ state: i.state, labels }),
      };
    })
    .sort((a, b) => a.number - b.number);

  return {
    repo: `${owner}/${name}`,
    tag,
    previousTag: prev,
    commits: commitCount,
    rows,
  };
}

interface RawCommit { sha: string; commit: { message: string } }

function numericList(s: string | null): number[] {
  if (!s) return [];
  return s.split(",").map((p) => Number(p.trim())).filter(Number.isInteger);
}

// `failed_reasons=N:urlencoded-reason,N:urlencoded-reason` を Map に parse する。
// release-close{,-batch}.ts が生成する flash param 経路と対 (= 同 file の
// `formatCloseFailureReason` でフォーマットされた 1 行短縮文字列)。
// 不正な entry は silently drop して残りを返す (= 旧 URL や手書き URL でも
// crash させない conservative parse)。Refs ippoan/ci-dashboard#152。
export function parseFailedReasons(s: string | null): Map<number, string> {
  const out = new Map<number, string>();
  if (!s) return out;
  for (const raw of s.split(",")) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const n = Number(raw.slice(0, idx).trim());
    if (!Number.isInteger(n) || n <= 0) continue;
    try {
      out.set(n, decodeURIComponent(raw.slice(idx + 1)));
    } catch {
      // malformed urlencoded → skip
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// HTML
// --------------------------------------------------------------------------

function html(body: string, status: number, cacheControl?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
  };
  if (cacheControl) headers["Cache-Control"] = cacheControl;
  return new Response(body, { status, headers });
}

function renderHtml(
  data: ReleasePayload,
  closedFlash: number[],
  failedFlash: number[],
  failedReasons: Map<number, string>,
): string {
  // Two filters drop rows from the form's candidate set:
  //   1. flash: just-closed rows from a close-then-redirect must not be offered
  //      again on the landing page (#61).
  //   2. state === "closed": issues that GitHub already reports as closed have
  //      nothing left to act on — the operator (or auto-close from `Closes #N`
  //      in some other PR) already handled them. Mirrors the index page's
  //      visible/hidden split in `renderTagBlock` so the detail and index views
  //      behave consistently. Pre-fix the row stayed in the form with the ⚠
  //      "already closed" warning and an un-ticked checkbox, which read as
  //      "still pending" to the operator (#90).
  const candidates = data.rows.filter(
    (r) => !closedFlash.includes(r.number) && r.state !== "closed",
  );
  const candidateRows = candidates.map((r) => renderRow(r)).join("\n");

  // Already-closed rows still live in the page as audit context (collapsed
  // <details>) so the operator can confirm which referenced issues this tag
  // actually resolved. flash-closed go in here too — the form has already
  // dropped them and the celebratory `empty` banner above shows the success;
  // the details strip just lists what got closed for reference.
  const closedRows = data.rows.filter(
    (r) => r.state === "closed" || closedFlash.includes(r.number),
  );
  const closedDetails = closedRows.length === 0 ? "" : `
    <details class="closed-details">
      <summary>${closedRows.length} closed issue${closedRows.length === 1 ? "" : "s"} (already resolved)</summary>
      <table>
        <thead><tr>
          <th>#</th>
          <th>Title</th>
          <th>State</th>
          <th>Labels</th>
          <th>Assignees</th>
        </tr></thead>
        <tbody>${closedRows.map((r) => renderClosedRow(r)).join("\n")}</tbody>
      </table>
    </details>`;

  const flash = renderFlash(closedFlash, failedFlash, failedReasons, data.repo);

  const summary =
    `${escapeHtml(data.repo)} · <code>${escapeHtml(data.tag)}</code>` +
    (data.previousTag
      ? ` (since <code>${escapeHtml(data.previousTag)}</code>, ${data.commits} commits)`
      : ` (first release; last ${data.commits} commits scanned)`);

  // Two distinct "nothing to do" states share the same hint slot:
  //   - data.rows.length === 0 → tag had no Refs at all
  //   - data.rows.length > 0 but candidates.length === 0 → everything is
  //     already closed (either before this page load, or just-closed via the
  //     redirect); show the celebratory variant.
  const empty = data.rows.length === 0
    ? `<div class="empty">🎉 No referenced issues for this release.</div>`
    : candidates.length === 0
      ? `<div class="empty">✅ All referenced issues for this release are closed.</div>`
      : "";

  const formInner = candidates.length === 0 ? "" : `
    <form method="POST" action="/api/release-close" class="close-form">
      <input type="hidden" name="repo" value="${escapeHtml(data.repo)}">
      <input type="hidden" name="tag" value="${escapeHtml(data.tag)}">
      <table>
        <thead><tr>
          <th class="col-check"></th>
          <th>#</th>
          <th>Title</th>
          <th>State</th>
          <th>Labels</th>
          <th>Assignees</th>
        </tr></thead>
        <tbody>${candidateRows}</tbody>
      </table>
      <div class="actions">
        <button type="submit">✅ Close selected as released</button>
        <span class="hint">Rows with ⚠️ are unchecked by default. Untick to skip.</span>
      </div>
    </form>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Release ${escapeHtml(data.tag)} — ${escapeHtml(data.repo)}</title>${PWA_HEAD_TAGS}
  <style>${STYLES}</style>
</head>
<body>
  <header>
    ${renderTabs("releases")}
    <h1>🏷️ Release confirmation</h1>
    <div class="summary">${summary}</div>
  </header>
  ${flash}
  ${empty}
  ${formInner}
  ${closedDetails}
  ${PWA_REGISTER_SCRIPT}
</body>
</html>`;
}

// Render an already-closed row for the audit <details> strip. No checkbox
// (nothing to act on), no warning icon (the "already closed" warn is implied
// by the section header). Same column layout as renderRow minus col-check.
function renderClosedRow(r: IssueRow): string {
  const labelChips = r.labels.length > 0
    ? `<div class="labels">${r.labels
        .map((l) => `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "";
  const assignees = r.assignees.length > 0
    ? r.assignees.map((a) => `@${escapeHtml(a)}`).join(", ")
    : "—";
  const stateChip =
    `<span class="state state-${escapeHtml(r.state)}">${escapeHtml(r.state)}</span>`;
  return `<tr>
    <td class="num"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">#${r.number}</a></td>
    <td class="title"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></td>
    <td>${stateChip}</td>
    <td>${labelChips || "—"}</td>
    <td class="assignees">${assignees}</td>
  </tr>`;
}

function renderRow(r: IssueRow): string {
  const hasWarn = r.warnings.length > 0;
  const checked = hasWarn ? "" : " checked";
  const warnIcon = hasWarn
    ? `<span class="warn" title="${escapeHtml(r.warnings.join(", "))}">⚠️</span>`
    : "";
  const labelChips = r.labels.length > 0
    ? `<div class="labels">${r.labels
        .map((l) => `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "";
  const assignees = r.assignees.length > 0
    ? r.assignees.map((a) => `@${escapeHtml(a)}`).join(", ")
    : "—";
  const stateChip =
    `<span class="state state-${escapeHtml(r.state)}">${escapeHtml(r.state)}</span>`;

  return `<tr>
    <td class="col-check"><input type="checkbox" name="issue" value="${r.number}"${checked}></td>
    <td class="num"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">#${r.number}</a></td>
    <td class="title">${warnIcon}<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a></td>
    <td>${stateChip}</td>
    <td>${labelChips || "—"}</td>
    <td class="assignees">${assignees}</td>
  </tr>`;
}

// Flash param (closed= / failed= / failed_reasons=) を address bar から除去する
// (Refs #314)。server 側の PRG + 1 回目の banner 表示は従来どおりで、render 後に
// history.replaceState で URL を clean にする。これでリロードしても flash banner
// が再表示されず、確認のための再読込が「また close された」ように見えない。
// `repo` は tag 同伴 (detail page) の時だけ残す — tag 無しの repo= は index に
// fall through する flash 添付用 param なので一緒に消す。
// close 後の UX: flash banner を `position: fixed` の toast として浮かべるため
// inline には DOM を増やさず、scroll 位置・周辺 card layout を一切ずらさない
// (Refs #411 / #413)。close form の submit 直前に scrollY を sessionStorage に
// 保存し、landing 時に `?closed=` フラッシュ params があれば復元する。
//
// FLASH_CLEANUP_SCRIPT は `${flash}` 直後 (= cards より前) で URL cleanup
// だけを早期実行する。実際の scroll restore は全 card render 完了後 (body
// 末尾) でないと document height が足りず top に丸められる (#412 でこれを
// 踏んだ) ため、別 script (RELEASES_SCROLL_RESTORE_SCRIPT) に切り出し body
// 最後で `requestAnimationFrame` 経由で実行する。
const FLASH_CLEANUP_SCRIPT = `<script>
(() => {
  try {
    const u = new URL(location.href);
    for (const k of ["closed", "failed", "failed_reasons"]) u.searchParams.delete(k);
    if (!u.searchParams.get("tag")) u.searchParams.delete("repo");
    const qs = u.searchParams.toString();
    history.replaceState(null, "", u.pathname + (qs ? "?" + qs : ""));
    // 注: scrollRestoration は **触らない** (#415)。"manual" に倒すと
    // location.reload() (WS auto-reload) で browser native の scroll
    // restoration が無効化されて結局 top に飛ぶ。form POST → GET redirect は
    // 新規 navigation 扱いなので scrollRestoration の影響を受けず、
    // save/restore script だけで足りる。
    // toast の開始時刻を sessionStorage に記録 (#417)。直後の WS auto-reload は
    // この marker を見て CSS animation の終わりまで postpone される。
    sessionStorage.setItem("releases-toast-startat", String(Date.now()));
  } catch { /* URL/History API 非対応環境では従来挙動のまま */ }
})();
</script>`;

// close 操作の前に scrollY を sessionStorage に保存する (Refs #411)。
// 全 batch-close-form (per-repo の close 確定ボタン) に submit listener を
// 1 回だけ載せる。capture phase で記録するので redirect で page が捨てられる前
// に確実に取れる。
const RELEASES_SCROLL_SAVE_SCRIPT = `<script>
(() => {
  try {
    document.addEventListener("submit", (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains("batch-close-form")) {
        sessionStorage.setItem("releases-scroll", String(window.scrollY));
      }
    }, true);
  } catch { /* ignore */ }
})();
</script>`;

// 保存済 scroll 位置を全 card render 完了後に復元する (Refs #413)。
// FLASH_CLEANUP_SCRIPT 内で scroll する版は cards より前に実行されるため
// document height が足りず top に丸められていた (#412 の残り bug)。本 script は
// body 末尾に置き、さらに requestAnimationFrame で 1 frame ずらしてレイアウト
// 計算後に scroll する。URL から flash params は既に消えているので、保存値の
// 有無だけで判定する (= 通常 navigation で誤発火する事は無い、submit listener
// が close ボタン経由でしか書かないため)。
const RELEASES_SCROLL_RESTORE_SCRIPT = `<script>
(() => {
  try {
    const raw = sessionStorage.getItem("releases-scroll");
    if (raw === null) return;
    sessionStorage.removeItem("releases-scroll");
    const y = parseInt(raw, 10);
    if (!Number.isFinite(y)) return;
    const restore = () => {
      // 1 度 raf してから scrollTo (= layout pass 後)。
      // それでも届かない (super-long page で <img> reflow 等) なら load イベントで再試行。
      window.scrollTo(0, y);
    };
    requestAnimationFrame(() => requestAnimationFrame(restore));
    window.addEventListener("load", restore, { once: true });
  } catch { /* ignore */ }
})();
</script>`;

function renderFlash(
  closed: number[],
  failed: number[],
  failedReasons: Map<number, string>,
  repo: string | null,
): string {
  if (closed.length === 0 && failed.length === 0) return "";
  // When the redirect carried a repo (single-tag detail close, batch close),
  // each issue number links to GitHub; otherwise we render bare `#N` text.
  const issueLink = (n: number): string => repo
    ? `<a href="https://github.com/${escapeHtml(repo)}/issues/${n}" target="_blank" rel="noopener">#${n}</a>`
    : `#${n}`;
  // flash は `position: fixed` の toast container にまとめ inline DOM 高を 0 に
  // する (Refs #411 — close 後 card の表示位置を 1px もずらさない)。
  const closedList = closed.length > 0
    ? `<div class="flash ok">✅ Closed: ${closed.map(issueLink).join(" ")}</div>`
    : "";
  // failed_reasons が同伴している場合は per-issue で「#N: 理由」を 1 行ずつ
  // 表示する。理由不明 (= 古い URL や旧 deploy の handler 由来) は従来通り
  // 「try again」フォールバックを並べる。reason 文字列は formatCloseFailureReason
  // で短縮済だが、念のため escapeHtml を通す (XSS 防御)。
  // Refs ippoan/ci-dashboard#152。
  let failedList = "";
  if (failed.length > 0) {
    if (failedReasons.size > 0) {
      const items = failed.map((n) => {
        const reason = failedReasons.get(n);
        return reason
          ? `<li>${issueLink(n)}: ${escapeHtml(reason)}</li>`
          : `<li>${issueLink(n)}: (try again)</li>`;
      }).join("");
      failedList = `<div class="flash err">❌ Failed to close:<ul style="margin:0.25rem 0 0 1.25rem;padding:0">${items}</ul></div>`;
    } else {
      failedList = `<div class="flash err">❌ Failed to close: ${failed.map(issueLink).join(" ")} (try again)</div>`;
    }
  }
  return `<div class="flash-toast">${closedList}${failedList}</div>` + FLASH_CLEANUP_SCRIPT;
}

function renderIndex(
  views: RepoView[],
  closedFlash: number[],
  failedFlash: number[],
  failedReasons: Map<number, string>,
  flashRepo: string | null,
  refreshing = false,
  staleRepos: string[] = [],
  authBroken = false,
): string {
  // Show every watched repo as a card — including ones with no referenced
  // issues yet or whose refs are all closed. The operator asked for the full
  // roster always-on (Refs #224); empty/closed repos render as a passive card
  // with a "no referenced issues" note (see renderIndexRepo) instead of being
  // dropped as noise. The bottom empty-state copy only kicks in when nothing
  // is watched at all (views is empty), so a fresh env still reads cleanly.
  const staleSet = new Set(staleRepos);
  const body = views.length === 0
    ? `<div class="empty">🤷 No releases with referenced issues in the recent window. Look one up below.</div>`
    : views.map((v) => renderIndexRepo(v, staleSet.has(v.repo))).join("\n");

  // Banner sits above the cards so a successful batch close redirect always
  // lands the operator on the list with confirmation of what got closed.
  const flash = renderFlash(closedFlash, failedFlash, failedReasons, flashRepo);

  // SWR で stale blob を即返しした時の注記 (Refs #325 / #327)。stale 化の
  // 原因 repo が分かる時はそれを列挙し、該当 card には 🔄 バッジが付く。
  // 更新完了は WS (releases-updated) が reload で反映する。
  // GitHub 認証失効 (Refs #334): 「🔄 更新中」のまま無言で詰まる事故の対策。
  const authBrokenNote = authBroken
    ? `<div class="auth-broken-note">🔑 GitHub 認証が失効しています — <a href="/oauth/login?return_to=/releases">/oauth/login</a> で再ログインすると自動復旧します (それまで集計の background 更新は停止)</div>`
    : "";
  const refreshingNote = refreshing
    ? (staleRepos.length > 0
      ? `<div class="refreshing-note">🔄 更新待ち: ${staleRepos.map((r) => `<code>${escapeHtml(r)}</code>`).join(" ")} — background で集計中、完了すると自動で再読込されます</div>`
      : `<div class="refreshing-note">🔄 background で集計を更新中 — 表示は直近の cache です (完了すると自動で再読込)</div>`)
    : "";

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Releases — CI Dashboard</title>${PWA_HEAD_TAGS}<style>${STYLES}</style>
</head><body>
<header>
  ${renderTabs("releases")}
  <h1>🏷️ Releases</h1>
  <div class="summary">Tick the issues that this release actually closed; one button per repo closes them all.</div>
</header>
${flash}
${authBrokenNote}
${refreshingNote}
${body}
<h2 class="lookup-header">Look up another release</h2>
${renderLookupForm(null, null)}
<div class="admin-link">
  <a href="/admin/dump-releases-blob" target="_blank" rel="noopener">🔍 dump releases blob (debug)</a>
  <span class="admin-link-sep">·</span>
  <a href="/admin/force-refresh-releases" target="_blank" rel="noopener" title="WEBHOOK_QUEUE に releases-index-refresh を 1 件 enqueue。次の queue 処理で blob が再生成される">🔄 force refresh</a>
</div>
${PWA_REGISTER_SCRIPT}
${RELEASES_LIVE_RELOAD_SCRIPT}
${RELEASES_SCROLL_SAVE_SCRIPT}
${RELEASES_SCROLL_RESTORE_SCRIPT}
</body></html>`;
}

// /releases の live 更新 (Refs #327)。index blob の refresh 完了時に Hub が
// broadcast する releases-updated を受けて debounce reload する。「集計完了後」
// の通知なので reload 直後は必ず fresh blob を読む。issues-updated でも
// close 候補の状態が変わるので併せて reload する。非表示タブは保留。
const RELEASES_LIVE_RELOAD_SCRIPT = `
  <script>
    (() => {
      let pending = false;
      let timer = null;
      // toast が表示中なら reload を postpone する (#417)。CSS animation 6s で
      // 自然消滅 するまで reload を待たせ、close 操作の確認 UI を毎回 ~1.5s で
      // 食い殺される不安定さを解消する。toast の開始時刻は close 直後の form
      // POST→GET landing で renderFlash が sessionStorage に書き込む。
      const TOAST_DURATION_MS = 6000;
      const TOAST_GRACE_MS = 500;
      const doReload = () => {
        if (document.visibilityState !== "visible") { pending = true; return; }
        try {
          const raw = sessionStorage.getItem("releases-toast-startat");
          if (raw !== null) {
            const startAt = parseInt(raw, 10);
            if (Number.isFinite(startAt)) {
              const elapsed = Date.now() - startAt;
              const remaining = TOAST_DURATION_MS + TOAST_GRACE_MS - elapsed;
              if (remaining > 0) {
                if (timer) clearTimeout(timer);
                timer = setTimeout(doReload, remaining);
                return;
              }
              // 終了済 → marker を消して reload に進む。
              sessionStorage.removeItem("releases-toast-startat");
            }
          }
        } catch {}
        // close 押下直後の reload で scroll が top に飛ばないよう、現在の
        // scrollY を保存してから reload する。次の load で
        // RELEASES_SCROLL_RESTORE_SCRIPT が同 key を読んで復元する (#415)。
        try { sessionStorage.setItem("releases-scroll", String(window.scrollY)); } catch {}
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
            if (msg && (msg.type === "releases-updated" || msg.type === "issues-updated")) {
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

// repo の release 運用 badge (Refs #312)。close するのに tag を打つ必要が
// あるか (要 tag) / merge がそのまま release か (tagless) を card 見出しで
// 即読みできるようにする — 「release から close するのに tag が要るか」を
// 画面から判断できないのが不便、という operator の指摘への対応。
function renderModeBadge(tagless: boolean): string {
  return tagless
    ? `<span class="mode-badge mode-tagless" title="tagless 運用 — merge がそのまま release。tag を打たずにここから close できる">tagless</span>`
    : `<span class="mode-badge mode-needs-tag" title="tag-release 運用 — close 候補を出すには release tag を打つ (/tag-release)">🏷️ 要 tag</span>`;
}

function renderIndexRepo(view: RepoView, updating = false): string {
  // stale 化の原因 repo に出す「更新中」バッジ (Refs #327)。refresh 完了で
  // blob が再生成され staleRepos が消える → WS reload 後は出ない。
  const updatingBadge = updating
    ? `<span class="updating-badge">🔄 更新中</span>`
    : "";
  // Only tag blocks with at least one OPEN (actionable) issue get the full
  // table+form treatment. Closed-only blocks are pure noise on the landing
  // page — the operator already released them. Refs #226.
  const openBlocks = view.tagBlocks.filter((b) =>
    b.issues.some((i) => i.state !== "closed"),
  );

  // When nothing in the repo is open, collapse the whole card to a single
  // compact line instead of a tall stack of expandable "N closed issues"
  // <details>. The repo stays on the roster (#224) but reads as one row:
  // either a deduped closed-issue count ("released") or a no-refs note.
  // No <form> / table / older-tags strip — the point is one line. Refs #226.
  const refreshHref = `/admin/force-refresh-releases?repo=${encodeURIComponent(view.repo)}`;
  const refreshLink = `<a class="repo-refresh" href="${refreshHref}" target="_blank" rel="noopener" title="この repo の view を即時再計算 (loadRepoView)">🔄</a>`;

  if (openBlocks.length === 0) {
    const closed = new Set<number>();
    for (const b of view.tagBlocks) {
      for (const i of b.issues) if (i.state === "closed") closed.add(i.number);
    }
    const summary = closed.size > 0
      ? `<span class="closed-summary">✅ ${closed.size} closed issue${closed.size === 1 ? "" : "s"} (released)</span>`
      : `<span class="no-refs">No referenced issues in the recent release window.</span>`;
    return `<section class="repo-card repo-card-compact">
      <a class="repo-link" href="https://github.com/${escapeHtml(view.repo)}/releases" target="_blank" rel="noopener">${escapeHtml(view.repo)}</a>
      ${renderModeBadge(view.tagless)}${updatingBadge}
      ${summary}
      ${refreshLink}
    </section>`;
  }

  const tagSections = openBlocks
    .map((b) => renderTagBlock(view.repo, b))
    .join("\n");

  const olderHtml = view.olderTags.length === 0
    ? ""
    : `<div class="older-tags">older: ${view.olderTags
        .map((t) =>
          `<a href="/releases?repo=${encodeURIComponent(view.repo)}&tag=${encodeURIComponent(t)}">${escapeHtml(t)}</a>`,
        )
        .join(" · ")}</div>`;

  // Every kept block has ≥1 open issue, so the close button always has
  // something to act on here.
  const actions = `<div class="actions">
        <button type="submit">✅ Close selected as released</button>
        <span class="hint">⚠️ rows start unchecked.</span>
      </div>`;

  // Whole repo card is one form so the operator can tick across tags and
  // close them in one shot; the POST handler groups by tag for comment
  // attribution.
  return `<section class="repo-card">
    <h2><a href="https://github.com/${escapeHtml(view.repo)}/releases" target="_blank" rel="noopener">${escapeHtml(view.repo)}</a>${renderModeBadge(view.tagless)}${updatingBadge}${refreshLink}</h2>
    <form method="POST" action="/api/release-close-batch" class="batch-close-form">
      <input type="hidden" name="repo" value="${escapeHtml(view.repo)}">
      ${tagSections}
      ${actions}
    </form>
    ${olderHtml}
  </section>`;
}

function renderTagBlock(repo: string, block: TagBlock): string {
  // Split by state: already-closed issues are noise in the at-a-glance view,
  // so they collapse into a native <details> below the active rows. The form
  // wrapping the whole repo card still picks up checkboxes inside <details>
  // when the operator expands it.
  //
  // Synthetic (direct-push) blocks have already filtered to open-only when
  // they were built (#57), so `hidden` ends up empty there and the <details>
  // collapses out naturally.
  const visible = block.issues.filter((i) => i.state !== "closed");
  const hidden = block.issues.filter((i) => i.state === "closed");

  const since = block.prevTag
    ? `<span class="since">since <code>${escapeHtml(block.prevTag)}</code></span>`
    : "";

  // Direct-push blocks have no compare range, so the detail page (`?tag=X`)
  // would 404. Show a passive "direct push" marker instead so the operator
  // knows why the link is missing.
  const detailOrMarker = block.synthetic
    ? `<span class="direct-marker" title="direct-push branch — no tag range">direct push</span>`
    : `<a class="detail-link"
         href="/releases?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(block.tag)}">
        → detail
      </a>`;

  const visibleTable = visible.length === 0 ? "" : `
    <table>
      <thead><tr>
        <th class="col-check"></th>
        <th>#</th>
        <th>Title</th>
        <th>State</th>
        <th>Labels</th>
      </tr></thead>
      <tbody>${visible.map((i) => renderIndexRow(block.tag, i)).join("\n")}</tbody>
    </table>`;

  const hiddenDetails = hidden.length === 0 ? "" : `
    <details class="closed-details">
      <summary>${hidden.length} closed issue${hidden.length === 1 ? "" : "s"}</summary>
      <table>
        <tbody>${hidden.map((i) => renderIndexRow(block.tag, i)).join("\n")}</tbody>
      </table>
    </details>`;

  return `<div class="tag-block">
    <div class="tag-block-header">
      <strong>${escapeHtml(block.tag)}</strong>
      ${since}
      ${detailOrMarker}
    </div>
    ${visibleTable}
    ${hiddenDetails}
  </div>`;
}

function renderIndexRow(tag: string, r: IssueRow): string {
  const hasWarn = r.warnings.length > 0;
  const checked = hasWarn ? "" : " checked";
  // Cross-repo rows (r.repo set) encode the home repo into the pair so the batch
  // close handler closes against it, not the card's repo: `<tag>:<owner>/<name>#<n>`.
  // Same-repo rows keep the legacy `<tag>:<n>`. Refs #292.
  const pair = r.repo ? `${tag}:${r.repo}#${r.number}` : `${tag}:${r.number}`;
  const warnIcon = hasWarn
    ? `<span class="warn" title="${escapeHtml(r.warnings.join(", "))}">⚠️</span>`
    : "";
  // Prefix the number cell with the foreign repo for cross-repo rows so it's
  // obvious the issue lives elsewhere (e.g. `ippoan/mcp-cf-workers#28`).
  const numLabel = r.repo ? `${escapeHtml(r.repo)}#${r.number}` : `#${r.number}`;
  const crossMarker = r.repo
    ? ` <span class="cross-repo-marker" title="cross-repo: lives in ${escapeHtml(r.repo)}, shipped by a PR here">cross-repo</span>`
    : "";
  const labelChips = r.labels.length > 0
    ? `<div class="labels">${r.labels
        .map((l) => `<span class="label">${escapeHtml(l)}</span>`).join("")}</div>`
    : "—";
  const stateChip =
    `<span class="state state-${escapeHtml(r.state)}">${escapeHtml(r.state)}</span>`;

  return `<tr>
    <td class="col-check"><input type="checkbox" name="pair" value="${escapeHtml(pair)}"${checked}></td>
    <td class="num"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${numLabel}</a></td>
    <td class="title">${warnIcon}<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>${crossMarker}</td>
    <td>${stateChip}</td>
    <td>${labelChips}</td>
  </tr>`;
}

// Bare `<form>` extracted so both the index landing page and the
// one-param-given page share the same input layout.
function renderLookupForm(repo: string | null, tag: string | null): string {
  return `<form method="GET" action="/releases" class="lookup">
  <label>repo (<code>owner/name</code>)
    <input name="repo" required placeholder="ippoan/ci-dashboard"
      value="${escapeHtml(repo ?? "")}">
  </label>
  <label>tag
    <input name="tag" required placeholder="v1.2.3"
      value="${escapeHtml(tag ?? "")}">
  </label>
  <button type="submit">Look up</button>
</form>`;
}

function renderError(msg: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Release confirmation — Error</title>
<style>${STYLES}</style></head><body>
<header>${renderTabs("releases")}
<h1>🏷️ Release confirmation</h1></header>
<div class="flash err">${escapeHtml(msg)}</div>
</body></html>`;
}

// Style block kept inline so the page is self-contained, mirroring
// issues-page.ts. Mobile is the operations target (CLAUDE.md notes the
// Android-first context) so we keep widths fluid and avoid fixed pixel cols.
const STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117; color: #c9d1d9; padding: 24px;
    max-width: 1200px; margin: 0 auto;
  }
  header { margin-bottom: 16px; }
  ${TAB_STYLES}
  h1 { font-size: 20px; color: #58a6ff; }
  .summary { font-size: 13px; color: #8b949e; margin-top: 4px; }
  .summary code { background: #161b22; padding: 1px 6px; border-radius: 4px; color: #d2a8ff; }
  .lookup {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: end;
    background: #161b22; border: 1px solid #30363d;
    padding: 16px; border-radius: 8px; margin-top: 12px;
  }
  .lookup label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #8b949e; }
  .lookup input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d;
    border-radius: 6px; padding: 6px 10px; font-size: 14px; min-width: 220px; }
  button { background: #238636; color: white; border: 0; border-radius: 6px;
    padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
  button:hover { background: #2ea043; }
  .close-form { background: #161b22; border: 1px solid #30363d;
    border-radius: 8px; overflow: hidden; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  tbody tr { border-top: 1px solid #21262d; }
  tbody tr:hover { background: #1c2129; }
  th, td { padding: 8px 12px; text-align: left; vertical-align: top; }
  th { font-size: 11px; font-weight: 600; text-transform: uppercase;
       letter-spacing: 0.5px; color: #8b949e; background: #0d1117; }
  td.col-check, th.col-check { width: 36px; }
  td.num { width: 60px; color: #8b949e; font-variant-numeric: tabular-nums; }
  td.num a { color: #58a6ff; text-decoration: none; }
  td.title a { color: #c9d1d9; text-decoration: none; font-weight: 500; }
  td.title a:hover { color: #58a6ff; text-decoration: underline; }
  td.assignees { color: #8b949e; }
  .warn { margin-right: 4px; }
  .labels .label { display: inline-block; font-size: 11px; padding: 1px 6px;
    border-radius: 10px; background: #1f6feb22; color: #79c0ff;
    margin-right: 4px; margin-bottom: 2px; }
  .state { display: inline-block; font-size: 11px; padding: 1px 8px;
    border-radius: 10px; font-weight: 600; }
  .state-open { background: #238636; color: white; }
  .state-closed { background: #8957e5; color: white; }
  .actions { padding: 12px 14px; border-top: 1px solid #21262d;
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .actions .hint { color: #8b949e; font-size: 12px; }
  .empty { padding: 32px; text-align: center; color: #8b949e; font-size: 14px; }
  .flash { padding: 10px 14px; border-radius: 6px; font-size: 13px;
    margin-bottom: 12px; }
  .flash.ok  { background: #1f3d28; border: 1px solid #238636; color: #a3e3b0; }
  .flash.err { background: #341a1f; border: 1px solid #f85149; color: #ffa198; }
  .flash a { color: inherit; text-decoration: underline; }

  /* close 結果の flash banner は viewport 右上に fixed で浮かべ、inline DOM を
     1 行も増やさない (Refs #411)。card layout も scroll 位置もずらさず、操作
     直後の確認だけ可視化して数秒で fade。 */
  .flash-toast {
    position: fixed;
    top: 16px; right: 16px;
    z-index: 1000;
    max-width: min(420px, calc(100vw - 32px));
    pointer-events: none;
    display: flex; flex-direction: column; gap: 8px;
    animation: flash-toast-fade 6s ease forwards;
  }
  .flash-toast:empty { display: none; }
  .flash-toast .flash {
    margin-bottom: 0;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    pointer-events: auto;
  }
  @keyframes flash-toast-fade {
    0%   { opacity: 0; transform: translateY(-6px); }
    8%   { opacity: 1; transform: translateY(0); }
    85%  { opacity: 1; }
    100% { opacity: 0; transform: translateY(-6px); visibility: hidden; }
  }

  /* Recent releases landing page — repo card with stacked tag blocks */
  .repo-card {
    background: #161b22; border: 1px solid #30363d;
    border-radius: 8px; padding: 16px; margin-bottom: 16px;
  }
  .repo-card > h2 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
  .repo-card > h2 a { color: #c9d1d9; text-decoration: none; }
  .repo-card > h2 a:hover { color: #58a6ff; }
  .batch-close-form { display: block; }
  .no-refs {
    font-size: 12px; color: #8b949e;
    padding: 4px 0 2px 0;
  }
  /* Closed-only / no-ref repos collapse to a single compact row (#226). */
  .repo-card-compact {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
    padding: 10px 16px;
  }
  .repo-card-compact .repo-link {
    font-size: 14px; font-weight: 600; color: #c9d1d9; text-decoration: none;
  }
  .repo-card-compact .repo-link:hover { color: #58a6ff; }
  .repo-card-compact .closed-summary { font-size: 12px; color: #8b949e; }
  .updating-badge {
    display: inline-block; font-size: 11px; font-weight: 400;
    padding: 1px 8px; border-radius: 10px; margin-left: 8px;
    vertical-align: middle; white-space: nowrap;
    background: #1f6feb22; color: #79c0ff; border: 1px solid #1f6feb88;
  }
  .auth-broken-note {
    background: #341a1f; border: 1px solid #f85149; color: #ffa198;
    border-radius: 6px; padding: 10px 14px; font-size: 13px; margin-bottom: 12px;
  }
  .auth-broken-note a { color: #ffa198; text-decoration: underline; }
  .refreshing-note {
    background: #1c2433; border: 1px solid #1f6feb88; color: #a5d6ff;
    border-radius: 6px; padding: 8px 14px; font-size: 12px; margin-bottom: 12px;
  }
  .mode-badge {
    display: inline-block; font-size: 11px; font-weight: 400;
    padding: 1px 8px; border-radius: 10px; margin-left: 8px;
    vertical-align: middle; white-space: nowrap;
  }
  .mode-tagless {
    background: #2ea04322; color: #7ee787; border: 1px solid #2ea04388;
  }
  .mode-needs-tag {
    background: #d2992222; color: #e3b341; border: 1px solid #d2992288;
  }
  .tag-block { margin-bottom: 14px; }
  .tag-block-header {
    display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;
    font-size: 13px; margin-bottom: 4px; color: #c9d1d9;
  }
  .tag-block-header strong {
    color: #d2a8ff; font-variant-numeric: tabular-nums; font-weight: 600;
  }
  .tag-block-header .since { color: #8b949e; font-size: 12px; }
  .tag-block-header .since code { background: #0d1117; padding: 1px 4px;
    border-radius: 4px; color: #d2a8ff; }
  .tag-block-header .detail-link {
    margin-left: auto; color: #58a6ff; text-decoration: none; font-size: 12px;
  }
  .tag-block-header .detail-link:hover { text-decoration: underline; }
  .tag-block-header .direct-marker {
    margin-left: auto; font-size: 11px; color: #8b949e;
    background: #21262d; border: 1px solid #30363d;
    padding: 1px 8px; border-radius: 10px;
  }
  .tag-block table {
    background: #0d1117; border: 1px solid #30363d;
    border-radius: 6px; overflow: hidden;
  }
  .older-tags {
    margin-top: 8px; font-size: 12px; color: #8b949e;
    border-top: 1px dashed #30363d; padding-top: 8px;
  }
  .older-tags a {
    color: #58a6ff; text-decoration: none;
    padding: 1px 6px; border-radius: 4px;
    font-variant-numeric: tabular-nums;
  }
  .older-tags a:hover { background: #1f6feb22; }
  details.closed-details {
    margin-top: 8px;
    background: #0d1117;
    border: 1px dashed #30363d;
    border-radius: 6px;
  }
  details.closed-details > summary {
    padding: 6px 12px;
    font-size: 12px; color: #8b949e;
    cursor: pointer; user-select: none;
    list-style: none;
  }
  details.closed-details > summary::before {
    content: "▶";
    display: inline-block;
    margin-right: 6px;
    transition: transform 0.1s;
    font-size: 10px;
  }
  details.closed-details[open] > summary::before { transform: rotate(90deg); }
  details.closed-details > summary:hover { color: #c9d1d9; }
  details.closed-details[open] > summary {
    color: #c9d1d9; border-bottom: 1px solid #30363d;
  }
  details.closed-details table { background: transparent; border: 0; }
  .lookup-header {
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.5px; color: #8b949e;
    margin: 24px 0 8px 0;
  }
  .admin-link {
    margin: 24px 0 12px 0;
    font-size: 12px;
  }
  .admin-link a { color: #6e7681; text-decoration: none; }
  .admin-link a:hover { color: #58a6ff; text-decoration: underline; }
  .admin-link-sep { color: #30363d; margin: 0 6px; }
  .repo-refresh {
    margin-left: 8px; font-size: 12px;
    color: #6e7681; text-decoration: none;
    opacity: 0.6;
  }
  .repo-refresh:hover { opacity: 1; color: #58a6ff; }
`;

// Minimal HTML escape, exported for tests.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
