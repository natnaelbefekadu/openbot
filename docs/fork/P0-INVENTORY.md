# P0 inventory — verified against the live machine (2026-11-08)

Everything below was checked by running it, not inferred from the docs. Where a probe failed,
the failure is recorded, because each one changes how the build must be done.

## 1. Where Hermes' state actually lives

| Surface | Truth | How OpenBot reaches it |
|---|---|---|
| Cron | `~/.hermes/cron/jobs.json` (+ per-profile) — 36 jobs, 29 enabled, keys incl. `id,name,prompt,skills,model,provider,script,no_agent` | `hermes cron list/create/edit/pause/resume/run/cancel/remove/runs/history` |
| Skills | `~/.hermes/skills` (shared bank, `skills.external_dirs`) | `hermes skills list/inspect/toggle…` |
| Chat history | `state.db` | ACP sessions (`session/new`, `session/load` with history replay) |
| Models | per-profile model catalog | ACP model list — **252** for the default profile |

## 2. The dashboard HTTP API is NOT usable from a non-browser client

`GET /api/skills` and `/api/cron/jobs` on `127.0.0.1:9120` and `:33052` return:

```
401 {"error":"unauthenticated","reason":"no_cookie","login_url":"/login"}
```

Bearer tokens are only honoured on routes explicitly registered with
`register_token_route` (today: the `dashboard_auth/drain` plugin only). So the cookie session is
the only way in, and obtaining one means the interactive dashboard login.

**Consequence for the build:** the panels must not depend on the dashboard API. They use the
CLI and the on-disk JSON/`state.db` instead — which is also what the desktop app itself
effectively does. Any future HTTP path needs a registered token route first.

## 3. The gateway on :8642 is a different service

`/api/*` there returns `{"error":{"message":"Invalid gateway API key (API_SERVER_KEY)"}}` — it is
the API-server platform, not the dashboard. Do not point panels at it.

## 4. Custom ACP agents — exact shape (learned the hard way)

`window.openbot.customAgents.save` accepts:

```js
{ id, name, command, args: string[], env: [{ name, value }], usagePrompt }
```

- `id`: lowercase letters, digits, hyphens. Becomes the model namespace.
- `env` is an **array of `{name, value}`**, not an object. An object is rejected with
  "A variable name must be letters, digits or `_`".
- The provider id for **every** custom agent is `"acp"`; the agent id is only the prefix of the
  model id (`hermes-bugfixer/nous:xiaomi/mimo-v2.6-flash`). Passing the custom agent's own id as
  `provider` fails with "Invalid agent provider".
- `window.openbot.agent.createAgent` requires `initialMessage`, and it must be non-empty — so
  creating a bot always starts a turn.

## 5. Per-profile agents work

Five custom agents now exist, each with its own `HERMES_HOME`, and each lists its **own** catalog:

| Agent id | Profile | Models listed |
|---|---|---|
| `hermes-t3` | default | 252 |
| `hermes-bugfixer` | `profiles/bug-fixer` | 260 |
| `hermes-eod` | `profiles/eod-reporter` | 174 |
| `hermes-german` | `profiles/german-teacher` | 173 |
| `hermes-memory` | `profiles/memory-manager` | 257 |

## 6. The first turn of a brand-new bot can fail

Creating a bot and immediately sending its first message produced
`acp.exceptions.RequestError: Internal error` (the known session-busy family). The retry
succeeded every time. **The create flow must wait for the provider handshake or retry once**
before showing a failure to the user.

## 7. ACP capability check

`available_commands_update` is already handled by OpenBot's ACP client, so the slash-command
catalog flows today. Model catalogs flow. Sessions can resume with history replay.
