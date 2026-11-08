# P2 — complete and verified in the running app

Updated 2026-11-08 after the review findings were closed and the build was reinstalled.

## Skills: 238, which is exactly what Hermes reports

| Check (CDP against the installed fork) | Result |
|---|---|
| `listInstalled` — Chief of Staff | **238** |
| Nested `mlops/*` skills present | `llama-cpp`, `serving-llms-vllm`, `evaluating-llms-harness`, `weights-and-biases` |
| Hidden folders leaking into the list | **0** |
| Toggle `openhue` off then on | `enabled` false then true, `config.yaml` `[]` at the end |
| Jerry Manager (not Hermes) | untouched, gate held |

The count was 234 before: the scan stopped two folders deep and four skills live three deep. It now
walks the bank at any depth with a cap of five, skipping dot-directories.

## Cron: five mutations plus history

| Check | Result |
|---|---|
| `listRoutines` | 36 jobs |
| `createRoutine` | job on disk, `deliver: bot-chat` |
| `updateRoutine` pause then resume | `active` false then true, each read back from `jobs.json` |
| `testRoutine` | real run, `succeeded` |
| `listRoutineRuns` | parsed from `hermes cron runs` |
| `deleteRoutine` | gone, back to 36 |

## What the review changed

An independent reviewer read the bridge and found six HIGH defects. Closed here:

1. **Recursive skill scan** — the four nested skills were invisible.
2. **Strict `config.yaml` read before a toggle** — a failed parse used to mean "nothing disabled",
   and the next write replaced the whole list. It now refuses.
3. **`HERMES_PROFILE` pinned beside `HERMES_HOME`** — a sticky `hermes profile use` can no longer
   send the write to a different profile than the reads.
4. **Pause and resume read back** — the exit code no longer stands in for the state.
5. **Bare-list `jobs.json`** and **profile-name validation** were fixed earlier.
6. **Argument errors are JSON**, not exit 2 with empty stdout.

## Known gaps, deliberately left

- `create` cannot set `--skill`, `--script`, `--no-agent`, `--workdir` or `--repeat`: the panel's
  form has no fields for them.
- A schedule kind the panel cannot express raises a clear error instead of guessing.
- Cron expressions round-trip as `custom`, so a monthly job shows `0 5 1,15 * *`.
- Same-name skills in two tiers collide by name; Hermes keeps both and marks the loser shadowed.
