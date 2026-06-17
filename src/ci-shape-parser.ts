// `ci-workflows/scripts/ci-shape-report.py` の TS port (Refs #402)。
// ci-shape-report.yml caller の workflow_run でしか KV が更新されないため、
// `push:main` を抜いた repo の shape が古いまま残る問題に対する fallback:
// scheduled refresh が repo の `.github/workflows/*.yml` を直接 fetch して
// このパーサで shape を生成 → KV upsert する。
//
// Python 版 (ci-shape-report.py) と同じ output 形状を維持する
// (= `ci-shape-webhook.ts` の `CI_SHAPE_BODY_SCHEMA` を満たす)。
//
// YAML parser として `yaml` package (peer-free、Worker runtime OK) を使う。

import { parse as parseYaml } from "yaml";
import type { CiShapePayload } from "./ci-shape-webhook";

export interface AnalyzedWorkflow {
  file: string;
  name?: string | null;
  triggers?: string[];
  permissions?: Record<string, string>;
  job_permissions_union?: string[];
  reusable_calls?: ReusableCall[];
  self_jobs?: string[];
  deviations?: string[];
  parse_error?: string;
  fetch_error?: boolean;
}

export interface ReusableCall {
  job_id: string;
  target_owner: string;
  target_repo: string;
  target_file: string;
  reusable_name: string;
  ref: string;
  pinned_sha: boolean;
  secrets_inherit: boolean;
}

/** `on:` block を flat な人間可読 string list に潰す。 */
export function parseTriggers(onBlock: unknown): string[] {
  if (onBlock === undefined || onBlock === null) return [];
  if (typeof onBlock === "string") return [onBlock];
  if (Array.isArray(onBlock)) return onBlock.map((x) => String(x));
  if (typeof onBlock === "object") {
    const out: string[] = [];
    for (const [k, v] of Object.entries(onBlock as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        const branches = obj.branches;
        const tags = obj.tags;
        let added = false;
        if (branches !== undefined && branches !== null) {
          const list = Array.isArray(branches) ? branches : [branches];
          for (const b of list) out.push(`${k}:branch(${String(b)})`);
          added = true;
        }
        if (tags !== undefined && tags !== null) {
          const list = Array.isArray(tags) ? tags : [tags];
          for (const t of list) out.push(`${k}:tag(${String(t)})`);
          added = true;
        }
        if (!added) out.push(String(k));
      } else if (Array.isArray(v)) {
        out.push(`${k}:${v.map(String).join(",")}`);
      } else {
        out.push(String(k));
      }
    }
    return out;
  }
  return [];
}

/** `permissions:` を `Record<string, string>` に正規化。 */
export function parsePermissions(permsBlock: unknown): Record<string, string> {
  if (permsBlock === undefined || permsBlock === null) return {};
  if (typeof permsBlock === "string") return { _all: permsBlock };
  if (typeof permsBlock === "object" && !Array.isArray(permsBlock)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(permsBlock as Record<string, unknown>)) {
      out[String(k)] = String(v);
    }
    return out;
  }
  return {};
}

/** `ippoan/ci-workflows/.github/workflows/frontend-ci.yml@main` を分解。
 *  `./.github/workflows/foo.yml` (local reusable) は対象外として null。 */
export function parseUses(uses: unknown): {
  owner: string;
  repo: string;
  file: string;
  ref: string;
  reusable_name: string;
} | null {
  if (typeof uses !== "string" || !uses.includes("@") || uses.startsWith("./")) {
    return null;
  }
  const atIdx = uses.lastIndexOf("@");
  const target = uses.slice(0, atIdx);
  const ref = uses.slice(atIdx + 1);
  const parts = target.split("/");
  if (parts.length < 5 || parts[2] !== ".github" || parts[3] !== "workflows") {
    return null;
  }
  const owner = parts[0];
  const repo = parts[1];
  const reusableName = parts[parts.length - 1];
  if (owner === undefined || repo === undefined || reusableName === undefined) {
    return null;
  }
  return {
    owner,
    repo,
    file: parts.slice(2).join("/"),
    ref,
    reusable_name: reusableName,
  };
}

/** 40-char hex = full SHA pin。`v1` / `main` 等は untrusted/mutable。 */
export function isPinnedSha(ref: string): boolean {
  if (ref.length !== 40) return false;
  return /^[0-9a-fA-F]{40}$/.test(ref);
}

/** silent trap を loud にする逸脱フラグ。`ci-shape-report.py::detect_deviations` と同等。 */
export function detectDeviations(workflow: AnalyzedWorkflow): string[] {
  if (workflow.parse_error) {
    return workflow.deviations ?? [];
  }
  const calls = workflow.reusable_calls ?? [];
  const declaredPerms = new Set<string>();
  for (const k of Object.keys(workflow.permissions ?? {})) declaredPerms.add(k);
  for (const k of workflow.job_permissions_union ?? []) declaredPerms.add(k);

  let hasSecretVerifyCaller = false;
  let hasCrossOrgInherit = false;
  const flags: string[] = [];

  for (const call of calls) {
    if (!call.pinned_sha) {
      const ref = call.ref;
      if (ref === "main" || ref === "master") {
        flags.push("unpinned-ref-main");
      } else if (ref) {
        flags.push(`unpinned-ref:${ref}`);
      }
    }
    const name = call.reusable_name;
    if (name === "frontend-ci.yml" || name === "go-ci.yml" || name === "lib-ci.yml") {
      hasSecretVerifyCaller = true;
    }
    if (name === "auto-merge.yml" && call.secrets_inherit) {
      hasCrossOrgInherit = true;
    }
  }

  if (hasSecretVerifyCaller && !declaredPerms.has("id-token")) {
    flags.push("missing-id-token-write");
  }
  if (hasCrossOrgInherit) {
    flags.push("auto-merge-secrets-inherit");
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const f of flags) {
    if (!seen.has(f)) {
      seen.add(f);
      deduped.push(f);
    }
  }
  return deduped;
}

/** 1 workflow yaml を analyze。parse 失敗時は `parse_error` 付き entry を返す。 */
export function analyzeWorkflowYaml(yamlText: string, filePath: string): AnalyzedWorkflow | null {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (e) {
    return {
      file: filePath,
      parse_error: String(e instanceof Error ? e.message : e).slice(0, 200),
      deviations: ["yaml-parse-error"],
    };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return null;
  }
  const docObj = doc as Record<string, unknown>;
  const name = typeof docObj.name === "string" ? docObj.name : null;

  // YAML quirk: bare `on:` parses as boolean true。`yaml` package では `true` キーで入る。
  let onBlock: unknown = docObj.on;
  if (onBlock === undefined) {
    const asUnknownMap = docObj as unknown as Map<unknown, unknown> | Record<string, unknown>;
    if (asUnknownMap instanceof Map && asUnknownMap.has(true)) {
      onBlock = asUnknownMap.get(true);
    } else if ("true" in docObj) {
      onBlock = (docObj as Record<string, unknown>)["true"];
    }
  }
  const triggers = parseTriggers(onBlock);
  const topPerms = parsePermissions(docObj.permissions);

  const jobsRaw = docObj.jobs;
  const jobs =
    jobsRaw && typeof jobsRaw === "object" && !Array.isArray(jobsRaw)
      ? (jobsRaw as Record<string, unknown>)
      : {};

  const reusableCalls: ReusableCall[] = [];
  const selfJobs: string[] = [];
  const jobPermsUnion = new Set<string>();

  for (const [jobId, jobVal] of Object.entries(jobs)) {
    if (!jobVal || typeof jobVal !== "object" || Array.isArray(jobVal)) continue;
    const job = jobVal as Record<string, unknown>;
    const uses = job.uses;
    if (typeof uses === "string") {
      const parsed = parseUses(uses);
      if (parsed !== null) {
        const secrets = job.secrets;
        reusableCalls.push({
          job_id: String(jobId),
          target_owner: parsed.owner,
          target_repo: parsed.repo,
          target_file: parsed.file,
          reusable_name: parsed.reusable_name,
          ref: parsed.ref,
          pinned_sha: isPinnedSha(parsed.ref),
          secrets_inherit: secrets === "inherit",
        });
        continue;
      }
    }
    selfJobs.push(String(jobId));
    const jobPerms = parsePermissions(job.permissions);
    for (const k of Object.keys(jobPerms)) jobPermsUnion.add(k);
  }

  return {
    file: filePath,
    name,
    triggers,
    permissions: topPerms,
    job_permissions_union: [...jobPermsUnion].sort(),
    reusable_calls: reusableCalls,
    self_jobs: selfJobs,
  };
}

/** `ci-shape-report.py::build_payload` の TS 版。
 *  `files` は GitHub API で取った `{ path, content }` のリスト
 *  (`.github/workflows/*.yml` / `*.yaml` の全件)。 */
export function buildShapePayload(
  owner: string,
  repo: string,
  headSha: string | undefined,
  files: { path: string; content: string }[],
  scannedAt: string,
): CiShapePayload {
  const workflows: AnalyzedWorkflow[] = [];
  // path 順 (= ci-shape-report.py の sorted glob と同じ stable order)
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const analyzed = analyzeWorkflowYaml(f.content, f.path);
    if (analyzed === null) continue;
    analyzed.deviations = detectDeviations(analyzed);
    workflows.push(analyzed);
  }
  return {
    schema_version: 1,
    owner,
    repo,
    head_sha: headSha ? headSha.slice(0, 40) : undefined,
    scanned_at: scannedAt,
    workflows,
  };
}
