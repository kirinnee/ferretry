import type { Instant } from '@ferretry/std';
import type { ProjectInfo, ProjectsFile } from '../../contract/index.ts';

/**
 * What the registry needs from the machine, as one port: the folder checks and the few git questions registering
 * asks. The real one (`adapters/folders.ts`) goes through the kernel's roots and spawn ports; tests give a map.
 */
export interface ProjectFolders {
  /** Whether `path` is an existing directory the owner may name (outside Ferretry's own home). */
  isDirectory(path: string): Promise<boolean>;
  /** The resolved workspace root for `path`: symlinks followed where the machine can say (git does). */
  canonical(path: string): Promise<string>;
  /** Makes one new directory (the parent must exist); refuses an existing one. */
  makeDirectory(path: string): Promise<void>;
  gitInit(path: string): Promise<void>;
  /** `git clone -- <url> <path>` with only the transports the address schema allows. */
  gitClone(url: string, path: string): Promise<void>;
  /** The repository's common directory for the work tree at `root`, or `undefined` when it is not one. */
  gitCommonDirectory(root: string): Promise<string | undefined>;
}

/** The registry file, read and updated on one serialization chain. */
export interface RegistryStore {
  /** Throws when the file is damaged: "missing" is the empty registry, "damaged" is evidence we cannot read. */
  read(): Promise<readonly ProjectInfo[]>;
  update(change: (current: ProjectsFile) => ProjectsFile): Promise<void>;
}

export interface RegistryClock {
  now(): Instant;
}
