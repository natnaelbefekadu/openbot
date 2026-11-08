# P5 — Mr Crons, the ledger, and delivery that lands

Built and proven on 2026-11-08. The bot stays; the probe job was removed.

## Mr Crons exists

| Step | Result |
|---|---|
| `hermes-bot create mr-crons --title "Mr Crons"` | profile, shared bank (**238 skills**), `bot:mr-crons` hindsight tag |
| model credentials | 22 keys copied from the default `.env`, **no Telegram token** |
| OpenBot provider `hermes-mr-crons` | saved, **49 models** after the first handshake |
| bot row | created on `hermes-mr-crons/opencode-go:deepseek-v4.1-flash` |
| first turn | replied **"ready"** |
| `skills.listInstalled` | **239** — the shared bank including the new reconciler skill |

## Delivery lands in him — verified

```
hermes cron create "0 4 1 1 *" "Reply with exactly: cron delivery test" \
  --name delivery-probe-mrcrons --deliver bot-chat:mr-crons
hermes cron run <id>   →  "Ran now: succeeded."
```

His `state.db` then held the injected job output and his reply:

```
user      [Cronjob "delivery-probe-mrcrons" output — scheduled job, not the user …]  cron delivery test
assistant Delivery test received — nothing to act on.
```

That is the whole loop: a job runs, its output arrives in Mr Crons' Bot Chat, and he answers it.

## The blocker that this exposed

His first attempt answered `HTTP 401: {"error":"Invalid API key"}`. `hermes profile create` writes
**no `.env` at all**, so a fresh profile has no model credentials — every call fails. The reconciler
now seeds the credentials a profile needs and deliberately withholds the ones that belong to the
host or to another bot's identity: `*_BOT_TOKEN`, `*ALLOWED_USERS`, `*CHAT_ID`, `OPEN_ID`,
`API_SERVER_*`, `HERMES_DASHBOARD_*`, `CAMOFOX_URL`.

## The ledger

Hermes keeps cron jobs **per profile**, so a job in `bug-fixer` is invisible from `default` — Mr
Crons' first tool call listed 0 jobs while 36 existed. The bridge now answers that question:

```
python3 tools/hermes-bridge/hermes_bridge.py cron ledger
→ jobs: 36 | enabled: 29 | profiles: 1 | failing: 0
```

Every job on the machine, with its owning profile, next run, last status and last error, sorted by
what fires next, plus a `failing` list.

## What is not done, and is the next real step

Delivery still points at whatever each job was created with. Mr Crons receives a job only when that
job names him (`--deliver bot-chat:mr-crons`). Re-pointing the existing 36 is a decision for Nati,
not something to do silently — a wrong target means output that nobody reads.
