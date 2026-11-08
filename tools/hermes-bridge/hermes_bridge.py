#!/usr/bin/env python3
"""hermes-bridge - data + control layer for OpenBot's Hermes panels.

Reads come from the files Hermes actually keeps (cron/jobs.json, the skill bank, config.yaml).
Writes go through the `hermes` CLI and are verified by re-reading the store afterwards.
No dashboard cookies, no scraping of tables.

Commands (all print JSON):
  skills list|show|content|write|enable|disable
  cron list|get|create|pause|resume|run|cancel|remove
  models list
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

HERMES = shutil.which("hermes") or str(Path.home() / ".local/bin/hermes")
DEFAULT_HOME = Path.home() / ".hermes"
SKIP_DIRS = {".archive", "__pycache__", "node_modules"}
MAX_SKILL_DEPTH = 5


PROFILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def default_home():
    configured = os.environ.get("HERMES_HOME", "").strip()
    return Path(configured) if configured else DEFAULT_HOME


def home_for(profile):
    if not profile or profile == "default":
        return default_home()
    profile = profile.lower()
    if not PROFILE_NAME.match(profile) or profile in (".", ".."):
        fail("invalid profile name %r" % profile)
    return default_home() / "profiles" / profile


def run(args, profile, timeout=180):
    cmd = [HERMES]
    if profile and profile != "default":
        cmd += ["-p", profile]
    return subprocess.run(cmd + args, capture_output=True, text=True, timeout=timeout)


def fail(message, code=1) -> "NoReturn":
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def ok(**payload):
    print(json.dumps({"ok": True, **payload}, indent=1, default=str))


def load_config(home):
    path = home / "config.yaml"
    if not path.is_file():
        return {}
    try:
        import yaml
        return yaml.safe_load(path.read_text()) or {}
    except Exception:
        return {}


def disabled_skills(home):
    cfg = load_config(home)
    return {str(v) for v in ((cfg.get("skills") or {}).get("disabled") or [])}


def skill_dirs(home):
    found = {}
    roots = [home / "skills"]
    for extra in (load_config(home).get("skills") or {}).get("external_dirs") or []:
        roots.append(Path(extra).expanduser())
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("SKILL.md")):
            directory = path.parent
            if any(part.startswith(".") or part in SKIP_DIRS for part in directory.relative_to(root).parts):
                continue
            if len(directory.relative_to(root).parts) > MAX_SKILL_DEPTH:
                continue
            found.setdefault(directory.name, directory)
    return found


def frontmatter(path):
    text = path.read_text(errors="replace")[:4000]
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out = {}
    for line in text[3:end].splitlines():
        if ":" in line and not line.startswith((" ", "\t", "#")):
            key, _, value = line.partition(":")
            out[key.strip()] = value.strip().strip("\"'")
    return out


def cmd_skills(args, profile):
    home = home_for(profile)
    dirs = skill_dirs(home)
    disabled = disabled_skills(home)

    if args.action == "list":
        items = []
        for name, path in sorted(dirs.items()):
            meta = frontmatter(path / "SKILL.md")
            real = meta.get("name") or name
            items.append({"name": real, "dir": str(path),
                          "description": meta.get("description", ""),
                          "enabled": real not in disabled})
        return ok(count=len(items), skills=items, profile=profile or "default")

    if args.action in ("show", "content"):
        path = dirs.get(args.name)
        if path is None:
            return fail("no skill named %r" % args.name)
        meta = frontmatter(path / "SKILL.md")
        if args.action == "show":
            return ok(name=meta.get("name") or args.name, dir=str(path),
                      description=meta.get("description", ""),
                      bytes=(path / "SKILL.md").stat().st_size,
                      enabled=(meta.get("name") or args.name) not in disabled,
                      files=sorted(p.name for p in path.iterdir()))
        return ok(name=args.name, content=(path / "SKILL.md").read_text(errors="replace"))

    if args.action == "write":
        path = dirs.get(args.name)
        if path is None:
            return fail("no skill named %r" % args.name)
        new_text = Path(args.file).read_text()
        if not new_text.startswith("---"):
            return fail("refusing to write a SKILL.md without YAML frontmatter")
        backup = path / "SKILL.md.bak"
        backup.write_text((path / "SKILL.md").read_text(errors="replace"))
        (path / "SKILL.md").write_text(new_text)
        return ok(written=str(path / "SKILL.md"), backup=str(backup), bytes=len(new_text))

    if args.action in ("enable", "disable"):
        if args.name not in dirs and args.name not in disabled:
            return fail("no skill named %r" % args.name)
        want_disabled = args.action == "disable"
        current = disabled_skills(home)
        if (args.name in current) == want_disabled:
            return ok(changed=False, disabled=sorted(current))
        current = (current | {args.name}) if want_disabled else (current - {args.name})
        proc = run(["config", "set", "skills.disabled", json.dumps(sorted(current))], profile)
        if proc.returncode != 0:
            return fail("config set failed: %s" % (proc.stderr.strip()[:300]))
        after = disabled_skills(home)
        if (args.name in after) != want_disabled:
            return fail("write did not stick")
        return ok(changed=True, enabled=not want_disabled, disabled=sorted(after))

    return fail("unknown skills action")


def profile_homes():
    """The default profile first, then every folder under profiles/ that has a config."""
    homes = [("default", default_home())]
    root = default_home() / "profiles"
    if root.is_dir():
        for entry in sorted(root.iterdir()):
            if (entry / "config.yaml").is_file():
                homes.append((entry.name, entry))
    return homes


def ledger():
    """Every cron job on this machine, whichever profile owns it.

    Hermes keeps jobs per profile, so a job that lives in `bug-fixer` is invisible from the default
    profile. That is exactly the question a cron owner has to answer, so it reads them all.
    """
    rows = []
    broken = []
    for profile, home in profile_homes():
        try:
            jobs = read_jobs(home)
        except (OSError, ValueError) as error:
            # One unreadable store must not take the whole ledger down: report it and keep going.
            broken.append({"profile": profile, "error": str(error)[:200]})
            continue
        for job in jobs:
            rows.append(
                {
                    "profile": profile,
                    "id": job.get("id"),
                    "name": job.get("name"),
                    "enabled": bool(job.get("enabled", True)),
                    "next_run": job.get("next_run_at"),
                    "last_run": job.get("last_run_at"),
                    "last_status": job.get("last_status"),
                    "last_error": job.get("last_error"),
                    "deliver": job.get("deliver"),
                }
            )
    failing = [
        row for row in rows if row["last_status"] in ("failed", "error") or row.get("last_error")
    ]
    return {
        "count": len(rows),
        "enabled": sum(1 for row in rows if row["enabled"]),
        "profiles": len({row["profile"] for row in rows}),
        "unreadable": broken,
        "failing": failing,
        "jobs": sorted(rows, key=lambda row: str(row["next_run"] or "")),
    }


def read_jobs(home):
    path = home / "cron" / "jobs.json"
    if not path.is_file():
        return []
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return data
    return (data.get("jobs") if isinstance(data, dict) else None) or []


def cmd_cron(args, profile):
    home = home_for(profile)
    jobs = read_jobs(home)

    if args.action == "list":
        rows = []
        for job in jobs:
            enabled = bool(job.get("enabled", True))
            if not (args.all or enabled):
                continue
            rows.append({"id": job.get("id"), "name": job.get("name"), "enabled": enabled,
                         "schedule": job.get("schedule"), "prompt": (job.get("prompt") or "")[:160],
                         "deliver": job.get("deliver") or job.get("delivery") or job.get("deliver_to"),
                         "last_run": job.get("last_run") or job.get("last_run_at"),
                         "next_run": job.get("next_run") or job.get("next_run_at"),
                         "last_status": job.get("last_status"),
                         "state": job.get("state"), "last_error": job.get("last_error"),
                         "paused_at": job.get("paused_at"), "repeat": job.get("repeat"),
                         "script": job.get("script"), "no_agent": job.get("no_agent"),
                         "skills": job.get("skills") or job.get("skill")})
        return ok(count=len(rows), jobs=rows, profile=profile or "default")

    if args.action == "ledger":
        return ok(**ledger())

    if args.action == "get":
        for job in jobs:
            if job.get("id") == args.job_id or job.get("name") == args.job_id:
                return ok(job=job)
        return fail("no job %r" % args.job_id)

    if args.action == "create":
        if not args.schedule:
            return fail("--schedule is required")
        cli = ["cron", "create", args.schedule]
        if args.prompt:
            cli.append(args.prompt)
        if args.name:
            cli += ["--name", args.name]
        if args.deliver:
            cli += ["--deliver", args.deliver]
        before = {j.get("id") for j in jobs}
        proc = run(cli, profile)
        if proc.returncode != 0:
            return fail("cron create failed: %s" % ((proc.stderr or proc.stdout).strip()[:400]))
        after = read_jobs(home)
        created = [j for j in after if j.get("id") not in before]
        if not created:
            return fail("create reported success but no new job is on disk")
        # `job` is answered for every other action; create answers it too so a caller has one shape.
        return ok(created=created, job=created[0], stdout=proc.stdout.strip()[:300])

    if args.action in ("pause", "resume", "run", "cancel", "remove"):
        proc = run(["cron", args.action, args.job_id], profile)
        if proc.returncode != 0:
            return fail("%s failed: %s" % (args.action, (proc.stderr or proc.stdout).strip()[:400]))
        after = read_jobs(home)
        job = next((j for j in after if j.get("id") == args.job_id), None)
        return ok(action=args.action, job=job, stdout=proc.stdout.strip()[:300])

    return fail("unknown cron action")


def cmd_models(args, profile):
    home = home_for(profile)
    model = load_config(home).get("model") or {}
    return ok(profile=profile or "default", model=model.get("default"),
              provider=model.get("provider"),
              note="per-agent catalogs come from ACP agent.listModels")


class JsonArgumentParser(argparse.ArgumentParser):
    """Every failure prints one JSON object, so a caller never gets empty stdout and exit 2."""

    def error(self, message) -> "NoReturn":
        fail("usage: %s" % message)


def build_parser():
    parser = JsonArgumentParser(prog="hermes-bridge")
    parser.add_argument("--profile", default=None)
    sub = parser.add_subparsers(dest="group", required=True)

    s = sub.add_parser("skills")
    s.add_argument("action", choices=["list", "show", "content", "write", "enable", "disable"])
    s.add_argument("name", nargs="?")
    s.add_argument("file", nargs="?")

    c = sub.add_parser("cron")
    c.add_argument(
        "action",
        choices=["list", "ledger", "get", "create", "pause", "resume", "run", "cancel", "remove"],
    )
    c.add_argument("job_id", nargs="?")
    c.add_argument("--all", action="store_true")
    c.add_argument("--schedule")
    c.add_argument("--prompt")
    c.add_argument("--name")
    c.add_argument("--deliver")

    m = sub.add_parser("models")
    m.add_argument("action", choices=["list"])
    return parser


def main():
    args = build_parser().parse_args()
    try:
        if args.group == "skills":
            cmd_skills(args, args.profile)
        elif args.group == "cron":
            cmd_cron(args, args.profile)
        else:
            cmd_models(args, args.profile)
    except FileNotFoundError:
        fail("the hermes command was not found on PATH")
    except subprocess.TimeoutExpired:
        fail("the hermes command timed out")
    except Exception as error:  # noqa: BLE001 - one JSON contract for every failure
        fail(str(error)[:400])


if __name__ == "__main__":
    main()
