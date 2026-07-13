# plan: Tag Release all + Auto Flip (armed 機構)

Refs #476 / #137 / #237

`/release-wave` に「全 repo を tag release し、対象 repo の release が全部完了したら
自動的に flip する」機能を足す。既存の「⚡ Tag Release all」(dispatch のみ) と
「⚡ Flip all」(`pendingFlipAllCore`) は分離しており、両者を繋ぐ完了検知 +
自動発火が無かった。

## 用語

- **armed**: 「Tag Release all + Auto Flip」ボタンで登録された「対象 repo 集合 +
  期限」の状態。KV `auto-flip-arm::latest` に最新 1 件だけ保持する。
- **完了検知**: 各 repo の release deploy が no-traffic upload 後に叩く
  `POST /webhooks/release-wave/pending-release` の到達。これが `pending-release::`
  (workers は `traffic::`) に載る = その repo の release 完了。
- **auto flip**: armed set の全 repo が pending に揃い、compat gate を通過した時に
  ci-dashboard worker が発火する `pendingFlipAllCore` (armed set 限定)。

## データモデル

`src/release-wave/auto-flip.ts`:

```ts
interface AutoFlipArmRecord {
  schema_version: 1;
  repos: string[];        // arm 時に needsRelease だった repo (owner/name)
  armed_at: string;       // UTC ISO
  expires_at: string;     // UTC ISO (armed_at + ttl)
  actor: string;          // audit
  status: "armed" | "blocked";
  blocked_reason: string | null; // status=blocked のときの理由
}
```

KV key は単一 `auto-flip-arm::latest` (直近の 1 orchestration のみ)。
`kv.put(..., { expirationTtl: 1800 })` で 30 分 TTL。TTL 消滅 =「全部揃わなかった
のでタイムアウト中断」を KV 自体で表現する (DO alarm / cron 不要)。
KV TTL のラグに備え `expires_at` を record にも持ち、webhook 到達時に超過を
検知したら明示 clear する (テスト容易性も兼ねる — in-memory KV は TTL を持たない)。

## 完了判定

`computeArmProgress(env, arm)`:

- `loadUnifiedPending(env)` (既存) で「今 flip 待ちの tag 付き version 一覧」を得る。
- armed set の各 repo について、pending に tag 付きエントリが 1 つ以上あれば
  「その repo は release 完了」とみなす (monorepo は unit が別でも repo 単位で満了)。
- `released` / `total` / `ready = released === total` を返す。

## 自動発火

`maybeAutoFlip(env, now)` を `handlePendingReleaseWebhook` の record 保存後に
best-effort (try/catch) で呼ぶ:

1. `getAutoFlipArm(env)` → 無ければ return。
2. `now > expires_at` なら `clearAutoFlipArm` して return (タイムアウト中断)。
3. status が既に `blocked` なら return (operator の手動対応待ち)。
4. `computeArmProgress` → `ready` でなければ return (次の webhook を待つ)。
5. compat gate: `computeGlobalCompatibility(env.COMPAT_KV)` が
   `checked && !verified` なら record を `status:"blocked"` + 理由付きで更新し
   return (自動 flip しない)。`checked=false` (誰も互換性 test していない) は
   既存 approve gate と同じく素通し。
6. gate OK → `pendingFlipAllCore(env, actor, new Set(arm.repos))` で armed set
   限定 flip → `clearAutoFlipArm`。

## `pendingFlipAllCore` の repo filter

既存 `pendingFlipAllCore(env, actor)` に optional 第 3 引数
`filterRepos?: ReadonlySet<string>` を足す。渡されたら
`unified.filter((u) => filterRepos.has(u.repo))` で armed set に限定する。
未指定は従来どおり全件 (既存 UI / MCP の挙動を壊さない)。

## arm / disarm

- `POST /api/release-wave/auto-flip/arm` (form field `repos` カンマ区切り):
  1. `repos` の各 `tag-release.yml` を `dispatchTagRelease` で逐次 dispatch
     (= 既存 `tag-release-all` 相当)。
  2. `armAutoFlip(env, repos, actor, now)` で armed record を登録。
  3. 303 で `/release-wave` へ redirect。
- `POST /api/release-wave/auto-flip/disarm`: `clearAutoFlipArm` して 303。

## UI (`renderRepoReleaseStatusSection`)

- 要リリース repo が 1 件以上のとき「⚡ Tag Release all + Auto Flip (N)」ボタンを
  出す (form → arm、confirm 付き)。hidden `repos` に needsRelease な repo 集合。
  1 件でも「tag release → 完了待ち → 自動 flip」で手動 Flip のクリック待ちを省ける。
- armed record があれば summary 下に帯を出す:
  - `armed`: 「Auto-flip armed: M/N released · expires HH:MM」+ Disarm ボタン。
  - `blocked`: 理由 + Disarm ボタン (自動 flip は止まっている)。

## timeout の考え方

- 正常: 全 repo が期限内に揃う → 自動 flip → armed clear。
- 一部が失敗 / 遅延: 期限までに揃わず TTL で armed 消滅 → 自動 flip されない。
  operator は「Repo リリース状況」で残りを確認して手動対応する。
- compat 非互換: `blocked` で自動 flip は止め、operator が手動判断
  (手動 Flip all / 個別 flip / disarm)。

## follow-up (本 PR 外)

- MCP tool (`release_wave_auto_flip_arm` / `_status` / `_disarm`) — webhook と機能
  等価にする org 方針に沿って後続で足す。
- armed 状態変化の live reload broadcast — 現状は flip 後の traffic-report 到達で
  既存 live reload に相乗りする (armed 帯の即時更新は将来対応)。
