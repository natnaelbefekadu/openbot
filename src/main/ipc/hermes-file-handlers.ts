import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  HERMES_FILE_MAX_BYTES,
  type HermesFileContent,
  type HermesFileReadInput,
  type HermesFileWriteInput,
} from "@openbot/contracts/ipc";
// A text file the file panel reads and saves. This is the one surface that writes a file the user
// did not stage through an attachment, so it refuses the things that quietly become a different
// file: a symlink, a device, a folder, a binary, or a path inside Hermes' own configuration.

import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { isObject, requireString } from "./validation";

/** Folders whose files are configuration or secrets, not source: never opened by this panel. */
const REFUSED_PREFIXES = [".ssh", ".gnupg", ".hermes", ".config/OpenBot", ".aws", ".kube", ".password-store"];

function refused(path: string): string | null {
  const home = homedir();
  for (const prefix of REFUSED_PREFIXES) {
    const full = join(home, prefix);
    if (path === full || path.startsWith(`${full}/`))
      return `That file is inside ~/${prefix}, which this panel does not open.`;
  }
  return null;
}

function parsePath(input: unknown): string {
  if (!isObject(input)) throw new Error("Invalid file request.");
  // A path is longer than an identifier, which is what `requireString` allows by default.
  const path = requireString(input.path, "path", 4096);
  if (!isAbsolute(path)) throw new Error("A file path has to be absolute.");
  const target = resolve(path);
  const blocked = refused(target);
  if (blocked) throw new Error(blocked);
  return target;
}

export function parseHermesFileRead(input: unknown): HermesFileReadInput {
  return { path: parsePath(input) };
}

export function parseHermesFileWrite(input: unknown): HermesFileWriteInput {
  if (!isObject(input) || typeof input.text !== "string") throw new Error("Invalid file contents.");
  return { path: parsePath(input), text: input.text };
}

async function describe(path: string, text: string): Promise<HermesFileContent> {
  const info = await stat(path);
  return { path, text, bytes: info.size, modifiedAt: info.mtime.toISOString() };
}

export function hermesFileIpcHandlers(): Pick<IpcGroupHandlers, "hermesFiles"> {
  return {
    hermesFiles: {
      read: payloadHandler(parseHermesFileRead, async ({ path }) => {
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error("That path is a symlink; open the file it points at.");
        if (!info.isFile()) throw new Error("That path is not a file.");
        if (info.size > HERMES_FILE_MAX_BYTES) throw new Error("That file is too large to open here.");
        const bytes = await readFile(path);
        if (bytes.includes(0)) throw new Error("That file is binary, not text.");
        return describe(path, bytes.toString("utf8"));
      }),
      write: payloadHandler(parseHermesFileWrite, async ({ path, text }) => {
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error("That path is a symlink; edit the file it points at.");
        if (!info.isFile()) throw new Error("That path is not a file.");
        if (Buffer.byteLength(text, "utf8") > HERMES_FILE_MAX_BYTES)
          throw new Error("That file is too large to save here.");
        // The backup is the undo, and the rename is what keeps a crash from truncating the original.
        const backup = `${path}.bak`;
        await writeFile(backup, await readFile(path));
        const staged = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
        await writeFile(staged, text, "utf8");
        try {
          await rename(staged, path);
        } catch (error) {
          await unlink(staged).catch(() => undefined);
          throw error;
        }
        const after = await readFile(path, "utf8");
        if (after !== text) throw new Error("The file did not keep what was written.");
        return describe(path, after);
      }),
    },
  };
}
