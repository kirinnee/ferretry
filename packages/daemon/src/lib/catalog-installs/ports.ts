/** What the installer needs from the file system, as ports: the service decides, the adapters touch disk. */
import type { CatalogInstallRefusal } from '@ferretry/protocol';

/** A refusal in the contract's vocabulary, with the status a route answers it with. */
export class CatalogInstallRefusalError extends Error {
  constructor(
    readonly code: CatalogInstallRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogInstallRefusalError';
  }
}

/** A folder's files as they are now: path relative to the folder → SHA-256 (hex) of the bytes. */
export interface SkillFolderReading {
  readonly exists: boolean;
  readonly files: ReadonlyMap<string, string>;
}

/** The folder cannot be used: a symbolic link on the way, something that is not a plain file, or too much of it. */
export class SkillFolderRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFolderRefused';
  }
}

/** A file moved between the read the person approved and the write. */
export class SkillFolderChanged extends Error {
  constructor() {
    super('the skill folder changed while it was being written, so nothing more was written. Try again.');
    this.name = 'SkillFolderChanged';
  }
}

/**
 * A few named files of a folder, read for a diff: their text, and the paths that could not be shown — a file
 * over the per-file bound, one that ran past the total bound, or one that is not text. A path that is simply
 * not there is in neither.
 */
export interface SkillFilesReading {
  readonly files: ReadonlyMap<string, string>;
  readonly tooLarge: readonly string[];
}

export interface SkillFolderChange {
  /** Files to put, relative to the folder. */
  readonly write: readonly { readonly path: string; readonly content: string }[];
  /** Files to delete, relative to the folder. */
  readonly remove: readonly string[];
  /** For every path touched: the hash it must still have (`null`: must still be absent). */
  readonly expected: ReadonlyMap<string, string | null>;
}

/**
 * A skill folder inside a project: `<root>/.claude/skills/<name>` or `<root>/.agents/skills/<name>`.
 * Every call refuses a symbolic link anywhere from `root` down, and anything that is not a plain file.
 */
export interface ProjectSkillFiles {
  inspect(root: string, folder: string): Promise<SkillFolderReading>;
  /** The text of exactly `paths` (relative to the folder), under the same no-link rules and bounded in size. */
  read(root: string, folder: string, paths: readonly string[]): Promise<SkillFilesReading>;
  /** Put and delete exactly `change`, each file by temp + rename, after re-checking `expected`. Empty folders are pruned. */
  apply(root: string, folder: string, change: SkillFolderChange): Promise<void>;
}

/** The skill folders of this machine's fleet (`<fleet>/assets/skills/<name>`). The fleet service writes; this reads and prunes. */
export interface RuntimeSkillAssets {
  inspect(name: string): Promise<SkillFolderReading>;
  /** The text of exactly `paths` (relative to the folder), under the same no-link rules and bounded in size. */
  read(name: string, paths: readonly string[]): Promise<SkillFilesReading>;
  /**
   * Delete exactly the files `expected` names, each only if it still has the hash the caller VERIFIED
   * (the guard is the caller's reading, not one taken here), then the folder if it is empty.
   */
  remove(name: string, expected: ReadonlyMap<string, string | null>): Promise<void>;
}
