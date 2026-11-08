/**
 * A text file inside a folder the user already let this computer's agent reach, as the file panel
 * reads and saves it. The path is absolute: the panel gets it from a folder the user picked, never
 * from typed text alone.
 */
export interface HermesFileReadInput {
  readonly path: string;
}

export interface HermesFileWriteInput {
  readonly path: string;
  readonly text: string;
  /**
   * A digest of the bytes the panel loaded. The save is refused when the file on disk no longer
   * matches: the agent writes to these files during its turns, and a timestamp alone misses a
   * writer that restores mtime (`git checkout`, `cp -p`, `rsync -t`).
   */
  readonly digest?: string;
}

export interface HermesFileContent {
  readonly path: string;
  readonly text: string;
  readonly bytes: number;
  readonly modifiedAt: string;
  /** SHA-256 of the bytes on disk, hex. Sent back on save so a stale buffer cannot win. */
  readonly digest: string;
}

/** A file bigger than this is not opened in the editor; it is not a source file. */
export const HERMES_FILE_MAX_BYTES = 2_000_000;

function field(value: unknown, key: string): string | number | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  for (const [name, entry] of Object.entries(value)) {
    if (name !== key) continue;
    if (typeof entry === "string" || typeof entry === "number") return entry;
    return undefined;
  }
  return undefined;
}

/** The decoder the preload binds, so a wrong shape fails at the boundary instead of in the panel. */
export function decodeHermesFileContent(value: unknown): HermesFileContent {
  if (!isHermesFileContent(value)) throw new Error("The file panel returned an unexpected record.");
  return value;
}

export function isHermesFileContent(value: unknown): value is HermesFileContent {
  return (
    typeof field(value, "path") === "string" &&
    typeof field(value, "text") === "string" &&
    typeof field(value, "bytes") === "number" &&
    typeof field(value, "modifiedAt") === "string" &&
    typeof field(value, "digest") === "string"
  );
}
