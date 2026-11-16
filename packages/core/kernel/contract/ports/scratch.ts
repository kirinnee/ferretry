import type { FencedPath } from '../bound.ts';

/** One private folder; every name is relative to it, and nothing is written through a link it made. */
export interface ScratchDirectory {
  /** The folder, for a child's cwd or arguments. Gone after `close`. */
  readonly path: FencedPath;
  makeDirectory(rel: string, mode?: number): Promise<void>;
  /** Create only (refused when anything is at the name), with exactly `mode` (umask does not apply). */
  writeFile(rel: string, data: string | Uint8Array, mode?: number): Promise<void>;
  /** A link whose target is text, never followed here. */
  symlink(rel: string, target: string): Promise<void>;
  /** Removes the folder and everything in it. */
  close(): Promise<void>;
}

export interface ScratchPort {
  open(): Promise<ScratchDirectory>;
}
