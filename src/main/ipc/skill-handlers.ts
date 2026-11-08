import { localSkillTools } from "../local-skill-tools";
import {
  parseCreateLocalSkill,
  parseInstallLocalSkill,
  parseReadLocalSkill,
  parseReviseLocalSkill,
} from "./local-skill-inputs";
// The skill marketplace, and the skills installed into a workspace.

import type { AgentSummary } from "@openbot/contracts/ipc";
import type { AppTranslate } from "@openbot/i18n";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { HermesSkills } from "../hermes-skills";
import type { SkillMarketplaceService } from "../skill-marketplace-service";
import {
  parseInstallSkill,
  parseMarketplaceSkillQuery,
  parseSetEnabledSkill,
  parseSubmitSkill,
  parseUninstallSkill,
} from "./app-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { nullishPayload, stringPayload } from "./validation";

export interface SkillIpcDependencies {
  skills: SkillMarketplaceService;
  getMainWindow: () => BrowserWindow | null;
  translate: AppTranslate;
  /** An agent that runs on Hermes reads and writes the shared Hermes bank instead of a workspace. */
  hermesSkills?: HermesSkills;
  agents?: () => AgentSummary[];
}

export function skillIpcHandlers({
  skills,
  getMainWindow,
  translate,
  hermesSkills,
  agents,
}: SkillIpcDependencies): Pick<IpcGroupHandlers, "skills"> {
  // The one Hermes profile an agent runs on, or null for every other provider. Narrow on
  // `provider` first so an agent that merely has the model id shape never reaches the bridge.
  const hermesProfile = (agentId: string) => {
    if (!hermesSkills?.profileForModel || !agents) return null;
    const agent = agents().find((candidate) => candidate.id === agentId);
    if (agent?.provider !== "acp" && agent?.provider !== "hermes") return null;
    return hermesSkills.profileForModel(agent.model);
  };

  return {
    skills: {
      localList: handler(() => runCauseEffect(localSkillTools(skills).list())),
      localGet: payloadHandler(parseReadLocalSkill, (input) => runCauseEffect(localSkillTools(skills).get(input))),
      localCreate: payloadHandler(parseCreateLocalSkill, (input) =>
        runCauseEffect(localSkillTools(skills).create(input)),
      ),
      localRevise: payloadHandler(parseReviseLocalSkill, (input) =>
        runCauseEffect(localSkillTools(skills).revise(input)),
      ),
      localInstall: payloadHandler(parseInstallLocalSkill, (input) =>
        runCauseEffect(localSkillTools(skills).install(input)),
      ),
      list: payloadHandler(nullishPayload(parseMarketplaceSkillQuery), (query) => runCauseEffect(skills.list(query))),
      get: payloadHandler(stringPayload("skillId"), (skillId) => runCauseEffect(skills.get(skillId))),
      getBySlug: payloadHandler(stringPayload("slug"), (slug) => runCauseEffect(skills.getBySlug(slug))),
      listMine: handler(() => runCauseEffect(skills.listMine())),
      choosePackage: handler(async () => {
        const mainWindow = getMainWindow();
        const options: OpenDialogOptions = {
          title: translate("dialog.chooseSkill"),
          properties: ["openFile", "openDirectory"],
          filters: [{ name: translate("dialog.filter.skillPackages"), extensions: ["zip"] }],
        };
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options);
        return result.canceled || !result.filePaths[0] ? null : runCauseEffect(skills.stage(result.filePaths[0]));
      }),
      submit: payloadHandler(parseSubmitSkill, (submission) => runCauseEffect(skills.submit(submission))),
      listInstalled: payloadHandler(stringPayload("agentId"), async (agentId) => {
        const profile = hermesProfile(agentId);
        return profile && hermesSkills ? hermesSkills.list(profile) : runCauseEffect(skills.listInstalled(agentId));
      }),
      install: payloadHandler(parseInstallSkill, (installation) => runCauseEffect(skills.install(installation))),
      uninstall: payloadHandler(parseUninstallSkill, (removal) => runCauseEffect(skills.uninstall(removal))),
      setEnabled: payloadHandler(parseSetEnabledSkill, async (change) => {
        const profile = hermesProfile(change.agentId);
        if (!profile || !hermesSkills) return runCauseEffect(skills.setEnabled(change));
        const updated = await hermesSkills.setEnabled(profile, change.skillId, change.enabled);
        const changed = updated.find((skill) => skill.skillId === change.skillId) ?? updated[0];
        if (!changed) throw new Error("Hermes returned no skill after the change.");
        return changed;
      }),
    },
  };
}
