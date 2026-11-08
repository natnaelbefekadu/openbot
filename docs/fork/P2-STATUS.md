# P2 status — skills panel is live in the app; cron panel is not

Updated 2026-11-08 after the build was installed and driven over CDP.

## Skills: done and verified in the running app

Every bot whose model resolves to a Hermes custom agent now lists the shared bank in its existing
skills panel. No new UI was written — `AgentSkillsModal` was pointed at Hermes.

| Check (over CDP against the installed fork) | Result |
|---|---|
| `skills.listInstalled` — Bug Fixer | **234**, all `hermes:` ids |
| EOD Reporter / German Teacher / Memory Manager | **234** each |
| Chief of Staff, Hermes T3 (default profile) | **234** each |
| Jerry Manager (non-Hermes, gpt-6-luna) | **0** — unaffected, the gate held |
| `setEnabled(openhue, false)` | row returns `enabled: false`, `config.yaml` gets `- openhue` |
| `setEnabled(openhue, true)` | row returns `enabled: true`, `config.yaml` back to `[]` |

Code: `src/main/hermes-skills.ts` (new), `src/main/ipc/skill-handlers.ts` (branches on
`provider === "acp"` plus a resolvable profile), `src/main/application-services.ts` (exposes
`customAgentEnvironments`, the decrypted env, because the store keeps values encrypted in
`custom-agents.json` and only `envNames` in plain text).

Two bugs found by running it, both fixed:

1. A custom agent with no `HERMES_HOME` (the default profile) resolved to nothing, so Chief of
   Staff kept showing its 32 imported copies. It now maps to `hermesRoot()`.
2. The write path passed `-p <profile>`, and Hermes rejects `.hermes` as a profile name. The
   profile is now selected with a pinned `HERMES_HOME` only, which is what the agent itself uses.

## Cron: the bridge works, the panel does not

The bridge covers cron fully (list with `next_run`/`state`/`last_error`/`paused_at`/`repeat`,
create, pause, resume, run, cancel, remove) and is tested. The panel is deliberately not wired yet:
`agentRoutines` has five mutations, and mapping only `listRoutines` would let a user "delete" a
Hermes job and see it vanish from OpenBot while it keeps firing in Hermes. All five must branch
together, each verified.

## Review findings fixed in the bridge

An independent review passed over `hermes_bridge.py`. Fixed and re-tested: bare-list `jobs.json`
no longer crashes, profile names are validated, `HERMES_HOME` is honoured, cron rows carry the
failure fields, and every failure is JSON instead of a traceback.

Still open from that review: `cron create` cannot set `--skill`, `--script`, `--no-agent`,
`--workdir` or `--repeat`, there is no `cron edit`, and the skill scan does not walk deeper than
two levels.
