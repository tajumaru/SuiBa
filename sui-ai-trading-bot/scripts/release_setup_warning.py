#!/usr/bin/env python3
"""Warn when a release changes files installed by the host setup scripts."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = APP_ROOT.parent
PAPER_SETUP = APP_ROOT / "deploy/paper-check/setup-paper-check.sh"
APPROVAL_SETUP = APP_ROOT / "deploy/broker/setup-ci-approval.sh"
APP_PREFIX = f"{APP_ROOT.name}/"


def pinned_paths() -> set[str]:
    """Return repository paths named by the setup scripts' pin tables."""
    paths: set[str] = set()
    paper = PAPER_SETUP.read_text()
    files_block = paper.split("FILES=(", 1)[1].split("\n)", 1)[0]
    for name in re.findall(r"^\s*'([^|']+)\|[0-9a-f]{64}\|", files_block, re.MULTILINE):
        paths.add(f"{APP_PREFIX}deploy/paper-check/{name}")

    approval = APPROVAL_SETUP.read_text()
    approval_urls = re.findall(
        r"^([A-Z_]+)_URL='[^']+/sui-ai-trading-bot/([^']+)'", approval, re.MULTILINE
    )
    for pin_name, url in approval_urls:
        if re.search(rf"^{pin_name}_SHA256='[0-9a-f]{{64}}'$", approval, re.MULTILINE):
            paths.add(f"{APP_PREFIX}{url}")
    return paths


def previous_successful_sha() -> str | None:
    """Read the newest successful release workflow head SHA from GitHub."""
    repository = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GITHUB_TOKEN")
    if not repository or not token:
        return None
    url = (
        f"https://api.github.com/repos/{repository}/actions/workflows/"
        "suiba-release.yml/runs?branch=main&status=success&per_page=1"
    )
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        runs = json.load(response).get("workflow_runs", [])
    sha = runs[0].get("head_sha") if runs else None
    return sha if isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) else None


def changed_paths(baseline: str) -> set[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=ACMRT", f"{baseline}...HEAD"],
        cwd=REPO_ROOT,
        check=True,
        text=True,
        capture_output=True,
    )
    return {line for line in result.stdout.splitlines() if line}


def warning_text(matches: set[str]) -> str:
    names = ", ".join(sorted(matches))
    return (
        f"ホスト配布ファイルが変更されています: {names}。このリリースの後、"
        "STOP→setup→START の短い窓がもう1回必要です。"
    )


def emit_warning(matches: set[str], summary_path: str | None) -> None:
    if not matches:
        return
    message = warning_text(matches)
    print(f"::warning title=ホスト setup が必要です::{message}")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write("## ⚠️ ホスト setup が必要です\n\n")
            summary.write(f"{message}\n\n")
            summary.write("変更された配布ファイル:\n")
            for path in sorted(matches):
                summary.write(f"- `{path}`\n")


def main() -> int:
    # This check is advisory by design: any unavailable API, git history, or
    # unexpected pin format silently skips the warning and never blocks release.
    try:
        baseline = previous_successful_sha()
        if baseline is None:
            return 0
        matches = changed_paths(baseline) & pinned_paths()
        emit_warning(matches, os.environ.get("GITHUB_STEP_SUMMARY"))
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
