import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CreateRoutineInput,
  DeleteRoutineInput,
  Routine,
  RoutineRun,
  RoutineRunStatus,
  RoutineSchedule,
  UpdateRoutineInput,
} from "@openbot/contracts/ipc";
import type { CustomAgentConfig } from "../backend/custom-acp-agents-client";
import { type HermesProfileRef, hermesProfileFor } from "./hermes-skills";

/**
 * The cron jobs of a Hermes agent, shown in OpenBot's own schedule surface.
 *
 * Hermes owns the schedule: `cron/jobs.json` is the record and `hermes cron` is the only writer.
 * Every method here reads that file, calls the CLI with an argument array, then reads again, so a
 * change the user makes in this panel and one they make in Hermes can never disagree silently.
 */

interface HermesJob {
  id?: unknown;
  name?: unknown;
  prompt?: unknown;
  enabled?: unknown;
  schedule?: unknown;
  schedule_display?: unknown;
  next_run_at?: unknown;
  created_at?: unknown;
  last_run_at?: unknown;
  paused_at?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function scheduleOf(job: HermesJob): RoutineSchedule {
  const schedule = job.schedule;
  if (typeof schedule === "object" && schedule !== null) {
    const kind = "kind" in schedule ? schedule.kind : undefined;
    const expr = "expr" in schedule ? str(schedule.expr) : undefined;
    if (kind === "cron" && expr) return { kind: "custom", expression: expr };
    if (kind === "once") {
      const next = str(job.next_run_at) ?? str(job.last_run_at);
      if (next) {
        const when = new Date(next);
        if (!Number.isNaN(when.getTime())) {
          const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
          const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
          return { kind: "once", date, time };
        }
      }
    }
    const display = "display" in schedule ? str(schedule.display) : undefined;
    if (display) return { kind: "custom", expression: display };
  }
  const fallback = str(job.schedule_display);
  return { kind: "custom", expression: fallback ?? "* * * * *" };
}

/** The schedule argument `hermes cron` takes for a schedule the panel shows. */
function expressionOf(schedule: RoutineSchedule): string {
  const parts = (time: string) => {
    const [hour, minute] = time.split(":");
    return { minute: Number(minute ?? 0), hour: Number(hour ?? 0) };
  };
  switch (schedule.kind) {
    case "hourly":
      return `${schedule.minute} * * * *`;
    case "daily": {
      const { minute, hour } = parts(schedule.time);
      return `${minute} ${hour} * * *`;
    }
    case "weekdays": {
      const { minute, hour } = parts(schedule.time);
      return `${minute} ${hour} * * 1-5`;
    }
    case "weekly": {
      const { minute, hour } = parts(schedule.time);
      return `${minute} ${hour} * * ${schedule.weekday}`;
    }
    case "monthly": {
      const { minute, hour } = parts(schedule.time);
      return `${minute} ${hour} ${schedule.day} * *`;
    }
    case "interval": {
      const unit = schedule.unit === "minutes" ? "m" : schedule.unit === "hours" ? "h" : "d";
      return `every ${schedule.amount}${unit}`;
    }
    case "once": {
      const when = new Date(`${schedule.date}T${schedule.time}:00`);
      if (Number.isNaN(when.getTime())) throw new Error("That date and time could not be read.");
      const minutes = Math.round((when.getTime() - Date.now()) / 60_000);
      if (minutes < 1) throw new Error("A one-off run has to be in the future.");
      return `in ${minutes}m`;
    }
    case "custom":
      return schedule.expression;
    default:
      throw new Error(`This panel cannot express a ${schedule.kind} schedule for Hermes yet. Use a cron expression.`);
  }
}

const RUN_STATUS: Readonly<Record<string, RoutineRunStatus>> = {
  completed: "succeeded",
  succeeded: "succeeded",
  failed: "failed",
  error: "failed",
  running: "running",
  cancelled: "cancelled",
  canceled: "cancelled",
  interrupted: "interrupted",
};

function statusOf(value: unknown): RoutineRunStatus {
  return RUN_STATUS[str(value) ?? ""] ?? "queued";
}

export class HermesCron {
  readonly #customAgents: () => readonly CustomAgentConfig[];
  readonly #hermesCommand: string;
  readonly #timezone: string;

  constructor(options: {
    customAgents: () => readonly CustomAgentConfig[];
    hermesCommand?: string;
    timezone?: string;
  }) {
    this.#customAgents = options.customAgents;
    this.#hermesCommand = options.hermesCommand ?? "hermes";
    this.#timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  }

  profileForModel(model: string | undefined): HermesProfileRef | null {
    return hermesProfileFor(model, this.#customAgents);
  }

  list(reference: HermesProfileRef, agentId: string): Routine[] {
    return this.#jobs(reference).map((job) => this.#toRoutine(job, agentId));
  }

  async create(reference: HermesProfileRef, input: CreateRoutineInput): Promise<Routine> {
    const expression = expressionOf(input.schedule);
    const before = new Set(this.#jobs(reference).map((job) => str(job.id)));
    await this.#run(reference, ["cron", "create", expression, input.instruction, "--name", input.name]);
    const created = this.#jobs(reference).find((job) => !before.has(str(job.id)));
    if (!created) throw new Error("Hermes reported no new job.");
    if (!input.active) await this.#run(reference, ["cron", "pause", str(created.id) ?? ""]);
    const job = this.#jobs(reference).find((candidate) => str(candidate.id) === str(created.id)) ?? created;
    return this.#toRoutine(job, input.agentId);
  }

  async update(reference: HermesProfileRef, input: UpdateRoutineInput): Promise<Routine> {
    const id = input.routineId;
    const args = ["cron", "edit", id];
    if (input.schedule) args.push("--schedule", expressionOf(input.schedule));
    if (input.instruction !== undefined) args.push("--prompt", input.instruction);
    if (input.name !== undefined) args.push("--name", input.name);
    if (args.length > 3) await this.#run(reference, args);
    if (input.active !== undefined) {
      const job = this.#job(reference, id);
      const enabled = job?.enabled === true;
      if (enabled !== input.active) await this.#run(reference, ["cron", input.active ? "resume" : "pause", id]);
    }
    return this.#toRoutine(this.#requireJob(reference, id), input.agentId);
  }

  async remove(reference: HermesProfileRef, input: DeleteRoutineInput): Promise<void> {
    await this.#run(reference, ["cron", "remove", input.routineId]);
    if (this.#job(reference, input.routineId)) throw new Error("Hermes did not remove that job.");
  }

  async test(reference: HermesProfileRef, agentId: string, routineId: string): Promise<RoutineRun> {
    const job = this.#requireJob(reference, routineId);
    const startedAt = new Date().toISOString();
    await this.#run(reference, ["cron", "run", routineId], 300_000);
    return {
      id: `hermes-run-${routineId}-${Date.now()}`,
      agentId,
      routineId,
      triggerId: null,
      kind: "manual",
      source: "test",
      scheduledFor: startedAt,
      routineName: str(job.name) ?? routineId,
      instruction: str(job.prompt) ?? "",
      status: "succeeded",
      error: null,
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
      deliveryId: null,
    };
  }

  async runs(reference: HermesProfileRef, agentId: string, routineId: string, limit = 20): Promise<RoutineRun[]> {
    const job = this.#job(reference, routineId);
    const output = await this.#capture(reference, ["cron", "runs", routineId, "--limit", String(limit)]);
    return output.split("\n").flatMap((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return [];
      const [runId, status, , , at] = parts;
      if (!runId || !status) return [];
      const when = at ?? new Date().toISOString();
      return [
        {
          id: runId,
          agentId,
          routineId,
          triggerId: null,
          kind: "scheduled",
          scheduledFor: when,
          routineName: str(job?.name) ?? routineId,
          instruction: str(job?.prompt) ?? "",
          status: statusOf(status),
          error: null,
          createdAt: when,
          updatedAt: when,
          deliveryId: null,
        },
      ];
    });
  }

  #toRoutine(job: HermesJob, agentId: string): Routine {
    const id = str(job.id) ?? "";
    const createdAt = str(job.created_at) ?? new Date().toISOString();
    return {
      id,
      agentId,
      name: str(job.name) ?? id,
      instruction: str(job.prompt) ?? "",
      active: job.enabled === true,
      timezone: this.#timezone,
      trigger: {
        id: `hermes-trigger-${id}`,
        routineId: id,
        schedule: scheduleOf(job),
        nextRunAt: str(job.next_run_at) ?? createdAt,
        createdAt,
        updatedAt: str(job.paused_at) ?? createdAt,
      },
      createdAt,
      updatedAt: str(job.last_run_at) ?? createdAt,
    };
  }

  #jobsPath(reference: HermesProfileRef): string {
    return join(reference.home, "cron", "jobs.json");
  }

  #jobs(reference: HermesProfileRef): HermesJob[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#jobsPath(reference), "utf8"));
    } catch {
      return [];
    }
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "jobs" in parsed && Array.isArray(parsed.jobs)
        ? parsed.jobs
        : [];
    return list.flatMap((entry) => (typeof entry === "object" && entry !== null ? [entry] : []));
  }

  #job(reference: HermesProfileRef, id: string): HermesJob | undefined {
    return this.#jobs(reference).find((job) => str(job.id) === id);
  }

  #requireJob(reference: HermesProfileRef, id: string): HermesJob {
    const job = this.#job(reference, id);
    if (!job) throw new Error(`No Hermes job ${id} in this profile.`);
    return job;
  }

  async #run(reference: HermesProfileRef, args: string[], timeout = 60_000): Promise<void> {
    await this.#capture(reference, args, timeout);
  }

  async #capture(reference: HermesProfileRef, args: string[], timeout = 60_000): Promise<string> {
    const [executable, ...rest] = [this.#hermesCommand, ...args];
    if (!executable) throw new Error("No hermes command configured.");
    return await new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        rest,
        { env: { ...process.env, HERMES_HOME: reference.home }, timeout, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout);
        },
      );
    });
  }
}
