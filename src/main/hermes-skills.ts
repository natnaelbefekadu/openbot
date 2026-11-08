import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { InstalledSkill } from "@openbot/contracts/ipc";
import { parse as parseYaml } from "yaml";

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

const SKIPPED_DIRECTORIES = new Set([".archive", "__pycache__"]);
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

/** The `HERMES_HOME` of one custom agent, read without trusting the file's shape. */
function readEnv(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || !("env" in entry) || !Array.isArray(entry.env)) return;
  for (const variable of entry.env) {
    if (typeof variable !== "object" || variable === null) continue;
    const name = "name" in variable ? text(variable.name) : undefined;
    const value = "value" in variable ? text(variable.value) : undefined;
    if (name === "HERMES_HOME" && value) return value;
  }
  return;
}

function readId(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || !("id" in entry)) return;
  return text(entry.id);
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

export class HermesSkills {
  readonly #customAgentsPath: string;
  readonly #hermesCommand: string;

  constructor(options: { customAgentsPath: string; hermesCommand?: string }) {
    this.#customAgentsPath = options.customAgentsPath;
    this.#hermesCommand = options.hermesCommand ?? "hermes";
  }

  /** The Hermes profile an agent runs on, or null when the agent is not a Hermes one. */
  profileForModel(model: string | undefined): HermesProfileRef | null {
    const prefix = model?.split("/")[0]?.trim();
    if (!prefix) return null;
    const match = this.#hermesHomes().find((candidate) => candidate.id === prefix);
    return match ? { profile: basename(match.home), home: match.home } : null;
  }

  list(reference: HermesProfileRef): InstalledSkill[] {
    const disabled = new Set(this.#settings(reference).disabled);
    const rows: InstalledSkill[] = [];
    for (const [name, directory] of this.#skillDirectories(reference)) {
      const meta = this.#frontmatter(join(directory, "SKILL.md"));
      const display = meta.name ?? name;
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
    const current = this.#settings(reference).disabled;
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
    const command =
      reference.profile === "default"
        ? [this.#hermesCommand, ...args]
        : [this.#hermesCommand, "-p", reference.profile, ...args];
    const [executable, ...rest] = command;
    if (!executable) throw new Error("No hermes command configured.");
    await new Promise<void>((resolve, reject) => {
      execFile(
        executable,
        rest,
        { env: { ...process.env, HERMES_HOME: reference.home }, timeout: 60_000 },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve();
        },
      );
    });
  }

  #hermesHomes(): Array<{ id: string; home: string }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#customAgentsPath, "utf8"));
    } catch {
      return [];
    }
    const entries = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "agents" in parsed && Array.isArray(parsed.agents)
        ? parsed.agents
        : [];
    return entries.flatMap((entry) => {
      const id = readId(entry);
      const home = readEnv(entry);
      return id && home ? [{ id, home }] : [];
    });
  }

  #settings(reference: HermesProfileRef): SkillSettings {
    try {
      return skillSettings(parseYaml(readFileSync(join(reference.home, "config.yaml"), "utf8")));
    } catch {
      return NO_SETTINGS;
    }
  }

  #roots(reference: HermesProfileRef): string[] {
    return [join(reference.home, "skills"), ...this.#settings(reference).externalDirs];
  }

  #skillDirectories(reference: HermesProfileRef): Array<[string, string]> {
    const found: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const root of this.#roots(reference)) {
      for (const entry of this.#readDirectory(root)) {
        const directory = join(root, entry);
        if (SKIPPED_DIRECTORIES.has(entry) || !this.#isDirectory(directory)) continue;
        if (this.#hasSkillFile(directory)) {
          if (seen.has(entry)) continue;
          seen.add(entry);
          found.push([entry, directory]);
          continue;
        }
        for (const child of this.#readDirectory(directory)) {
          const nested = join(directory, child);
          if (seen.has(child) || !this.#hasSkillFile(nested)) continue;
          seen.add(child);
          found.push([child, nested]);
        }
      }
    }
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
