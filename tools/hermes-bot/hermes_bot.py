#!/usr/bin/env python3
"""hermes-bot - create, inspect and remove a Hermes bot profile in one step.

A bot is a Hermes profile plus the things that make it behave like the rest of the fleet:
the same shared skill bank, the same model, its own SOUL, and a Hindsight tag so its memories
are attributable. Telegram is the one step this cannot do for you: BotFather hands out the token.

Every command prints one JSON object. `create` reports each step as done, skipped or pending,
so a half-finished bot says exactly what it is missing.

Usage:
  hermes-bot create <name> [--title T] [--description D] [--no-soul]
  hermes-bot verify <name>
  hermes-bot list
  hermes-bot delete <name> --yes
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERMES = shutil.which("hermes") or str(Path.home() / ".local/bin/hermes")
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
PROFILE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
SHARED_SKILL_DIRS = [str(Path.home() / ".hermeslink" / "hermes-skills"), str(HERMES_HOME / "skills")]


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def ok(**payload):
    print(json.dumps({"ok": True, **payload}, indent=1, default=str))


def run(args, timeout=300):
    return subprocess.run([HERMES, *args], capture_output=True, text=True, timeout=timeout)


def clean(text):
    return re.sub(r"\x1b\[[0-9;]*m", "", (text or "")).strip()


def profile_home(name):
    return HERMES_HOME / "profiles" / name


def exists(name):
    return (profile_home(name) / "config.yaml").is_file()


def skill_count(name):
    proc = run(["-p", name, "skills", "list"])
    match = re.search(r"(\d+) enabled", clean(proc.stdout))
    return int(match.group(1)) if match else None


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(tmp, path)


def ensure_skill_bank(name, steps):
    """Point the profile at the shared bank instead of copying it, which is the fleet rule."""
    config = profile_home(name) / "config.yaml"
    text = config.read_text() if config.is_file() else ""
    if "external_dirs" in text and ".hermeslink/hermes-skills" in text:
        steps.append({"step": "shared skill bank", "status": "done", "detail": "already configured"})
        return
    payload = json.dumps(SHARED_SKILL_DIRS)
    proc = run(["-p", name, "config", "set", "skills.external_dirs", payload])
    if proc.returncode != 0:
        steps.append({"step": "shared skill bank", "status": "failed", "detail": clean(proc.stderr)[:200]})
        return
    count = skill_count(name)
    steps.append({"step": "shared skill bank", "status": "done", "detail": f"{count} skills visible"})


def ensure_hindsight_tag(name, steps):
    path = profile_home(name) / "hindsight" / "config.json"
    tag = f"bot:{name}"
    config = read_json(path, {})
    tags = config.get("retain_tags") or []
    if tag in tags:
        steps.append({"step": "hindsight tag", "status": "done", "detail": tag})
        return
    config["retain_tags"] = sorted([*tags, tag])
    try:
        write_json(path, config)
    except OSError as error:
        steps.append({"step": "hindsight tag", "status": "failed", "detail": str(error)[:160]})
        return
    reread = read_json(path, {}).get("retain_tags") or []
    steps.append(
        {
            "step": "hindsight tag",
            "status": "done" if tag in reread else "failed",
            "detail": tag,
        }
    )


def copy_soul(name, steps, inherit):
    source = HERMES_HOME / "SOUL.md"
    target = profile_home(name) / "SOUL.md"
    if not inherit:
        steps.append({"step": "soul", "status": "done", "detail": "the profile keeps its own starting SOUL"})
        return
    if not source.is_file():
        steps.append({"step": "soul", "status": "skipped", "detail": "no default SOUL.md to inherit"})
        return
    # `profile create` writes a short template; only replace that, never a soul someone has edited.
    if target.is_file() and target.stat().st_size > 2000:
        steps.append({"step": "soul", "status": "skipped", "detail": "the profile's SOUL is already substantial"})
        return
    if target.is_file():
        shutil.copyfile(target, target.with_suffix(".md.bak"))
    shutil.copyfile(source, target)
    steps.append({"step": "soul", "status": "done", "detail": f"inherited {target.stat().st_size} bytes"})


def cmd_create(args):
    name = args.name
    if not PROFILE_NAME.match(name):
        fail("a bot name is lowercase letters, digits and hyphens, up to 31 characters")
    steps = []
    if exists(name):
        steps.append({"step": "profile", "status": "done", "detail": "already exists"})
    else:
        proc = run(["profile", "create", name, "--no-alias"])
        if proc.returncode != 0:
            fail(f"profile create failed: {clean(proc.stderr or proc.stdout)[:300]}")
        steps.append({"step": "profile", "status": "done", "detail": str(profile_home(name))})

    if args.description:
        if run(["profile", "describe", name, "--text", args.description]).returncode != 0:
            steps.append({"step": "description", "status": "failed", "detail": args.description[:80]})
    if args.title:
        run(["profile", "rename", name, args.title])

    ensure_skill_bank(name, steps)
    ensure_hindsight_tag(name, steps)
    if not args.no_soul:
        copy_soul(name, steps, args.inherit_soul)
    else:
        steps.append({"step": "soul", "status": "skipped", "detail": "--no-soul"})

    remaining = [
        {
            "step": "telegram bot",
            "status": "pending",
            "detail": "needs a token from BotFather; set platforms.telegram in this profile's config.yaml",
        },
        {
            "step": "openbot bot",
            "status": "pending",
            "detail": f"register a custom ACP agent with HERMES_HOME={profile_home(name)}",
        },
    ]
    ok(name=name, home=str(profile_home(name)), steps=steps, remaining=remaining)


def cmd_verify(args):
    name = args.name
    if not exists(name):
        fail(f"no profile named {name}")
    home = profile_home(name)
    checks = []
    checks.append({"check": "profile", "ok": True, "detail": str(home)})
    count = skill_count(name)
    checks.append({"check": "skills", "ok": count is not None and count > 0, "detail": count})
    tag = read_json(home / "hindsight" / "config.json", {}).get("retain_tags") or []
    checks.append({"check": "hindsight tag", "ok": f"bot:{name}" in tag, "detail": tag})
    soul = home / "SOUL.md"
    checks.append({"check": "soul", "ok": soul.is_file() and soul.stat().st_size > 0, "detail": soul.stat().st_size if soul.is_file() else 0})
    described = clean(run(["profile", "describe", name]).stdout)
    has_description = bool(described) and "no description set" not in described.lower()
    checks.append({"check": "description", "ok": has_description, "detail": described[:80]})
    ok(name=name, checks=checks, passed=all(c["ok"] for c in checks))


def cmd_list(_args):
    proc = run(["profile", "list"])
    listing = [
        line.strip()
        for line in clean(proc.stdout).splitlines()
        if line.strip() and not set(line.strip()) <= {"-", "─", "|", " "}
    ]
    ok(profiles=[name for name in os.listdir(HERMES_HOME / "profiles") if exists(name)] if (HERMES_HOME / "profiles").is_dir() else [], raw=listing[:40])


def cmd_delete(args):
    name = args.name
    if not exists(name):
        fail(f"no profile named {name}")
    if not args.yes:
        fail("refusing to delete without --yes: a bot profile carries its own history")
    archive = HERMES_HOME / "profiles-disabled" / f"{name}-{datetime.now().strftime('%Y%m%d-%H%M')}"
    archive.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(profile_home(name)), str(archive))
    ok(name=name, archived=str(archive), deleted=not exists(name))


def build_parser():
    parser = argparse.ArgumentParser(prog="hermes-bot")
    sub = parser.add_subparsers(dest="action", required=True)
    create = sub.add_parser("create")
    create.add_argument("name")
    create.add_argument("--title")
    create.add_argument("--description")
    create.add_argument("--no-soul", action="store_true")
    create.add_argument(
        "--inherit-soul",
        action="store_true",
        help="replace the profile's short starting SOUL with the default one, keeping a .bak",
    )
    verify = sub.add_parser("verify")
    verify.add_argument("name")
    sub.add_parser("list")
    delete = sub.add_parser("delete")
    delete.add_argument("name")
    delete.add_argument("--yes", action="store_true")
    return parser


def main():
    args = build_parser().parse_args()
    try:
        {"create": cmd_create, "verify": cmd_verify, "list": cmd_list, "delete": cmd_delete}[args.action](args)
    except subprocess.TimeoutExpired:
        fail("the hermes command timed out")
    except Exception as error:
        fail(f"{type(error).__name__}: {error}")


if __name__ == "__main__":
    main()
