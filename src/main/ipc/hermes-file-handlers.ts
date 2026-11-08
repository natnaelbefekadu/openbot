import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, open, rename, unlink } from "node:fs/promises";
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

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * A path is opened once, on a handle, and every check reads that handle: a `lstat` followed by a
 * second `open` is a window in which the path can become a symlink to something else.
 */
async function openRegular(path: string, flags: number): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(path, flags | NOFOLLOW);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ELOOP") throw new Error("That path is a symlink; open the file it points at.");
    if (code === "ENOENT") throw new Error("That file does not exist.");
    throw error;
  }
}

async function readText(path: string): Promise<HermesFileContent> {
  const handle = await openRegular(path, constants.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("That path is not a file.");
    if (info.size > HERMES_FILE_MAX_BYTES) throw new Error("That file is too large to open here.");
    const bytes = await handle.readFile();
    if (bytes.includes(0)) throw new Error("That file is binary, not text.");
    let text: string;
    try {
      // A file that is not valid UTF-8 would come back with replacement characters and be written
      // back corrupted. Refusing is the only honest answer.
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("That file is not valid UTF-8 text, so editing it here would corrupt it.");
    }
    return { path, text, bytes: info.size, modifiedAt: info.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

/** The first save keeps `<path>.bak`; later saves never overwrite it, so the original survives. */
async function backupPath(path: string): Promise<string> {
  const first = `${path}.bak`;
  try {
    await open(first, constants.O_RDONLY | NOFOLLOW).then((handle) => handle.close());
    return `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  } catch {
    return first;
  }
}

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

export function hermesFileIpcHandlers(): Pick<IpcGroupHandlers, "hermesFiles"> {
  return {
    hermesFiles: {
      read: payloadHandler(parseHermesFileRead, async ({ path }) => readText(path)),
      write: payloadHandler(parseHermesFileWrite, async ({ path, text }) => {
        // Opening the file is what proves it is still a regular file: the path could have become a
        // symlink after the panel read it.
        const handle = await openRegular(path, constants.O_RDONLY);
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new Error("That path is not a file.");
        } finally {
          await handle.close();
        }
        if (Buffer.byteLength(text, "utf8") > HERMES_FILE_MAX_BYTES)
          throw new Error("That file is too large to save here.");

        // The backup is the undo. The first save takes `<path>.bak`; later saves take a dated copy,
        // so the original is never overwritten by a second edit.
        await copyFile(path, await backupPath(path));

        const staged = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
        try {
          // Write, flush, then rename: a crash leaves either the old file or the new one, never half.
          const out = await open(staged, "wx", 0o600);
          try {
            await out.writeFile(text, "utf8");
            await out.sync();
          } finally {
            await out.close();
          }
          await rename(staged, path);
          const directory = await open(dirname(path), constants.O_RDONLY).catch(() => null);
          if (directory) {
            await directory.sync().catch(() => undefined);
            await directory.close();
          }
        } catch (error) {
          // A staging file that stays behind would litter the user's project.
          await unlink(staged).catch(() => undefined);
          throw error;
        }
        const after = await readText(path);
        if (after.text !== text) throw new Error("The file did not keep what was written.");
        return after;
      }),
    },
  };
}
