/**
 * /release-wave の「Start wave」UI と POST endpoint。
 *
 * backend (rust-alc-api) + consumer frontend を 1 wave にまとめて開始し、
 * 同時 flip できるようにする画面側の入口 (Refs #137 / #157 改善B)。
 * これまで wave は `release_wave_start` MCP tool でしか開始できず、
 * 画面から start する導線が無かった。
 *
 * 設計:
 *   - 参加候補 repo は `getRepoReleaseStatuses` が discover する監視対象 repo
 *     (Hub status / direct-push allowlist / TAGLESS_REPOS / compat グラフ) を
 *     流用する。archived / tagless は除外。
 *   - 各候補をチェックボックスで選択し、repo ごとに target_tag をフォーム入力する。
 *     target_tag は妥協入力 (= 自動採番せず operator が打つ tag を手で書く)。
 *   - 各 repo の head_sha は POST 受信時に default branch HEAD を GitHub から
 *     取得する (= フォームには出さない)。
 *   - flip_policy は安全側の `manual-approval` を default にする (= stage 後に
 *     approve を要求)。`auto` も選べる。
 *   - 認証は CF Access edge に委譲 (= 他の action と同じトラストモデル)。
 *
 * CSP は page.ts の strict 設定 (`script-src 'none'`, `form-action 'self'`) なので、
 * 素の <form method="post"> + inline style のみで構成する (JS 無し)。
 */

import type { Env } from "../index";
import type { ReleaseWaveHub, RpcResult } from "./do";
import type { FlipPolicy, WaveState } from "./types";
import { parseRepo, tokenForOrg, githubApi } from "../github-api";
import { cachedRepoMeta } from "../release-cache";
import {
  getRepoReleaseStatuses,
  type RepoReleaseStatus,
} from "./repo-release-status";
import { parseStableSemver } from "../release-helpers";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function hubStub(env: Env): DurableObjectStub<ReleaseWaveHub> {
  const id = env.RELEASE_WAVE_HUB.idFromName("singleton");
  return env.RELEASE_WAVE_HUB.get(id) as DurableObjectStub<ReleaseWaveHub>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** wave start 後は詳細ページに 303 redirect。 */
function redirectToDetail(wave_id: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/release-wave/${encodeURIComponent(wave_id)}` },
  });
}

// ----------------------------------------------------------------------------
// SSR: Start wave フォーム section
// ----------------------------------------------------------------------------

/** default wave_id 候補 (操作者が上書き可)。`wave_YYYY_MM_DD_HHMM` (UTC)。 */
export function defaultWaveId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `wave_${now.getUTCFullYear()}_${p(now.getUTCMonth() + 1)}_${p(now.getUTCDate())}` +
    `_${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
  );
}

/**
 * Start wave フォームを HTML で返す。
 *
 * 候補 repo = tagless でない監視対象 repo (= getRepoReleaseStatuses の結果)。
 * tagless はそもそも tag を打たない方針なので wave に乗せられない。
 * 候補が 0 件 (= CI_STATUS 未 bind / 取得失敗) なら "" を返し、呼び出し側で
 * section を落とす。
 */
export function renderStartWaveSection(
  statuses: RepoReleaseStatus[],
  now: Date = new Date(),
  pendingTagByRepo: Map<string, string> = new Map(),
): string {
  const candidates = statuses.filter((s) => !s.tagless && s.behind >= 0);
  if (candidates.length === 0) return "";

  const rows = candidates
    .map((s) => {
      // target_tag の prefill (Refs #237):
      // wave は「事前に tag push → no-traffic upload された pending release」を
      // flip するだけなので、prefill は **実在 tag** を出す。latest+1 のような
      // 未来の合成 tag は出さない (旧 stage-driven モデルの名残で、実態とずれる)。
      //   1) その repo に pending release (no-traffic version) があればその tag。
      //   2) 無ければ現 stable latest tag (そのまま、bump しない)。
      //   3) latest が prerelease (`-wave-test-NN` / `-dev` / `-rc` 等) のみなら
      //      value 空 (placeholder のみ、operator が手で打つ)。
      const pendingTag = pendingTagByRepo.get(s.repo);
      const stableLatest =
        s.latestTag && parseStableSemver(s.latestTag) ? s.latestTag : "";
      const prefill = pendingTag ?? stableLatest;
      const placeholder = s.latestTag ?? "v0.1.0";
      const id = `repo_${s.repo.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const tagHint = pendingTag
        ? `<span class="meta">pending: ${escapeHtml(pendingTag)} (no-traffic)</span>`
        : s.hasTag
          ? `<span class="meta">latest: ${escapeHtml(s.latestTag ?? "")}</span>`
          : `<span class="meta">未tag</span>`;
      return `
        <tr>
          <td>
            <input type="checkbox" name="include" value="${escapeHtml(s.repo)}" id="${escapeHtml(id)}">
            <label for="${escapeHtml(id)}">${escapeHtml(s.repo)}</label>
          </td>
          <td>${tagHint}</td>
          <td>
            <input type="text" name="target_tag__${escapeHtml(s.repo)}"
              value="${escapeHtml(prefill)}"
              placeholder="${escapeHtml(placeholder)}"
              style="width:140px">
          </td>
          <td>
            <input type="checkbox" name="require_compatibility" value="${escapeHtml(s.repo)}"
              title="backend repo の場合: consuming frontend が未 test なら approve を拒否する">
          </td>
        </tr>`;
    })
    .join("");

  return `
    <div class="section">
      <h2>Start wave</h2>
      <p class="meta">backend と consumer frontend をまとめて 1 wave にして同時 flip する。
        参加 repo をチェックし、各 repo に cut する target tag を入力する。
        head_sha は start 時に default branch HEAD を自動取得する。
        flip_policy は安全側の <strong>manual-approval</strong> が default
        (= stage 後に approve が必要)。</p>
      <form method="post" action="/api/release-wave/start">
        <div style="margin:8px 0">
          <label for="wave_id">Wave ID</label>
          <input type="text" name="wave_id" id="wave_id"
            value="${escapeHtml(defaultWaveId(now))}" style="width:260px" required>
          &nbsp;&nbsp;
          <label for="flip_policy">Flip policy</label>
          <select name="flip_policy" id="flip_policy">
            <option value="manual-approval" selected>manual-approval</option>
            <option value="auto">auto</option>
          </select>
        </div>
        <div style="margin:8px 0">
          <label for="note">Note</label>
          <input type="text" name="note" id="note" placeholder="release theme (optional)"
            style="width:420px">
        </div>
        <table>
          <thead>
            <tr>
              <th>Repo (include)</th>
              <th>Tag</th>
              <th>Target tag</th>
              <th title="backend repo: consuming frontend 未 test 時に approve を拒否">require_compat</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="margin:10px 0">
          <button type="submit">Start wave</button>
        </div>
      </form>
    </div>`;
}

/**
 * レンダリング済み一覧 HTML に Start wave section を注入する。
 *
 * 配置: 既存 wave 一覧テーブル (`<h1>Release Waves</h1>` 直下に Compatibility /
 * Pending releases / Repo リリース状況 section が続く) の **末尾**、wave 一覧
 * テーブルの直前に入れたいが、テーブルは marker が無いので簡便に h1 直後に置く。
 * → start フォームを一番上 (h1 直後) に出し、その下に既存 section が続く。
 */
export function injectStartWaveSection(html: string, section: string): string {
  if (!section) return html;
  const h1Marker = "<h1>Release Waves</h1>";
  const h1 = html.indexOf(h1Marker);
  if (h1 !== -1) {
    // h1 の直後に続く <p class="meta"> 説明文の終わりまで読み飛ばして入れる。
    const at = h1 + h1Marker.length;
    return html.slice(0, at) + "\n    " + section + html.slice(at);
  }
  return html.replace("</body>", `${section}\n</body>`);
}

// ----------------------------------------------------------------------------
// POST /api/release-wave/start
// ----------------------------------------------------------------------------

/**
 * default branch HEAD の commit sha を取得する。失敗時は null。
 *
 * `GET /repos/{owner}/{name}` で default_branch を引き (cachedRepoMeta、KV cache)、
 * `GET /repos/{owner}/{name}/commits/{branch}` で HEAD commit の sha を取る。
 */
async function fetchHeadSha(
  env: Env,
  repo: string,
): Promise<string | null> {
  try {
    const { owner, repo: name } = parseRepo(repo);
    const token = await tokenForOrg(env, owner);
    const meta = await cachedRepoMeta(token, env.CI_STATUS, owner, name);
    const commit = await githubApi<{ sha: string }>(
      token,
      "GET",
      `/repos/${owner}/${name}/commits/${encodeURIComponent(meta.default_branch)}`,
    );
    return commit.sha || null;
  } catch {
    return null;
  }
}

/**
 * Start wave フォームの submit を受け、createWave を起こす。
 *
 * form fields:
 *   - `wave_id`            必須。wave 識別子。
 *   - `flip_policy`        `manual-approval` | `auto`。既定 manual-approval。
 *   - `note`              任意。
 *   - `include`           checkbox (複数)。参加させる repo の "owner/name"。
 *   - `target_tag__<repo>` 各参加 repo に cut する tag。
 *   - `require_compatibility` checkbox (複数)。compat gate を立てる backend repo。
 *
 * head_sha は各 repo の default branch HEAD を取得して埋める。取得失敗 repo は
 * その旨を 400 で返す (= sha 無しで start すると flip dispatch の checkout ref が
 * 壊れるため、ここで弾く)。
 * 成功すると wave 詳細ページに 303 redirect。createWave が ALREADY_EXISTS /
 * WAVE_IN_PROGRESS 等を返したら対応する HTTP status の JSON を返す。
 */
export async function handleReleaseWaveStart(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED", error: "use POST" });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: "expected form-encoded body",
    });
  }

  const waveId = String(form.get("wave_id") ?? "").trim();
  if (!waveId) {
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: "form field 'wave_id' is required",
    });
  }

  const flipRaw = String(form.get("flip_policy") ?? "manual-approval").trim();
  const flip_policy: FlipPolicy =
    flipRaw === "auto" ? "auto" : "manual-approval";
  const note = String(form.get("note") ?? "").trim();

  const includes = form
    .getAll("include")
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
  if (includes.length === 0) {
    return jsonResponse(400, {
      code: "BAD_REQUEST",
      error: "select at least one repo (form field 'include')",
    });
  }

  const requireCompat = new Set(
    form.getAll("require_compatibility").map((v) => String(v).trim()),
  );

  // 各参加 repo の target_tag を引き、未入力なら 400。
  const repos: Array<{
    repo: string;
    target_tag: string;
    head_sha: string;
    require_compatibility?: boolean;
  }> = [];
  const missingTag: string[] = [];
  const missingSha: string[] = [];

  for (const repo of includes) {
    const tag = String(form.get(`target_tag__${repo}`) ?? "").trim();
    if (!tag) {
      missingTag.push(repo);
      continue;
    }
    const head_sha = await fetchHeadSha(env, repo);
    if (!head_sha) {
      missingSha.push(repo);
      continue;
    }
    repos.push({
      repo,
      target_tag: tag,
      head_sha,
      ...(requireCompat.has(repo) ? { require_compatibility: true } : {}),
    });
  }

  if (missingTag.length > 0) {
    return jsonResponse(400, {
      code: "MISSING_TARGET_TAG",
      error: `target_tag required for: ${missingTag.join(", ")}`,
    });
  }
  if (missingSha.length > 0) {
    return jsonResponse(502, {
      code: "HEAD_SHA_FETCH_FAILED",
      error: `failed to resolve default-branch HEAD sha for: ${missingSha.join(", ")}`,
    });
  }

  const result = (await hubStub(env).start({
    wave_id: waveId,
    flip_policy,
    note,
    repos,
  })) as RpcResult<WaveState>;

  if (!result.ok) {
    const status =
      result.code === "ALREADY_EXISTS"
        ? 409
        : result.code === "WAVE_IN_PROGRESS"
          ? 409
          : 400;
    return jsonResponse(status, { code: result.code, error: result.error });
  }

  return redirectToDetail(waveId);
}
