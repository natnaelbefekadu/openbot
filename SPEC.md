# OpenBot ⟷ Hermes integration — SPEC

Status: **v3 — every decision locked, awaiting sign-off**
Date: 2026-11-08
Owner: Nati
Base: OpenBot v0.65.0, fork `natnaelbefekadu/openbot`, branch `local`
Engine: Hermes Agent (gateway `127.0.0.1:8642`, dashboard `9120`, link `52379`)

---

## 1. What you are asking for

OpenBot desktop becomes the **only surface you use daily**. Hermes stays the engine —
the bots, their memory, their skills, their schedules, their history. OpenBot is a window
and a control panel onto that engine, not a second brain.

Your three quotes are the acceptance test:

1. *"It must feel like I'm using the desktop app when it comes to functionality. On the
   desktop app I don't feel restricted in any way."*
2. *"Nothing from the Hermes app will be missing in OpenBot."*
3. *"The phone connection is the reason I'm here — it's as close to instant as possible."*

So: **full capability, zero duplication, phone untouched.**

## 2. Non-negotiables

| # | Rule | Why |
|---|---|---|
| N1 | No embedded browser / iframe of the Hermes dashboard | You rejected it; it is not the same app |
| N2 | Phone compatibility is never broken | The vendor app is third-party; we cannot patch it |
| N3 | Hermes is the single source of truth for bots, history, skills, cron and persona | Stops the copies that caused the 32-skill cap and truncated memories |
| N4 | Full write parity from OpenBot — no read-only panels | "I don't want it to be limited" |
| N5 | Same bot in both apps, no divergence in behaviour or history | "It's just a GUI layer" |
| N6 | Everything must survive upstream releases | Patch series + fork-owned update feed |

## 3. Settled architecture decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **History lives in Hermes `state.db`.** OpenBot keeps only UI state | Pick up work in either app; no transcript drift |
| D2 | **Persona lives in Hermes SOUL.md.** OpenBot's description is a caption | One place to edit a bot's character |
| D3 | **Skills live in the shared bank** (`~/.hermes/skills`), written through Hermes' API | One bank, same behaviour everywhere |
| D4 | **Cron lives in Hermes.** OpenBot's own routines engine is off for these bots | One scheduler; jobs fire once |
| D5 | **Bot-to-bot rides Hermes Bot Chat** (single-writer FIFO). OpenBot is viewer + sender | Telegram and phone see the same conversation Chief remembers |
| D6 | **One custom ACP agent per Hermes profile**, distinguished by `HERMES_HOME` | Each OpenBot bot runs on its own profile's brain |
| D7 | **Session `cwd` = the profile's home**, not OpenBot's workspace | Same bot starts in the same folder as the desktop app |
| D8 | **Hermes hooks stay auto-accepted** (`--accept-hooks`); OpenBot approvals are the only gate | You don't want to fight Hermes to accept a task |
| D9 | **Bots stay warm**, evicted after ~15 idle minutes | Instant feel without five runtimes camping in RAM |
| D10 | **Search proxies Hermes' search** | Search what you read |
| D11 | **Updates point at the fork**; auto-download off by default | Upstream can never overwrite the fork |
| D12 | **Files are editable inside OpenBot**, scoped to the agent workspace | You edit files in T3 today; OpenBot must match |
| D13 | **Cron is centralised in one bot ("Mr Crons") as the ledger**; jobs still run as their owning bot | One place to see and debug schedules, without adding a relay hop |

## 4. Surface inventory

| Surface | Truth | OpenBot role | Mobile |
|---|---|---|---|
| Chat / threads | Hermes sessions | viewer + sender (ACP) | works |
| Models | Hermes catalog (252) | selection + endpoint label | works (host-side setting) |
| /commands | Hermes command catalog | slash menu, full catalog preserved | works as typed text |
| Skills | `~/.hermes/skills` | list · toggle · lock · edit · create | works when invoked; no picker |
| Cron | Hermes cron | list · create · edit · pause · resume · trigger · cancel · runs | not shown |
| Memory | Hindsight bank | **nothing** — invisible by design | n/a |
| Bots (fleet) | Hermes profiles | list · create · rename · delete (reconciled) | list works |
| Bot-to-bot | Hermes Bot Chat | viewer + sender | visible in bot chats |
| Files / artifacts | agent workspaces | browse · preview · **create · rename · delete · edit** | view only |

## 5. Acceptance criteria

1. Changing a bot's model in OpenBot changes Hermes' config, takes effect next turn, and holds when the bot is used from the phone.
2. Editing a skill in OpenBot changes the file Hermes reads; the next turn honours it; visible in the Hermes app.
3. Creating, pausing and triggering a cron job in OpenBot is reflected by `hermes cron list` and run history, and fires exactly once.
4. Chief messages Bug Fixer: both sides appear in OpenBot **and** Telegram/desktop, same ids, no duplicates.
5. A cron job firing at 06:00 appears in OpenBot without a refresh.
6. A bot created in either app appears in both, no restart.
7. Opening a chat the desktop app holds shows a take-over prompt, never a lockout.
8. Phone behaviour is unchanged throughout.
9. Editing a file in OpenBot writes to disk; the change is visible to the bot on its next turn and to `cat`; a file changed on disk refreshes in the preview instead of going stale.
10. A cron job running as *another* bot delivers its output into **Mr Crons'** chat, and the receipt names the owning bot.

## 6. Files and artifacts — parity with your T3 fork

You already solved this in T3. Your fork carries the exact four commits, and OpenBot needs
the same work in its own IPC layer:

| Your T3 commit | What it fixed | OpenBot equivalent |
|---|---|---|
| `6b7262256e` feat(files): real filesystem browser | the Files pane was not a real browser | OpenBot browses and previews only |
| `109a2177d6` feat(files): create/rename/delete/edit | no write operations; needed new RPCs **plus auth and instrumentation registration** | new workspace file ops in the main process, registered in auth + instrumentation |
| `bb4a03c6ae` fix(files): refresh previews after external edits | previews went stale when files changed on disk; browsing broke with no workspace | same bug will appear — Hermes writes files constantly |
| `0439888f99` fix(files): ghost empty drafts blanking previews | an empty buffer was treated as real content | same trap |

**Verified today:** OpenBot exposes `listWorkspaceDirectory`, preview and open, and has **no
workspace write path** — `writeFile` appears only in archive/import/template services. So this
is genuinely new code, not re-wiring.

**Safety rules for this block** (about data, not permissions):
- writes are scoped to the agent's workspace root, no traversal outside
- overwrite writes a `.bak` beside the file first
- delete moves to a trash folder inside the workspace, never `rm`
- binary and large files stay preview-only

## 7. Cron ownership — "Mr Crons"

**Your model:** one bot owns the cron system, deliveries land in his chat, and he suggests
delegating a job to the right bot when the context fits.

**My verdict: the instinct is right, the relay is wrong.**

Right — with 30+ jobs across five bots, one ledger beats hunting through profiles.

Wrong — making him the message bus adds a hop, doubles message volume, and creates a single
point of failure. If he is idle-evicted or mid-turn, output stalls. It also gives you two
orchestrators: Chief delegates work, Mr Crons routes schedules, and they will eventually
contradict each other.

**Design that keeps the intent and drops the risk:**

- **The job belongs to the executing bot.** A job for X Strategist runs in X Strategist's
  profile, as X Strategist, with its tools, skills and memory.
- **Delivery target is Mr Crons.** Hermes cron already separates these two concepts
  (`/api/cron/delivery-targets`). The job runs as X Strategist; its output lands in Mr Crons' chat.
- **Mr Crons owns the ledger and the health checks** — every job, owner, schedule, last run,
  failure — and messages the owning bot directly when something needs attention.
- **He creates when the context is clear, proposes when it is not.** An explicit request
  ("schedule X every morning") is created directly against the owning profile. A vague or
  new request is proposed first — "this looks like an X Strategist job, shall I set it up?" —
  and waits for your yes. Either way the job is created against the owning profile, never
  as Mr Crons. He is the delivery area, not the executioner.

## 8. Work items

| # | Item | Mechanism | Config / Code |
|---|---|---|---|
| W1 | Per-profile ACP agents | `customAgents.save` with `HERMES_HOME` per profile | config |
| W2 | `cwd` = profile home | session start parameter | code (small) |
| W3 | Skills panel (full CRUD) | `GET /api/skills`, `POST /api/skills`, `PUT /api/skills/content`, `PUT /api/skills/toggle`, `PUT /api/skills/lock` | code |
| W4 | Cron panel (full CRUD) | `GET/POST/PUT /api/cron/jobs`, `…/pause`, `…/resume`, `…/trigger`, `…/cancel`, `…/runs`, `…/delivery-targets` | code |
| W5 | Model surface | ACP catalog + endpoint label; persist to profile config | code (small) |
| W6 | Command catalog | already delivered via `available_commands_update`; verify the menu | code (verify) |
| W7 | Bot reconciler | Hermes profiles ⇄ `custom-agents.json` + agent rows, keyed on stable profile id | code |
| W8 | Bot creation | run Hermes' `profile create`, then register the ACP agent | code |
| W9 | Rename / delete | one operation, both sides, keyed on stable id | code |
| W10 | Live subscription | subscribe to Hermes session events; cron and bot-to-bot turns stream in | code |
| W11 | Search proxy | OpenBot search → Hermes `session_search` | code |
| W12 | Take-over prompt | detect the Bot Chat writer lease; offer take-over | code |
| W13 | Warm pool + idle eviction | keep sessions resident, evict after ~15 min | code |
| W14 | Citation cards | quoted paragraph + comment + answer beneath (`quoteSelection` exists) | code (UI) |
| W15 | Endpoint adapter | one module listing every Hermes endpoint used, with version check and "unavailable" state | code |
| W16 | Workspace file ops | create · rename · delete · edit + preview refresh + draft guard | code |
| W17 | Cron delivery targets + Mr Crons ledger | job owner vs delivery target; ledger view | code |

## 9. Explicitly out of scope

- Hermes pages we are **not** rebuilding: Config, Env, MCP, Plugins, Profiles, Pairing,
  Webhooks, Channels, Analytics, Docs, Profile Builder, System
- Any UI for Hindsight memory beyond what the bot already does
- Any change to the mobile app, or to the team/signal wire protocol
- Replacing Hermes' scheduler
- Commercial distribution

## 10. Constraints and risks

| Risk | Mitigation |
|---|---|
| Fork breaks the phone | `appId`/`productName` frozen; account + signal services untouched; additive capabilities only |
| Hermes changes an endpoint we call | W15 adapter: version check, "unavailable" state, never a crash |
| Upstream ships daily and buries the fork | Patch series + `scripts/local/sync.sh <tag>`; conflicts stop with instructions |
| Two sources of truth creep back | Keystone rule: for Hermes-backed bots OpenBot owns no skills, memories, routines or transcripts |
| File editing destroys data | scoped roots, `.bak` on overwrite, trash instead of delete |
| OpenBot writes a bad skill to the shared bank | snapshot before write, one-command restore, audit list |
| Warm bots eat RAM | idle eviction ~15 min; only the active bot resident |
| Is OpenBot stable enough for a central cron bot? | The transport is the part you already trust daily; what we add is new code whose risk is drift, not crashes. Patch series + endpoint adapter is the answer, and cron lands in P5 on proven ground |

## 11. Build and release

- Source: `~/Documents/openbot-fork`; `main` = pristine upstream tag, `local` = main + `fork-patches/*.patch`
- Sync: `./scripts/local/sync.sh v0.66.0` (fetch tag → reset main → replay patches → build)
- Degraded-GitHub build: `--dir -c.electronDist=node_modules/electron/dist`; runtimes copied from
  the installed AppImage and digest-verified (`references/fork-build.md`)
- Verified artifact: `dist/linux-unpacked` 657 MB · `cua-driver` 0.34.0 · `remote-desktop-runtime`
  · `app-update.yml` → fork · `agentSkills: 200` · auto-download off
- `.AppImage` waits on GitHub tooling
- New work always lands as new files in `fork-patches/`, never as edits to `main`

## 12. Phases

| Phase | Content | Exit criteria |
|---|---|---|
| **P0** | Inventory: what ACP already delivers; every endpoint checked against the live gateway | written matrix, no guessing |
| **P1** | W1, W2, W7 — one bot per profile, cwd fixed | Chief and one other run on their own profiles |
| **P2** | W3, W4, W6 — skills and cron panels, read + write | tests 2 and 3 |
| **P3** | W5, W15 — model surface + endpoint adapter | test 1 |
| **P4** | W8, W9, W12 — create / rename / delete / take-over | tests 6 and 7 |
| **P5** | W10, W11, W13, W17 — live updates, search, warm pool, Mr Crons ledger | tests 4, 5, 10 |
| **P6** | W14, W16 — citation cards, file editing | tests 8, 9 |

## 13. Verification standard

Proven on the system that holds the truth, never by the UI looking right:

- model change → profile `config.yaml`
- skill edit → the file, then the next turn
- cron → `hermes cron list` + run history
- bot creation → profile dir + `custom-agents.json` + `projection_agents`
- bot-to-bot → message ids both sides, no duplicates
- file edit → `cat` on disk, then the bot's next turn
- live updates → DB timestamps with the UI untouched

## 14. Open questions

**Resolved:** Mr Crons = the delivery area, never the executioner; he may create jobs for
another bot directly when the context is clear, and proposes first when it is not.

Still on defaults unless you overrule:

1. **Idle eviction window** — 15 minutes.
2. **Skills scope in the panel** — whole bank.
3. **Bot deletion** — soft/archive, restorable.
4. **Citation cards** — full T3 parity.

## 15. Reference map

- OpenBot: `~/.config/OpenBot/openbot.db`, `custom-agents.json`, `openbot-remote-servers-v1.json`
- Hermes: `~/.hermes`, `~/.hermes/profiles/<name>`, `~/.hermes/skills`, `~/.hermes/cron/jobs.json`
- Services: gateway `8642`, dashboard `9120`, link `52379`, Hindsight `9177`, CLI proxy `8318`
- ACP agent: `/home/natnael/.local/bin/hermes acp --accept-hooks`
- Fork: `~/Documents/openbot-fork`, patches `fork-patches/`, build docs `references/fork-build.md`
