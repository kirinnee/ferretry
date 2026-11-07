/**
 * What a local skill copy needs from the world, as ports: the service decides, the adapters (or other plugins, when
 * they are on) provide. Some of these are the catalog installer's (the review, the folder reader, the runtime write):
 * Catalogs and Runtimes own them, so here they are seams a caller binds, and an unbound one refuses in words.
 */
import type {
  LocalSkillRefusal,
  SkillInstallWarning,
  SkillProvenance,
  SkillReviewEntry,
  SkillSourceProblem,
} from '../../../contract/index.ts';

/** A refusal in the local-copy contract's vocabulary, with the status a route answers it with. */
export class LocalSkillRefusalError extends Error {
  constructor(
    readonly code: LocalSkillRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'LocalSkillRefusalError';
  }
}

/** The most files a skill folder at a destination holds: a longer one could never be removed or updated. */
export const MAX_SKILL_FOLDER_FILES = 64;

/** A folder's files as they are now: path relative to the folder -> SHA-256 (hex) of the bytes. */
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

export interface SkillFolderChange {
  readonly write: readonly { readonly path: string; readonly content: string }[];
  readonly remove: readonly string[];
  /** For every path touched: the hash it must still have (`null`: must still be absent). */
  readonly expected: ReadonlyMap<string, string | null>;
}

/** A skill folder inside a project: `<root>/.claude/skills/<name>` or `<root>/.agents/skills/<name>`. */
export interface ProjectSkillFiles {
  inspect(root: string, folder: string): Promise<SkillFolderReading>;
  apply(root: string, folder: string, change: SkillFolderChange): Promise<void>;
}

/** The skill folders a runtime's profile carries (Runtimes writes them; this reads and prunes). */
export interface RuntimeSkillAssets {
  inspect(name: string): Promise<SkillFolderReading>;
  remove(name: string, expected: ReadonlyMap<string, string | null>): Promise<void>;
}

/** A skill folder read whole for review: carried files, what was left out and said, or why none can be carried. */
export interface ReadSkillFolder {
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly problems: readonly SkillSourceProblem[];
  readonly refusal?: string;
}

/** Reads the folder of one SKILL.md the inventory listed, never following a link and staying inside `boundary`. */
export interface SkillFolderReader {
  read(manifestPath: string, boundary: string): Promise<ReadSkillFolder>;
}

/** The catalog installer's review of an item, used unchanged so a local copy reads like a catalog install. */
export interface SkillItemReviewer {
  review(
    name: string,
    files: readonly { readonly path: string; readonly content: string }[],
    provenance: SkillProvenance,
  ): {
    readonly review: readonly SkillReviewEntry[];
    readonly warnings: readonly SkillInstallWarning[];
  };
}

export interface RuntimeRef {
  readonly id: string;
  readonly name: string;
  readonly profile: string;
}

/** The runtime half of a copy: a skill component in a profile, written and removed as one reviewed change. */
export interface RuntimeSkillTarget {
  runtimes(): Promise<readonly RuntimeRef[]>;
  profiles(): Promise<readonly { readonly name: string }[]>;
  /** The stored `skills` component of that name, or `undefined`. */
  storedComponent(name: string): Promise<unknown>;
  install(change: {
    readonly name: string;
    readonly files: readonly { readonly path: string; readonly content: string }[];
    readonly profile: string;
    readonly provenance: SkillProvenance;
    readonly replace: boolean;
  }): Promise<{ readonly component: unknown }>;
  removeComponent(name: string): Promise<void>;
}

/** Why a seam that no plugin binds refuses. */
export const unavailable = (what: string): never => {
  throw new LocalSkillRefusalError('local_skill_target_unknown', `${what} is not available on this machine yet.`);
};
