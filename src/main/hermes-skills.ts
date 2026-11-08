import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { InstalledSkill } from "@openbot/contracts/ipc";
import { parse as parseYaml } from "yaml";
import type { CustomAgentConfig } from "../backend/custom-acp-agents-client";
import { hermesRoot } from "./hermes-import-reader";

/**
 * The skills a Hermes agent actually has.
 *
 * Hermes keeps one shared bank on disk rather than a per-workspace copy, so an agent that runs on
 * Hermes lists that bank, and enablement writes `skills.disabled` in the profile's `config.yaml`.
 * Reads come from disk; the one write shells out to the `hermes` CLI with an argument array and a
 * fixed environment, then re-reads the file and throws when the change is absent.
 */

export interface HermesProfileRef {
  /** The profile folder name under `~/.hermes/profiles`, or `default`. */
  profile: string;
  /** Absolute profile home. */
  home: string;
}

const SKIPPED_DIRECTORIES = new Set([".archive", "__pycache__", "node_modules"]);
const MAX_SKILL_DEPTH = 5;
const NO_SETTINGS = { disabled: [], externalDirs: [] };

interface SkillSettings {
  disabled: string[];
  externalDirs: string[];
}

interface Frontmatter {
  name?: string;
  description?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const one = text(item);
    return one ? [one] : [];
  });
}

function skillSettings(config: unknown): SkillSettings {
  if (typeof config !== "object" || config === null || !("skills" in config)) return NO_SETTINGS;
  const skills = config.skills;
  if (typeof skills !== "object" || skills === null) return NO_SETTINGS;
  return {
    disabled: "disabled" in skills ? strings(skills.disabled) : [],
    externalDirs: "external_dirs" in skills ? strings(skills.external_dirs) : [],
  };
}

function frontmatterOf(raw: unknown): Frontmatter {
  if (typeof raw !== "object" || raw === null) return {};
  return {
    name: "name" in raw ? text(raw.name) : undefined,
    description: "description" in raw ? text(raw.description) : undefined,
  };
}

/** A custom agent counts as Hermes only when it actually launches Hermes. */
export function isHermesCustomAgent(agent: CustomAgentConfig): boolean {
  const command = basename(agent.command).toLowerCase();
  if (command === "hermes" || command.startsWith("hermes-") || command === "hermes-agent") return true;
  return agent.env.some((variable) => variable.name === "HERMES_HOME" || variable.name === "HERMES_PROFILE");
}

/**
 * The Hermes profile a model id names, or null when the prefix is not a Hermes custom agent. A
 * custom agent with no `HERMES_HOME` runs on the default profile, which is still Hermes.
 */
export function hermesProfileFor(
  model: string | undefined,
  customAgents: () => readonly CustomAgentConfig[],
): HermesProfileRef | null {
  const prefix = model?.split("/")[0]?.trim();
  if (!prefix) return null;
  const match = customAgents().find((agent) => agent.id === prefix && isHermesCustomAgent(agent));
  if (!match) return null;
  const home =
    match.env.flatMap((variable) => (variable.name === "HERMES_HOME" ? [variable.value] : []))[0] ?? hermesRoot();
  return { profile: basename(home), home };
}

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readTextOr(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // Only a missing file means "empty". Anything else is unreadable, and must not be treated as
    // "nothing there": writing back then replaces what could not be read.
    if (missingFile(error)) return null;
    throw error;
  }
}

export class HermesSkills {
  readonly #customAgents: () => readonly CustomAgentConfig[];
  readonly #hermesCommand: string;

  constructor(options: { customAgents: () => readonly CustomAgentConfig[]; hermesCommand?: string }) {
    this.#customAgents = options.customAgents;
    this.#hermesCommand = options.hermesCommand ?? "hermes";
  }

  /** The Hermes profile an agent runs on, or null when the agent is not a Hermes one. */
  profileForModel(model: string | undefined): HermesProfileRef | null {
    return hermesProfileFor(model, this.#customAgents);
  }

  list(reference: HermesProfileRef): InstalledSkill[] {
    const disabled = new Set(this.#settings(reference).disabled);
    const rows: InstalledSkill[] = [];
    const used = new Set<string>();
    for (const [name, directory] of this.#skillDirectories(reference)) {
      const meta = this.#frontmatter(join(directory, "SKILL.md"));
      const display = meta.name ?? name;
      // Two folders can declare the same name; one row per name keeps keys unique and the toggle honest.
      if (used.has(display)) continue;
      used.add(display);
      rows.push({
        skillId: `hermes:${display}`,
        slug: display,
        name: display,
        installedVersion: 1,
        availableVersion: 1,
        state: "installed",
        enabled: !disabled.has(display),
        origin: "workspace",
        description: meta.description ?? "",
        location: relative(reference.home, directory),
      });
    }
    return rows.sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Writes `skills.disabled` for one profile, then answers the refreshed list. */
  async setEnabled(reference: HermesProfileRef, skillId: string, enabled: boolean): Promise<InstalledSkill[]> {
    const name = skillId.startsWith("hermes:") ? skillId.slice("hermes:".length) : skillId;
    const current = this.#strictSettings(reference).disabled;
    const wanted = enabled ? current.filter((entry) => entry !== name) : [...new Set([...current, name])].sort();
    const changed = wanted.length !== current.length || wanted.some((entry) => !current.includes(entry));
    if (changed) {
      await this.#run(reference, ["config", "set", "skills.disabled", JSON.stringify(wanted)]);
      const after = this.#settings(reference).disabled;
      if (after.includes(name) === enabled) throw new Error(`Hermes did not record the change for ${name}.`);
    }
    if (!this.list(reference).some((skill) => skill.slug === name)) {
      throw new Error(`No skill named ${name} in this Hermes profile.`);
    }
    return this.list(reference);
  }

  async #run(reference: HermesProfileRef, args: string[]): Promise<void> {
    // `-p` takes a profile name, and the default home's folder is `.hermes`, which it rejects.
    // The pinned `HERMES_HOME` below is what selects the profile, as it does for the agent itself.
    const [executable, ...rest] = [this.#hermesCommand, ...args];
    if (!executable) throw new Error("No hermes command configured.");
    await new Promise<void>((resolve, reject) => {
      execFile(
        executable,
        rest,
        {
          // Pinning both keeps a sticky `hermes profile use` from redirecting the write to another
          // profile while these reads stay on the one this agent runs.
          env: { ...process.env, HERMES_HOME: reference.home, HERMES_PROFILE: reference.profile },
          timeout: 60_000,
        },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve();
        },
      );
    });
  }

  #strictSettings(reference: HermesProfileRef): SkillSettings {
    const contents = readTextOr(join(reference.home, "config.yaml"));
    if (contents === null || !contents.trim()) return NO_SETTINGS;
    const parsed = parseYaml(contents);
    if (typeof parsed !== "object" || parsed === null) throw new Error("Hermes config.yaml could not be read.");
    if ("skills" in parsed && typeof parsed.skills === "object" && parsed.skills !== null) {
      const skills = parsed.skills;
      // A scalar or a map here would be replaced by the list this write sends, so refuse instead.
      if ("disabled" in skills && skills.disabled !== undefined && !Array.isArray(skills.disabled)) {
        throw new Error("Hermes skills.disabled is not a list; refusing to overwrite it.");
      }
    }
    return skillSettings(parsed);
  }

  #settings(reference: HermesProfileRef): SkillSettings {
    const contents = readTextOr(join(reference.home, "config.yaml"));
    if (contents === null || !contents.trim()) return NO_SETTINGS;
    return skillSettings(parseYaml(contents));
  }

  #roots(reference: HermesProfileRef): string[] {
    return [join(reference.home, "skills"), ...this.#settings(reference).externalDirs];
  }

  /**
   * Every skill folder under a root, at any depth: the bank nests by category, and `mlops/inference/x`
   * is a real skill. Hidden folders are skipped, so `.hub` and `.archive` never contribute.
   */
  #skillDirectories(reference: HermesProfileRef): Array<[string, string]> {
    const found: Array<[string, string]> = [];
    const seen = new Set<string>();
    const walk = (directory: string, depth: number): void => {
      if (depth > MAX_SKILL_DEPTH) return;
      if (this.#hasSkillFile(directory)) {
        const name = basename(directory);
        if (!seen.has(name)) {
          seen.add(name);
          found.push([name, directory]);
        }
        return;
      }
      for (const entry of this.#readDirectory(directory)) {
        if (entry.startsWith(".") || SKIPPED_DIRECTORIES.has(entry)) continue;
        const nested = join(directory, entry);
        if (this.#isDirectory(nested)) walk(nested, depth + 1);
      }
    };
    for (const root of this.#roots(reference)) walk(root, 0);
    return found;
  }

  #readDirectory(path: string): string[] {
    try {
      return readdirSync(path).sort();
    } catch {
      return [];
    }
  }

  #hasSkillFile(directory: string): boolean {
    try {
      return statSync(join(directory, "SKILL.md")).isFile();
    } catch {
      return false;
    }
  }

  #isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  #frontmatter(path: string): Frontmatter {
    try {
      const contents = readFileSync(path, "utf8").slice(0, 4000);
      if (!contents.startsWith("---")) return {};
      const end = contents.indexOf("\n---", 3);
      if (end < 0) return {};
      return frontmatterOf(parseYaml(contents.slice(3, end)));
    } catch {
      return {};
    }
  }
}
