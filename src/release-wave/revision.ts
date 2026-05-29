/**
 * Cloud Run revision name から service 名を導出するヘルパ。
 *
 * Cloud Run の revision name は `<service>-NNNNN-<suffix>` 形式
 * (例 `rust-alc-api-00042-abc`)。ci-dashboard は backend repo の current_image
 * (= revision name) しか持たず service 名を別途持たないため、backend rollback の
 * dispatch で `rollback_target[<service>] = <revision>` map を作るのに revision
 * から service 名を逆算する。Refs ippoan/ci-dashboard#197。
 */

/** `<service>-NNNNN-<suffix>` の suffix を剥がす正規表現。 */
const REVISION_RE = /^(.+)-\d{5}-[a-z0-9]+$/;

/**
 * revision name から service 名を返す。形式に合わなければ null
 * (= handler 側で rollback_revision の単一値 fallback に委ねる)。
 */
export function serviceNameFromRevision(revision: string): string | null {
  const m = REVISION_RE.exec(revision.trim());
  return m ? m[1]! : null;
}
