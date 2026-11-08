# P2 status — complete: skills and cron both live in the app

Updated 2026-11-08 after the built fork was installed and driven over CDP.

## Skills

Every bot whose model resolves to a Hermes custom agent lists the shared bank in the existing
skills panel. No new UI: `AgentSkillsModal` now reads Hermes.

| Check | Result |
|---|---|
| `listInstalled` — Bug Fixer, EOD, German, Memory Manager, Chief of Staff, Hermes T3 | **234** each, all `hermes:` ids |
| Jerry Manager (gpt-6-luna, not Hermes) | **0** — gate held |
| disable `openhue` then re-enable | `config.yaml` `[openhue]` then `[]`, both reflected in the panel |

## Cron

All five mutations plus history, against the same panel:

| Check | Result |
|---|---|
| `listRoutines` (Chief of Staff) | **37** jobs, with expression, next run, instruction, active |
| `createRoutine` (custom `0 4 1 1 *`) | job on disk, `deliver: bot-chat`, enabled |
| `updateRoutine` (rename and pause) | name changed on disk, `enabled: false`, `paused_at` set |
| `testRoutine` | real run, `status: succeeded`, `source: test` |
| `listRoutineRuns` | history returned, parsed from `hermes cron runs` |
| `deleteRoutine` (both test jobs) | gone, total back to 36 |
| Jerry Manager routines | **0** — gate held |

A job created here delivers to the bot's own Bot Chat. The CLI default is `origin`, which means
nothing for a job started from a panel and could land on an external channel.

## Known gaps, deliberately left

- `create` cannot yet set `--skill`, `--script`, `--no-agent`, `--workdir`, `--repeat`: the panel's
  create form has no fields for them. Hermes keeps such jobs working; they just cannot be authored
  from here yet.
- A schedule kind the panel cannot express (`advanced`) raises a clear error instead of guessing.
- Cron expressions round-trip as `custom`, so a monthly job shows its expression rather than a
  friendly "every 1st" label.
