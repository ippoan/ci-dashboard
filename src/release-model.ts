/**
 * repo の「リリースモデル」自動判定。
 *
 * 「Repo リリース状況」section が repo を tagless 扱い (= 一覧・Tag Release
 * ボタンから除外) するかどうかを、**手書きの TAGLESS_REPOS リストではなく repo
 * の現行 config から自動導出**するのを基本方針とする。手書きリストは tag 駆動 /
 * merge 駆動を混同して drift する footgun だったため (nuxt-notify の tagless
 * 誤登録 / seikyu の未登録が発端)。
 *
 * 判定シグナル (いずれも **current config** = 後から変更可能。タグ実績のような
 * 履歴依存の不可逆シグナルは使わない):
 *   - **wave**: `.github/workflows/release-wave.yml` が存在する
 *               = Release Wave 参加 (v* タグ → no-traffic upload → flip の tag 駆動 deploy)
 *   - **npm** : publish 可能な `package.json` がある (`name` 有り & `private !== true`)
 *               = npm lib (v* タグ → publish の tag 駆動)
 *
 * tagless = wave も npm も無い = タグを切らない repo。これには
 * **staging=prod (single-env, PR merge → prod deploy) の merge 駆動 service**
 * と純 infra/config repo が含まれる (どちらも wave/npm 無し)。
 *
 * ただし `TAGLESS_REPOS` var による **手動 override** は例外的に残す
 * (`isTaglessRepo` 参照)。「npm あり = 自前の `tag-release.yml` で self-service
 * stable tag を切れる」という auto-detect の前提が崩れる repo (dev tag しか
 * 自動採番しない等) の逃げ道。
 *
 * GitHub contents 呼び出しは release-cache と同じ KV キャッシュ層 (1h TTL) に
 * 載せるので、config 変更 (wave/npm の追加・削除) は最大 1h で反映される。
 */

import type { Env } from "./index";
import { GitHubApiError, githubApi, parseRepo, tokenForOrg } from "./github-api";
import { parseTaglessRepos } from "./tagless-repos";

const PREFIX = "rcache:v1:relmodel:";
// 1h。release-wave.yml / package.json の追加・削除 (= モデル変更) の反映 lag 上限。
const TTL_RELEASE_MODEL = 3600;

export interface ReleaseModel {
  /** release-wave.yml を持つ (Release Wave = tag 駆動 deploy)。 */
  wave: boolean;
  /** publish 可能な npm package (name 有り & private でない = tag 駆動 publish)。 */
  npm: boolean;
}

/** tagless = タグを切らない (wave も npm publish も無い) repo。 */
export function isTagless(model: ReleaseModel): boolean {
  return !model.wave && !model.npm;
}

/** release-cache.kvCached と同じ最小ラッパー (循環 import を避けるため再掲)。 */
async function kvCached<T>(
  kv: KVNamespace | undefined,
  key: string,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (!kv) return loader();
  const cached = await kv.get<T>(key, "json");
  if (cached !== null && cached !== undefined) return cached;
  const fresh = await loader();
  await kv.put(key, JSON.stringify(fresh), { expirationTtl: ttlSec });
  return fresh;
}

/** repo に指定 path の file が存在するか (GitHub contents、404 = 不在)。 */
async function fileExists(
  token: string,
  owner: string,
  name: string,
  path: string,
): Promise<boolean> {
  try {
    await githubApi(token, "GET", `/repos/${owner}/${name}/contents/${path}`);
    return true;
  } catch (e) {
    if (e instanceof GitHubApiError && e.status === 404) return false;
    throw e;
  }
}

/** base64 (GitHub contents の encoding) を UTF-8 文字列へ。 */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** root `package.json` が publish 可能な npm package か (`name` 有り & private でない)。 */
async function isNpmPackage(
  token: string,
  owner: string,
  name: string,
): Promise<boolean> {
  try {
    const res = await githubApi<{ content?: string }>(
      token,
      "GET",
      `/repos/${owner}/${name}/contents/package.json`,
    );
    if (!res?.content) return false;
    const pkg = JSON.parse(decodeBase64Utf8(res.content)) as {
      name?: unknown;
      private?: unknown;
    };
    return typeof pkg.name === "string" && pkg.name.length > 0 && pkg.private !== true;
  } catch (e) {
    if (e instanceof GitHubApiError && e.status === 404) return false;
    return false; // parse error 等は「npm でない」に倒す
  }
}

/**
 * token を与えて repo の release model を GitHub config から判定する
 * (キャッシュ無し)。token 取得と分離してあるので fetch stub で単体テストできる
 * (release-cache のテストと同方式 — module mock 不要)。
 */
export async function detectReleaseModel(
  token: string,
  owner: string,
  name: string,
): Promise<ReleaseModel> {
  const [wave, npm] = await Promise.all([
    fileExists(token, owner, name, ".github/workflows/release-wave.yml"),
    isNpmPackage(token, owner, name),
  ]);
  return { wave, npm };
}

/** repo の release model (1h KV キャッシュ)。token は loader 内で org 別に解決。 */
export async function getReleaseModel(
  env: Env,
  kv: KVNamespace | undefined,
  repo: string,
): Promise<ReleaseModel> {
  const { owner, repo: name } = parseRepo(repo);
  return kvCached(kv, `${PREFIX}${repo}`, TTL_RELEASE_MODEL, async () => {
    const token = await tokenForOrg(env, owner);
    return detectReleaseModel(token, owner, name);
  });
}

/**
 * repo が tagless か。判定不能 (token 取得失敗 / GitHub error) のときは
 * **false (= tracked 側、一覧に出す)** に倒す — repo を黙って隠さない。
 *
 * `TAGLESS_REPOS` wrangler var に repo が明示列挙されていれば、config 自動判定
 * より優先して tagless 扱いにする (manual override)。auto-detect (wave/npm) は
 * 「npm publish 可能な package.json がある = 自前の `tag-release.yml` で
 * self-service に stable tag を切れる」という前提に立つが、この前提が崩れる
 * repo (例: `ippoan/mcp-cf-workers` — dev-release.yml が `dev-*` prerelease tag
 * を自動採番するだけで、stable `v*` tag を dispatch する `tag-release.yml` 自体は
 * 存在しない) では npm:true と誤検出され、Release Wave の「Tag Release」ボタンが
 * 存在しない workflow を dispatch しようとして GitHub API 404 になる
 * (Refs ippoan/mcp-cf-workers, ippoan/ci-dashboard の tag-release 404 事故)。
 * こうした config-signal だけでは判定しきれない例外の逃げ道として、手書き
 * override を残す。
 */
export async function isTaglessRepo(
  env: Env,
  kv: KVNamespace | undefined,
  repo: string,
): Promise<boolean> {
  if (parseTaglessRepos(env.TAGLESS_REPOS).has(repo)) return true;
  try {
    return isTagless(await getReleaseModel(env, kv, repo));
  } catch {
    return false;
  }
}
