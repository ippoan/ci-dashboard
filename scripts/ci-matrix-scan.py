#!/usr/bin/env python3
"""ci-matrix-scan: 全 repo の `.github/workflows/*.yml` を取得して
reusable workflow 採用状況を `data/ci-matrix.json` に書く。

Refs ippoan/ci-dashboard#377.

入力: env `GITHUB_TOKEN` (App installation token), `GITHUB_ORGS` (comma 区切り、
default `ippoan,ohishi-exp,yhonda-ohishi`)。

出力: `data/ci-matrix.json`。
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import yaml  # type: ignore[import-not-found]

GITHUB_API = "https://api.github.com"
USER_AGENT = "ci-dashboard-matrix-scanner"
SCHEMA_VERSION = 1

# ippoan/ci-workflows の reusable 名 → 列カテゴリの mapping。新 reusable が
# 増えたらここに追加する。UI 側 (ci-matrix-page.ts) も対応する column を増やす。
REUSABLE_CATEGORIES: dict[str, str] = {
    "frontend-ci.yml": "frontend-ci",
    "go-ci.yml": "go-ci",
    "lib-ci.yml": "lib-ci",
    "rust-ci.yml": "rust-ci",
    "auto-merge.yml": "auto-merge",
    "secret-verify-gcp.yml": "secret-verify",
    "skills-check.yml": "skills-check",
    "catalog-extract.yml": "cap-catalog-extract",
    "release-wave-handler.yml": "release-wave",
    "cloud-run-deploy.yml": "cloud-run-deploy",
    "lib-publish.yml": "lib-publish",
    "rust-binary-release.yml": "rust-binary-release",
    "tag-release.yml": "tag-release",
    "dev-tag-release.yml": "dev-tag-release",
    "ci-shape-report.yml": "ci-shape-report",
}


def gh_api(path: str, token: str, params: dict[str, str] | None = None) -> object:
    url = GITHUB_API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (403, 429) and attempt < 2:
                reset = e.headers.get("X-RateLimit-Reset")
                wait = max(5, int(reset) - int(time.time())) if reset else 30
                print(
                    f"  rate-limited ({e.code}), sleep {wait}s",
                    file=sys.stderr,
                )
                time.sleep(min(wait, 120))
                continue
            raise
        except urllib.error.URLError:
            if attempt < 2:
                time.sleep(2**attempt)
                continue
            raise
    raise RuntimeError("unreachable")


def list_org_repos(org: str, token: str) -> list[dict[str, object]]:
    repos: list[dict[str, object]] = []
    page = 1
    while True:
        batch = gh_api(
            f"/orgs/{org}/repos",
            token,
            params={"per_page": "100", "page": str(page), "type": "all"},
        )
        if not isinstance(batch, list) or not batch:
            break
        repos.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return [r for r in repos if not r.get("archived")]


def list_workflow_files(owner: str, repo: str, token: str) -> list[dict[str, str]]:
    """Return [{path, download_url}] for .github/workflows/*.yml files."""
    entries = gh_api(
        f"/repos/{owner}/{repo}/contents/.github/workflows",
        token,
    )
    if not isinstance(entries, list):
        return []
    out: list[dict[str, str]] = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        name = e.get("name", "")
        if not (name.endswith(".yml") or name.endswith(".yaml")):
            continue
        path = e.get("path")
        url = e.get("download_url")
        if isinstance(path, str) and isinstance(url, str):
            out.append({"path": path, "download_url": url})
    return out


def fetch_text(url: str, token: str) -> str | None:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None


def parse_triggers(on_block: object) -> list[str]:
    """`on:` を flat な人間可読 string list に潰す。"""
    out: list[str] = []
    if isinstance(on_block, str):
        return [on_block]
    if isinstance(on_block, list):
        return [str(x) for x in on_block]
    if isinstance(on_block, dict):
        for k, v in on_block.items():
            if isinstance(v, dict):
                # push: {branches: [main], tags: [v*]}
                branches = v.get("branches")
                tags = v.get("tags")
                if branches:
                    for b in branches if isinstance(branches, list) else [branches]:
                        out.append(f"{k}:branch({b})")
                if tags:
                    for t in tags if isinstance(tags, list) else [tags]:
                        out.append(f"{k}:tag({t})")
                if not branches and not tags:
                    out.append(k)
            elif isinstance(v, list):
                out.append(f"{k}:{','.join(str(x) for x in v)}")
            else:
                out.append(k)
    return out


def parse_permissions(perms_block: object) -> dict[str, str]:
    if perms_block is None:
        return {}
    if isinstance(perms_block, str):
        # `permissions: read-all` 等
        return {"_all": perms_block}
    if isinstance(perms_block, dict):
        return {str(k): str(v) for k, v in perms_block.items()}
    return {}


def parse_uses(uses: str) -> dict[str, str] | None:
    """`ippoan/ci-workflows/.github/workflows/frontend-ci.yml@main` を分解。
    `./.github/workflows/foo.yml` のような local reusable は対象外として None。
    """
    if not isinstance(uses, str) or "@" not in uses or uses.startswith("./"):
        return None
    target, ref = uses.rsplit("@", 1)
    parts = target.split("/")
    # owner/repo/.github/workflows/<name>.yml
    if len(parts) < 5 or parts[2] != ".github" or parts[3] != "workflows":
        return None
    owner = parts[0]
    repo = parts[1]
    file = "/".join(parts[2:])
    name = parts[-1]
    return {
        "owner": owner,
        "repo": repo,
        "file": file,
        "ref": ref,
        "reusable_name": name,
    }


def is_pinned_sha(ref: str) -> bool:
    """40-char hex = full SHA pin。`v1` / `main` 等は untrusted/mutable。"""
    if len(ref) != 40:
        return False
    try:
        int(ref, 16)
        return True
    except ValueError:
        return False


def analyze_workflow_yaml(yaml_text: str, file_path: str) -> dict[str, object] | None:
    try:
        doc = yaml.safe_load(yaml_text)
    except yaml.YAMLError as e:
        return {
            "file": file_path,
            "parse_error": str(e)[:200],
        }
    if not isinstance(doc, dict):
        return None
    name = doc.get("name") if isinstance(doc.get("name"), str) else None
    # YAML quirk: bare `on:` parses as boolean True. handle both.
    on_block = doc.get("on")
    if on_block is None and True in doc:
        on_block = doc[True]
    triggers = parse_triggers(on_block)
    top_perms = parse_permissions(doc.get("permissions"))

    jobs = doc.get("jobs") if isinstance(doc.get("jobs"), dict) else {}
    reusable_calls: list[dict[str, object]] = []
    self_jobs: list[str] = []
    job_perms_union: set[str] = set()
    for job_id, job in jobs.items():
        if not isinstance(job, dict):
            continue
        uses = job.get("uses")
        if isinstance(uses, str):
            parsed = parse_uses(uses)
            if parsed is not None:
                # `secrets: inherit` 検出
                secrets = job.get("secrets")
                secrets_inherit = secrets == "inherit"
                reusable_calls.append(
                    {
                        "job_id": str(job_id),
                        "target_owner": parsed["owner"],
                        "target_repo": parsed["repo"],
                        "target_file": parsed["file"],
                        "reusable_name": parsed["reusable_name"],
                        "ref": parsed["ref"],
                        "pinned_sha": is_pinned_sha(parsed["ref"]),
                        "secrets_inherit": bool(secrets_inherit),
                    }
                )
                continue
        self_jobs.append(str(job_id))
        job_perms = parse_permissions(job.get("permissions"))
        job_perms_union.update(job_perms.keys())

    return {
        "file": file_path,
        "name": name,
        "triggers": triggers,
        "permissions": top_perms,
        "job_permissions_union": sorted(job_perms_union),
        "reusable_calls": reusable_calls,
        "self_jobs": self_jobs,
    }


def detect_deviations(workflow: dict[str, object]) -> list[str]:
    """逸脱フラグ判定。silent trap (= startup_failure になりやすい) を loud に。"""
    flags: list[str] = []
    if "parse_error" in workflow:
        flags.append("yaml-parse-error")
        return flags
    reusable_calls = workflow.get("reusable_calls", [])
    if not isinstance(reusable_calls, list):
        return flags
    has_secret_verify_caller = False
    has_cross_org_inherit = False
    top_perms = workflow.get("permissions") if isinstance(workflow.get("permissions"), dict) else {}
    job_perms_union = workflow.get("job_permissions_union") or []
    declared_perms: set[str] = set()
    if isinstance(top_perms, dict):
        declared_perms.update(top_perms.keys())
    if isinstance(job_perms_union, list):
        declared_perms.update(job_perms_union)

    for call in reusable_calls:
        if not isinstance(call, dict):
            continue
        # @main / @v1 / mutable ref を pinned_sha=False で検出
        if call.get("pinned_sha") is False:
            ref = str(call.get("ref", ""))
            if ref == "main" or ref == "master":
                flags.append("unpinned-ref-main")
            elif ref:
                flags.append(f"unpinned-ref:{ref}")
        # frontend-ci.yml / go-ci.yml / lib-ci.yml は secret-verify 内蔵 →
        # caller に id-token: write が要る (silent trap = startup_failure)。
        name = call.get("reusable_name")
        if name in {"frontend-ci.yml", "go-ci.yml", "lib-ci.yml"}:
            has_secret_verify_caller = True
        # auto-merge.yml の cross-org caller + secrets: inherit は無音 401。
        if name == "auto-merge.yml" and call.get("secrets_inherit"):
            has_cross_org_inherit = True

    if has_secret_verify_caller and "id-token" not in declared_perms:
        flags.append("missing-id-token-write")
    if has_cross_org_inherit:
        # 注: ippoan-internal caller では問題ない。scanner では「可能性あり」と
        # して flag だけ立て、UI 側で owner=ippoan は warning から除外する。
        flags.append("auto-merge-secrets-inherit")

    return flags


def main() -> int:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("GITHUB_TOKEN is required", file=sys.stderr)
        return 2
    orgs_env = os.environ.get("GITHUB_ORGS", "ippoan,ohishi-exp,yhonda-ohishi")
    orgs = [o.strip() for o in orgs_env.split(",") if o.strip()]

    all_repos: list[dict[str, object]] = []
    for org in orgs:
        print(f"[org] {org}", file=sys.stderr)
        try:
            repos = list_org_repos(org, token)
        except Exception as e:  # noqa: BLE001
            print(f"  list_org_repos failed: {e}", file=sys.stderr)
            continue
        print(f"  -> {len(repos)} non-archived repos", file=sys.stderr)
        for r in repos:
            all_repos.append({"owner": org, "repo": r.get("name"), "default_branch": r.get("default_branch")})

    out_repos: list[dict[str, object]] = []
    for entry in all_repos:
        owner = str(entry["owner"])
        repo = str(entry["repo"])
        print(f"[repo] {owner}/{repo}", file=sys.stderr)
        try:
            files = list_workflow_files(owner, repo, token)
        except Exception as e:  # noqa: BLE001
            print(f"  list_workflow_files failed: {e}", file=sys.stderr)
            out_repos.append(
                {
                    "owner": owner,
                    "repo": repo,
                    "scanned_at": datetime.now(timezone.utc).isoformat(),
                    "error": str(e)[:200],
                    "workflows": [],
                }
            )
            continue

        workflows: list[dict[str, object]] = []
        for f in files:
            text = fetch_text(f["download_url"], token)
            if text is None:
                workflows.append({"file": f["path"], "fetch_error": True})
                continue
            analyzed = analyze_workflow_yaml(text, f["path"])
            if analyzed is None:
                continue
            analyzed["deviations"] = detect_deviations(analyzed)
            workflows.append(analyzed)

        # repo 単位の集約。
        reusable_caller_count = 0
        deviation_flag_union: set[str] = set()
        used_reusables: set[str] = set()
        for w in workflows:
            if not isinstance(w, dict):
                continue
            calls = w.get("reusable_calls")
            if isinstance(calls, list) and calls:
                reusable_caller_count += 1
                for c in calls:
                    if isinstance(c, dict):
                        name = c.get("reusable_name")
                        cat = REUSABLE_CATEGORIES.get(str(name)) if name else None
                        if cat:
                            used_reusables.add(cat)
            devs = w.get("deviations")
            if isinstance(devs, list):
                deviation_flag_union.update(str(d) for d in devs)

        out_repos.append(
            {
                "owner": owner,
                "repo": repo,
                "scanned_at": datetime.now(timezone.utc).isoformat(),
                "workflows": workflows,
                "summary": {
                    "total_workflows": len(workflows),
                    "reusable_caller_workflows": reusable_caller_count,
                    "used_reusable_categories": sorted(used_reusables),
                    "deviation_flags": sorted(deviation_flag_union),
                },
            }
        )

    payload = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scan_source": "scheduled",
        "orgs": orgs,
        "reusable_categories": REUSABLE_CATEGORIES,
        "repos": out_repos,
    }
    os.makedirs("data", exist_ok=True)
    with open("data/ci-matrix.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False, sort_keys=False)
        f.write("\n")
    print(
        f"wrote data/ci-matrix.json ({len(out_repos)} repos)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
