import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  HERMES_FILE_MAX_BYTES,
  type HermesFileContent,
  type HermesFileReadInput,
  type HermesFileWriteInput,
} from "@openbot/contracts/ipc";
// The one surface that writes a file the user did not stage through an attachment. It refuses what
// would quietly become a different file: a symlink (leaf or parent), a hardlink, a device, a folder,
// a binary, a file that is not UTF-8, one that changed since it was opened, or a path inside
// Hermes' own configuration.

import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { isObject, requireString } from "./validation";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Folders whose files are configuration or secrets, not source: never opened by this panel. */
const REFUSED_PREFIXES = [".ssh", ".gnupg", ".hermes", ".config/OpenBot", ".aws", ".kube", ".password-store"];

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** A refusal in words, because `ENOENT: no such file…` is not an answer a user can act on. */
function explain(error: unknown): Error {
  switch (errorCode(error)) {
    case "ENOENT":
      return new Error("That file does not exist.");
    case "ELOOP":
      return new Error("That path is a symlink; open the file it points at.");
    case "EACCES":
    case "EPERM":
      return new Error("That file is not readable by this user.");
    case "EISDIR":
      return new Error("That path is not a file.");
    case "ENOSPC":
    case "EDQUOT":
      return new Error("There is no room on the disk to save that file.");
    default:
      return error instanceof Error ? error : new Error(String(error));
  }
}

/** True when `child` is `parent` or below it, on this platform's separator rules. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function refuseSecrets(path: string): Promise<void> {
  const home = await realpath(homedir()).catch(() => homedir());
  const base = dirname(path);
  // The parent is resolved too: `notes -> ~/.ssh` passes a string test on the leaf path alone.
  const parent = await realpath(base).catch(() => base);
  const resolved = parent === base ? path : join(parent, path.slice(base.length + 1));
  const fold = process.platform === "linux" ? (value: string) => value : (value: string) => value.toLowerCase();
  for (const prefix of REFUSED_PREFIXES) {
    const full = fold(join(home, prefix));
    if (within(full, fold(resolved)) || within(full, fold(parent))) {
      throw new Error(`That file is inside ~/${prefix}, which this panel does not open.`);
    }
  }
}

function parsePath(input: unknown): string {
  if (!isObject(input)) throw new Error("Invalid file request.");
  const path = requireString(input.path, "path", 4096);
  // A NUL byte makes every later syscall throw a raw TypeError.
  if (path.includes("\0")) throw new Error("That path is not a real path.");
  if (!isAbsolute(path)) throw new Error("A file path has to be absolute.");
  // A UNC root is a network share, not a file on this computer.
  if (/^[\\/]{2}/.test(path)) throw new Error("A network path is not opened here.");
  return resolve(path);
}

export function parseHermesFileRead(input: unknown): HermesFileReadInput {
  return { path: parsePath(input) };
}

export function parseHermesFileWrite(input: unknown): HermesFileWriteInput {
  if (!isObject(input) || typeof input.text !== "string") throw new Error("Invalid file contents.");
  return {
    path: parsePath(input),
    text: input.text,
    modifiedAt: typeof input.modifiedAt === "string" ? input.modifiedAt : undefined,
  };
}

interface Opened {
  readonly text: string;
  readonly content: HermesFileContent;
  readonly mode: number;
}

async function readRegular(path: string): Promise<Opened> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW).catch((error: unknown) => {
    throw explain(error);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("That path is not a file.");
    // A hardlink is another name for a file outside this folder, and nothing here can see that.
    if (info.nlink > 1) throw new Error("That file has more than one name on this disk; open it directly instead.");
    if (info.size > HERMES_FILE_MAX_BYTES) throw new Error("That file is too large to open here.");
    const bytes = await handle.readFile();
    if (bytes.includes(0)) throw new Error("That file is binary, not text.");
    let text: string;
    try {
      // A file that is not valid UTF-8 would come back as replacement characters and be written
      // back corrupted. Refusing is the only honest answer.
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("That file is not valid UTF-8 text, so editing it here would corrupt it.");
    }
    return {
      text,
      mode: info.mode & 0o777,
      content: { path, text, bytes: info.size, modifiedAt: info.mtime.toISOString() },
    };
  } finally {
    await handle.close();
  }
}

/** The first save keeps `<path>.bak`; later saves never overwrite it, so the original survives. */
async function backupPath(path: string): Promise<string> {
  const first = `${path}.bak`;
  const existing = await lstat(first).catch(() => null);
  if (!existing) return first;
  // A planted symlink at `foo.md.bak` would make the backup overwrite whatever it points at.
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error("A backup beside that file is not a regular file; move it before saving here.");
  }
  return `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  const staged = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const out = await open(staged, "wx", mode);
    try {
      await out.writeFile(text, "utf8");
      // Flushed before the rename: a power cut then leaves either the old file or the new one.
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
    // A staging file left behind would litter the user's project.
    await unlink(staged).catch(() => undefined);
    throw explain(error);
  }
}

export function hermesFileIpcHandlers(): Pick<IpcGroupHandlers, "hermesFiles"> {
  return {
    hermesFiles: {
      read: payloadHandler(parseHermesFileRead, async ({ path }) => {
        await refuseSecrets(path);
        return (await readRegular(path)).content;
      }),
      write: payloadHandler(parseHermesFileWrite, async ({ path, text, modifiedAt }) => {
        await refuseSecrets(path);
        const current = await readRegular(path);
        if (modifiedAt && current.content.modifiedAt !== modifiedAt) {
          throw new Error("That file changed since you opened it. Open it again to see what is there now.");
        }
        if (Buffer.byteLength(text, "utf8") > HERMES_FILE_MAX_BYTES) {
          throw new Error("That file is too large to save here.");
        }
        // The backup is the undo, and the copy keeps the original file's permissions.
        const backup = await backupPath(path);
        await copyFile(path, backup).catch((error: unknown) => {
          throw explain(error);
        });
        await writeAtomic(path, text, current.mode);
        const after = await readRegular(path);
        if (after.text !== text) throw new Error("The file did not keep what was written.");
        return after.content;
      }),
    },
  };
}
