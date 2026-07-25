#!/usr/bin/env python3
"""Copy the pinned Terminal-Bench subset and disable agent-phase networking."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any


def tree_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        content = path.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def add_no_network(task_toml: Path) -> None:
    content = task_toml.read_text()
    match = re.search(r"(?m)^\[agent\]\s*$", content)
    if not match:
        raise ValueError(f"missing [agent] section: {task_toml}")
    end = re.search(r"(?m)^\[", content[match.end() :])
    section_end = match.end() + (end.start() if end else len(content[match.end() :]))
    section = content[match.end() : section_end]
    if re.search(r"(?m)^network_mode\s*=", section):
        raise ValueError(f"[agent].network_mode already set: {task_toml}")
    content = content[: match.end()] + '\nnetwork_mode = "no-network"' + content[match.end() :]
    task_toml.write_text(content)


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text())
    if config.get("version") != 1 or not isinstance(config.get("sourceRevision"), str):
        raise ValueError(f"invalid subset config: {path}")
    tasks = config.get("tasks")
    if not isinstance(tasks, list) or not tasks or any(not isinstance(task, str) or "/" in task for task in tasks):
        raise ValueError(f"invalid task list: {path}")
    if len(set(tasks)) != len(tasks):
        raise ValueError(f"duplicate task names: {path}")
    return config


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True, help="Pinned terminal-bench-2 checkout")
    parser.add_argument("--target", type=Path, required=True, help="New output directory")
    parser.add_argument(
        "--config",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "benchmarks" / "terminal-bench-2" / "subset.json",
    )
    args = parser.parse_args()
    source = args.source.resolve()
    target = args.target.resolve()
    config = load_config(args.config.resolve())
    revision = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if revision != config["sourceRevision"]:
        raise ValueError(f"source revision mismatch: expected {config['sourceRevision']}, got {revision}")
    status = subprocess.run(
        ["git", "-C", str(source), "status", "--porcelain"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    if status:
        raise ValueError("source checkout is dirty; materialization requires the exact pinned tree")
    if target.exists():
        raise FileExistsError(f"target already exists: {target}")
    target.mkdir(parents=True)

    source_hashes: dict[str, str] = {}
    materialized_hashes: dict[str, str] = {}
    try:
        for task in config["tasks"]:
            source_task = source / task
            if not (source_task / "task.toml").is_file():
                raise FileNotFoundError(f"task not found: {source_task}")
            source_hashes[task] = tree_hash(source_task)
            target_task = target / task
            shutil.copytree(source_task, target_task)
            add_no_network(target_task / "task.toml")
            materialized_hashes[task] = tree_hash(target_task)
        provenance = {
            "version": 1,
            "configSha256": hashlib.sha256(args.config.resolve().read_bytes()).hexdigest(),
            "dataset": config.get("dataset"),
            "harborRevision": config.get("harborRevision"),
            "sourceGit": config.get("sourceGit"),
            "sourceRevision": revision,
            "sourceTaskSha256": source_hashes,
            "materializedTaskSha256": materialized_hashes,
            "trustedModification": "Set [agent].network_mode to no-network; verifier and solution assets unchanged.",
        }
        (target / "PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise
    print(target)


if __name__ == "__main__":
    main()
