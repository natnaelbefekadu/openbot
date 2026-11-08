# P2 status — skills and cron, data layer done and tested

Date: 2026-11-08

## What exists and is verified

`tools/hermes-bridge/hermes_bridge.py` — stdlib-only, JSON-speaking, per-profile.

| Test | Result |
|---|---|
| `skills list` | 233 skills, name + dir + description + enabled |
| `skills content openhue` | 2839 chars returned |
| `skills write openhue <copy>` | written, `SKILL.md.bak` created, md5 identical to source |
| `skills disable openhue` | `skills.disabled: [openhue]` in config.yaml |
| `skills enable openhue` | `skills.disabled: []` |
| `cron list` | 29 enabled / 36 total, with delivery targets |
| `cron create --schedule "every 24h" --deliver local` | job `3edcb3de8952` on disk |
| `cron pause` / `cron resume` | `enabled` flipped false → true |
| `cron run` | "Ran now: succeeded." |
| `cron remove` | job gone, total back to 36 |

Also installed as a Hermes skill (`automation/hermes-bridge`) so both the desktop panels and
any bot in chat can drive it. Skill count went 233 → 234.

## Why the bridge exists instead of HTTP calls

The dashboard API needs a browser cookie: `/api/skills` and `/api/cron/jobs` on `:9120` and
`:33052` answer `401 {"reason":"no_cookie"}`. Bearer tokens only work on routes registered with
`register_token_route` (today: one plugin route). So the panels cannot call HTTP endpoints
without an interactive login. The CLI plus on-disk stores is the path that works today.

## What is still missing for P2 to be "done"

The panels themselves — the renderer surfaces that call the bridge:

1. main-process IPC: one handler per bridge command, spawning `python3 hermes_bridge.py …`
   with a fixed argument list (never a shell string), parsing the JSON, and surfacing
   `{ok:false,error}` as a toast instead of a crash.
2. contracts: typed request/response for the skills and cron groups.
3. renderer: skills list with enable/disable and an editor; cron list with pause/resume/run/
   remove and a create dialog; both with an "unavailable" state when the bridge is missing.
4. Mobile: the new IPC is desktop-only; the phone ignores it because the capabilities are
   additive.

## Safety carried over

- `skills write` refuses unknown names and content without frontmatter
- every write leaves a `SKILL.md.bak`
- every write is verified by re-reading the store, so a silent no-op is impossible
- `cron remove` needs an explicit id; nothing bulk-deletes
