# P2 UI wiring plan — exact files and APIs

Written after reading the fork's IPC layer. This is the shape of the remaining work, with the
APIs already located so the next session does not rediscover them.

## The insight that saves the most work

OpenBot already ships a full skills UI: `src/renderer/src/features/conversation/AgentSkillsModal.tsx`
with list / install / enable / disable, backed by the `skills` IPC group. Hermes bots do not need
a new panel — they need that existing surface pointed at the Hermes bank.

Contract already in place (`packages/contracts/src/ipc-endpoints.ts:1054`):

```
skills: {
  listInstalled: request<string, InstalledSkill[]>       // agentId
  setEnabled:    request<SetEnabledSkillInput, InstalledSkill>
  install / uninstall / localCreate / localRevise ...
}
```

`InstalledSkill` (`packages/contracts/src/ipc-skills.ts:138`) only requires
`skillId, slug, name, installedVersion, availableVersion, state` and takes optional
`enabled, origin, description, location`. `origin` is one of
`["marketplace","managed","local","workspace"]`. A Hermes skill maps cleanly:

```ts
{ skillId: `hermes:${name}`, slug: name, name, installedVersion: 1, availableVersion: 1,
  state: "installed", enabled, origin: "workspace", description, location: relativeDir }
```

## Files to touch

1. **new** `src/main/hermes-skills.ts`
   - resolve profile: read `join(app.getPath("userData"), "custom-agents.json")`
     (`CUSTOM_AGENTS_FILE`, `src/main/custom-agent-store.ts:28`), find the entry whose `id`
     matches the model prefix (`model.split("/")[0]`), read its `env[{name,value}]` for
     `HERMES_HOME`; profile is `basename(home)` or `default` when it is `~/.hermes`.
   - `list(profile)`: scan `<home>/skills/**/SKILL.md` (two levels, skipping `.archive`), plus
     `skills.external_dirs` from `config.yaml` (`yaml@2.9.1` is a dependency), return
     `InstalledSkill[]`; `enabled` = name not in `skills.disabled`.
   - `setEnabled(profile, name, enabled)`: `execFile("hermes", ["-p", profile, "config", "set",
     "skills.disabled", JSON.stringify(next)])` — argument array, never a shell string — then
     re-read `config.yaml` and throw if the change is absent.

2. `src/main/ipc/skill-handlers.ts` (73 lines, easy)
   - add optional dep `hermesSkills?: HermesSkills` and `agentLookup?: (agentId) => { model?: string } | null`
   - `listInstalled`: if the agent resolves to a Hermes profile, return `hermesSkills.list()`,
     else fall through to the existing `skills.listInstalled(agentId)`
   - `setEnabled`: same branch; map back to `InstalledSkill` from the same list so the renderer
     gets a consistent row

3. `src/main/index.ts:849` — pass the two new deps into `skillIpcHandlers`. The agent service
   passed to `agentIpcHandlers` at `:999` is the source for `agentLookup`.

4. Nothing to change in the renderer. `AgentSkillsModal` already renders `InstalledSkill[]` and
   calls `setEnabled`. Skills appear, toggle, and re-list without new UI.

## Gates that keep other agents safe

- Branch only when `agent.provider === "acp"` **and** a `HERMES_HOME` env entry exists.
- Everything else falls through to today's code path untouched.
- No new i18n strings if the existing labels are reused; add keys only for an "unavailable"
  state.
- Telemetry: the skills the modal reports become the Hermes bank for these agents, which is the
  intent (one shared bank, no duplication).

## Verification loop

1. `bun run typecheck` — baseline is green in ~25s, so any error is attributable.
2. `bun run build`, then relaunch `~/Applications/OpenBot-Fork/openbot`.
3. CDP: open a Hermes bot's settings → skills; expect ~234 rows, first names matching
   `hermes-bridge`, `openhue`, etc. Toggle one off, re-open, confirm it stays off and that
   `hermes config get skills.disabled` shows it.
4. Non-Hermes agent: confirm its modal still lists its own skills unchanged.

## Cron equivalent (next, same pattern)

`agentRoutines` (`ipc-endpoints.ts:1738`) + `SchedulePanel.tsx` are the cron surface. Routines are
disabled for Hermes bots by decision D7, so the panel is empty today. Same trick: branch
`agentRoutines.list` for a Hermes agent to read `cron/jobs.json` through a `hermes-cron.ts`
module, and map pause/resume/run onto `hermes cron <action> <id>`. `cron create` already supports
`--deliver bot-chat[:profile]`, which is exactly the Mr Crons delivery model.

## Known risks

- `hermes config get skills.disabled` warns the key is not in Hermes' config schema. The
  dashboard reads it (`hermes_cli/skills_config.py`), so it works, but it may move upstream.
  Read it from `config.yaml` directly, never through `hermes config get`.
- Agents whose model has no custom-agent entry (e.g. a marketplace agent) must fall through.
- `InstalledSkill.state` has no "external" value; `workspace` is the closest honest mapping.
