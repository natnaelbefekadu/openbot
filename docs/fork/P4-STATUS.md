# P4 — the bot reconciler, and what it proved

Built and exercised on 2026-11-08 with a throwaway bot (`zz-selftest`), then removed.

## What it does

`tools/hermes-bot/hermes_bot.py` — one command per intent, JSON out, idempotent.

```
hermes-bot create <name> [--title T] [--description D] [--inherit-soul]
hermes-bot verify <name>
hermes-bot list
hermes-bot delete <name> --yes
```

`create` does, in order, and reports each step as done / skipped / failed:

1. `hermes profile create <name>`
2. point the profile at the **shared skill bank** (`skills.external_dirs`), never a copy
3. write its Hindsight tag (`retain_tags: ["bot:<name>"]`) and re-read to confirm
4. description via `profile describe --text`, display name via `profile rename`
5. optionally inherit the default SOUL, only over the short 667-byte template `profile create` writes

Then it reports what it deliberately did **not** do:

- the Telegram token — BotFather's, not something a script can invent
- the OpenBot bot row — a second, separate step (below)

## The OpenBot half, exercised end to end

| Step | Result |
|---|---|
| `customAgents.save` with `HERMES_HOME` pointing at the new profile | saved |
| model catalog for the new profile | **49 models** |
| `agent.createAgent` bound to one of its own models | created |
| `skills.listInstalled` on the new bot | **238** — the shared bank, no duplication |
| `listRoutines` on the new bot | **0** — an empty profile schedules nothing |
| first turn | replied **"ready"** |
| cleanup: `deleteAgent`, `customAgents.delete`, profile archived | 7 bots, 5 profiles, as before |

## The hazard this exposed, and the rule it produced

The first time a custom agent is saved, its model list is **empty for about a minute**: Hermes'
ACP process has to handshake, and OpenBot gives up waiting. Creating the bot during that window
does not fail — it silently takes whatever model was used last, which was another profile's
(`hermes-bugfixer/...`). A bot that looks fine and runs on the wrong profile's brain.

**Rule: save the provider, wait for its catalog, then create the bot.** If the catalog is still
empty, stop and report — do not create the bot. After an app restart the catalog appears reliably
(49 models for the test profile).

## Deleting a bot, exactly

- `agent.deleteAgent(agentId)` takes the **bare id string**, not an object. An object fails with
  "agentId is required".
- `customAgents.delete({ id })`.
- the profile itself goes to `profiles-disabled/<name>-<timestamp>` by default, never `rm -rf`.
