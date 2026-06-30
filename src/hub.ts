import { DurableObject } from "cloudflare:workers";
import type { CIStatus, JobStatus } from "./webhook";
import type { Env } from "./index";
import {
  type ReleaseAlert,
  recomputeAlert,
  computeReleaseAlert,
  computeReleaseAlertForPr,
} from "./release-alert";
import { parseRepo, tokenForOrg } from "./github-api";
import { invalidateIssue } from "./release-cache";
import {
  applyCloseToReleasesIndex,
  applyIssueEventToReleasesIndex,
  applyRefsPatchToReleasesIndex,
  type BlobStore,
} from "./releases-index-patch";
import {
  RELEASES_INDEX_DO_KEY,
  RELEASES_INDEX_KEY,
  RELEASES_INDEX_STORE_SECONDS,
  type ReleasesIndexBlob,
} from "./releases-index-cache";
import type { IssueWebhookPayload } from "./issue-cache";
import { WEBHOOK_URL_KV_KEY as DISCORD_WEBHOOK_URL_KV_KEY } from "./discord";

// Discord PR close 通知用 webhook URL の DO storage key (Refs #441 PR2)。
// SoT は本 DO の `this.ctx.storage`。旧 PR1 で operator が KV
// (`discord:prCloseWebhookUrl`) に投入した値は、初回 read で seed として
// 吸い上げて DO に書き写す (releases blob の v3 → v4 migration と同 pattern)。
const DISCORD_WEBHOOK_URL_DO_KEY = "discord:prCloseWebhookUrl";

// shape refresh の結果型 (ci-shape-refresh.ts と同形だが、循環 import を避けるため
// 本ファイル内に再宣言する)。
export interface ShapeRefreshResult {
  scanned: number;
  ok: number;
  failed: number;
  errors: string[];
}

// WebSocket message envelope. All broadcasts now share `{ type, data }` so
// the dashboard JS can dispatch by type. Two channels currently:
//   - "ci-statuses"     → CIStatus[] (workflow run grid)
//   - "release-alerts"  → ReleaseAlert[] (post-tag-release banner)
type WsEnvelope =
  | { type: "ci-statuses"; data: CIStatus[] }
  | { type: "release-alerts"; data: ReleaseAlert[] }
  // /issues page の live reload trigger (Refs #321)。webhook の issues event
  // 処理後に webhook.ts が /issues-updated 経由で broadcast する。
  | { type: "issues-updated"; data: { repo: string; number: number; state: string } }
  // /releases page の live reload trigger (Refs #327)。index blob の refresh
  // 完了後に webhook.ts (queue consumer) が /releases-updated 経由で broadcast
  // する — 「集計完了後」なので reload 直後は必ず fresh blob を読む。
  | { type: "releases-updated"; data: { repo: string } };

const ALERT_KEY_PREFIX = "release-alert:";
const ALERT_TTL_SECONDS = 7 * 86400;

// in_progress のまま留まる run を recheck の対象にするまでの age。index.ts の
// `STALE_IN_PROGRESS_MS` (snapshot 経路の reconcile) と同値で揃える。
// 値変更時は両方とも合わせる。Refs #366 / #384。
export const HUB_STALE_IN_PROGRESS_MS = 60 * 60 * 1000;

// DO alarm() の interval。snapshot 経路 (`autoRecheckStale`) は client が
// `/snapshot` を叩いた時にしか発火しないため、WS 接続のままタブが開きっぱなしの
// dashboard では stale recheck が実質起動しない (Refs #384)。これを補う safety
// net として、CIDashboardHub DO が自前で 10 分毎に in-memory cache を walk し、
// stale な in_progress run を recheck する。
export const STALE_RECHECK_ALARM_MS = 10 * 60 * 1000;

// ci-shape KV の scheduled refresh interval (Refs #402)。
// `ci-shape-report.yml` caller は repo の workflow event でしか fire しないため、
// `push:main` を切った repo (例: mcp-relay-rs#21) は caller workflow file を
// 変更しても次の PR まで KV に反映されない。alarm() が 10 分毎に走るので、
// その中で「最後の shape refresh から 6h 経過」をチェックして refresh する。
export const SHAPE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

// DO storage key: 最後に shape refresh を完了した unix ms。
const SHAPE_REFRESH_KEY = "shape_refresh_last_at";

/** in-memory cache から stale な in_progress run を抽出する pure helper。
 *  - `status === "completed"` は除外
 *  - `updated_at` が parse 不能 (NaN) は除外
 *  - `updated_at` が `now - staleMs` より新しいものは除外
 *  alarm() と test の両方から呼ぶ。 */
export function pickStaleInProgressRuns(
  statuses: Iterable<CIStatus>,
  now: number,
  staleMs: number,
): CIStatus[] {
  const stale: CIStatus[] = [];
  for (const s of statuses) {
    if (s.status === "completed") continue;
    const updatedMs = new Date(s.updated_at).getTime();
    if (!Number.isFinite(updatedMs)) continue;
    if (now - updatedMs < staleMs) continue;
    stale.push(s);
  }
  return stale;
}

function tagAlertKey(repo: string): string {
  return `${ALERT_KEY_PREFIX}${repo}`;
}

function prAlertKey(repo: string, prNumber: number): string {
  return `${ALERT_KEY_PREFIX}${repo}:pr-${prNumber}`;
}

export class CIDashboardHub extends DurableObject<Env> {
  // In-memory cache: run_id → CIStatus
  private cache = new Map<number, CIStatus>();
  private cacheLoaded = false;

  // In-memory cache: KV key → ReleaseAlert. Keys take one of two shapes:
  //   release-alert:<owner>/<name>            — traditional tag-driven alert
  //   release-alert:<owner>/<name>:pr-<n>     — PR-merge alert for tagless repos
  // Keying the map by the full KV key (instead of "owner/name") lets us hold
  // multiple PR-based alerts per repo concurrently while still overwriting
  // the tag alert in place when a fresh tag release fires.
  private alerts = new Map<string, ReleaseAlert>();
  private alertsLoaded = false;

  // /releases index blob への mutation を直列化する instance 内 mutex
  // (Refs #341)。queue consumer は並走 3 (#336) のため、batch close の
  // issues event が同じ blob を同時 read-modify-write すると後勝ちで他の
  // patch が消える (lost update)。本 DO は singleton なので promise chain で
  // 確実に直列になる。
  private releasesPatchChain: Promise<unknown> = Promise.resolve();

  private serializeReleasesPatch<T>(work: () => Promise<T>): Promise<T> {
    const run = this.releasesPatchChain.then(work);
    // 後続は成功/失敗に関わらず続行 (失敗は caller に伝播)。
    this.releasesPatchChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // /releases blob の SoT は本 DO の `this.ctx.storage` (#409、強整合)。
  // 旧設計 (v3 以前) は CI_STATUS KV を SoT にしていたが、CF KV の global
  // propagation lag (最大 60s) と WS auto-reload (~10s) が噛み合い、close
  // 直後の reload で「復活」する事故 (#400) が確定したため SoT を DO に移した。
  //
  // bootstrap migration: DO storage が空 (deploy 直後 / 初回 access) なら
  // 旧 key (`releases:index:v3`) を 1 回だけ seed として読み、DO に書き写す。
  // それ以降は DO のみが読まれる (KV v4 は queue 経由の backup のみで、reader
  // は最終 fallback でしか触らない)。
  private async getReleasesIndexBlob<T = unknown>(): Promise<ReleasesIndexBlob<T> | null> {
    const stored = await this.ctx.storage.get<ReleasesIndexBlob<T>>(RELEASES_INDEX_DO_KEY);
    if (stored !== undefined && stored !== null) return stored;
    // legacy v3 (#400 までの SoT) を seed として試す。
    const legacy = await this.env.CI_STATUS.get(
      "releases:index:v3",
      "json",
    ) as ReleasesIndexBlob<T> | null;
    if (legacy) {
      await this.ctx.storage.put(RELEASES_INDEX_DO_KEY, legacy);
      return legacy;
    }
    // v4 backup (本 PR 以降の KV backup) も試す (disaster recovery 用)。
    const backup = await this.env.CI_STATUS.get(
      RELEASES_INDEX_KEY,
      "json",
    ) as ReleasesIndexBlob<T> | null;
    if (backup) {
      await this.ctx.storage.put(RELEASES_INDEX_DO_KEY, backup);
      return backup;
    }
    return null;
  }

  private async putReleasesIndexBlob(blob: ReleasesIndexBlob): Promise<void> {
    await this.ctx.storage.put(RELEASES_INDEX_DO_KEY, blob);
    // KV backup を queue 経由で非同期に依頼する (best-effort、失敗は drop)。
    // KV は disaster recovery / external dump 用の eventual mirror で、
    // 読み手は基本 DO のみを見るため backup の lag や drop は許容できる。
    if (this.env.WEBHOOK_QUEUE) {
      try {
        await this.env.WEBHOOK_QUEUE.send({ kind: "releases-index-kv-backup" });
      } catch { /* fail-open */ }
    }
  }

  /** Discord PR close 通知用 webhook URL の getter (Refs #441 PR2)。
   *  DO storage に無ければ legacy KV (PR1 経路) を 1 回だけ seed として読み、
   *  DO に書き写してから返す。以後 KV は触らない。 */
  private async getDiscordPrCloseWebhookUrl(): Promise<string | null> {
    const stored = await this.ctx.storage.get<string>(DISCORD_WEBHOOK_URL_DO_KEY);
    if (typeof stored === "string" && stored.length > 0) return stored;
    const legacy = await this.env.CI_STATUS.get(DISCORD_WEBHOOK_URL_KV_KEY);
    if (legacy) {
      await this.ctx.storage.put(DISCORD_WEBHOOK_URL_DO_KEY, legacy);
      return legacy;
    }
    return null;
  }

  /** Discord webhook URL を DO storage に書き込む (Refs #441 PR2 / PR3 で
   *  healChannel が叩く)。空文字 / null を渡すと delete (= 通知 disabled)。 */
  private async putDiscordPrCloseWebhookUrl(url: string | null): Promise<void> {
    if (!url) {
      await this.ctx.storage.delete(DISCORD_WEBHOOK_URL_DO_KEY);
      return;
    }
    await this.ctx.storage.put(DISCORD_WEBHOOK_URL_DO_KEY, url);
  }

  /** apply-close/issue/refs が使う BlobStore adapter。direct DO storage IO で
   *  read-modify-write を 1 つのトランザクション内で完結させる。 */
  private blobStore(): BlobStore {
    return {
      read: <T = unknown>() => this.getReleasesIndexBlob<T>(),
      write: (blob: ReleasesIndexBlob) => this.putReleasesIndexBlob(blob),
    };
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
    // DO が wake する度に alarm を ensure する (idempotent: 既存があれば no-op)。
    // これで stale recheck の chain が一度途切れても次の wake で復活する。
    // Refs #384。
    this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null) {
        await this.ctx.storage.setAlarm(Date.now() + STALE_RECHECK_ALARM_MS);
      }
    });
  }

  // 10 分毎に in-memory cache を walk し、1h 以上 in_progress に居座っている
  // run を GitHub API で recheck → cache / KV / WS broadcast を update する。
  // snapshot 経路の `autoRecheckStale` (index.ts) と相補的な safety net。
  // Refs #384。同 alarm() で 6h 毎の ci-shape KV refresh も走らせる (Refs #402)。
  async alarm(): Promise<void> {
    const now = Date.now();
    try {
      await this.runStaleRecheck(now);
    } catch (err) {
      console.warn("hub alarm runStaleRecheck failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await this.maybeRunShapeRefresh(now);
    } catch (err) {
      console.warn("hub alarm maybeRunShapeRefresh failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // 次の tick を必ず chain する。失敗時も chain しないと recheck が永久停止する。
    await this.ctx.storage.setAlarm(Date.now() + STALE_RECHECK_ALARM_MS);
  }

  /** 6h 毎の ci-shape KV refresh。最後の完了 timestamp が `SHAPE_REFRESH_INTERVAL_MS`
   *  以上前なら refreshAllShapes() を走らせて timestamp を更新する。テストから直接
   *  呼べるよう public。 */
  async maybeRunShapeRefresh(now: number): Promise<{ ran: boolean; result?: ShapeRefreshResult }> {
    const last = (await this.ctx.storage.get<number>(SHAPE_REFRESH_KEY)) ?? 0;
    if (now - last < SHAPE_REFRESH_INTERVAL_MS) {
      return { ran: false };
    }
    // 遅延 import (test pool で循環参照を避ける + bootstrap cost を払わない)
    const { refreshAllShapes } = await import("./ci-shape-refresh");
    const result = await refreshAllShapes(this.env);
    await this.ctx.storage.put(SHAPE_REFRESH_KEY, now);
    if (result.failed > 0) {
      console.warn("hub shape refresh had failures", {
        scanned: result.scanned,
        ok: result.ok,
        failed: result.failed,
        errors: result.errors.slice(0, 5),
      });
    } else {
      console.log("hub shape refresh ok", { scanned: result.scanned });
    }
    return { ran: true, result };
  }

  /** alarm() の本体。テストから直接呼べるよう public にしている。 */
  async runStaleRecheck(now: number): Promise<void> {
    await this.ensureCache();
    const stale = pickStaleInProgressRuns(
      this.cache.values(),
      now,
      HUB_STALE_IN_PROGRESS_MS,
    );
    let anyUpdated = false;
    for (const s of stale) {
      try {
        await this.recheckRunFromGitHub(s.run_id, s.repo);
        anyUpdated = true;
      } catch (err) {
        // best-effort: 個別 run の失敗で全体を止めない。次の alarm で再試行。
        console.warn("hub alarm recheck failed", {
          run_id: s.run_id,
          repo: s.repo,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // updateRun / updateJob は cache + KV だけ更新するので、WS subscriber に
    // 反映するため明示的に broadcast する (fetch route 側と同じ pattern)。
    if (anyUpdated) this.broadcastFromCache();
  }

  /** GitHub API を直叩きして run + jobs を取り直し、内部 update メソッドで
   *  cache / KV / WS broadcast を更新する。`recheck.ts` の `recheckRun` は
   *  DO stub 経由で動く設計なので、alarm() からは DO 内部で完結する本関数を使う。 */
  private async recheckRunFromGitHub(
    run_id: number,
    repo: string,
  ): Promise<void> {
    const slashIdx = repo.indexOf("/");
    if (slashIdx <= 0) return;
    const owner = repo.slice(0, slashIdx);

    const token = await tokenForOrg(this.env, owner);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ci-dashboard",
    };

    const runRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs/${run_id}`,
      { headers },
    );
    if (!runRes.ok) {
      throw new Error(`GitHub API ${runRes.status}`);
    }
    const run = (await runRes.json()) as {
      id: number;
      name: string;
      head_branch: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      actor: { login: string };
      updated_at: string;
      run_started_at: string;
    };
    await this.updateRun({
      run: {
        id: run.id,
        name: run.name,
        head_branch: run.head_branch,
        status: run.status,
        conclusion: run.conclusion,
        html_url: run.html_url,
        actor: { login: run.actor.login },
        updated_at: run.updated_at,
        run_started_at: run.run_started_at,
      },
      repo,
    });

    const jobsRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs/${run_id}/jobs`,
      { headers },
    );
    if (jobsRes.ok) {
      const { jobs } = (await jobsRes.json()) as {
        jobs: Array<{
          run_id: number;
          name: string;
          status: string;
          conclusion: string | null;
          html_url: string;
          started_at: string | null;
          completed_at: string | null;
        }>;
      };
      for (const job of jobs) {
        await this.updateJob({
          job: {
            run_id: job.run_id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            html_url: job.html_url,
            started_at: job.started_at,
            completed_at: job.completed_at,
          },
        });
      }
    }
  }

  private async ensureCache(): Promise<void> {
    if (this.cacheLoaded) return;
    const list = await this.env.CI_STATUS.list({ prefix: "run:" });
    const values = await Promise.all(
      list.keys.map((key) => this.env.CI_STATUS.get(key.name))
    );
    for (const v of values) {
      if (v) {
        const s = JSON.parse(v) as CIStatus;
        this.cache.set(s.run_id, s);
      }
    }
    this.cacheLoaded = true;
  }

  private async ensureAlerts(): Promise<void> {
    if (this.alertsLoaded) return;
    const list = await this.env.CI_STATUS.list({ prefix: ALERT_KEY_PREFIX });
    const values = await Promise.all(
      list.keys.map((key) => this.env.CI_STATUS.get(key.name))
    );
    for (let i = 0; i < list.keys.length; i++) {
      const v = values[i];
      if (!v) continue;
      try {
        const a = JSON.parse(v) as ReleaseAlert;
        // Use the KV key directly so tag and PR alerts co-exist in the map
        // without colliding on `repo`.
        this.alerts.set(list.keys[i]!.name, a);
      } catch { /* skip corrupt entry */ }
    }
    this.alertsLoaded = true;
  }

  private computeStatuses(): CIStatus[] {
    const all = [...this.cache.values()];

    const latestInProgress = new Map<string, CIStatus>();
    const latestCompleted = new Map<string, CIStatus>();

    for (const s of all) {
      const map = s.status === "completed" ? latestCompleted : latestInProgress;
      const existing = map.get(s.repo);
      if (!existing || s.updated_at > existing.updated_at) {
        map.set(s.repo, s);
      }
    }

    for (const [repo, ip] of latestInProgress) {
      const completed = latestCompleted.get(repo);
      if (completed && completed.updated_at > ip.updated_at) {
        latestInProgress.delete(repo);
      }
    }

    const result = [...latestInProgress.values(), ...latestCompleted.values()];
    result.sort((a, b) => {
      if (a.status !== "completed" && b.status === "completed") return -1;
      if (a.status === "completed" && b.status !== "completed") return 1;
      return b.updated_at.localeCompare(a.updated_at);
    });

    return result;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast") {
      const data = await request.text();
      this.broadcast(data);
      return new Response("OK");
    }

    // All statuses from in-memory cache (for /status endpoint)
    if (url.pathname === "/statuses") {
      await this.ensureCache();
      const statuses = this.computeStatuses();
      return Response.json(statuses);
    }

    // All release alerts from in-memory cache (for /release-alerts endpoint).
    // Lazy-refresh path: drop openIssues that GitHub now reports as closed
    // before returning. The KV alert entry has a 7d TTL and is only mutated
    // on /release-alert-detect{,-pr} / /release-alert-recompute, so an issue
    // closed outside the dashboard's UI (manually on GitHub, or via a `Closes
    // #N` from another repo's PR) would otherwise haunt the banner for days.
    // See #90 follow-up.
    if (url.pathname === "/release-alerts") {
      await this.ensureAlerts();
      await this.refreshStaleAlerts();
      return Response.json([...this.alerts.values()]);
    }

    // Unified snapshot: { statuses, alerts } in one DO call. Dashboard UI
    // uses this on WS connect / reconnect instead of polling /status +
    // /release-alerts every 30s. Refs #64 (90% Worker request reduction).
    // Same lazy-refresh as /release-alerts above — this is the actual read
    // path the dashboard JS hits on every page load.
    if (url.pathname === "/snapshot") {
      await this.ensureCache();
      await this.ensureAlerts();
      await this.refreshStaleAlerts();
      return Response.json({
        statuses: this.computeStatuses(),
        alerts: [...this.alerts.values()],
      });
    }

    // Compute alert for a tag release that just shipped, store + broadcast.
    // Called from webhook.ts after a `Tag Release` workflow_run completes.
    if (url.pathname === "/release-alert-detect") {
      const { repo, tag } = await request.json<{ repo: string; tag?: string }>();
      await this.ensureAlerts();
      try {
        const alert = await computeReleaseAlert(
          this.env, repo, tag, this.env.CI_STATUS,
        );
        this.persistAlertAtKey(tagAlertKey(repo), alert);
        this.broadcastAlerts();
      } catch {
        // Best-effort: a failed compute (e.g. token rate-limit) leaves any
        // existing alert in place rather than wiping it.
      }
      return new Response("OK");
    }

    // Tagless-repo variant: a PR was just merged into the default branch on a
    // repo that doesn't cut release tags. Treat the PR as a mini-release —
    // walk it for Refs and persist a PR-scoped alert. Each PR gets its own KV
    // entry so multiple in-flight close-required PRs co-exist.
    if (url.pathname === "/release-alert-detect-pr") {
      const { repo, prNumber, mergeSha, defaultBranch } = await request.json<{
        repo: string;
        prNumber: number;
        mergeSha: string | null;
        defaultBranch: string;
      }>();
      await this.ensureAlerts();
      try {
        const alert = await computeReleaseAlertForPr(
          this.env, repo, prNumber, mergeSha, defaultBranch, this.env.CI_STATUS,
        );
        this.persistAlertAtKey(prAlertKey(repo, prNumber), alert);
        this.broadcastAlerts();
      } catch {
        // Same best-effort pattern as the tag path — failed compute keeps any
        // existing PR alert in place.
      }
      return new Response("OK");
    }

    // Recompute alert(s) for a repo whose state changed elsewhere (e.g. an
    // operator just closed issues via /api/release-close{,-batch}). For repos
    // with multiple PR-scoped alerts we recompute each one and drop those that
    // have no open issues left.
    if (url.pathname === "/release-alert-recompute") {
      const { repo } = await request.json<{ repo: string }>();
      await this.ensureAlerts();

      // Collect every (key, alert) pair for this repo before mutating so we
      // can iterate without disturbing the live Map.
      const matching = [...this.alerts.entries()].filter(([_, a]) => a.repo === repo);
      if (matching.length === 0) return new Response("OK");

      let changed = false;
      for (const [kvKey, existing] of matching) {
        try {
          const fresh = existing.prNumber !== undefined
            ? await computeReleaseAlertForPr(
                this.env, repo, existing.prNumber,
                /* mergeSha */ null,
                /* defaultBranch */ existing.tag.split("@")[0] ?? "main",
                this.env.CI_STATUS,
              )
            : await recomputeAlert(
                this.env, repo, existing.tag, this.env.CI_STATUS,
              );
          this.persistAlertAtKey(kvKey, fresh);
          changed = true;
        } catch {
          // Leave this particular alert in place; siblings still get a try.
        }
      }
      if (changed) this.broadcastAlerts();
      return new Response("OK");
    }

    // Discord PR close 通知用 webhook URL の read (Refs #441 PR2)。
    // legacy KV (`discord:prCloseWebhookUrl`) からの lazy migration は
    // getter 側で行う。URL 未設定は 200 + 空 body (= 通知 disabled、
    // discord.ts の readPrCloseWebhookUrl が null 扱いにする)。
    if (url.pathname === "/discord-webhook-url" && request.method === "GET") {
      const stored = await this.getDiscordPrCloseWebhookUrl();
      return new Response(stored ?? "", { status: 200 });
    }

    // Discord PR close 通知用 webhook URL の write (Refs #441 PR2、PR3 の
    // healChannel から再利用)。body は `{ url: string | null }`。本 endpoint
    // 自体は無認証 — Worker 側で gate するか、PR3 で Bot token と一緒に保護
    // する。本 PR2 段階では Hub と Worker の信頼境界 (= 同 isolate からの
    // service binding 内通信) に閉じている前提。
    if (url.pathname === "/discord-webhook-url" && request.method === "PUT") {
      const { url: nextUrl } = await request.json<{ url: string | null }>();
      await this.putDiscordPrCloseWebhookUrl(nextUrl ?? null);
      return new Response("OK");
    }

    // /issues page の live reload trigger (Refs #321)。KV upsert 済みの issue
    // 変更を WS client に通知する。dashboard JS は未知 type を無視するので
    // 同一 /ws チャネルに相乗りして良い。
    if (url.pathname === "/issues-updated") {
      const data = await request.json<{ repo: string; number: number; state: string }>();
      this.broadcastEnvelope({ type: "issues-updated", data });
      return new Response("OK");
    }

    // /releases index blob の read (Refs #409)。本 DO の `this.ctx.storage`
    // から strongly consistent に返す。`releases-index-cache.ts` の
    // `readReleasesIndexBlob(env)` (= worker fetch handler 側) がここを叩く。
    // blob 不在は 200 空 body で返す (caller は parse 前に length チェック)。
    if (url.pathname === "/releases-index-read") {
      const blob = await this.getReleasesIndexBlob();
      if (!blob) return new Response("", { status: 200 });
      return new Response(JSON.stringify(blob), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // /releases index blob の write (Refs #409)。任意の blob オブジェクト
    // (storedAt / views / staleRepos) を受け取りそのまま DO storage に put。
    // `writeReleasesIndexBlob` (refresh 経路) と
    // `writePatchedReleasesIndexBlob` (webhook patch 後の再 fetch 経路) と
    // `markReleasesIndexStale` の 3 つが叩く統合 endpoint。
    if (url.pathname === "/releases-index-write") {
      const blob = await request.json<ReleasesIndexBlob>();
      await this.putReleasesIndexBlob(blob);
      return new Response("OK");
    }

    // /releases index blob への webhook 直接 patch (Refs #339/#341)。
    // consumer から委譲され、本 DO 内で直列実行する (lost update 防止)。
    // patch 成功時の WS broadcast もここで行う = patch → broadcast が原子的。
    if (url.pathname === "/releases-index-apply-issue") {
      const payload = await request.json<IssueWebhookPayload>();
      const patched = await this.serializeReleasesPatch(() =>
        applyIssueEventToReleasesIndex(this.blobStore(), payload),
      );
      if (patched) {
        this.broadcastEnvelope({
          type: "releases-updated",
          data: { repo: payload.repository.full_name },
        });
      }
      return Response.json({ patched });
    }

    // ダッシュボード起点 close の index blob 同期反映 (Refs #343)。issues
    // webhook (apply-issue) が来ない repo でも close を即 blob に焼くため、
    // handleReleaseClose から closed issue の url 群を委譲される。本 DO 内で
    // 直列実行 (lost update 防止) + patch 成功時 broadcast を原子的に行う。
    if (url.pathname === "/releases-index-apply-close") {
      const { repo, urls } = await request.json<{ repo: string; urls: string[] }>();
      const patched = await this.serializeReleasesPatch(() =>
        applyCloseToReleasesIndex(this.blobStore(), urls),
      );
      if (patched) {
        this.broadcastEnvelope({ type: "releases-updated", data: { repo } });
      }
      return Response.json({ patched });
    }

    if (url.pathname === "/releases-index-apply-refs") {
      const { repo, refs, headSha } = await request.json<{
        repo: string;
        refs: number[];
        headSha: string | null;
      }>();
      const outcome = await this.serializeReleasesPatch(() =>
        applyRefsPatchToReleasesIndex(this.blobStore(), this.env.CI_STATUS, repo, refs, headSha),
      );
      if (outcome === "patched") {
        this.broadcastEnvelope({ type: "releases-updated", data: { repo } });
      }
      return Response.json({ outcome });
    }

    // /releases page の live reload trigger (Refs #327)。
    if (url.pathname === "/releases-updated") {
      const data = await request.json<{ repo: string }>();
      this.broadcastEnvelope({ type: "releases-updated", data });
      return new Response("OK");
    }

    if (url.pathname === "/update-run") {
      const payload = await request.json<{
        run: {
          id: number;
          name: string;
          head_branch: string;
          status: string;
          conclusion: string | null;
          html_url: string;
          actor: { login: string };
          updated_at: string;
          run_started_at: string;
        };
        repo: string;
      }>();
      await this.ensureCache();
      await this.updateRun(payload);
      this.broadcastFromCache();
      return new Response("OK");
    }

    if (url.pathname === "/update-job") {
      const payload = await request.json<{
        job: {
          run_id: number;
          name: string;
          status: string;
          conclusion: string | null;
          html_url: string;
          started_at: string | null;
          completed_at: string | null;
        };
      }>();
      await this.ensureCache();
      await this.updateJob(payload);
      this.broadcastFromCache();
      return new Response("OK");
    }

    if (url.pathname === "/delete-run") {
      const { run_id } = await request.json<{ run_id: number }>();
      await this.ensureCache();
      this.cache.delete(run_id);
      await this.env.CI_STATUS.delete(`run:${run_id}`);
      this.broadcastFromCache();
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }

  private async updateRun(payload: {
    run: {
      id: number;
      name: string;
      head_branch: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      actor: { login: string };
      updated_at: string;
      run_started_at: string;
    };
    repo: string;
  }): Promise<void> {
    const { run, repo } = payload;
    const existing = this.cache.get(run.id);

    let status: CIStatus;
    if (existing) {
      existing.status = run.status;
      existing.conclusion = run.conclusion;
      existing.updated_at = run.updated_at;
      if (run.status === "completed" && existing.jobs) {
        for (const job of existing.jobs) {
          if (job.status === "in_progress" || job.status === "queued") {
            job.status = "completed";
            job.conclusion = job.conclusion ?? "skipped";
          }
        }
      }
      status = existing;
    } else {
      status = {
        repo,
        workflow: run.name,
        branch: run.head_branch,
        status: run.status,
        conclusion: run.conclusion,
        run_id: run.id,
        run_url: run.html_url,
        actor: run.actor.login,
        updated_at: run.updated_at,
        started_at: run.run_started_at,
      };
    }

    this.cache.set(run.id, status);
    // KV write is fire-and-forget for speed; cache is source of truth
    this.ctx.waitUntil(
      this.env.CI_STATUS.put(`run:${run.id}`, JSON.stringify(status), {
        expirationTtl: 86400,
      })
    );
  }

  private async updateJob(payload: {
    job: {
      run_id: number;
      name: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      started_at: string | null;
      completed_at: string | null;
    };
  }): Promise<void> {
    const { job } = payload;
    const status = this.cache.get(job.run_id);
    if (!status) return;

    const jobStatus: JobStatus = {
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      url: job.html_url,
      started_at: job.started_at,
      completed_at: job.completed_at,
    };

    const jobs = status.jobs ?? [];
    const idx = jobs.findIndex((j) => j.name === job.name);
    if (idx >= 0) {
      jobs[idx] = jobStatus;
    } else {
      jobs.push(jobStatus);
    }
    status.jobs = jobs;

    this.ctx.waitUntil(
      this.env.CI_STATUS.put(`run:${job.run_id}`, JSON.stringify(status), {
        expirationTtl: 86400,
      })
    );
  }

  // Persist (or delete, when fresh is null) the alert at a specific KV key.
  // Map + KV stay in lockstep — the in-memory `alerts` Map is keyed by the same
  // KV key so a future `ensureAlerts()` read sees consistent state. Same KV-
  // fire-and-forget pattern as the run cache. Caller broadcasts afterward.
  private persistAlertAtKey(kvKey: string, fresh: ReleaseAlert | null): void {
    if (fresh === null) {
      this.alerts.delete(kvKey);
      this.ctx.waitUntil(this.env.CI_STATUS.delete(kvKey));
    } else {
      this.alerts.set(kvKey, fresh);
      this.ctx.waitUntil(
        this.env.CI_STATUS.put(kvKey, JSON.stringify(fresh), {
          expirationTtl: ALERT_TTL_SECONDS,
        }),
      );
    }
  }

  // For each in-memory alert, re-verify its openIssues against current GitHub
  // state. Drop issues now reported closed; if the alert ends up with no
  // openIssues, delete the alert entirely so the banner disappears.
  //
  // We deliberately bypass `cachedIssue` (60 s KV TTL) AND Cloudflare's
  // outbound fetch cache (`cache: "no-store"`). The reason: an issue
  // referenced by an alert is, by definition, one we already think is open.
  // The whole point of refreshing here is to detect the open→closed flip.
  // Reading any cached state runs the risk of returning the stale "open"
  // value that originally triggered the alert — defeating the refresh.
  //
  // Side effect: invalidate the cachedIssue KV entry after a state change so
  // /releases (which uses cachedIssue) reflects the fresh state on its next
  // load instead of waiting out the 60 s TTL.
  //
  // Cost: N raw GitHub `/issues/N` fetches per /snapshot call where N is the
  // total openIssues count across all alerts. Typical N is 1-5. /snapshot is
  // called on dashboard load + visibilitychange (Refs #92) — no periodic
  // polling. No GitHub fetches when `alerts.size === 0`.
  //
  // Best-effort: any per-issue fetch error keeps that issue in place
  // (transient GitHub 5xx shouldn't silently hide an alert that may still be
  // legitimate).
  //
  // Refs #94 (the previous cachedIssue-based version saw stale "open" data
  // and never dropped a known-closed issue).
  private async refreshStaleAlerts(): Promise<void> {
    if (this.alerts.size === 0) return;
    const entries = [...this.alerts.entries()];
    let anyChanged = false;
    const invalidations: Array<Promise<void>> = [];
    await Promise.all(entries.map(async ([kvKey, alert]) => {
      let owner: string;
      let name: string;
      try {
        ({ owner, repo: name } = parseRepo(alert.repo));
      } catch {
        return;
      }
      const statuses = await Promise.all(alert.openIssues.map(async (i) => {
        try {
          const state = await this.fetchLiveIssueState(owner, name, i.number);
          return { issue: i, state };
        } catch {
          // Keep the issue on transient failure (treat as "still open" so the
          // banner doesn't quietly disappear because of GitHub rate limits).
          return { issue: i, state: "open" };
        }
      }));
      const stillOpen = statuses
        .filter((s) => s.state !== "closed")
        .map((s) => s.issue);
      if (stillOpen.length === alert.openIssues.length) return;
      anyChanged = true;
      // Wipe the cachedIssue entry for each now-closed issue so /releases
      // also picks up the fresh "closed" on its next render rather than
      // serving the same stale "open" we just routed around.
      for (const s of statuses) {
        if (s.state === "closed") {
          invalidations.push(invalidateIssue(this.env.CI_STATUS, owner, name, s.issue.number));
        }
      }
      if (stillOpen.length === 0) {
        this.persistAlertAtKey(kvKey, null);
      } else {
        this.persistAlertAtKey(kvKey, { ...alert, openIssues: stillOpen });
      }
    }));
    if (invalidations.length > 0) this.ctx.waitUntil(Promise.all(invalidations).then(() => undefined));
    if (anyChanged) this.broadcastAlerts();
  }

  // Direct GitHub fetch that bypasses every cache layer:
  //   - KV `cachedIssue` (60 s TTL): we don't call it
  //   - Cloudflare Worker outbound fetch cache, defense in depth:
  //       1. `cache: "no-store"` (officially-supported escape hatch —
  //          https://developers.cloudflare.com/workers/runtime-apis/fetch/).
  //          The Worker types lib doesn't expose `cache` on RequestInit, so we
  //          widen via a cast — the runtime does honor it.
  //       2. Per-call cache-buster query (`?_=${Date.now()}`) so the cache
  //          key (full URL) misses on every request even if (1) is ignored.
  //          GitHub ignores unknown query params on /issues/N.
  //       3. `Cache-Control: no-cache, no-store, must-revalidate` + `Pragma:
  //          no-cache` request headers to ask the intermediate layer not to
  //          serve a cached response.
  //
  // Only used by refreshStaleAlerts; for any page-render path stick with
  // `cachedIssue` which is fine.
  //
  // Refs #94: without (1), the Worker's implicit fetch cache held a stale
  // `state: "open"` response for #64 across hours of /snapshot calls. After
  // shipping (1) alone the bug recurred — the cache only cleared when an
  // operator manually purged it. (2)+(3) defend against that recurrence.
  private async fetchLiveIssueState(owner: string, name: string, n: number): Promise<string> {
    const token = await tokenForOrg(this.env, owner);
    const init: RequestInit & { cache?: string } = {
      method: "GET",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ci-dashboard-mcp",
        "X-GitHub-Api-Version": "2022-11-28",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    };
    const url = `https://api.github.com/repos/${owner}/${name}/issues/${n}?_=${Date.now()}`;
    const res = await fetch(url, init as RequestInit);
    if (!res.ok) {
      throw new Error(`GitHub /issues/${n} returned ${res.status}`);
    }
    const body = await res.json() as { state?: string };
    return body.state ?? "open";
  }

  private broadcastFromCache(): void {
    const statuses = this.computeStatuses();
    this.broadcastEnvelope({ type: "ci-statuses", data: statuses });
  }

  private broadcastAlerts(): void {
    this.broadcastEnvelope({
      type: "release-alerts",
      data: [...this.alerts.values()],
    });
  }

  private broadcastEnvelope(envelope: WsEnvelope): void {
    this.broadcast(JSON.stringify(envelope));
  }

  broadcast(data: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Client disconnected
      }
    }
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }
}
